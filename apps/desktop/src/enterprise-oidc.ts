/** Native-app OIDC login and an OS-encrypted token vault for managed Desktop. */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  None, authorizationCodeGrant, buildAuthorizationUrl, calculatePKCECodeChallenge, discovery,
  randomNonce, randomPKCECodeVerifier, randomState, refreshTokenGrant, tokenRevocation,
  type Configuration, type TokenEndpointResponse,
} from 'openid-client'
import type { EnterpriseOidcPolicy } from '@deepseek-ai/dsh-app-boot'

const TOKEN_EXPIRY_SKEW_MS = 30_000
const LOGIN_DEADLINE_MS = 5 * 60_000
const TOKEN_FILE = 'enterprise-session.bin'
const CALLBACK_PAGE = '<!doctype html><meta charset="utf-8"><title>Sign-in complete</title><p>You can return to DeepSeek Harness.</p>'

/** Electron's OS-bound string encryption surface. */
export interface EnterpriseTokenEncryption {
  /** @returns whether the OS encryption backend is available. */
  isEncryptionAvailable(): boolean
  /** @param value - serialized token record. @returns OS-encrypted bytes. */
  encryptString(value: string): Buffer
  /** @param value - bytes previously returned by {@link encryptString}. @returns decrypted token record. */
  decryptString(value: Buffer): string
}

interface StoredTokenSet {
  readonly version: 1
  readonly accessToken: string
  readonly refreshToken?: string
  readonly idToken?: string
  readonly expiresAt: number
}

interface SignInAttempt {
  readonly server: Server
  readonly controller: AbortController
  redirectUri: string
  readonly callbackPath: string
  readonly state: string
  readonly nonce: string
  readonly verifier: string
  readonly completion: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
  settling: boolean
}

/** A safe, stable error class for OIDC operations surfaced to the Desktop shell. */
export class EnterpriseOidcError extends Error {
  /** @param code - stable category that does not include IdP response text. */
  constructor(readonly code: 'cancelled' | 'unavailable' | 'protocol' | 'token-storage' | 'token-refresh') {
    super(`enterprise SSO: ${code}`)
    this.name = 'EnterpriseOidcError'
  }
}

/** Encrypts the refreshable token record using Electron's OS-backed storage. */
export class EnterpriseTokenVault {
  /**
   * @param directory - per-user Electron data directory.
   * @param encryption - Electron `safeStorage`.
   */
  constructor(private readonly directory: string, private readonly encryption: EnterpriseTokenEncryption) {}

  /** @returns the decrypted token set, or undefined when no session exists. */
  async read(): Promise<StoredTokenSet | undefined> {
    const path = join(this.directory, TOKEN_FILE)
    let bytes: Buffer
    try { bytes = await readFile(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new EnterpriseOidcError('token-storage')
    }
    if (!this.encryption.isEncryptionAvailable()) throw new EnterpriseOidcError('token-storage')
    try {
      const parsed: unknown = JSON.parse(this.encryption.decryptString(bytes))
      return parseStoredTokenSet(parsed)
    } catch {
      throw new EnterpriseOidcError('token-storage')
    }
  }

  /** @param value - validated OIDC token set to encrypt and atomically store. */
  async write(value: StoredTokenSet): Promise<void> {
    if (!this.encryption.isEncryptionAvailable()) throw new EnterpriseOidcError('token-storage')
    const bytes = this.encryption.encryptString(JSON.stringify(value))
    const path = join(this.directory, TOKEN_FILE)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new EnterpriseOidcError('token-storage')
    }
  }

  /** Remove the local session ciphertext. */
  async clear(): Promise<void> {
    try { await rm(join(this.directory, TOKEN_FILE), { force: true }) }
    catch { throw new EnterpriseOidcError('token-storage') }
  }
}

/** Runs one public-client OIDC flow and serves short-lived gateway tokens to the Host. */
export class EnterpriseOidcSession {
  private configuration: Promise<Configuration> | undefined
  private attempt: SignInAttempt | undefined
  private refreshing: Promise<string | undefined> | undefined
  private readonly discover: typeof discovery

