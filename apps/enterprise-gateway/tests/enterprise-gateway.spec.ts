import { createServer, type IncomingMessage, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { allowInsecureRequests, discovery } from 'openid-client'
import { createAccessTokenVerifier, createEnterpriseGateway, loadConfig } from '../src/server.mjs'
import { EnterpriseOidcSession, EnterpriseTokenVault, type EnterpriseTokenEncryption } from '../../desktop/src/enterprise-oidc.ts'

const servers: Server[] = []
const sessions: EnterpriseOidcSession[] = []
const temporaryRoots: string[] = []
const issuer = 'https://id.example.test/tenant'
const audience = 'https://gateway.example.test/'
type TokenOptions = { issuer?: string; audience?: string; expiresIn?: number }
type SignToken = (claims: Record<string, unknown>, options?: TokenOptions) => Promise<string>
type TestOidcPolicy = {
  issuer: string
  clientId: string
  gatewayScope: string
  scopes: string[]
  audience: string
}
type TestConfig = ReturnType<typeof gatewayConfig> & {
  localJwks: ReturnType<typeof createLocalJWKSet>
  verify: ReturnType<typeof createAccessTokenVerifier>
  sign: SignToken
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.cancelSignIn()))
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }))
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('validates deployment settings and requires HTTPS endpoints and a key file', () => {
  const values = {
    OIDC_ISSUER: issuer,
    OIDC_JWKS_URL: 'https://id.example.test/keys',
    OIDC_AUDIENCE: audience,
    OIDC_REQUIRED_SCOPE: 'model:run',
    REDIS_URL: 'rediss://quota.example.test:6380/0',
    DEEPSEEK_UPSTREAM_BASE_URL: 'https://api.deepseek.com/anthropic',
    MODEL_ALLOWLIST: 'deepseek-chat,deepseek-reasoner',
    DEEPSEEK_API_KEY_FILE: '/run/secrets/model-key',
  }
  expect(loadConfig(values, (path) => {
    expect(path).toBe('/run/secrets/model-key')
    return 'server-side-secret\n'
  })).toMatchObject({ issuer, audience, requiredScope: 'model:run', apiKey: 'server-side-secret',
    redisUrl: new URL('rediss://quota.example.test:6380/0') })
  for (const invalid of [
    { ...values, OIDC_ISSUER: 'http://id.example.test' },
    { ...values, OIDC_JWKS_URL: 'http://id.example.test/keys' },
    { ...values, OIDC_REQUIRED_SCOPE: 'model run' },
    { ...values, DEEPSEEK_UPSTREAM_BASE_URL: 'http://api.deepseek.com/anthropic' },
    { ...values, MODEL_ALLOWLIST: 'deepseek-chat,deepseek-chat' },
    { ...values, REDIS_URL: 'https://quota.example.test' },
    { ...values, REDIS_URL: 'redis://quota.example.test/?credential=secret' },
  ]) expect(() => loadConfig(invalid, () => 'key')).toThrow('enterprise gateway:')
  expect(() => loadConfig(values, () => { throw new Error('secret file unavailable') })).toThrow('cannot read DEEPSEEK_API_KEY_FILE')
  const { DEEPSEEK_UPSTREAM_BASE_URL: _upstream, ...withoutUpstream } = values
  expect(() => loadConfig(withoutUpstream, () => 'key')).toThrow('DEEPSEEK_UPSTREAM_BASE_URL')
  expect(() => loadConfig({ ...values, REDIS_URL: undefined, NODE_ENV: 'production' }, () => 'key'))
    .toThrow('REDIS_URL is required in production')
})

