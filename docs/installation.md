# Installing LDAPilot

Every [release](https://github.com/DPicillo/LDAPilot/releases) carries these files (checksums in `SHA256SUMS.txt`). Their names never change, so `https://github.com/DPicillo/LDAPilot/releases/latest/download/<file>` always downloads the newest one.

| Platform | File | Per machine | Per user (no admin / root) | Unattended |
|---|---|---|---|---|
| Windows | `LDAPilot-windows-amd64-installer.exe` | yes (`/ALLUSERS`) | yes (default) | yes |
| Windows | `LDAPilot-windows-amd64.exe` | – | portable, nothing installed | – |
| Debian 12+, Ubuntu 22.04+ | `LDAPilot-linux-amd64.deb` | yes | – | yes |
| Fedora, openSUSE, RHEL / Rocky / Alma 10 (EPEL) | `LDAPilot-linux-amd64.rpm` | yes | – | yes |
| RHEL / Rocky / Alma 9 | `LDAPilot-linux-amd64.el9.rpm` | yes | – | yes |
| Any Linux with WebKitGTK | `LDAPilot-linux-amd64.tar.gz` | – | yes (`~/.local`) | yes |
| macOS (Apple silicon, Intel) | `LDAPilot-macos-universal.zip` | drag to Applications | drag to `~/Applications` | – |

The builds are not code-signed yet.

Settings (connection profiles, the key of the stored passwords, AI chats) are always per user: `%APPDATA%\LDAPilot`, `~/.config/LDAPilot`, `~/Library/Application Support/LDAPilot`. Installing, updating or uninstalling never touches them. LDAPilot does not update itself and sends nothing home; the installed version is the one you deployed.

## Windows

### Interactive

Run the setup. It asks whether to install **for you only** (recommended, no administrator rights, into `%LOCALAPPDATA%\Programs\LDAPilot`) or **for all users** (administrator rights, `C:\Program Files\LDAPilot`). An existing installation keeps its mode. Then: destination folder (first installation only), shortcuts (Start menu on, desktop off), install. If LDAPilot is running, the setup offers to close it. The wizard is in German or English, following Windows, in light or dark mode.

### Unattended

```bat
:: Per machine (software distribution, administrator, SYSTEM)
LDAPilot-windows-amd64-installer.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS /LOG="C:\Windows\Temp\LDAPilot-install.log"

:: Per user, without administrator rights
LDAPilot-windows-amd64-installer.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /LOG="%TEMP%\LDAPilot-install.log"

:: Update: the same command with the newer file

:: Uninstall per machine / per user
"C:\Program Files\LDAPilot\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="C:\Windows\Temp\LDAPilot-uninstall.log"
"%LOCALAPPDATA%\Programs\LDAPilot\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Always pass `/ALLUSERS` or `/CURRENTUSER`; without either the setup keeps the mode of an existing installation, else installs per user.

| Switch | Effect |
|---|---|
| `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` | No window, no questions, never a restart |
| `/ALLUSERS`, `/CURRENTUSER` | Install mode |
| `/LOG="file"` | Log file (the folder must exist); `/LOG` alone writes `Setup Log <date>.txt` to `%TEMP%` |
| `/DIR="x:\path"` | Other destination folder |
| `/MERGETASKS="desktopicon"` | Also a desktop shortcut |
| `/MERGETASKS="!startmenuicon"` | No Start menu shortcut |
| `/WEBVIEW2=nodownload` | WebView2 runtime missing: stop with exit code 7 instead of downloading it |
| `/WEBVIEW2=ignore` | Install even without the WebView2 runtime |
| `/CLOSEAPPLICATIONS` | Close a running LDAPilot (only works when it runs in the same Windows session as the setup) |

**Exit codes** of the setup:

| Code | Meaning |
|---|---|
| 0 | Installed |
| 1 | Setup could not start, e.g. `/ALLUSERS` without administrator rights, Windows older than 10 |
| 2 | Cancelled before the installation (interactive only) |
| 3, 4 | Fatal error |
| 5 | Cancelled during the installation, e.g. a file could not be replaced; nothing changed |
| 7 | Precondition not met, the reason is in the log: LDAPilot is running; the WebView2 runtime is missing and could not be installed; LDAPilot is installed for all users (when installing per user); LDAPilot is installed from its MSI |

The uninstaller returns 0 when done and non-zero otherwise (e.g. 1 while LDAPilot runs; nothing is removed then). It returns after the files are gone.

**Detection rule**: registry key `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1` (64-bit view, not `WOW6432Node`; per user the same key under `HKCU`), value `DisplayVersion` (e.g. `0.6.0`), compared as a version. Alternatively the file version of `C:\Program Files\LDAPilot\LDAPilot.exe`. The key also has `InstallLocation`, `UninstallString` and `QuietUninstallString`.

**LDAPilot running**: a silent setup stops with exit code 7 and changes nothing; the uninstaller refuses. This works across Windows sessions (setup as SYSTEM, LDAPilot in the user's session). Schedule the deployment for when LDAPilot is closed, or retry later (Intune: map 7 to "Retry"). A restart is never needed.

**WebView2 runtime**: part of Windows 11 and present on nearly all Windows 10 machines; Windows Server may lack it. If it is missing, the setup downloads and installs it with Microsoft's bootstrapper (needs internet; per machine when the setup runs elevated, else per user) and stops with 7 if that fails. Without internet, deploy the runtime first with Microsoft's offline installer (`MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install`; detection: value `pv` under `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`) and use `/WEBVIEW2=nodownload`.

**Both modes on one machine**: the per-user mode refuses (7) when LDAPilot is installed for all users. A machine-wide installation cannot see other users' per-user installations; they keep working.

**From LDAPilot 0.5.0**: a per-machine installation removes the 0.5.0 installation (`C:\Program Files\David Picillo\LDAPilot`) first; settings stay.

**Removing the user data** (optional, per user): `%APPDATA%\LDAPilot` (settings) and `%APPDATA%\LDAPilot.exe` (WebView2 data: bookmarks, history, layout).

### Software distribution

- **Intune** (Win32 app): `IntuneWinAppUtil -c <folder> -s LDAPilot-windows-amd64-installer.exe -o <output>`; install and uninstall command as above; install behaviour *System* with `/ALLUSERS` or *User* with `/CURRENTUSER`; detection rule: registry, as above; return code 7 → *Retry*. Environment variables are not expanded in the uninstall command; for per-user installs use a small script.
- **Configuration Manager** (Script Installer deployment type): commands as above, *Install for system*, *Whether or not a user is logged on*, *Hidden*; detection method: registry, as above, data type *Version*, *greater than or equal to*. Optionally enter `LDAPilot.exe` under *Install Behavior*.
- **Ivanti DSM** (eScript package): `ExecuteEx` with the command line and a return-code variable, then `ExitProcEx` "Log as failed" for anything but 0; computer-related, executed by the service; compliance condition `RegValue` on `DisplayVersion` (tick "Disable file redirection on x64 machines").

## Linux

### Packages

```sh
# Debian, Ubuntu
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ./LDAPilot-linux-amd64.deb
sudo apt-get remove -y ldapilot
dpkg-query -W -f='${Version}' ldapilot        # 0.6.0-1

# Fedora, RHEL / Rocky / Alma (10: first  dnf install -y epel-release)
sudo dnf -y install ./LDAPilot-linux-amd64.rpm         # RHEL 9: LDAPilot-linux-amd64.el9.rpm
sudo dnf -y remove ldapilot
rpm -q --qf '%{VERSION}' ldapilot               # 0.6.0

# openSUSE (the packages are not signed yet)
sudo zypper -n install --allow-unsigned-rpm ./LDAPilot-linux-amd64.rpm
sudo zypper -n remove ldapilot
```

`dnf` and `zypper` also take the download URL instead of a file. The package pulls in WebKitGTK. `apt-get` refuses an older file over a newer installation (exit code 100); `dnf` downgrades silently. A running LDAPilot keeps running with the old version until it is restarted; no restart of the machine is needed.

The packages install `/usr/bin/ldapilot`, the desktop entry `io.github.dpicillo.LDAPilot.desktop`, icons and AppStream data, so LDAPilot appears in the application menu and the dock shows its icon.

### Per user, without root

```sh
tar -xzf LDAPilot-linux-amd64.tar.gz
./LDAPilot-linux-amd64/install.sh               # into ~/.local
./LDAPilot-linux-amd64/install.sh --uninstall
```

`install.sh` picks the binary for the installed WebKitGTK (4.1, else 4.0) and exits with 0 (done), 2 (wrong usage) or 3 (WebKitGTK missing; it names the package to install).

## macOS

Unzip `LDAPilot-macos-universal.zip` and move `LDAPilot.app` to Applications (or `~/Applications` without admin rights). The app is not notarized yet: the first start is refused; open it via System Settings › Privacy & Security › Open Anyway.