  /** @param policy - administrator-owned OIDC issuer, client, scopes, and gateway resource audience. */
  constructor(
    private readonly policy: EnterpriseOidcPolicy,
    private readonly vault: EnterpriseTokenVault,
    options: { readonly discovery?: typeof discovery } = {},
  ) {
    this.discover = options.discovery ?? discovery
  }

  /**
   * Start an external-browser Authorization Code + PKCE flow.
   * @returns The URL for the system browser and a completion promise.
   */
  async startSignIn(): Promise<{ authorizeUrl: string; completion: Promise<void> }> {
    if (this.attempt !== undefined) return this.publicAttempt(this.attempt, await this.config())
    const server = createServer()
    const controller = new AbortController()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    const attempt: SignInAttempt = {
      server, controller, redirectUri: '', callbackPath: `/${randomUUID()}`,
      state: randomState(), nonce: randomNonce(), verifier: randomPKCECodeVerifier(),
      completion, resolve, reject, timer: undefined, settling: false,
    }
    this.attempt = attempt
    server.on('request', (request, response) => { void this.handleCallback(attempt, request, response) })
    try {
      await new Promise<void>((done, fail) => {
        server.once('error', fail)
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); done() })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new EnterpriseOidcError('unavailable')
      attempt.redirectUri = `http://127.0.0.1:${String(address.port)}${attempt.callbackPath}`
      attempt.timer = setTimeout(() => { void this.settle(attempt, new EnterpriseOidcError('cancelled')) }, LOGIN_DEADLINE_MS)
      const configuration = await this.config()
      const codeChallenge = await calculatePKCECodeChallenge(attempt.verifier)
      const authorizeUrl = buildAuthorizationUrl(configuration, {
        client_id: this.policy.clientId,
        redirect_uri: attempt.redirectUri,
        response_type: 'code',
        scope: this.policy.scopes.join(' '),
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        resource: this.policy.audience,
      }).href
      return { authorizeUrl, completion }
    } catch {
      await this.settle(attempt)
      throw new EnterpriseOidcError('unavailable')
    }
  }

  /** Cancel the pending browser flow without accepting a late callback. */
  async cancelSignIn(): Promise<void> {
    const attempt = this.attempt
    if (attempt !== undefined) await this.settle(attempt, new EnterpriseOidcError('cancelled'))
  }

  /**
   * Return a gateway access token, refreshing it before expiry.
   * @returns a bearer token for the approved model gateway, or undefined after sign-out.
   */
  async getAccessToken(): Promise<string | undefined> {
    const stored = await this.vault.read()
    if (stored === undefined) return undefined
    if (stored.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS) return stored.accessToken
    if (stored.refreshToken === undefined) return undefined
    this.refreshing ??= this.refresh(stored).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** Clear local credentials before attempting remote revocation. */
  async signOut(): Promise<void> {
    await this.cancelSignIn()
    await this.refreshing?.catch(() => undefined)
    const stored = await this.vault.read().catch(() => undefined)
    await this.vault.clear()
    if (stored?.refreshToken === undefined) return
    try {
      await tokenRevocation(await this.config(), stored.refreshToken, { token_type_hint: 'refresh_token' })
    } catch {
      // Local sign-out remains complete when the IdP is offline or omits revocation support.
    }
  }

  private publicAttempt(
    attempt: SignInAttempt,
    configuration: Configuration,
  ): Promise<{ authorizeUrl: string; completion: Promise<void> }> {
    const codeChallenge = calculatePKCECodeChallenge(attempt.verifier)
    return codeChallenge.then(value => ({
      authorizeUrl: buildAuthorizationUrl(configuration, {
        client_id: this.policy.clientId, redirect_uri: attempt.redirectUri, response_type: 'code',
        scope: this.policy.scopes.join(' '), state: attempt.state, nonce: attempt.nonce,
        code_challenge: value, code_challenge_method: 'S256',
        resource: this.policy.audience,
      }).href,
      completion: attempt.completion,
    }))
  }

  private async config(): Promise<Configuration> {
    this.configuration ??= this.discover(new URL(this.policy.issuer), this.policy.clientId, undefined, None()).catch(() => {
      this.configuration = undefined
      throw new EnterpriseOidcError('unavailable')
    })
    return this.configuration
  }

  private async handleCallback(attempt: SignInAttempt, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' || !isLoopbackAddress(request.socket.remoteAddress)) {
      respond(response, 400)
      return
    }
    let current: URL
    try { current = new URL(request.url ?? '/', attempt.redirectUri) }
    catch { respond(response, 400); return }
    if (current.origin !== new URL(attempt.redirectUri).origin || current.pathname !== attempt.callbackPath) {
      respond(response, 404)
      return
    }
    if (current.searchParams.get('state') !== attempt.state) {
      respond(response, 400)
      return
    }
    if (attempt.settling) { respond(response, 409); return }
    attempt.settling = true
    respond(response, 200)
    try {
      const tokens = await authorizationCodeGrant(await this.config(), current, {
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.verifier,
      }, { resource: this.policy.audience })
      if (attempt.controller.signal.aborted) throw new EnterpriseOidcError('cancelled')
      await this.vault.write(tokenSet(tokens))
      await this.settle(attempt)
    } catch {
      await this.settle(attempt, new EnterpriseOidcError('protocol'))
    }
  }

  private async refresh(stored: StoredTokenSet): Promise<string | undefined> {
    try {
      const tokens = await refreshTokenGrant(await this.config(), stored.refreshToken as string,
        { resource: this.policy.audience })
      const next = tokenSet(tokens, stored)
      await this.vault.write(next)
      return next.accessToken
    } catch {
      throw new EnterpriseOidcError('token-refresh')
    }
  }

  private async settle(attempt: SignInAttempt, error?: Error): Promise<void> {
    if (this.attempt !== attempt) return
    this.attempt = undefined
    attempt.controller.abort()
    if (attempt.timer !== undefined) clearTimeout(attempt.timer)
    if (attempt.server.listening) {
      await new Promise<void>((resolve) => {
        attempt.server.close(() => { resolve() })
        attempt.server.closeAllConnections()
      })
    }
    if (error === undefined) attempt.resolve()
    else attempt.reject(error)
  }
}

