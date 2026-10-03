import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertWindowsPolicyAcl, type WindowsPolicyAclRunner } from '../src/windows-policy-acl.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-policy-acl-'))
const file = join(root, 'policy.json')
const securePolicyScript = join(import.meta.dirname, '../../../../deploy/enterprise/Secure-Policy.ps1')
const policy = { version: 1, modelGateway: 'https://gateway.example.test/anthropic',
  workspaceMode: 'read-only', workspaceRoot: root,
  oidc: { issuer: 'https://id.example.test/tenant', clientId: 'desktop-test',
    gatewayScope: 'model:run', scopes: ['openid', 'profile', 'offline_access', 'model:run'],
    audience: 'https://gateway.example.test/' } }

function runSecurePolicy(): void {
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', securePolicyScript, '-PolicyPath', file], { windowsHide: true, timeout: 15_000 })
}

it('runs the ACL verifier through a hidden, bounded PowerShell process', () => {
  let invocation: { command: string; args: string[]; options: Parameters<WindowsPolicyAclRunner>[2] } | undefined
  const run: WindowsPolicyAclRunner = (command, args, options) => { invocation = { command, args, options } }
  assertWindowsPolicyAcl(file, run)
  expect(invocation?.command).toBe('powershell.exe')
  expect(invocation?.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  expect(invocation?.options).toEqual({ stdio: 'ignore', windowsHide: true, timeout: 15_000 })
  const encoded = invocation?.args.at(-1)
  expect(encoded).toBeDefined()
  const script = Buffer.from(encoded!, 'base64').toString('utf16le')
  expect(script).toContain('untrusted write access')
  expect(script).toContain('reparse point')
})

it('does not expose PowerShell diagnostics when the ACL check fails', () => {
  const run: WindowsPolicyAclRunner = () => { throw new Error('private host diagnostic') }
  let message = ''
  try { assertWindowsPolicyAcl(file, run) } catch (error) { message = error instanceof Error ? error.message : String(error) }
  expect(message).toBe('enterprise policy: Windows policy file and directory must be writable only by Administrators or SYSTEM')
})

it('uses the default hidden PowerShell runner and fails closed when inspection is unavailable', () => {
  if (process.platform === 'win32') {
    expect(() => assertWindowsPolicyAcl(file)).not.toThrow()
  } else {
    expect(() => assertWindowsPolicyAcl(file)).toThrow(
      'enterprise policy: Windows policy file and directory must be writable only by Administrators or SYSTEM',
    )
  }
})

beforeAll(() => {
  if (process.platform !== 'win32') return
  writeFileSync(file, JSON.stringify(policy))
  try {
    runSecurePolicy()
  } catch (error) {
    const diagnostic = error instanceof Error && 'stderr' in error && error.stderr instanceof Buffer && error.stderr.length > 0
      ? error.stderr.toString('utf8').trim()
      : error instanceof Error && 'stdout' in error && error.stdout instanceof Buffer && error.stdout.length > 0
        ? error.stdout.toString('utf8').trim()
        : error instanceof Error ? error.message : String(error)
    throw new Error(`Windows policy ACL fixture setup failed: ${diagnostic}`)
  }
}, 30_000)
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

it.skipIf(process.platform !== 'win32')('accepts the administrator-owned policy provisioned by the deployment script', () => {
  let diagnostic = ''
  const run: WindowsPolicyAclRunner = (command, args, options) => {
    try {
      execFileSync(command, args, { windowsHide: options.windowsHide, timeout: options.timeout })
    } catch (error) {
      diagnostic = error instanceof Error && 'stderr' in error && error.stderr instanceof Buffer && error.stderr.length > 0
        ? error.stderr.toString('utf8').trim()
        : error instanceof Error && 'stdout' in error && error.stdout instanceof Buffer && error.stdout.length > 0
          ? error.stdout.toString('utf8').trim()
          : error instanceof Error ? error.message : String(error)
      throw error
    }
  }
  try {
    assertWindowsPolicyAcl(file, run)
  } catch {
    throw new Error(`Windows ACL validation rejected provisioned policy: ${diagnostic}`)
  }
})

it.skipIf(process.platform !== 'win32')('accepts OIDC policy and rejects invalid OIDC fields in the deployment script', () => {
  for (const oidc of [
    null,
    { issuer: 'http://id.example.test', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'https://gateway.example.test/' },
    { issuer: 'https://id.example.test', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['profile', 'model:run'], audience: 'https://gateway.example.test/' },
    { issuer: 'https://id.example.test', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['openid', 'openid', 'model:run'], audience: 'https://gateway.example.test/' },
    { issuer: 'https://id.example.test?tenant=1', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'https://gateway.example.test/' },
    { issuer: 'https://id.example.test', clientId: ' ', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'https://gateway.example.test/' },
    { issuer: 'https://id.example.test', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['openid', 'bad scope', 'model:run'], audience: 'https://gateway.example.test/' },
    { issuer: 'https://id.example.test', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'relative' },
    { issuer: 'https://id.example.test', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['openid', 'model:run'], audience: 'https://gateway.example.test/', unknown: true },
    { issuer: 'https://id.example.test', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['openid', 'model:run'] },
    { issuer: 'https://id.example.test', clientId: 'desktop-test', gatewayScope: 'model:run', scopes: ['openid'], audience: 'https://gateway.example.test/' },
  ]) {
    writeFileSync(file, JSON.stringify({ ...policy, oidc }))
    expect(() => { runSecurePolicy() }).toThrow()
  }
  writeFileSync(file, JSON.stringify(policy))
  expect(() => { runSecurePolicy() }).not.toThrow()
}, 30_000)

it.skipIf(process.platform !== 'win32')('accepts exact approved bundle versions and rejects unsafe entries in the deployment script', () => {
  const approvedBundles = [{ name: '@contoso/dsh-plugin', version: '2.4.1-rc.2+build.7', sha256: 'b'.repeat(64) }]
  writeFileSync(file, JSON.stringify({ ...policy, approvedBundles }))
  expect(() => { runSecurePolicy() }).not.toThrow()
  for (const invalid of [
    [{ name: '@contoso/dsh-plugin', version: '^2.4.1' }],
    [{ name: '@contoso/dsh-plugin', version: '2.4' }],
    [{ name: '@contoso/dsh-plugin', version: '2.4.1-' }],
    [{ name: '@deepseek-ai/dsh-base', version: '2.4.1' }],
    [{ name: '../plugin', version: '2.4.1' }],
    [{ name: '@contoso/dsh-plugin', version: '2.4.1', extra: true }],
    [{ name: '@contoso/dsh-plugin', version: '2.4.1', sha256: 'B'.repeat(64) }],
    [approvedBundles[0], approvedBundles[0]],
  ]) {
    writeFileSync(file, JSON.stringify({ ...policy, approvedBundles: invalid }))
    expect(() => { runSecurePolicy() }).toThrow()
  }
  writeFileSync(file, JSON.stringify(policy))
}, 30_000)

it.skipIf(process.platform !== 'win32')('rejects a policy writable by Authenticated Users', () => {
  execFileSync('icacls.exe', [file, '/grant', '*S-1-5-11:(M)'], { stdio: 'ignore', windowsHide: true })
  expect(() => { assertWindowsPolicyAcl(file) }).toThrow('writable only by Administrators or SYSTEM')
})
