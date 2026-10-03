/** Isolated, owner-only Harness data root for managed Desktop. */

import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, relative, sep } from 'node:path'

/** PowerShell runner for the managed home ACL check. */
export type EnterpriseHomeAclRunner = (command: string, args: string[], options: {
  readonly stdio: 'ignore'
  readonly windowsHide: true
  readonly timeout: number
}) => void

/**
 * Create or validate the Harness home used only by managed Desktop.
 * @param userData - Electron's per-user application data directory.
 * @param platform - operating system used to apply its directory-protection rules.
 * @returns The canonical Enterprise Harness home below `userData`.
 * @throws When the home is not a real directory inside `userData` or POSIX permissions cannot be restricted.
 */
export function prepareEnterpriseHarnessHome(userData: string, platform: NodeJS.Platform = process.platform): string {
  if (!isAbsolute(userData)) throw new Error('enterprise data: user data path must be absolute')
  mkdirSync(userData, { recursive: true })
  const rootInfo = lstatSync(userData)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('enterprise data: user data must be a real directory')
  const root = realpathSync.native(userData)
  const home = join(root, 'enterprise-harness-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const info = lstatSync(home)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('enterprise data: home must be a real directory')
  const canonicalHome = realpathSync.native(home)
  const pathFromRoot = relative(root, canonicalHome)
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error('enterprise data: home must remain inside user data')
  }
  if (platform !== 'win32') {
    chmodSync(canonicalHome, 0o700)
    if ((statSync(canonicalHome).mode & 0o777) !== 0o700) {
      throw new Error('enterprise data: home permissions must be owner-only')
    }
  } else {
    assertWindowsEnterpriseHomeAcl(root, canonicalHome)
  }
  return canonicalHome
}

/** Refuse Windows data roots readable or writable outside the current user and system administrators. */
export function assertWindowsEnterpriseHomeAcl(
  userData: string,
  home: string,
  run: EnterpriseHomeAclRunner = (command, args, options) => { execFileSync(command, args, options) },
): void {
  const values = [userData, home].map(path => Buffer.from(path, 'utf16le').toString('base64'))
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$paths = @('${values[0]}', '${values[1]}') | ForEach-Object { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($_)) }
$allowedOwners = @('S-1-5-32-544', 'S-1-5-18', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
foreach ($candidate in $paths) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($item.Attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'invalid data directory' }
  $acl = [IO.Directory]::GetAccessControl($candidate)
  $owner = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin $allowedOwners) { throw 'untrusted data directory owner' }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($sid -notin $allowedOwners) { throw 'untrusted data directory access' }
  }
}
`
  try {
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
  } catch {
    throw new Error('enterprise data: Windows user data and managed home must be accessible only to the current user, Administrators, or SYSTEM')
  }
}
