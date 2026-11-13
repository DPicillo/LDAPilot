# Installer, Etappe 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Wails NSIS setup with an Inno Setup installer (per machine and per user, unattended), ship `.deb`/`.rpm`/`.el9.rpm` and a per-user archive for Linux, with the small program changes they need, built and smoke-tested in CI.

**Architecture:** Three program changes in `package main` (Windows mutex, Linux program name = app ID, complete Windows version resource). Packaging sources live under `build/windows/setup/` and `build/linux/`; `scripts/package-linux.sh` builds all Linux artifacts with nfpm; the Windows CI job compiles the setup with `ISCC.exe` and runs `scripts/windows-setup-smoke.ps1`. The release job attaches the new files.

**Tech Stack:** Go 1.26 / Wails v2.17.0, Inno Setup 7.1.1, nfpm 2.49.0, GitHub Actions, PowerShell 5.1, POSIX sh.

**Spec:** `docs/plans/2026-11-12-installer-design.md` (sections 3.3–3.5, 3.10, 4.3–4.8, 7, 8, 9 Etappe 1; tested prototypes in appendices C and D).

## Global Constraints

- Inno `AppId` `{2216036E-00F6-49B8-9C8F-D331676AFF43}`, uninstall key `…\Uninstall\{2216036E-00F6-49B8-9C8F-D331676AFF43}_is1`; never changes.
- App ID `io.github.dpicillo.LDAPilot` (desktop entry, icons, AppStream, Wayland app ID / `ProgramName`, `StartupWMClass`); package name `ldapilot`; Linux binary `/usr/bin/ldapilot`.
- Mutex names exactly `LDAPilot.Running` and `Global\LDAPilot.Running`.
- Install dirs `{autopf}\LDAPilot` (machine) and `%LOCALAPPDATA%\Programs\LDAPilot` (user); program file stays `LDAPilot.exe`.
- Version: `wails.json` `info.productVersion` is the only source; three numeric fields.
- Release file names: `LDAPilot-windows-amd64-installer.exe` (name kept), `LDAPilot-windows-amd64.exe`, `ldapilot_<v>-1_amd64.deb`, `ldapilot-<v>-1.x86_64.rpm`, `ldapilot-<v>-1.el9.x86_64.rpm`, `LDAPilot-linux-amd64.tar.gz`, `LDAPilot-macos-universal.zip`, `SHA256SUMS.txt`. The two naked Linux binaries are no longer attached to a release.
- Release rule unchanged: only the CI run of a `v*` tag attaches files, never afterwards.
- Commits: no Claude co-author or session lines.
- Setup exit codes as documented by Inno (0 ok, 1 cannot start / no admin rights, 5 aborted, 7 precondition: running, WebView2 missing, other install type present).

## Review Focus

1. `LDAPilot.exe --mcp-relay …` (WSL relay, `mcprelay.Flag`) must exit before the mutex is created, or a relay would block every update — test in Task 1.
2. Running the same setup version twice (repair) must succeed with 0 and keep shortcuts and settings — smoke test in Task 3.
3. A machine with only WebKitGTK 4.0 (RHEL 9) gets the 4.0 binary from `install.sh` — container test in Task 2.
4. Interactive setup with LDAPilot running must offer to close it (Restart Manager) instead of failing with the silent message — VM check in Task 3.
5. A `productVersion` the MSI/packages cannot carry (pre-release suffix) must fail the packaging step loudly — check in `scripts/package-linux.sh` (Task 2) and the setup build step (Task 4).

---

### Task 1: Program changes (mutex, program name, version resource)

**Files:**
- Create: `appid.go`, `appmutex.go`, `appmutex_windows.go`, `appmutex_other.go`, `packaging_test.go`
- Modify: `main.go` (call after the relay branch; `linux.Options.ProgramName`), `build/windows/info.json`

**Interfaces:**
- Produces: `const appID = "io.github.dpicillo.LDAPilot"`; `var appMutexNames = []string{"LDAPilot.Running", `Global\LDAPilot.Running`}`; `func holdAppMutexes()` (Windows: `windows.CreateMutex(nil, false, name)` per name, handles kept for the process lifetime, errors logged and ignored; elsewhere a no-op).