it('fails closed when the shared concurrency store is unavailable', async () => {
  const { config, token } = await setup()
  const audits: Array<Record<string, unknown>> = []
  let upstreamCalls = 0
  const gateway = createEnterpriseGateway(config, {
    verify: config.verify,
    fetch: async () => { upstreamCalls += 1; throw new Error('upstream must not run') },
    limiter: { isReady: () => false, acquire: async () => { throw new Error('Redis unavailable') } },
    audit: (event: Record<string, unknown>) => { audits.push(event) },
  })
  const gatewayUrl = await listen(gateway)
  const body = JSON.stringify({ model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'user', content: 'private' }] })
  const response = await post(gatewayUrl, body, token)
  expect(response.status).toBe(503)
  expect(upstreamCalls).toBe(0)
  expect(audits.map(event => event.outcome)).toEqual(['concurrency_store_unavailable'])
  expect(await fetch(`${gatewayUrl}/readyz`).then(value => value.status)).toBe(503)
  expect(await fetch(`${gatewayUrl}/healthz`).then(value => value.status)).toBe(200)
})

it('loads strict per-tenant model and concurrency policies from protected configuration', () => {
  const values = {
    OIDC_ISSUER: issuer,
    OIDC_JWKS_URL: 'https://id.example.test/keys',
    OIDC_AUDIENCE: audience,
    OIDC_REQUIRED_SCOPE: 'model:run',
    OIDC_TENANT_CLAIM: 'tenant_id',
    TENANT_POLICY_FILE: '/run/config/tenants.json',
    DEEPSEEK_UPSTREAM_BASE_URL: 'https://inference.example.test/anthropic',
    MODEL_ALLOWLIST: 'deepseek-chat,deepseek-reasoner',
    DEEPSEEK_API_KEY_FILE: '/run/secrets/model-key',
  }
  const policies = JSON.stringify({ engineering: { models: ['deepseek-chat'], maxConcurrentRequests: 3,
    maxTokensPerRequest: 2048 } })
  const config = loadConfig(values, path => path === '/run/secrets/model-key' ? 'server-side-secret' : policies)
  expect(config.tenantPolicies?.get('engineering')).toMatchObject({
    models: new Set(['deepseek-chat']), maxConcurrentRequests: 3, maxTokensPerRequest: 2048,
  })
  expect(config.tenantPolicies?.has('unlisted')).toBe(false)
  const samplePolicies = readFileSync(new URL('../../../deploy/enterprise/gateway/tenants.json.example', import.meta.url), 'utf8')
  const sampleConfig = loadConfig(values, path => path === '/run/secrets/model-key' ? 'server-side-secret' : samplePolicies)
  expect(sampleConfig.tenantPolicies?.size).toBe(2)
  expect(() => loadConfig({ ...values, OIDC_TENANT_CLAIM: undefined }, path => path.endsWith('model-key')
    ? 'server-side-secret' : policies)).toThrow('OIDC_TENANT_CLAIM is required')
  for (const invalid of [
    '{',
    '{}',
    JSON.stringify({ engineering: { models: ['unknown-model'], maxConcurrentRequests: 1, maxTokensPerRequest: 10 } }),
    JSON.stringify({ engineering: { models: ['deepseek-chat'], maxConcurrentRequests: 0, maxTokensPerRequest: 10 } }),
    JSON.stringify({ engineering: { models: ['deepseek-chat'], maxConcurrentRequests: 1, maxTokensPerRequest: 0 } }),
    JSON.stringify({ engineering: { models: ['deepseek-chat', 'deepseek-chat'], maxConcurrentRequests: 1,
      maxTokensPerRequest: 10 } }),
    JSON.stringify({ engineering: { models: ['deepseek-chat'], maxConcurrentRequests: 1,
      maxTokensPerRequest: 10, allowUsers: ['*'] } }),
  ]) {
    expect(() => loadConfig(values, path => path.endsWith('model-key') ? 'server-side-secret' : invalid))
      .toThrow('enterprise gateway:')
  }
})

