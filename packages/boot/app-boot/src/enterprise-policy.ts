/** Administrator-owned policy for the managed Desktop distribution. */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, parse, resolve, win32 } from 'node:path'
import semver from 'semver'
import { assertWindowsPolicyAcl } from './windows-policy-acl.ts'

/** Settings accepted by a managed Desktop process. */
export interface EnterprisePolicy {
  readonly version: 1
  readonly modelGateway: string
  readonly workspaceMode: 'read-only' | 'workspace-write'
  readonly workspaceRoot: string
  /** Additional plugin bundles admitted from the signed, read-only Desktop installation. */
  readonly approvedBundles?: readonly EnterpriseApprovedBundle[]
  readonly oidc?: EnterpriseOidcPolicy
}

/** Exact package identity an administrator permits in the managed Desktop composition. */
export interface EnterpriseApprovedBundle {
  /** Installed npm package name. */
  readonly name: string
  /** Exact installed semantic version; ranges and tags are rejected. */
  readonly version: string
  /** Lowercase SHA-256 digest of bundle files, directories, and resolved in-installation symlink targets. */
  readonly sha256: string
}

/** Public OIDC client configuration for managed Desktop sign-in. */
export interface EnterpriseOidcPolicy {
  readonly issuer: string
  readonly clientId: string
  /** Gateway authorization scope; the client requests it and the gateway enforces the same value. */
  readonly gatewayScope: string
  readonly scopes: readonly string[]
  readonly audience: string
}

/** Fixed machine-wide location; a profile, home directory, or environment cannot select it.
 * @param platform - Host platform.
 * @returns Fixed policy file path.
 */
export function enterprisePolicyPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/DeepSeek Harness Enterprise/policy.json'
  if (platform === 'win32') return win32.join('C:\\ProgramData', 'DeepSeek Harness Enterprise', 'policy.json')
  throw new Error('enterprise policy: managed Desktop supports macOS and Windows only')
}

/** Read a policy before any plugin mounts; macOS checks its root-owned ancestry and Windows checks its machine ACL.
 * @param path - Policy path, fixed by the launcher in production.
 * @param platform - Host platform.
 * @returns Validated immutable policy.
 */
export function loadEnterprisePolicy(path = enterprisePolicyPath(), platform: NodeJS.Platform = process.platform): EnterprisePolicy {
  const absolute = resolve(path)
  if (platform === 'win32' && absolute === resolve(enterprisePolicyPath('win32'))) {
    assertWindowsPolicyAcl(absolute)
  }
  /* v8 ignore start -- Windows Stats have no POSIX uid; the macOS ancestry guard runs on POSIX hosts. */
  if (platform === 'darwin') {
    for (let current = absolute; ; current = dirname(current)) {
      const info = lstatSync(current)
      if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error(`enterprise policy: ${current} must be root-owned and not writable by users or groups`)
      }
      if (current === parse(current).root) break
    }
  }
  /* v8 ignore stop */
  const value: unknown = JSON.parse(readFileSync(absolute, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('enterprise policy: expected a JSON object')
  }
  const fields = value as Record<string, unknown>
  const fieldNames = Object.keys(fields).sort().join(',')
  const allowedFields = new Set([
    'modelGateway,version,workspaceMode,workspaceRoot',
    'approvedBundles,modelGateway,version,workspaceMode,workspaceRoot',
    'modelGateway,oidc,version,workspaceMode,workspaceRoot',
    'approvedBundles,modelGateway,oidc,version,workspaceMode,workspaceRoot',
  ])
  if (!allowedFields.has(fieldNames)
    || fields.version !== 1 || typeof fields.modelGateway !== 'string'
    || (fields.workspaceMode !== 'read-only' && fields.workspaceMode !== 'workspace-write')
    || typeof fields.workspaceRoot !== 'string' || !isAbsolute(fields.workspaceRoot)) {
    throw new Error('enterprise policy: expected version 1, modelGateway, workspaceMode and absolute workspaceRoot')
  }
  let gateway: URL
  try { gateway = new URL(fields.modelGateway) }
  catch { throw new Error('enterprise policy: modelGateway must be an HTTPS URL') }
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash
    || gateway.hostname === 'api.deepseek.com' || gateway.hostname === 'www.deepseek.com') {
    throw new Error('enterprise policy: modelGateway must be an approved HTTPS gateway without credentials, query or fragment')
  }
  const workspaceRoot = realpathSync.native(fields.workspaceRoot)
  if (!statSync(workspaceRoot).isDirectory() || workspaceRoot === parse(workspaceRoot).root) {
    throw new Error('enterprise policy: workspaceRoot must be an existing non-root directory')
  }
  const oidc = fields.oidc === undefined ? undefined : parseOidcPolicy(fields.oidc)
  const approvedBundles = fields.approvedBundles === undefined ? undefined : parseApprovedBundles(fields.approvedBundles)
  return Object.freeze({ version: 1, modelGateway: gateway.href.replace(/\/$/u, ''),
    workspaceMode: fields.workspaceMode, workspaceRoot,
    ...(approvedBundles === undefined || approvedBundles.length === 0 ? {} : { approvedBundles }),
    ...(oidc === undefined ? {} : { oidc }) })
}

