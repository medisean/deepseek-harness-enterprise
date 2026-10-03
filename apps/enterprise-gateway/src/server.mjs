import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createClient } from 'redis'
import { createLocalConcurrencyLimiter, createRedisConcurrencyLimiter } from './concurrency-limiter.mjs'

const DEFAULT_BODY_LIMIT = 16 * 1024 * 1024
const MAX_AUDIT_FRAME = 256 * 1024

/** Read and validate deployment configuration without exposing secret contents in errors.
 * @param {NodeJS.ProcessEnv} env - Process or test deployment settings.
 * @param {(path: string, encoding: BufferEncoding) => string} readSecret - Reads a UTF-8 secret or policy file.
 * @returns {{issuer: string, jwksUrl: URL, audience: string, requiredScope: string, upstream: URL, prefix: string,
 *   models: Set<string>, apiKey: string, tenantClaim?: string,
 *   tenantPolicies?: Map<string, {models: Set<string>, maxConcurrentRequests: number, maxTokensPerRequest: number}>, bodyLimitBytes: number,
 *   redisUrl?: URL, maxConcurrentPerSubject: number, requestTimeoutMs: number, upstreamTimeoutMs: number,
 *   port: number, host: string}} Validated gateway configuration.
 */
export function loadConfig(env = process.env, readSecret = readFileSync) {
  const issuer = secureUrl(env.OIDC_ISSUER, 'OIDC_ISSUER').href
  const jwksUrl = secureUrl(env.OIDC_JWKS_URL, 'OIDC_JWKS_URL')
  const audience = required(env.OIDC_AUDIENCE, 'OIDC_AUDIENCE')
  const requiredScope = required(env.OIDC_REQUIRED_SCOPE ?? 'model:run', 'OIDC_REQUIRED_SCOPE')
  if (!/^[\x21-\x7e]+$/u.test(requiredScope)) {
    throw new Error('enterprise gateway: OIDC_REQUIRED_SCOPE must be one printable ASCII scope token')
  }
  const upstream = secureUrl(env.DEEPSEEK_UPSTREAM_BASE_URL, 'DEEPSEEK_UPSTREAM_BASE_URL')
  const prefix = normalizePrefix(env.GATEWAY_PATH_PREFIX ?? '/anthropic')
  const models = new Set(required(env.MODEL_ALLOWLIST, 'MODEL_ALLOWLIST').split(',').map(value => value.trim()))
  if ([...models].some(value => value.length === 0) || models.size === 0) {
    throw new Error('enterprise gateway: MODEL_ALLOWLIST must contain unique model names')
  }
  if (models.size !== env.MODEL_ALLOWLIST.split(',').length) {
    throw new Error('enterprise gateway: MODEL_ALLOWLIST entries must be unique')
  }
  const secretPath = required(env.DEEPSEEK_API_KEY_FILE, 'DEEPSEEK_API_KEY_FILE')
  let apiKey
  try { apiKey = readSecret(secretPath, 'utf8').trim() }
  catch { throw new Error('enterprise gateway: cannot read DEEPSEEK_API_KEY_FILE') }
  if (apiKey.length === 0 || /[\r\n]/u.test(apiKey)) {
    throw new Error('enterprise gateway: DeepSeek API key file must contain one non-empty line')
  }
  const tenantClaim = env.OIDC_TENANT_CLAIM?.trim() || undefined
  const tenantPolicies = env.TENANT_POLICY_FILE === undefined || env.TENANT_POLICY_FILE.trim() === ''
    ? undefined : loadTenantPolicies(env.TENANT_POLICY_FILE, readSecret, models, tenantClaim)
  const bodyLimitBytes = positiveInteger(env.MAX_REQUEST_BYTES ?? String(DEFAULT_BODY_LIMIT), 'MAX_REQUEST_BYTES', 64 * 1024 * 1024)
  const maxConcurrentPerSubject = positiveInteger(env.MAX_CONCURRENT_REQUESTS_PER_SUBJECT ?? '4',
    'MAX_CONCURRENT_REQUESTS_PER_SUBJECT', 1024)
  const redisUrl = env.REDIS_URL === undefined || env.REDIS_URL.trim() === '' ? undefined : parseRedisUrl(env.REDIS_URL)
  if (env.NODE_ENV === 'production' && redisUrl === undefined) {
    throw new Error('enterprise gateway: REDIS_URL is required in production to enforce shared concurrency limits')
  }
  const requestTimeoutMs = positiveInteger(env.REQUEST_TIMEOUT_MS ?? '300000', 'REQUEST_TIMEOUT_MS', 600000)
  const upstreamTimeoutMs = positiveInteger(env.UPSTREAM_TIMEOUT_MS ?? '120000', 'UPSTREAM_TIMEOUT_MS', 600000)
  const port = positiveInteger(env.PORT ?? '8080', 'PORT', 65535)
  const host = env.HOST ?? '0.0.0.0'
  if (host.length === 0 || /[\s/\\]/u.test(host)) throw new Error('enterprise gateway: HOST is invalid')
  return Object.freeze({ issuer, jwksUrl, audience, requiredScope, upstream, prefix, models,
    apiKey, tenantClaim, tenantPolicies, bodyLimitBytes, redisUrl, maxConcurrentPerSubject, requestTimeoutMs,
    upstreamTimeoutMs, port, host })
}

