import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertWindowsPolicyAcl, type WindowsPolicyAclRunner } from '../src/windows-policy-acl.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-policy-acl-'))
const file = join(root, 'policy.json')

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

beforeAll(() => {
  if (process.platform !== 'win32') return
  writeFileSync(file, JSON.stringify({ version: 1, modelGateway: 'https://gateway.example.test/anthropic',
    workspaceMode: 'read-only', workspaceRoot: root }))
  try {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(import.meta.dirname, '../../../../deploy/enterprise/Secure-Policy.ps1'), '-PolicyPath', file],
    { windowsHide: true, timeout: 15_000 })
  } catch (error) {
    const diagnostic = error instanceof Error && 'stderr' in error && error.stderr instanceof Buffer
      ? error.stderr.toString('utf8').trim()
      : error instanceof Error ? error.message : String(error)
    throw new Error(`Windows policy ACL fixture setup failed: ${diagnostic}`)
  }
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

it.skipIf(process.platform !== 'win32')('accepts the administrator-owned policy provisioned by the deployment script', () => {
  let diagnostic = ''
  const run: WindowsPolicyAclRunner = (command, args, options) => {
    try {
      execFileSync(command, args, { windowsHide: options.windowsHide, timeout: options.timeout })
    } catch (error) {
      diagnostic = error instanceof Error && 'stderr' in error && error.stderr instanceof Buffer
        ? error.stderr.toString('utf8').trim()
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

it.skipIf(process.platform !== 'win32')('rejects a policy writable by Authenticated Users', () => {
  execFileSync('icacls.exe', [file, '/grant', '*S-1-5-11:(M)'], { stdio: 'ignore', windowsHide: true })
  expect(() => { assertWindowsPolicyAcl(file) }).toThrow('writable only by Administrators or SYSTEM')
})
