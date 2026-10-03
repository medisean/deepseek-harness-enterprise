import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertWindowsEnterpriseHomeAcl, prepareEnterpriseHarnessHome, type EnterpriseHomeAclRunner } from '../src/enterprise-home.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-enterprise-home-'))
  roots.push(root)
  return root
}

describe('managed Desktop Harness home', () => {
  it('creates an isolated home below Electron user data and restricts POSIX permissions', { timeout: 20_000 }, () => {
    const userData = tempRoot()
    const home = prepareEnterpriseHarnessHome(userData)
    expect(home).toBe(realpathSync.native(join(userData, 'enterprise-harness-home')))
    expect(lstatSync(home).isDirectory()).toBe(true)
    expect(lstatSync(home).isSymbolicLink()).toBe(false)
    if (process.platform !== 'win32') expect(lstatSync(home).mode & 0o777).toBe(0o700)
  })

  it.skipIf(process.platform === 'win32')('rejects a managed home replaced with a symlink', () => {
    const userData = tempRoot()
    const outside = join(tempRoot(), 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(userData, 'enterprise-harness-home'), 'dir')
    expect(() => prepareEnterpriseHarnessHome(userData, 'darwin')).toThrow('real directory')
  })

  it.skipIf(process.platform === 'win32')('rejects Electron user data redirected through a symlink', () => {
    const outside = join(tempRoot(), 'outside')
    mkdirSync(outside)
    const redirected = join(tempRoot(), 'redirected-user-data')
    symlinkSync(outside, redirected, 'dir')
    expect(() => prepareEnterpriseHarnessHome(redirected, 'darwin')).toThrow('user data must be a real directory')
  })

  it('rejects a relative Electron user data path', () => {
    expect(() => prepareEnterpriseHarnessHome('relative/path', 'darwin')).toThrow('must be absolute')
  })

  it('checks Windows user data and managed home ACLs in a bounded hidden PowerShell process', () => {
    let invocation: { command: string; args: string[]; options: Parameters<EnterpriseHomeAclRunner>[2] } | undefined
    const run: EnterpriseHomeAclRunner = (command, args, options) => { invocation = { command, args, options } }
    assertWindowsEnterpriseHomeAcl('C:\\Users\\alice\\AppData\\Roaming\\Harness', 'C:\\Users\\alice\\AppData\\Roaming\\Harness\\enterprise-harness-home', run)
    expect(invocation?.command).toBe('powershell.exe')
    expect(invocation?.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(invocation?.options).toEqual({ stdio: 'ignore', windowsHide: true, timeout: 15_000 })
    const script = Buffer.from(invocation!.args.at(-1)!, 'base64').toString('utf16le')
    expect(script).toContain('WindowsIdentity]::GetCurrent().User.Value')
    expect(script).toContain('untrusted data directory access')
  })

  it('fails closed with a generic error when the Windows home ACL check fails', () => {
    const run: EnterpriseHomeAclRunner = () => { throw new Error('private host diagnostic') }
    expect(() => { assertWindowsEnterpriseHomeAcl('C:\\Users\\alice\\AppData', 'C:\\Users\\alice\\AppData\\Harness', run) })
      .toThrow('enterprise data: Windows user data and managed home must be accessible only to the current user, Administrators, or SYSTEM')
  })
})