function tokenSet(tokens: TokenEndpointResponse, previous?: StoredTokenSet): StoredTokenSet {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0
    || typeof tokens.id_token !== 'string' && previous?.idToken === undefined) {
    throw new EnterpriseOidcError('protocol')
  }
  const expiresIn = tokens.expires_in
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new EnterpriseOidcError('protocol')
  }
  const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
    ? tokens.refresh_token : previous?.refreshToken
  return {
    version: 1,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(typeof tokens.id_token === 'string' ? { idToken: tokens.id_token } : previous?.idToken === undefined ? {} : { idToken: previous.idToken }),
  }
}

function parseStoredTokenSet(value: unknown): StoredTokenSet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new EnterpriseOidcError('token-storage')
  const fields = value as Record<string, unknown>
  const keys = Object.keys(fields).sort().join(',')
  if ((keys !== 'accessToken,expiresAt,version' && keys !== 'accessToken,expiresAt,idToken,version'
    && keys !== 'accessToken,expiresAt,refreshToken,version'
    && keys !== 'accessToken,expiresAt,idToken,refreshToken,version')
    || fields.version !== 1 || typeof fields.accessToken !== 'string' || fields.accessToken.length === 0
    || !Number.isSafeInteger(fields.expiresAt)
    || (fields.refreshToken !== undefined && (typeof fields.refreshToken !== 'string' || fields.refreshToken.length === 0))
    || (fields.idToken !== undefined && (typeof fields.idToken !== 'string' || fields.idToken.length === 0))) {
    throw new EnterpriseOidcError('token-storage')
  }
  return fields as unknown as StoredTokenSet
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

function respond(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" })
  response.end(statusCode === 200 ? CALLBACK_PAGE : '<!doctype html><title>Sign-in failed</title>')
}
