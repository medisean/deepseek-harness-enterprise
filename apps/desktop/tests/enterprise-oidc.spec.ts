import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { allowInsecureRequests, discovery } from 'openid-client'
import type { EnterpriseOidcPolicy } from '@deepseek-ai/dsh-app-boot'
import { EnterpriseOidcSession, EnterpriseTokenVault, type EnterpriseTokenEncryption } from '../src/enterprise-oidc.ts'

const liveServers: ReturnType<typeof createServer>[] = []
const temporaryRoots: string[] = []
const sessions: EnterpriseOidcSession[] = []

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.cancelSignIn()))
  for (const server of liveServers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

class TestEncryption implements EnterpriseTokenEncryption {
  isEncryptionAvailable(): boolean { return true }
  encryptString(value: string): Buffer { return Buffer.from(value, 'utf8').reverse() }
  decryptString(value: Buffer): string { return Buffer.from(value).reverse().toString('utf8') }
}

it('completes OIDC code + PKCE, rejects a bad state, and keeps the gateway token encrypted', async () => {
  const { policy, privateKey, publicJwk } = await issuer()
  const authorization = { url: undefined as URL | undefined }
  let activePolicy = policy
  let receivedVerifier: string | undefined
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', activePolicy.issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
      json(response, {
        issuer: activePolicy.issuer, authorization_endpoint: `${activePolicy.issuer}/authorize`,
        token_endpoint: `${activePolicy.issuer}/token`, jwks_uri: `${activePolicy.issuer}/jwks`,
        revocation_endpoint: `${activePolicy.issuer}/revoke`, response_types_supported: ['code'],
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (url.pathname === '/jwks') { json(response, { keys: [publicJwk] }); return }
    if (url.pathname === '/token' && request.method === 'POST') {
      const body = await requestText(request)
      const parameters = new URLSearchParams(body)
      receivedVerifier = parameters.get('code_verifier') ?? undefined
      const challenge = createHash('sha256').update(receivedVerifier ?? '').digest('base64url')
      const expectedChallenge = authorization.url?.searchParams.get('code_challenge')
      if (expectedChallenge === undefined || challenge !== expectedChallenge) {
        response.writeHead(400).end()
        return
      }
      const claims = b64url(JSON.stringify({ iss: activePolicy.issuer, sub: 'employee-123', aud: 'managed-desktop',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: authorization.url?.searchParams.get('nonce') }))
      const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'enterprise-test-key', typ: 'JWT' }))
      const signingInput = `${header}.${claims}`
      const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')
      json(response, { access_token: 'gateway-access-token', refresh_token: 'refresh-token',
        token_type: 'Bearer', expires_in: 3600, id_token: `${signingInput}.${signature}` })
      return
    }
    if (url.pathname === '/revoke') { response.writeHead(200).end(); return }
    response.writeHead(404).end()
  }
  const server = createServer((request, response) => { void handleRequest(request, response) })
  liveServers.push(server)
  activePolicy = await listen(server, policy)
  const root = await mkdtemp(join(tmpdir(), 'dsh-enterprise-oidc-'))
  temporaryRoots.push(root)
  const vault = new EnterpriseTokenVault(root, new TestEncryption())
  const session = new EnterpriseOidcSession(activePolicy, vault, {
    discovery: (issuerUrl, clientId, metadata, auth) => discovery(issuerUrl, clientId, metadata, auth, {
      // oxlint-disable-next-line typescript/no-deprecated -- The test IdP binds only to its allocated loopback port.
      execute: [allowInsecureRequests],
    }),
  })
  sessions.push(session)

  const flow = await session.startSignIn()
  authorization.url = new URL(flow.authorizeUrl)
  expect(authorization.url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorization.url.searchParams.get('scope')?.split(' ')).toContain('model:run')
  expect(authorization.url.searchParams.get('resource')).toBe('api://model-gateway')
  const callback = new URL(authorization.url.searchParams.get('redirect_uri')!)
  callback.searchParams.set('code', 'one-time-code')
  callback.searchParams.set('state', 'wrong-state')
  expect((await fetch(callback)).status).toBe(400)
  callback.searchParams.set('state', authorization.url.searchParams.get('state')!)
  expect((await fetch(callback)).status).toBe(200)
  await flow.completion

  expect(receivedVerifier).toBeTruthy()
  await expect(session.getAccessToken()).resolves.toBe('gateway-access-token')
  const encrypted = await readFile(join(root, 'enterprise-session.bin'), 'utf8')
  expect(encrypted).not.toContain('gateway-access-token')
  await session.signOut()
  await expect(session.getAccessToken()).resolves.toBeUndefined()
})