it('validates signed access tokens with issuer, audience, expiry, subject, and scope claims', async () => {
  const { config, sign } = await setup()
  const verify = createAccessTokenVerifier(config, config.localJwks)
  await expect(verify(await sign({ sub: 'employee-42', scope: 'model:run' })))
    .resolves.toEqual({ subject: 'employee-42', scopes: ['model:run'], tenant: 'engineering' })
  await expect(verify(await sign({ sub: 'employee-42', scope: 'profile' }))).resolves.toMatchObject({ scopes: ['profile'] })
  await expect(verify(await sign({ sub: 'employee-42', scope: 'model:run' }, { audience: 'https://other.example/' })))
    .rejects.toThrow()
  await expect(verify(await sign({ scope: 'model:run' }))).rejects.toThrow()
  await expect(verify(await sign({ sub: 'employee-42', scope: 'model:run' }, { issuer: 'https://wrong.example/' })))
    .rejects.toThrow()
  await expect(verify(await sign({ sub: 'employee-42', scope: 'model:run' }, { expiresIn: -1 }))).rejects.toThrow()
})

it('uses a Desktop OIDC access token to authenticate a request through the enterprise gateway', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const publicJwk = { ...await exportJWK(publicKey), kid: 'sso-gateway-test-key', use: 'sig', alg: 'RS256' }
  const localJwks = createLocalJWKSet({ keys: [publicJwk] })
  const authorize = { url: undefined as URL | undefined }
  let policy: TestOidcPolicy = {
    issuer: 'http://127.0.0.1', clientId: 'managed-desktop', gatewayScope: 'model:run',
    scopes: ['openid', 'profile', 'model:run'], audience,
  }
  const issuerServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', policy.issuer)
      if (url.pathname === '/.well-known/openid-configuration') {
        json(response, { issuer: policy.issuer, authorization_endpoint: `${policy.issuer}/authorize`,
          token_endpoint: `${policy.issuer}/token`, jwks_uri: `${policy.issuer}/jwks`,
          response_types_supported: ['code'], subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'] })
        return
      }
      if (url.pathname === '/jwks') { json(response, { keys: [publicJwk] }); return }
      if (url.pathname === '/token' && request.method === 'POST') {
        const parameters = new URLSearchParams(await requestText(request))
        const verifier = parameters.get('code_verifier') ?? ''
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (authorize.url?.searchParams.get('code_challenge') !== challenge
          || parameters.get('resource') !== audience) {
          response.writeHead(400).end()
          return
        }
        const now = Math.floor(Date.now() / 1000)
        const accessToken = await new SignJWT({ scope: 'model:run', tenant_id: 'engineering' })
          .setProtectedHeader({ alg: 'RS256', kid: 'sso-gateway-test-key' }).setIssuer(policy.issuer)
          .setSubject('employee-sso-1').setAudience(audience).setIssuedAt(now).setExpirationTime(now + 300)
          .sign(privateKey)
        const idToken = await new SignJWT({ nonce: authorize.url?.searchParams.get('nonce') })
          .setProtectedHeader({ alg: 'RS256', kid: 'sso-gateway-test-key' }).setIssuer(policy.issuer)
          .setSubject('employee-sso-1').setAudience(policy.clientId).setIssuedAt(now).setExpirationTime(now + 300)
          .sign(privateKey)
        json(response, { access_token: accessToken, id_token: idToken, refresh_token: 'refresh-secret',
          token_type: 'Bearer', expires_in: 300 })
        return
      }
      response.writeHead(404).end()
    })()
  })
  const issuerUrl = await listen(issuerServer)
  policy = { ...policy, issuer: issuerUrl }

  const upstreamRequests: Array<{ authorization: string | undefined; apiKey: string | undefined; body: string }> = []
  const upstream = createServer((request, response) => {
    void (async () => {
      upstreamRequests.push({ authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined, body: await requestText(request) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"type":"message","usage":{"input_tokens":1,"output_tokens":2}}')
    })()
  })
  const upstreamUrl = await listen(upstream)
  const config = { ...gatewayConfig(), issuer: policy.issuer, upstream: new URL(upstreamUrl) }
  const verify = createAccessTokenVerifier(config, localJwks)
  const audit: Array<Record<string, unknown>> = []
  const gateway = createEnterpriseGateway(config, { verify,
    audit: (event: Record<string, unknown>) => { audit.push(event) } })
  const gatewayUrl = await listen(gateway)
  const root = await mkdtemp(join(tmpdir(), 'dsh-enterprise-sso-gateway-'))
  temporaryRoots.push(root)
  const session = new EnterpriseOidcSession(policy, new EnterpriseTokenVault(root, new TestEncryption()), {
    discovery: (issuerUrlValue, clientId, metadata, auth) => discovery(issuerUrlValue, clientId, metadata, auth, {
      // oxlint-disable-next-line typescript/no-deprecated -- The test IdP binds only to its allocated loopback port.
      execute: [allowInsecureRequests],
    }),
  })
  sessions.push(session)
  const flow = await session.startSignIn()
  authorize.url = new URL(flow.authorizeUrl)
  const callback = new URL(authorize.url.searchParams.get('redirect_uri')!)
  callback.searchParams.set('code', 'one-time-code')
  callback.searchParams.set('state', authorize.url.searchParams.get('state')!)
  expect((await fetch(callback)).status).toBe(200)
  await flow.completion

  const token = await session.getAccessToken()
  expect(token).toBeTruthy()
  const body = JSON.stringify({ model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'user', content: 'private prompt' }] })
  const response = await post(gatewayUrl, body, token)
  expect(response.status).toBe(200)
  expect(upstreamRequests).toEqual([{ authorization: undefined, apiKey: 'server-side-secret', body }])
  expect(audit).toHaveLength(1)
  expect(JSON.stringify(audit)).not.toContain('private prompt')
  expect(JSON.stringify(audit)).not.toContain(token)
})