/** Create the HTTP server with replaceable network boundaries for isolation tests. */
export function createEnterpriseGateway(config, options = {}) {
  const fetchImpl = options.fetch ?? fetch
  const verify = options.verify ?? createAccessTokenVerifier(config)
  const audit = options.audit ?? (event => { process.stdout.write(`${JSON.stringify(event)}\n`) })
  const limiter = options.limiter ?? createLocalConcurrencyLimiter()
  const route = `${config.prefix}/v1/messages`

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) sendError(response, 500, 'internal_error', requestIdOf(response))
      else response.destroy()
    })
  })
  server.requestTimeout = config.requestTimeoutMs

  async function handleRequest(request, response) {
    const requestId = randomUUID()
    response.setHeader('x-request-id', requestId)
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end('{"status":"ok"}')
      return
    }
    if (request.method === 'GET' && request.url === '/readyz') {
      const ready = limiter.isReady()
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(ready ? '{"status":"ready"}' : '{"status":"not_ready"}')
      return
    }
    if (request.method !== 'POST' || request.url !== route) {
      sendError(response, 404, 'not_found', requestId)
      return
    }
    const startedAt = Date.now()
    const started = process.hrtime.bigint()
    let principal
    let model
    let decision = 'deny'
    let outcome = 'invalid_token'
    let statusCode = 401
    let usage
    let concurrencyLease
    const record = (extra = {}) => {
      audit({
        event: 'enterprise_model_request', requestId, timestamp: new Date(startedAt).toISOString(),
        ...(principal === undefined ? {} : { subject: principal.subject }),
        ...(principal?.tenant === undefined ? {} : { tenant: principal.tenant }),
        ...(model === undefined ? {} : { model }),
        decision, outcome, statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
        ...(usage === undefined ? {} : { usage }),
        ...extra,
      })
    }
    try {
      const token = bearerToken(request.headers.authorization)
      if (token === undefined) {
        outcome = 'missing_bearer_token'
        sendError(response, 401, 'unauthorized', requestId)
        statusCode = 401
        return
      }
      try { principal = await verify(token) }
      catch {
        outcome = 'invalid_token'
        sendError(response, 401, 'unauthorized', requestId)
        statusCode = 401
        return
      }
      if (!principal.scopes.includes(config.requiredScope)) {
        outcome = 'insufficient_scope'
        statusCode = 403
        sendError(response, statusCode, 'forbidden', requestId)
        return
      }
      const tenantPolicy = config.tenantPolicies?.get(principal.tenant)
      if (config.tenantPolicies !== undefined && tenantPolicy === undefined) {
        outcome = 'tenant_not_allowed'
        statusCode = 403
        sendError(response, statusCode, 'forbidden', requestId)
        return
      }
      try {
        concurrencyLease = await limiter.acquire({
          requestId, subject: principal.subject, tenant: principal.tenant,
          subjectLimit: config.maxConcurrentPerSubject,
          tenantLimit: tenantPolicy?.maxConcurrentRequests ?? 0,
        })
      } catch {
        outcome = 'concurrency_store_unavailable'
        statusCode = 503
        sendError(response, statusCode, 'service_unavailable', requestId)
        return
      }
      if ('reason' in concurrencyLease) {
        outcome = concurrencyLease.reason
        statusCode = 429
        response.setHeader('retry-after', '1')
        sendError(response, statusCode, 'rate_limited', requestId)
        concurrencyLease = undefined
        return
      }
      const declaredSize = request.headers['content-length']
      if (typeof declaredSize === 'string' && Number(declaredSize) > config.bodyLimitBytes) {
        outcome = 'request_too_large'
        statusCode = 413
        sendError(response, statusCode, 'request_too_large', requestId)
        return
      }
      const body = await readBody(request, config.bodyLimitBytes)
      let payload
      try { payload = JSON.parse(body.toString('utf8')) }
      catch {
        outcome = 'invalid_request'
        statusCode = 400
        sendError(response, statusCode, 'invalid_request', requestId)
        return
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
        || typeof payload.model !== 'string' || !Number.isSafeInteger(payload.max_tokens) || payload.max_tokens < 1) {
        outcome = 'invalid_request'
        statusCode = 400
        sendError(response, statusCode, 'invalid_request', requestId)
        return
      }
      model = payload.model
      if (!config.models.has(model)) {
        outcome = 'model_not_allowed'
        statusCode = 403
        sendError(response, statusCode, 'model_not_allowed', requestId)
        return
      }
      if (tenantPolicy !== undefined && !tenantPolicy.models.has(model)) {
        outcome = 'tenant_model_not_allowed'
        statusCode = 403
        sendError(response, statusCode, 'model_not_allowed', requestId)
        return
      }
      if (tenantPolicy !== undefined && payload.max_tokens > tenantPolicy.maxTokensPerRequest) {
        outcome = 'tenant_token_limit'
        statusCode = 403
        sendError(response, statusCode, 'request_limit_exceeded', requestId)
        return
      }
      decision = 'allow'
      const upstreamUrl = new URL(`${config.upstream.pathname.replace(/\/$/u, '')}/v1/messages`, config.upstream.origin)
      const controller = new AbortController()
      response.once('close', () => { if (!response.writableEnded) controller.abort() })
      let upstream
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': safeHeader(request.headers['anthropic-version']) ?? '2023-06-01',
            'x-request-id': requestId,
          },
          body,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(config.upstreamTimeoutMs)]),
          redirect: 'error',
        })
      } catch {
        outcome = controller.signal.aborted ? 'client_disconnected' : 'upstream_unavailable'
        statusCode = controller.signal.aborted ? 499 : 502
        if (!response.destroyed) sendError(response, statusCode, 'upstream_unavailable', requestId)
        return
      }
      statusCode = upstream.status
      outcome = upstream.ok ? 'completed' : 'upstream_error'
      response.statusCode = upstream.status
      response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json')
      response.setHeader('cache-control', 'no-store')
      if (upstream.body === null) {
        response.end()
        return
      }
      const observer = createUsageObserver((value) => { usage = value })
      try {
        await pipeline(Readable.fromWeb(upstream.body), observer, response)
      } catch {
        outcome = controller.signal.aborted ? 'client_disconnected' : 'upstream_stream_error'
        if (!response.destroyed && !response.headersSent) sendError(response, 502, 'upstream_unavailable', requestId)
      }
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        outcome = 'request_too_large'
        statusCode = 413
        sendError(response, statusCode, 'request_too_large', requestId)
      } else {
        outcome = 'invalid_request'
        statusCode = 400
        sendError(response, statusCode, 'invalid_request', requestId)
      }
    } finally {
      let quotaLeaseReleaseFailed = false
      try { await concurrencyLease?.release() }
      catch { quotaLeaseReleaseFailed = true }
      if (quotaLeaseReleaseFailed) record({ quotaLeaseReleaseFailed: true })
      else record()
    }
  }

  return server
}