it('closes the loopback listener and cancels a pending sign-in', async () => {
  const { policy } = await issuer()
  let activePolicy = policy
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', activePolicy.issuer)
    if (url.pathname !== '/.well-known/openid-configuration') { response.writeHead(404).end(); return }
    json(response, {
      issuer: activePolicy.issuer, authorization_endpoint: `${activePolicy.issuer}/authorize`,
      token_endpoint: `${activePolicy.issuer}/token`, jwks_uri: `${activePolicy.issuer}/jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'],
    })
  })
  liveServers.push(server)
  activePolicy = await listen(server, policy)
  const root = await mkdtemp(join(tmpdir(), 'dsh-enterprise-oidc-cancel-'))
  temporaryRoots.push(root)
  const session = new EnterpriseOidcSession(activePolicy, new EnterpriseTokenVault(root, new TestEncryption()), {
    discovery: (issuerUrl, clientId, metadata, auth) => discovery(issuerUrl, clientId, metadata, auth, {
      // oxlint-disable-next-line typescript/no-deprecated -- The test IdP binds only to its allocated loopback port.
      execute: [allowInsecureRequests],
    }),
  })
  sessions.push(session)
  const flow = await session.startSignIn()
  const completion = expect(flow.completion).rejects.toMatchObject({ code: 'cancelled' })
  const callback = new URL(new URL(flow.authorizeUrl).searchParams.get('redirect_uri')!)
  await session.cancelSignIn()
  await completion
  await expect(fetch(callback)).rejects.toThrow()
})

it('refreshes an expired gateway token once and persists token rotation', async () => {
  const { policy } = await issuer()
  let activePolicy = policy
  const tokenRequests: URLSearchParams[] = []
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', activePolicy.issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
      json(response, {
        issuer: activePolicy.issuer, authorization_endpoint: `${activePolicy.issuer}/authorize`,
        token_endpoint: `${activePolicy.issuer}/token`, jwks_uri: `${activePolicy.issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      tokenRequests.push(new URLSearchParams(await requestText(request)))
      json(response, { access_token: 'refreshed-gateway-token', refresh_token: 'rotated-refresh-token',
        token_type: 'Bearer', expires_in: 3600 })
      return
    }
    response.writeHead(404).end()
  }
  const server = createServer((request, response) => { void handleRequest(request, response) })
  liveServers.push(server)
  activePolicy = await listen(server, policy)
  const root = await mkdtemp(join(tmpdir(), 'dsh-enterprise-oidc-refresh-'))
  temporaryRoots.push(root)
  const vault = new EnterpriseTokenVault(root, new TestEncryption())
  await vault.write({ version: 1, accessToken: 'expired-gateway-token', refreshToken: 'original-refresh-token',
    idToken: 'enterprise-id-token', expiresAt: Date.now() - 1 })
  const session = new EnterpriseOidcSession(activePolicy, vault, {
    discovery: (issuerUrl, clientId, metadata, auth) => discovery(issuerUrl, clientId, metadata, auth, {
      // oxlint-disable-next-line typescript/no-deprecated -- The test IdP binds only to its allocated loopback port.
      execute: [allowInsecureRequests],
    }),
  })
  sessions.push(session)

  await expect(Promise.all([session.getAccessToken(), session.getAccessToken()]))
    .resolves.toEqual(['refreshed-gateway-token', 'refreshed-gateway-token'])
  expect(tokenRequests).toHaveLength(1)
  expect(tokenRequests[0]?.get('grant_type')).toBe('refresh_token')
  expect(tokenRequests[0]?.get('refresh_token')).toBe('original-refresh-token')
  expect(tokenRequests[0]?.get('resource')).toBe('api://model-gateway')
  await expect(vault.read()).resolves.toMatchObject({ accessToken: 'refreshed-gateway-token',
    refreshToken: 'rotated-refresh-token' })
})

async function issuer(): Promise<{ policy: EnterpriseOidcPolicy; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; publicJwk: Record<string, unknown> }> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicJwk = publicKey.export({ format: 'jwk' })
  return {
    policy: { issuer: 'http://127.0.0.1', clientId: 'managed-desktop', gatewayScope: 'model:run',
      scopes: ['openid', 'profile', 'model:run'], audience: 'api://model-gateway' },
    privateKey,
    publicJwk: { ...publicJwk, kid: 'enterprise-test-key', use: 'sig', alg: 'RS256' },
  }
}

async function listen(server: ReturnType<typeof createServer>, policy: EnterpriseOidcPolicy): Promise<EnterpriseOidcPolicy> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('OIDC fixture did not bind a loopback port')
  return { ...policy, issuer: `http://127.0.0.1:${String(address.port)}` }
}

function json(response: import('node:http').ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function requestText(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('error', reject)
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
  })
}

function b64url(value: string): string { return Buffer.from(value).toString('base64url') }
