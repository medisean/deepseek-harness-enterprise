[CmdletBinding()]
param(
  [string]$PolicyPath = 'C:\ProgramData\DeepSeek Harness Enterprise\policy.json'
)

$ErrorActionPreference = 'Stop'
$adminsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$usersSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$writeRights = [System.Security.AccessControl.FileSystemRights]::WriteData `
  -bor [System.Security.AccessControl.FileSystemRights]::AppendData `
  -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes `
  -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes `
  -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles `
  -bor [System.Security.AccessControl.FileSystemRights]::CreateDirectories `
  -bor [System.Security.AccessControl.FileSystemRights]::Delete `
  -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles `
  -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions `
  -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole($adminsSid)) { throw 'Run this script from an elevated Administrator session.' }

$fullPath = [System.IO.Path]::GetFullPath($PolicyPath)
$directory = [System.IO.Path]::GetDirectoryName($fullPath)
if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$directoryItem = Get-Item -LiteralPath $directory -Force
if (($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Policy directory cannot be a reparse point: $directory"
}

function Set-EnterpriseAcl([string]$Path, [bool]$IsDirectory) {
  if ($IsDirectory) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit `
      -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $usersRights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    $usersRights = [System.Security.AccessControl.FileSystemRights]::Read
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($adminsSid)
  $adminRule = [System.Security.AccessControl.FileSystemAccessRule]::new($adminsSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $systemRule = [System.Security.AccessControl.FileSystemAccessRule]::new($systemSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $usersRule = [System.Security.AccessControl.FileSystemAccessRule]::new($usersSid, $usersRights,
    $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($adminRule)
  $acl.AddAccessRule($systemRule)
  $acl.AddAccessRule($usersRule)
  if ($IsDirectory) {
    [System.IO.Directory]::SetAccessControl($Path, $acl)
  } else {
    [System.IO.File]::SetAccessControl($Path, $acl)
  }
}

function Assert-EnterpriseAcl([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
    $acl = [System.IO.Directory]::GetAccessControl($Path)
  } else {
    $acl = [System.IO.File]::GetAccessControl($Path)
  }
  $owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate(
    [System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin @($adminsSid.Value, $systemSid.Value)) { throw "Policy path owner is not an administrator: $Path" }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($sid -in @($adminsSid.Value, $systemSid.Value)) { continue }
    if (([int64]$rule.FileSystemRights -band [int64]$writeRights) -ne 0) {
      throw "A non-administrator can write the policy path: $Path"
    }
  }
}

Set-EnterpriseAcl $directory $true
if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Policy file does not exist: $fullPath" }
$policyItem = Get-Item -LiteralPath $fullPath -Force
if (($policyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Policy file cannot be a reparse point: $fullPath"
}
$policy = Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json
$keys = @($policy.PSObject.Properties.Name | Sort-Object)
$keyNames = $keys -join ','
if (($keyNames -notin @(
      'modelGateway,version,workspaceMode,workspaceRoot',
      'approvedBundles,modelGateway,version,workspaceMode,workspaceRoot',
      'modelGateway,oidc,version,workspaceMode,workspaceRoot',
      'approvedBundles,modelGateway,oidc,version,workspaceMode,workspaceRoot'
    )) -or
    $policy.version -ne 1) {
  throw 'Policy must contain version, modelGateway, workspaceMode, workspaceRoot, and optional approvedBundles and oidc.'
}
if (($policy.modelGateway -isnot [string]) -or
    ($policy.workspaceRoot -isnot [string]) -or
    ($policy.workspaceMode -notin @('read-only', 'workspace-write'))) {
  throw 'Policy fields have invalid types or values.'
}
$workspace = [System.IO.Path]::GetFullPath($policy.workspaceRoot)
if (-not (Test-Path -LiteralPath $workspace -PathType Container) -or
    $workspace.TrimEnd('\') -eq [System.IO.Path]::GetPathRoot($workspace).TrimEnd('\')) {
  throw 'workspaceRoot must be an existing absolute non-root directory.'
}
$gateway = [Uri]$policy.modelGateway
if (-not $gateway.IsAbsoluteUri -or $gateway.Scheme -ne 'https' -or $gateway.UserInfo -ne '' -or
    $gateway.Query -ne '' -or $gateway.Fragment -ne '' -or $gateway.Host -in @('api.deepseek.com', 'www.deepseek.com')) {
  throw 'modelGateway must be an approved HTTPS URL without credentials, query, or fragment.'
}
if ($policy.PSObject.Properties.Name -contains 'approvedBundles') {
  $bundles = $policy.approvedBundles
  if ($bundles -isnot [array] -or $bundles.Count -gt 64) {
    throw 'approvedBundles must be an array of at most 64 exact package versions.'
  }
  $bundleNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $packageNamePattern = '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$'
  $exactSemverPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
  foreach ($bundle in $bundles) {
    if ($null -eq $bundle -or $bundle -isnot [System.Management.Automation.PSCustomObject] -or
        (@($bundle.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'name,sha256,version' -or
        $bundle.name -isnot [string] -or $bundle.name.Length -gt 214 -or
        $bundle.name -notmatch $packageNamePattern -or
        $bundle.name -in @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') -or
        $bundle.version -isnot [string] -or $bundle.version.Length -gt 128 -or
        $bundle.version -notmatch $exactSemverPattern -or
        $bundle.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not $bundleNames.Add($bundle.name)) {
      throw 'approvedBundles entries require unique non-core package names, exact semantic versions, and lowercase SHA-256 digests.'
    }
  }
}
if ($policy.PSObject.Properties.Name -contains 'oidc') {
  $oidc = $policy.oidc
  if ($null -eq $oidc -or $oidc -isnot [System.Management.Automation.PSCustomObject]) {
    throw 'oidc must be an object.'
  }
  $oidcKeys = @($oidc.PSObject.Properties.Name | Sort-Object) -join ','
  if ($oidcKeys -ne 'audience,clientId,gatewayScope,issuer,scopes' -or
      $oidc.issuer -isnot [string] -or [string]::IsNullOrWhiteSpace($oidc.issuer) -or
      $oidc.clientId -isnot [string] -or [string]::IsNullOrWhiteSpace($oidc.clientId) -or
      $oidc.gatewayScope -isnot [string] -or $oidc.gatewayScope -notmatch '^[\x21-\x7e]+$' -or
      $oidc.scopes -isnot [array] -or $oidc.scopes.Count -eq 0) {
    throw 'oidc must contain issuer, clientId, gatewayScope included in unique scopes with openid, and audience.'
  }
  $issuer = $null
  if (-not [Uri]::TryCreate($oidc.issuer, [UriKind]::Absolute, [ref]$issuer) -or
      $issuer.Scheme -ne 'https' -or $issuer.UserInfo -ne '' -or $issuer.Query -ne '' -or $issuer.Fragment -ne '') {
    throw 'oidc issuer must be an HTTPS URL without credentials, query, or fragment.'
  }
  $scopeSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($scope in $oidc.scopes) {
    if ($scope -isnot [string] -or $scope -notmatch '^[\x21-\x7e]+$' -or -not $scopeSet.Add($scope)) {
      throw 'oidc scopes must be unique printable ASCII strings.'
    }
  }
  if (-not $scopeSet.Contains('openid')) { throw "oidc scopes must include 'openid'." }
  if (-not $scopeSet.Contains($oidc.gatewayScope)) { throw 'oidc scopes must include gatewayScope.' }
  $audience = $null
  if ($oidc.audience -isnot [string] -or
      -not [Uri]::TryCreate($oidc.audience, [UriKind]::Absolute, [ref]$audience) -or
      $audience.UserInfo -ne '' -or $audience.Fragment -ne '') {
    throw 'oidc audience must be an absolute URI without credentials or fragment.'
  }
}
Set-EnterpriseAcl $fullPath $false
Assert-EnterpriseAcl $directory
Assert-EnterpriseAcl $fullPath

Write-Output "Secured enterprise policy: $fullPath"