- [ ] **Step 1: Write the failing tests** in `packaging_test.go`: `TestAppMutexNames` (exact slice above), `TestWindowsVersionResource` (parse `build/windows/info.json`; `fixed.product_version` and `info."0000".FileVersion` equal `{{.Info.ProductVersion}}`), `TestRelayExitsBeforeMutex` (source check: in `main.go` the `mcprelay.Flag` branch precedes `holdAppMutexes()`).
- [ ] **Step 2: Run** `go test -tags webkit2_41 -run 'TestAppMutexNames|TestWindowsVersionResource|TestRelayExitsBeforeMutex' .` — expect FAIL (undefined names, missing keys).
- [ ] **Step 3: Implement** the files and the two `main.go` edits; `info.json` gets `"product_version"` in `fixed` and `"FileVersion"` in `info."0000"`.
- [ ] **Step 4: Run** the same command — PASS; also `GOOS=windows go vet .` and `gofmt -l .` clean.
- [ ] **Step 5: Verify the built program** in the builder container (Linux binary with `-tags webkit2_41`, Windows binary via `-platform windows/amd64`): Wayland app ID `io.github.dpicillo.LDAPilot` under headless sway; X11 `WM_CLASS` instance `io.github.dpicillo.LDAPilot`. If the app ID is still `ldapilot`, add `prgname_linux.go` calling `g_set_prgname(appID)` in `init()` via cgo and re-verify. Windows: file properties show `FileVersion`/`ProductVersion` = productVersion (VM).
- [ ] **Step 6: Commit** `feat: mutex and app ID for the installers, complete Windows version resource`.

### Task 2: Linux packages and per-user archive

**Files:**
- Create: `build/linux/io.github.dpicillo.LDAPilot.desktop`, `build/linux/io.github.dpicillo.LDAPilot.metainfo.xml` (with `@VERSION@`/`@DATE@` release placeholders), `build/linux/icons/{48,64,128}.png` (from `icon.png`), `build/linux/copyright` (DEP-5, Apache-2.0 via `/usr/share/common-licenses/Apache-2.0`), `build/linux/nfpm.yaml`, `build/linux/install.sh`, `scripts/package-linux.sh`
- Modify: `packaging_test.go`

**Interfaces:**
- Consumes: `appID` (Task 1).
- Produces: `scripts/package-linux.sh <version> <binary-webkit40> <binary-webkit41> <outdir>` → the four Linux release files in `<outdir>`; needs `nfpm` on PATH; exits non-zero on a version that is not `N.N.N`. `nfpm.yaml` reads env `PKG_RELEASE`, `DEB_WEBKIT`, `RPM_WEBKIT`, `VERSION` and packages `dist/linux/stage/ldapilot`.

- [ ] **Step 1: Failing test** `TestLinuxPackagingIdentifiers` in `packaging_test.go`: desktop file name `appID+".desktop"` with `Exec=ldapilot`, `Icon=`+appID, `StartupWMClass=`+appID, `Categories=Network;`; metainfo `<id>` = appID, `<launchable type="desktop-id">` = appID+".desktop"; `nfpm.yaml` installs both under `/usr/share/applications/` and `/usr/share/metainfo/`.
- [ ] **Step 2: Run** it — FAIL.
- [ ] **Step 3: Create the files** (contents as spec appendix D, with the 4.4 lintian fixes: DEP-5 copyright, `libc6 (>= 2.34)`, nfpm changelog generated by the script from version and date; deb deps `libwebkit2gtk-4.1-0, libgtk-3-0, libc6 (>= 2.34)` / el9 `libwebkit2gtk-4.0.so.37()(64bit)`; `install.sh` exit codes 0/2/3).
- [ ] **Step 4: Run** the test — PASS; `desktop-file-validate` and `appstreamcli validate --no-net` on the generated files — no errors.
- [ ] **Step 5: Container check** with the release binaries of Task 1: build all four files; install deb on `debian:13` and `ubuntu:22.04`, rpm on `fedora:latest` and `opensuse/leap:16.0` (`--allow-unsigned-rpm`), el9 rpm on `rockylinux:9`; `install.sh` as a normal user on `debian:13` and on `rockylinux:9` (must pick the 4.0 binary); `lintian` shows no errors; GNOME Shell test from spec A.4 shows the window matched to `io.github.dpicillo.LDAPilot.desktop`.
- [ ] **Step 6: Commit** `feat: Linux packages (.deb, .rpm) and a per-user archive`.

### Task 3: Windows setup (Inno Setup)

**Files:**
- Create: `build/windows/setup/ldapilot.iss`, `build/windows/setup/wizard-small.png`, `build/windows/setup/wizard-large.png`, `scripts/windows-setup-smoke.ps1`
- Delete: `build/windows/installer/project.nsi`, `build/windows/installer/wails_tools.nsh`
- Modify: `build/README.md`, `packaging_test.go`