it('proxies only authorized, allowlisted Messages requests and emits content-free audit records', async () => {
  const { config, token } = await setup()
  const upstreamRequests: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = []
  const upstream = createServer((request, response) => {
    void (async () => {
      upstreamRequests.push({ headers: request.headers, body: await requestText(request) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'event: message_start', 'data: {"type":"message_start","message":{"usage":{"input_tokens":17}}}', '',
        'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"text":"MODEL_RESPONSE_MUST_NOT_BE_AUDITED"}}', '',
        'event: message_delta', 'data: {"type":"message_delta","usage":{"output_tokens":8}}', '',
        'event: message_stop', 'data: {"type":"message_stop"}', '', '',
      ].join('\n'))
    })()
  })
  const upstreamUrl = await listen(upstream)
  const audits: Array<Record<string, unknown>> = []
  const gateway = createEnterpriseGateway({ ...config, upstream: new URL(upstreamUrl), maxConcurrentPerSubject: 2 }, {
    verify: config.verify,
    fetch: fetch,
    audit: (event: Record<string, unknown>) => { audits.push(event) },
  })
  const gatewayUrl = await listen(gateway)
  const prompt = 'PROMPT_MUST_NOT_BE_AUDITED'
  const body = JSON.stringify({ model: 'deepseek-chat', max_tokens: 20, stream: true,
    messages: [{ role: 'user', content: prompt }] })
  const response = await post(gatewayUrl, body, token)
  const responseBody = await response.text()
  expect(response.status).toBe(200)
  expect(responseBody).toContain('MODEL_RESPONSE_MUST_NOT_BE_AUDITED')
  expect(upstreamRequests).toHaveLength(1)
  expect(upstreamRequests[0]?.body).toBe(body)
  expect(upstreamRequests[0]?.headers['x-api-key']).toBe('server-side-secret')
  expect(upstreamRequests[0]?.headers.authorization).toBeUndefined()
  expect(upstreamRequests[0]?.headers['x-request-id']).toBe(response.headers.get('x-request-id'))
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({
    event: 'enterprise_model_request', subject: 'employee-42', tenant: 'engineering', model: 'deepseek-chat',
    decision: 'allow', outcome: 'completed', statusCode: 200, usage: { inputTokens: 17, outputTokens: 8 },
  })
  const auditText = JSON.stringify(audits)
  for (const secret of [token, 'server-side-secret', prompt, 'MODEL_RESPONSE_MUST_NOT_BE_AUDITED']) {
    expect(auditText).not.toContain(secret)
  }

  const missing = await post(gatewayUrl, body)
  const insufficient = await post(gatewayUrl, body, await config.sign({ sub: 'employee-42', scope: 'profile' }))
  const disallowed = await post(gatewayUrl, JSON.stringify({ model: 'unknown-model', max_tokens: 20 }), token)
  const malformed = await post(gatewayUrl, '{', token)
  expect(missing.status).toBe(401)
  expect(insufficient.status).toBe(403)
  expect(disallowed.status).toBe(403)
  expect(malformed.status).toBe(400)
  expect(upstreamRequests).toHaveLength(1)
  expect(audits.map(event => event.outcome)).toEqual([
    'completed', 'missing_bearer_token', 'insufficient_scope', 'model_not_allowed', 'invalid_request',
  ])
})