/** Connect to the shared quota store and return a ready distributed limiter. */
async function connectRedisLimiter(config) {
  if (config.redisUrl === undefined) return { limiter: createLocalConcurrencyLimiter(), close: async () => {} }
  const client = createClient({ url: config.redisUrl.href, disableOfflineQueue: true,
    commandOptions: { timeout: 5000 } })
  client.on('error', () => {})
  try {
    await client.connect()
    return {
      limiter: createRedisConcurrencyLimiter(client, config.requestTimeoutMs + config.upstreamTimeoutMs + 30_000),
      close: async () => { if (client.isOpen) await client.close() },
    }
  } catch {
    client.destroy()
    throw new Error('enterprise gateway: cannot connect to the configured concurrency store')
  }
}

function loadTenantPolicies(path, readFile, globalModels, tenantClaim) {
  if (tenantClaim === undefined) {
    throw new Error('enterprise gateway: OIDC_TENANT_CLAIM is required when TENANT_POLICY_FILE is configured')
  }
  let source
  try { source = readFile(path, 'utf8') }
  catch { throw new Error('enterprise gateway: cannot read TENANT_POLICY_FILE') }
  if (typeof source !== 'string' || Buffer.byteLength(source) > 256 * 1024) {
    throw new Error('enterprise gateway: TENANT_POLICY_FILE must not exceed 256 KiB')
  }
  let value
  try { value = JSON.parse(source) }
  catch { throw new Error('enterprise gateway: TENANT_POLICY_FILE must contain valid JSON') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length === 0 || Object.keys(value).length > 10000) {
    throw new Error('enterprise gateway: TENANT_POLICY_FILE must be a non-empty object with at most 10000 tenants')
  }
  const policies = new Map()
  for (const [tenant, entry] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(tenant)
      || typeof entry !== 'object' || entry === null || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'maxConcurrentRequests,maxTokensPerRequest,models'
      || !Number.isSafeInteger(entry.maxConcurrentRequests) || entry.maxConcurrentRequests < 1 || entry.maxConcurrentRequests > 1024
      || !Number.isSafeInteger(entry.maxTokensPerRequest) || entry.maxTokensPerRequest < 1 || entry.maxTokensPerRequest > 1000000
      || !Array.isArray(entry.models) || entry.models.length === 0
      || entry.models.some(model => typeof model !== 'string' || !globalModels.has(model))
      || new Set(entry.models).size !== entry.models.length) {
      throw new Error(`enterprise gateway: TENANT_POLICY_FILE entry for ${tenant} is invalid`)
    }
    policies.set(tenant, Object.freeze({ models: new Set(entry.models),
      maxConcurrentRequests: entry.maxConcurrentRequests, maxTokensPerRequest: entry.maxTokensPerRequest }))
  }
  return policies
}

