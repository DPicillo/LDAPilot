; LDAPilot setup (Inno Setup 7). One setup for both install modes: per user
; (default, no admin rights, %LOCALAPPDATA%\Programs\LDAPilot) and per machine
; (/ALLUSERS, C:\Program Files\LDAPilot); unattended with /VERYSILENT.
; Switches, exit codes and the detection rule: docs/installation.md.
;
; Build next to LDAPilot.exe and MicrosoftEdgeWebview2Setup.exe (the CI
; downloads Microsoft's current Evergreen bootstrapper):
;   ISCC.exe /DAppVersion=<wails.json info.productVersion> ldapilot.iss
; Signing: add /Ssigntool="<command> $f" /DSignTool=signtool.
#ifndef AppVersion
  #error Pass the version: ISCC /DAppVersion=<wails.json info.productVersion>
#endif
; The setup's identity: never change the AppId (uninstall key, detection rules).
#define UninstKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1"
; The setup of LDAPilot 0.5.0 (NSIS, per machine only), removed on upgrade.
#define OldNsisKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\David PicilloLDAPilot"
; Written by the LDAPilot MSI: one installation type per machine.
#define MsiMarkerKey "Software\LDAPilot\Installer"
; Created by LDAPilot at start-up (appmutex_windows.go).
#define Mutexes "LDAPilot.Running,Global\LDAPilot.Running"

[Setup]
AppId={{2216036E-00F6-49B8-9C8F-D331676AFF43}
AppName=LDAPilot
AppVersion={#AppVersion}
AppVerName=LDAPilot {#AppVersion}
AppPublisher=David Picillo
AppPublisherURL=https://github.com/DPicillo/LDAPilot
AppSupportURL=https://github.com/DPicillo/LDAPilot/issues
AppUpdatesURL=https://github.com/DPicillo/LDAPilot/releases
AppCopyright=Copyright © David Picillo. Licensed under the Apache License 2.0.
DefaultDirName={autopf}\LDAPilot
DisableDirPage=auto
DisableProgramGroupPage=yes
DisableWelcomePage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=out
OutputBaseFilename=LDAPilot-windows-amd64-installer
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\LDAPilot.exe
UninstallDisplayName=LDAPilot
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}.0
VersionInfoDescription=LDAPilot Setup
WizardStyle=modern dynamic
WizardSmallImageFile=wizard-small.png
WizardImageFile=wizard-large.png
ShowLanguageDialog=auto
; Interactive runs offer to close a running LDAPilot (Restart Manager, same
; session only); silent runs stop with exit code 7 instead (PrepareToInstall).
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
Compression=lzma2
SolidCompression=yes
#ifdef SignTool
SignTool={#SignTool}
#endif

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[CustomMessages]
en.StartMenuIcon=Start menu shortcut
de.StartMenuIcon=Startmenü-Verknüpfung
en.AppRunning=LDAPilot is running. Close it and run Setup again.
de.AppRunning=LDAPilot läuft. Schließen Sie LDAPilot und starten Sie Setup erneut.
en.AppRunningUninstall=LDAPilot is running. Close it and run the uninstaller again.
de.AppRunningUninstall=LDAPilot läuft. Schließen Sie LDAPilot und starten Sie die Deinstallation erneut.
en.MsiInstalled=LDAPilot is installed from its MSI package on this computer. Use the MSI to update or remove it.
de.MsiInstalled=LDAPilot ist auf diesem Computer aus dem MSI-Paket installiert. Aktualisieren oder entfernen Sie es über das MSI.
en.MachineInstalled=LDAPilot is already installed for all users of this computer.
de.MachineInstalled=LDAPilot ist auf diesem Computer bereits für alle Benutzer installiert.
en.WebView2Missing=The Microsoft Edge WebView2 Runtime is not installed and could not be installed. Install it first (offline: MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install), or run Setup with /WEBVIEW2=ignore.
de.WebView2Missing=Die Microsoft Edge WebView2 Runtime ist nicht installiert und konnte nicht installiert werden. Installieren Sie sie zuerst (ohne Internet: MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install) oder starten Sie Setup mit /WEBVIEW2=ignore.
en.OldSetupFailed=The previous LDAPilot setup in %1 could not be removed (exit code %2).
de.OldSetupFailed=Das bisherige LDAPilot-Setup in %1 konnte nicht entfernt werden (Exit-Code %2).

[Tasks]
Name: "startmenuicon"; Description: "{cm:StartMenuIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "MicrosoftEdgeWebview2Setup.exe"; Flags: dontcopy
Source: "LDAPilot.exe"; DestDir: "{app}"; Flags: ignoreversion uninsrestartdelete

[Icons]
Name: "{autoprograms}\LDAPilot"; Filename: "{app}\LDAPilot.exe"; Tasks: startmenuicon
Name: "{autodesktop}\LDAPilot"; Filename: "{app}\LDAPilot.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\LDAPilot.exe"; Description: "{cm:LaunchProgram,LDAPilot}"; Flags: postinstall nowait skipifsilent

[Code]
const
  WV2 = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

{ Version of the WebView2 runtime per Microsoft's rule: missing, empty or 0.0.0.0 = not installed. }
function WebView2Version(): String;
var
  v: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WV2, 'pv', v) and (v <> '') and (v <> '0.0.0.0') then
    Result := v
  else if RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WV2, 'pv', v) and (v <> '') and (v <> '0.0.0.0') then
    Result := v;
end;

{ Runs the bundled Evergreen bootstrapper (needs internet; per machine when elevated, else per user).
  Success is judged by the registry afterwards: Microsoft documents no exit codes. }
procedure InstallWebView2();
var
  rc: Integer;
begin
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  Log('WebView2 runtime missing; running the bootstrapper');
  if Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, rc) then
    Log(Format('WebView2 bootstrapper exit code %d', [rc]))
  else
    Log('WebView2 bootstrapper could not be started');
end;

{ Removes the NSIS setup of LDAPilot 0.5.0 before a per-machine install (_?= makes the call wait). }
function RemoveOldNsisSetup(): String;
var
  s, dir, uninst: String;
  rc: Integer;
begin
  Result := '';
  if not RegQueryStringValue(HKLM64, '{#OldNsisKey}', 'UninstallString', s) then exit;
  uninst := RemoveQuotes(s);
  dir := ExtractFileDir(uninst);
  if not IsAdminInstallMode() then begin
    Log('LDAPilot 0.5.0 (NSIS) is installed for all users in ' + dir + '; removing it needs administrator rights, it stays');
    exit;
  end;
  Log('Removing LDAPilot 0.5.0 (NSIS) from ' + dir);
  if not Exec(uninst, '/S _?=' + dir, '', SW_HIDE, ewWaitUntilTerminated, rc) or (rc <> 0) then begin
    Result := FmtMessage(CustomMessage('OldSetupFailed'), [dir, IntToStr(rc)]);
    exit;
  end;
  DeleteFile(uninst);
  RemoveDir(dir);
  RemoveDir(ExtractFileDir(dir));
  Log('LDAPilot 0.5.0 (NSIS) removed');
end;

function HasSwitch(const Name: String): Boolean;
var
  i: Integer;
begin
  Result := False;
  for i := 1 to ParamCount do
    if CompareText(ParamStr(i), Name) = 0 then Result := True;
end;

{ Exit code 7 with the reason in the log when a precondition fails. /WEBVIEW2=install (default)
  runs the bootstrapper when the runtime is missing, nodownload does not, ignore installs anyway. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  mode: String;
begin
  Result := '';
  if WizardSilent() and not HasSwitch('/CLOSEAPPLICATIONS') and CheckForMutexes('{#Mutexes}') then begin
    Result := CustomMessage('AppRunning');
    exit;
  end;
  if RegKeyExists(HKLM64, '{#MsiMarkerKey}') then begin
    Result := CustomMessage('MsiInstalled');
    exit;
  end;
  if (not IsAdminInstallMode()) and RegKeyExists(HKLM64, '{#UninstKey}') then begin
    Result := CustomMessage('MachineInstalled');
    exit;
  end;
  mode := Lowercase(ExpandConstant('{param:WEBVIEW2|install}'));
  if WebView2Version() = '' then begin
    if mode = 'install' then InstallWebView2();
    if WebView2Version() <> '' then
      Log('WebView2 runtime now installed: ' + WebView2Version())
    else if mode = 'ignore' then
      Log('WebView2 runtime not found; continuing because of /WEBVIEW2=ignore')
    else begin
      Result := CustomMessage('WebView2Missing');
      exit;
    end;
  end else
    Log('WebView2 runtime found: ' + WebView2Version());
  Result := RemoveOldNsisSetup();
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  if CheckForMutexes('{#Mutexes}') then begin
    SuppressibleMsgBox(CustomMessage('AppRunningUninstall'), mbError, MB_OK, IDOK);
    Result := False;
  end;
end;