it('isolates concurrent work per subject and enforces request body limits', async () => {
  const { config, token, sign } = await setup()
  let releaseUpstream!: () => void
  let signalFirstRequest!: () => void
  let upstreamRequestCount = 0
  const firstUpstreamRequest = new Promise<void>((resolve) => { signalFirstRequest = resolve })
  const upstreamReady = new Promise<void>((resolve) => { releaseUpstream = resolve })
  const upstream = createServer((_request, response) => {
    void (async () => {
      upstreamRequestCount += 1
      if (upstreamRequestCount === 1) signalFirstRequest()
      await upstreamReady
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}')
    })()
  })
  const upstreamUrl = await listen(upstream)
  const audits: Array<Record<string, unknown>> = []
  const gateway = createEnterpriseGateway({ ...config, upstream: new URL(upstreamUrl), maxConcurrentPerSubject: 1,
    bodyLimitBytes: 128 }, { verify: config.verify, audit: (event: Record<string, unknown>) => { audits.push(event) } })
  const gatewayUrl = await listen(gateway)
  const requestBody = JSON.stringify({ model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
  const first = post(gatewayUrl, requestBody, token)
  await firstUpstreamRequest
  const sameSubject = await post(gatewayUrl, requestBody, token)
  const otherSubject = post(gatewayUrl, requestBody, await sign({ sub: 'employee-43', scope: 'model:run' }))
  expect(sameSubject.status).toBe(429)
  releaseUpstream()
  const [firstResponse, otherResponse] = await Promise.all([first, otherSubject])
  expect(firstResponse.status).toBe(200)
  expect(otherResponse.status).toBe(200)
  const tooLarge = await post(gatewayUrl, JSON.stringify({ model: 'deepseek-chat', max_tokens: 10, data: 'x'.repeat(256) }), token)
  expect(tooLarge.status).toBe(413)
  expect(audits.map(event => event.outcome).sort()).toEqual([
    'completed', 'completed', 'request_too_large', 'subject_concurrency_limit',
  ])
})

it('denies unknown tenants and enforces each tenant model and concurrency policy', async () => {
  const { config, token, sign } = await setup()
  let releaseUpstream!: () => void
  let signalFirstRequest!: () => void
  const firstUpstreamRequest = new Promise<void>((resolve) => { signalFirstRequest = resolve })
  const upstreamReady = new Promise<void>((resolve) => { releaseUpstream = resolve })
  let upstreamRequestCount = 0
  const upstream = createServer((_request, response) => {
    void (async () => {
      upstreamRequestCount += 1
      if (upstreamRequestCount === 1) signalFirstRequest()
      await upstreamReady
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"type":"message"}')
    })()
  })
  const upstreamUrl = await listen(upstream)
  const audits: Array<Record<string, unknown>> = []
  const gateway = createEnterpriseGateway({ ...config, upstream: new URL(upstreamUrl), maxConcurrentPerSubject: 4,
    tenantPolicies: new Map([['engineering', { models: new Set(['deepseek-chat']), maxConcurrentRequests: 1,
      maxTokensPerRequest: 2048 }]]) }, {
    verify: config.verify, audit: (event: Record<string, unknown>) => { audits.push(event) },
  })
  const gatewayUrl = await listen(gateway)
  const allowedBody = JSON.stringify({ model: 'deepseek-chat', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
  const deniedModelBody = JSON.stringify({ model: 'deepseek-reasoner', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
  const deniedTokenBudgetBody = JSON.stringify({ model: 'deepseek-chat', max_tokens: 2049,
    messages: [{ role: 'user', content: 'hi' }] })
  const deniedModel = await post(gatewayUrl, deniedModelBody, token)
  const deniedTokenBudget = await post(gatewayUrl, deniedTokenBudgetBody, token)
  const unknownTenant = await post(gatewayUrl, allowedBody,
    await sign({ sub: 'employee-44', scope: 'model:run', tenant_id: 'unlisted' }))
  expect(deniedModel.status).toBe(403)
  expect(deniedTokenBudget.status).toBe(403)
  expect(unknownTenant.status).toBe(403)

  const first = post(gatewayUrl, allowedBody, token)
  await firstUpstreamRequest
  const otherSubjectSameTenant = await post(gatewayUrl, allowedBody,
    await sign({ sub: 'employee-43', scope: 'model:run', tenant_id: 'engineering' }))
  expect(otherSubjectSameTenant.status).toBe(429)
  releaseUpstream()
  expect((await first).status).toBe(200)
  expect(upstreamRequestCount).toBe(1)
  expect(audits.map(event => event.outcome)).toEqual([
    'tenant_model_not_allowed', 'tenant_token_limit', 'tenant_not_allowed', 'tenant_concurrency_limit', 'completed',
  ])
})

async function setup(): Promise<{
  config: TestConfig
  token: string
  sign: SignToken
}> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const publicJwk = { ...await exportJWK(publicKey), kid: 'gateway-test-key', use: 'sig', alg: 'RS256' }
  const localJwks = createLocalJWKSet({ keys: [publicJwk] })
  const config = gatewayConfig()
  const verify = createAccessTokenVerifier(config, localJwks)
  const sign: SignToken = async (claims, options = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const jwt = new SignJWT({ tenant_id: 'engineering', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'gateway-test-key' })
      .setIssuer(options.issuer ?? issuer).setAudience(options.audience ?? audience)
      .setIssuedAt(now).setExpirationTime(now + (options.expiresIn ?? 300))
    if (typeof claims.sub === 'string') jwt.setSubject(claims.sub)
    return jwt.sign(privateKey)
  }
  const token = await sign({ sub: 'employee-42', scope: 'model:run', tenant_id: 'engineering' })
  return { config: { ...config, localJwks, verify, sign }, token, sign }
}

function gatewayConfig() {
  return {
    issuer,
    jwksUrl: new URL('https://id.example.test/keys'),
    audience,
    requiredScope: 'model:run',
    upstream: new URL('http://127.0.0.1/anthropic'),
    prefix: '/anthropic',
    models: new Set(['deepseek-chat', 'deepseek-reasoner']),
    apiKey: 'server-side-secret',
    tenantClaim: 'tenant_id',
    bodyLimitBytes: 4096,
    maxConcurrentPerSubject: 4,
    upstreamTimeoutMs: 10_000,
    port: 0,
    host: '127.0.0.1',
  }
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('enterprise gateway test server did not bind a port')
  return `http://127.0.0.1:${String(address.port)}`
}

async function post(url: string, body: string, token?: string): Promise<Response> {
  return fetch(`${url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body,
  })
}

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(toBuffer(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: import('node:http').ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

class TestEncryption implements EnterpriseTokenEncryption {
  isEncryptionAvailable(): boolean { return true }
  encryptString(value: string): Buffer { return Buffer.from(value, 'utf8').reverse() }
  decryptString(value: Buffer): string { return Buffer.from(value).reverse().toString('utf8') }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new Error('enterprise gateway test received a non-byte request chunk')
}
