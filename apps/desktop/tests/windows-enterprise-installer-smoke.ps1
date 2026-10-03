<# Verify the enterprise installer writes an all-user install beneath Program Files. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey, [Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$installPath = Join-Path $env:ProgramFiles ("DeepSeek Harness Enterprise Test $RegistryKey")
$appPath = Join-Path $installPath ($ProductName + '.exe')
$uninstaller = Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')
$appRegistry = 'HKLM:\Software\' + $RegistryKey
$uninstallRegistry = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey
# Composite rights overlap on read-only permission bits, so check only mutating access flags.
$writeRights = [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
try {
    $arguments = '/S /D=' + $installPath
    $setup = Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if (-not $setup.WaitForExit(60000)) { $setup.Kill(); $setup.WaitForExit(); throw 'Enterprise setup timed out' }
    if ($setup.ExitCode -ne 0) { throw "Enterprise setup returned $($setup.ExitCode)" }
    $upgrade = Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if (-not $upgrade.WaitForExit(60000)) { $upgrade.Kill(); $upgrade.WaitForExit(); throw 'Enterprise upgrade timed out' }
    if ($upgrade.ExitCode -ne 0) { throw "Enterprise upgrade returned $($upgrade.ExitCode)" }
    if (-not (Test-Path -LiteralPath $appPath) -or -not (Test-Path -LiteralPath $uninstaller)) {
        throw 'The machine-wide application payload is missing'
    }
    $application = Get-ItemProperty -LiteralPath $appRegistry
    $uninstall = Get-ItemProperty -LiteralPath $uninstallRegistry
    if ($application.InstallLocation.TrimEnd('\') -ne $installPath -or $uninstall.InstallLocation.TrimEnd('\') -ne $installPath) {
        throw 'The installer did not register the application for all users'
    }
    $acl = Get-Acl -LiteralPath $installPath
    $principals = @(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
        [Security.Principal.SecurityIdentifier]::new('S-1-5-11'),
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    )
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
        if (($principals | Where-Object { $_.Value -eq $sid.Value }) -and (($rule.FileSystemRights -band $writeRights) -ne 0)) {
            throw "The machine-wide install grants write access to $($sid.Value)"
        }
    }
    Write-Output 'PASS: silent-install-under-Program-Files'
    Write-Output 'PASS: machine-wide-HKLM-registration'
    Write-Output 'PASS: standard-user-install-directory-is-read-only'
} finally {
    if (Test-Path -LiteralPath $uninstaller) {
        $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -WindowStyle Hidden
        if (-not $remove.WaitForExit(60000)) { $remove.Kill(); $remove.WaitForExit(); throw 'Enterprise uninstall timed out' }
        if ($remove.ExitCode -ne 0) { throw "Enterprise uninstall returned $($remove.ExitCode)" }
    }
    if (Test-Path -LiteralPath $installPath) { Remove-Item -LiteralPath $installPath -Recurse -Force }
    if (Test-Path -LiteralPath $appRegistry) { Remove-Item -LiteralPath $appRegistry -Recurse -Force }
    if (Test-Path -LiteralPath $uninstallRegistry) { Remove-Item -LiteralPath $uninstallRegistry -Recurse -Force }
}
