/** Administrator-owned policy for the managed Desktop distribution. */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, parse, resolve, win32 } from 'node:path'
import { assertWindowsPolicyAcl } from './windows-policy-acl.ts'

/** Settings accepted by a managed Desktop process. */
export interface EnterprisePolicy {
  readonly version: 1
  readonly modelGateway: string
  readonly workspaceMode: 'read-only' | 'workspace-write'
  readonly workspaceRoot: string
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
  if (platform === 'darwin') {
    for (let current = absolute; ; current = dirname(current)) {
      const info = lstatSync(current)
      if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error(`enterprise policy: ${current} must be root-owned and not writable by users or groups`)
      }
      if (current === parse(current).root) break
    }
  }
  const value: unknown = JSON.parse(readFileSync(absolute, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('enterprise policy: expected a JSON object')
  }
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).sort().join(',') !== 'modelGateway,version,workspaceMode,workspaceRoot'
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
  return Object.freeze({ version: 1, modelGateway: gateway.href.replace(/\/$/u, ''),
    workspaceMode: fields.workspaceMode, workspaceRoot })
}