function parseApprovedBundles(value: unknown): readonly EnterpriseApprovedBundle[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error('enterprise policy: approvedBundles must be an array of at most 64 exact package versions')
  }
  const names = new Set<string>()
  const bundles = value.map((entry): EnterpriseApprovedBundle => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('enterprise policy: each approvedBundles entry must contain a package name and exact version')
    }
    const fields = entry as Record<string, unknown>
    if (Object.keys(fields).sort().join(',') !== 'name,sha256,version'
      || typeof fields.name !== 'string' || fields.name.length > 214
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(fields.name)
      || fields.name === '@deepseek-ai/dsh-base' || fields.name === '@deepseek-ai/dsh-web-app'
      || typeof fields.version !== 'string' || fields.version.length > 128
      || !/^\d/u.test(fields.version) || semver.valid(fields.version) === null
      || typeof fields.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(fields.sha256)
      || names.has(fields.name)) {
      throw new Error('enterprise policy: approvedBundles entries require unique non-core package names, exact semantic versions, and lowercase SHA-256 digests')
    }
    names.add(fields.name)
    return Object.freeze({ name: fields.name, version: fields.version, sha256: fields.sha256 })
  })
  return Object.freeze(bundles)
}

function parseOidcPolicy(value: unknown): EnterpriseOidcPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('enterprise policy: oidc must be an object')
  }
  const fields = value as Record<string, unknown>
  const keys = Object.keys(fields).sort().join(',')
  if (keys !== 'audience,clientId,gatewayScope,issuer,scopes'
    || typeof fields.issuer !== 'string' || typeof fields.clientId !== 'string' || fields.clientId.trim() === ''
    || typeof fields.gatewayScope !== 'string' || !/^[\x21-\x7e]+$/u.test(fields.gatewayScope)
    || !Array.isArray(fields.scopes) || fields.scopes.length === 0
    || fields.scopes.some(scope => typeof scope !== 'string' || !/^[\x21-\x7e]+$/u.test(scope))
    || !fields.scopes.includes('openid') || new Set(fields.scopes).size !== fields.scopes.length
    || !fields.scopes.includes(fields.gatewayScope)
    || typeof fields.audience !== 'string') {
    throw new Error('enterprise policy: oidc requires issuer, clientId, gatewayScope included in unique scopes with openid, and audience')
  }
  let issuer: URL
  try { issuer = new URL(fields.issuer) }
  catch { throw new Error('enterprise policy: oidc issuer must be an HTTPS URL') }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error('enterprise policy: oidc issuer must be an HTTPS URL without credentials, query or fragment')
  }
  let audience: string
  try {
    const parsed = new URL(fields.audience)
    if (parsed.username || parsed.password || parsed.hash) throw new Error()
    audience = parsed.href
  } catch {
    throw new Error('enterprise policy: oidc audience must be an absolute URI without credentials or fragment')
  }
  const scopes = fields.scopes as string[]
  return Object.freeze({ issuer: issuer.href.replace(/\/$/u, ''), clientId: fields.clientId.trim(),
    gatewayScope: fields.gatewayScope,
    scopes: Object.freeze([...scopes]), audience })
}
