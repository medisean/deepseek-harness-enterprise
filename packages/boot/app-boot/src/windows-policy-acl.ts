/** Windows access-control validation for the fixed machine policy file. */
import { execFileSync } from 'node:child_process'

/** Powershell command runner used by the platform-specific ACL test. */
export type WindowsPolicyAclRunner = (command: string, args: string[], options: {
  stdio: 'ignore'
  windowsHide: true
  timeout: number
}) => void

/** Reject policy files that an ordinary user can replace or rewrite.
 * @param policyPath - Fully resolved policy file path.
 * @param run - Host command runner; tests provide a deterministic stand-in.
 */
export function assertWindowsPolicyAcl(policyPath: string, run: WindowsPolicyAclRunner = (command, args, options) => {
  execFileSync(command, args, options)
}): void {
  const pathValue = Buffer.from(policyPath, 'utf16le').toString('base64')
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${pathValue}'))
$admin = 'S-1-5-32-544'
$system = 'S-1-5-18'
$allowedOwners = @($admin, $system)
$writeRights = [int64]([Security.AccessControl.FileSystemRights]::WriteData -bor
  [Security.AccessControl.FileSystemRights]::AppendData -bor
  [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [Security.AccessControl.FileSystemRights]::CreateFiles -bor
  [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership)
$directory = [IO.Path]::GetDirectoryName($path)
foreach ($candidate in @($path, $directory)) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
  if (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) {
    $acl = [IO.Directory]::GetAccessControl($candidate)
  } else {
    $acl = [IO.File]::GetAccessControl($candidate)
  }
  $owner = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin $allowedOwners) { throw 'untrusted owner' }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($sid -in $allowedOwners) { continue }
    if (([int64]$rule.FileSystemRights -band $writeRights) -ne 0) { throw 'untrusted write access' }
  }
}
`
  try {
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true, timeout: 15_000 })
  } catch {
    throw new Error('enterprise policy: Windows policy file and directory must be writable only by Administrators or SYSTEM')
  }
}