/** Validate and verify a JWT access token, returning only authorization claims used by the gateway.
 * @param {ReturnType<typeof loadConfig>} config - Validated gateway settings.
 * @param {import('jose').JWTVerifyGetKey} keySet - Trusted key resolver for access-token signatures.
 * @returns {(token: string) => Promise<{subject: string, scopes: string[], tenant?: string}>} Token verifier.
 */
export function createAccessTokenVerifier(config, keySet = createRemoteJWKSet(config.jwksUrl)) {
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp'],
    })
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 256) {
      throw new Error('enterprise gateway: token subject is invalid')
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/u).filter(Boolean)
      : Array.isArray(payload.scp) && payload.scp.every(scope => typeof scope === 'string') ? payload.scp : []
    const tenantValue = config.tenantClaim === undefined ? undefined : payload[config.tenantClaim]
    if (config.tenantClaim !== undefined && (typeof tenantValue !== 'string' || tenantValue.length === 0 || tenantValue.length > 256)) {
      throw new Error('enterprise gateway: token tenant claim is invalid')
    }
    return { subject: payload.sub, scopes, ...(typeof tenantValue === 'string' ? { tenant: tenantValue } : {}) }
  }
}

function createUsageObserver(onUsage) {
  let buffered = ''
  let inputTokens
  let outputTokens
  let complete = false
  const publish = () => {
    const usage = {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    }
    if (Object.keys(usage).length > 0) onUsage(usage)
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (complete) { callback(null, chunk); return }
      buffered += chunk.toString('utf8')
      if (buffered.length > MAX_AUDIT_FRAME) { buffered = ''; complete = true; callback(null, chunk); return }
      let boundary
      while ((boundary = buffered.search(/\r?\n\r?\n/u)) >= 0) {
        const frame = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary).replace(/^\r?\n\r?\n/u, '')
        const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim()).join('\n')
        if (data === '' || data === '[DONE]') continue
        try {
          const event = JSON.parse(data)
          const usage = event.type === 'message_start' ? event.message?.usage
            : event.type === 'message_delta' ? event.usage : undefined
          if (Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0) inputTokens = usage.input_tokens
          if (Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0) outputTokens = usage.output_tokens
          publish()
        } catch { /* Non-JSON SSE frames carry no auditable token usage. */ }
      }
      callback(null, chunk)
    },
  })
}

