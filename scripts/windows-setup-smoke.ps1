<#
Smoke test of the LDAPilot setup on Windows (CI runner or a test VM), run as
an administrator:

  powershell -ExecutionPolicy Bypass -File scripts\windows-setup-smoke.ps1 `
    -Setup <LDAPilot-windows-amd64-installer.exe> -Exe <LDAPilot.exe>

-Exe is started for the "LDAPilot is running" checks. Prints one line per
check and exits 1 when one fails. Leaves the machine without LDAPilot.
#>
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Exe
)
$ErrorActionPreference = 'Stop'
$Setup = (Resolve-Path $Setup).Path
$Exe = (Resolve-Path $Exe).Path
$Version = ((Get-Item $Setup).VersionInfo.ProductVersion -split '\.')[0..2] -join '.'
$Key = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1'
$MachineDir = Join-Path $env:ProgramFiles 'LDAPilot'
$UserDir = Join-Path $env:LOCALAPPDATA 'Programs\LDAPilot'
$StartMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\LDAPilot.lnk'
$PublicDesktop = Join-Path $env:PUBLIC 'Desktop\LDAPilot.lnk'
$WebView2Key = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$Silent = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
$LogDir = Join-Path $env:TEMP 'ldapilot-smoke'
New-Item -ItemType Directory -Force $LogDir | Out-Null
$script:Failed = @()

function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  if ($Ok) { Write-Output "ok   - $Name" }
  else { Write-Output "FAIL - $Name $Detail"; $script:Failed += $Name }
}
function Run([string]$File, [string]$Arguments) {
  (Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru).ExitCode
}
function InstallArgs([string]$Mode, [string]$Log, [string]$Extra = '') {
  "$Silent $Mode $Extra /LOG=`"$(Join-Path $LogDir $Log)`""
}
function MachineVersion { (Get-ItemProperty "HKLM:\$Key" -ErrorAction SilentlyContinue).DisplayVersion }
function UserVersion { (Get-ItemProperty "HKCU:\$Key" -ErrorAction SilentlyContinue).DisplayVersion }

Write-Output "setup $Setup (version $Version)"

# 1. Per machine
$rc = Run $Setup (InstallArgs '/ALLUSERS' 'machine.log')
Check 'machine install exit 0' ($rc -eq 0) "(exit $rc)"
Check 'machine uninstall key DisplayVersion' ((MachineVersion) -eq $Version) "($(MachineVersion))"
$installed = Join-Path $MachineDir 'LDAPilot.exe'
Check 'program file installed' (Test-Path $installed)
if (Test-Path $installed) {
  Check 'program FileVersion' ((Get-Item $installed).VersionInfo.FileVersion -eq $Version) "($((Get-Item $installed).VersionInfo.FileVersion))"
}
Check 'Start menu shortcut for all users' (Test-Path $StartMenu)
Check 'no desktop shortcut by default' (-not (Test-Path $PublicDesktop))

# 2. Same version again (repair)
$rc = Run $Setup (InstallArgs '/ALLUSERS' 'repair.log')
Check 'repeat install exit 0' ($rc -eq 0) "(exit $rc)"
Check 'Start menu shortcut kept' (Test-Path $StartMenu)

# 3. LDAPilot running: silent setup and uninstall refuse. LDAPilot needs a
#    desktop for its window and exits at once without one (a service session);
#    then this script holds LDAPilot's mutexes (appmutex.go) in its place.
$proc = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 5
$held = @()
if ($proc.HasExited) {
  Write-Output "note - LDAPilot exited at once (exit $($proc.ExitCode), no desktop?); holding its mutexes instead"
  $held = 'LDAPilot.Running', 'Global\LDAPilot.Running' | ForEach-Object { New-Object System.Threading.Mutex($false, $_) }
}
try {
  $rc = Run $Setup (InstallArgs '/ALLUSERS' 'running.log')
  Check 'setup while LDAPilot runs exit 7' ($rc -eq 7) "(exit $rc)"
  $rc = Run (Join-Path $MachineDir 'unins000.exe') $Silent
  Check 'uninstall while LDAPilot runs refused' ($rc -ne 0) "(exit $rc)"
  Check 'still installed after refused uninstall' (Test-Path $installed)
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  $held | ForEach-Object { $_.Dispose() }
  Start-Sleep -Seconds 2
}

# 4. Uninstall per machine
$rc = Run (Join-Path $MachineDir 'unins000.exe') "$Silent /LOG=`"$(Join-Path $LogDir 'uninstall.log')`""
Check 'machine uninstall exit 0' ($rc -eq 0) "(exit $rc)"
Check 'program file removed' (-not (Test-Path $installed))
Check 'uninstall key removed' (-not (Test-Path "HKLM:\$Key"))
Check 'Start menu shortcut removed' (-not (Test-Path $StartMenu))

# 5. Per user
$rc = Run $Setup (InstallArgs '/CURRENTUSER' 'user.log')
Check 'user install exit 0' ($rc -eq 0) "(exit $rc)"
Check 'user uninstall key DisplayVersion' ((UserVersion) -eq $Version) "($(UserVersion))"
Check 'program file in the user profile' (Test-Path (Join-Path $UserDir 'LDAPilot.exe'))
$rc = Run (Join-Path $UserDir 'unins000.exe') $Silent
Check 'user uninstall exit 0' ($rc -eq 0) "(exit $rc)"
Check 'user uninstall key removed' (-not (Test-Path "HKCU:\$Key"))

# 6. WebView2 runtime missing, no download: exit 7, nothing installed
$pv = (Get-ItemProperty $WebView2Key -ErrorAction SilentlyContinue).pv
if ($pv) {
  try {
    Set-ItemProperty $WebView2Key -Name pv -Value '0.0.0.0'
    $rc = Run $Setup (InstallArgs '/ALLUSERS' 'webview2.log' '/WEBVIEW2=nodownload')
    Check 'WebView2 missing with /WEBVIEW2=nodownload exit 7' ($rc -eq 7) "(exit $rc)"
    Check 'nothing installed without WebView2' (-not (Test-Path "HKLM:\$Key"))
  } finally {
    Set-ItemProperty $WebView2Key -Name pv -Value $pv
  }
} else {
  Write-Output "skip - WebView2 checks (no per-machine runtime registered)"
}

if ($script:Failed.Count -gt 0) {
  Write-Output "$($script:Failed.Count) check(s) failed; logs in $LogDir"
  exit 1
}
Write-Output 'all checks passed'