**Interfaces:**
- Consumes: mutex names and version resource (Task 1).
- Produces: `ISCC.exe /DAppVersion=<v> [/DSignTool=…] build\windows\setup\ldapilot.iss` with `LDAPilot.exe` and `MicrosoftEdgeWebview2Setup.exe` in `build\windows\setup\` → `build\windows\setup\out\LDAPilot-windows-amd64-installer.exe`. `scripts/windows-setup-smoke.ps1 -Setup <path> -Exe <path>` exits 0 when every check passes, else 1 with the failing check named.

- [ ] **Step 1: Failing test** `TestWindowsSetupIdentifiers`: `ldapilot.iss` contains `AppId={{2216036E-00F6-49B8-9C8F-D331676AFF43}`, the mutex define equals `strings.Join(appMutexNames, ",")`, `DefaultDirName={autopf}\LDAPilot`, `PrivilegesRequired=lowest`, `PrivilegesRequiredOverridesAllowed=dialog commandline`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Write `ldapilot.iss`** from spec appendix C plus: `WizardStyle=modern dynamic`, `ShowLanguageDialog=auto`, `WizardSmallImageFile`/`WizardImageFile` (transparent PNGs from `frontend/src/assets/logo.png`), `CloseApplications=yes` with the mutex check in `PrepareToInstall` only when `WizardSilent` and `/CLOSEAPPLICATIONS` is absent (interactive runs get Inno's close-applications page), `uninsrestartdelete` on `LDAPilot.exe`, `[Run]` "Launch LDAPilot" (`postinstall nowait skipifsilent`), `#ifdef SignTool` → `SignTool=`, German and English messages for the custom texts.
- [ ] **Step 4: Write `windows-setup-smoke.ps1`**: machine install (exit 0, key `DisplayVersion`, exe, Start-menu link, no desktop link), repeat install (0), program running → silent setup 7 and uninstall non-zero, uninstall (0, files and key gone), user install via `/CURRENTUSER` (HKCU key), `/WEBVIEW2=nodownload` with `pv` set to `0.0.0.0` (7, value restored in `finally`).
- [ ] **Step 5: Run** `TestWindowsSetupIdentifiers` — PASS; compile under Wine (ISCC 7.1.1) — exit 0.
- [ ] **Step 6: VM check** (Windows 11 VM from the spec): the smoke script passes as administrator; migration from the 0.5.0 NSIS setup; standard user `/CURRENTUSER`; interactive run with screenshots of every page in light mode, and the close-applications page while LDAPilot runs.
- [ ] **Step 7: Commit** `feat: Inno Setup installer for per-machine and per-user installs`.

### Task 4: CI and release

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `scripts/package-linux.sh`, `build/windows/setup/ldapilot.iss`, `scripts/windows-setup-smoke.ps1`.

- [ ] **Step 1: Windows build job**: drop `-nsis`; download the WebView2 bootstrapper from `https://go.microsoft.com/fwlink/p/?LinkId=2124703`, fail unless `Get-AuthenticodeSignature` is `Valid` with a Microsoft signer; install Inno Setup 7.1.1 from its GitHub release with a pinned SHA-256; compile with `/DAppVersion` from `wails.json` (fail on a non-`N.N.N` version); run the smoke script; collect `LDAPilot-windows-amd64-installer.exe`.
- [ ] **Step 2: New job `package-linux`** (needs `build`): download the two Linux build artifacts, install nfpm 2.49.0 with checksum, `desktop-file-utils`, `appstream`; run `scripts/package-linux.sh`; install the deb in `debian:13` and the rpm in `fedora:latest` containers; upload artifact `ldapilot-linux-packages`.
- [ ] **Step 3: Release job**: needs `package-linux`; upload `LDAPilot-windows-*`, `LDAPilot-macos-*`, `LDAPilot-linux-amd64.tar.gz`, `ldapilot_*`, `ldapilot-*` (not the naked Linux binaries); `SHA256SUMS.txt` over exactly these; downloads table rewritten with "for whom" (per machine, per user, software distribution).
- [ ] **Step 4: Verify** with `actionlint` if available, else a YAML parse; the shell parts of the new steps run locally against the Task 2/3 outputs.
- [ ] **Step 5: Commit** `ci: build and smoke-test the installers and Linux packages`.

### Task 5: Documentation and final verification

**Files:**
- Create: `docs/installation.md` (admin guide: Windows switches, exit codes, detection rule, uninstall, running program, WebView2, Intune / ConfigMgr / DSM entries; Linux commands, exit codes, detection; macOS current state)
- Modify: `README.md` (Installation section), `CHANGELOG.md` (`[Unreleased]` → "Installation"), `CLAUDE.md` (CI paragraph, Version paragraph with the fixed identifiers, a Gotchas bullet "Installers"), add `docs/plans/2026-11-12-installer-design.md` and this plan.

- [ ] **Step 1: Write the docs** (English, like README/CHANGELOG); command lines copied from the tested smoke script and spec 3.5 / 4.5.
- [ ] **Step 2: Full verification**: `gofmt -l`, `go vet -tags webkit2_41 ./...`, `go test -tags webkit2_41 ./...`, `scripts/lint-tokens.sh`, frontend `tsc` and node tests unchanged-green.
- [ ] **Step 3: Commit** `docs: installation guide and installer notes`.