async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) {
      request.destroy()
      const error = new Error('enterprise gateway: request body is too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function bearerToken(header) {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(header)
  return match?.[1]
}

function sendError(response, status, code, requestId) {
  if (response.destroyed || response.writableEnded) return
  const body = JSON.stringify({ type: 'error', error: { type: code, message: 'The request was rejected by the enterprise gateway.' } })
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId })
  response.end(body)
}

function requestIdOf(response) { return response.getHeader('x-request-id') }

function safeHeader(value) {
  if (typeof value !== 'string' || value.length > 128 || /[\r\n]/u.test(value)) return undefined
  return value
}

function secureUrl(value, name) {
  let url
  try { url = new URL(required(value, name)) }
  catch { throw new Error(`enterprise gateway: ${name} must be an absolute HTTPS URL`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`enterprise gateway: ${name} must be an HTTPS URL without credentials, query, or fragment`)
  }
  return url
}

function parseRedisUrl(value) {
  let url
  try { url = new URL(value) }
  catch { throw new Error('enterprise gateway: REDIS_URL must be a redis:// or rediss:// URL') }
  if (!['redis:', 'rediss:'].includes(url.protocol) || url.hostname === '' || url.search !== '' || url.hash !== '') {
    throw new Error('enterprise gateway: REDIS_URL must be a redis:// or rediss:// URL without query or fragment')
  }
  if (url.pathname !== '/' && !/^\/(0|[1-9]\d*)$/u.test(url.pathname)) {
    throw new Error('enterprise gateway: REDIS_URL database path must be a non-negative integer')
  }
  return url
}

function normalizePrefix(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.includes('?') || value.includes('#')
    || value.includes('..') || value.includes('\\')) throw new Error('enterprise gateway: GATEWAY_PATH_PREFIX is invalid')
  return value.replace(/\/+$/u, '')
}

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`enterprise gateway: ${name} is required`)
  return value.trim()
}

function positiveInteger(value, name, maximum) {
  if (!/^\d+$/u.test(value)) throw new Error(`enterprise gateway: ${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`enterprise gateway: ${name} must be from 1 through ${maximum}`)
  }
  return parsed
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    const config = loadConfig()
    const quota = await connectRedisLimiter(config)
    const server = createEnterpriseGateway(config, { limiter: quota.limiter })
    server.listen(config.port, config.host, () => {
      process.stdout.write(`enterprise gateway listening on ${config.host}:${config.port}\n`)
    })
    const stop = () => server.close(() => {
      void quota.close().finally(() => { process.exitCode = 0 })
    })
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'enterprise gateway startup failed'}\n`)
    process.exitCode = 1
  })
}
