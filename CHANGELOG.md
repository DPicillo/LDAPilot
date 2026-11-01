# Changelog

All notable changes to LDAPilot are listed here. Versions follow [Semantic Versioning](https://semver.org/); dates are UTC.

## [Unreleased]

### Build
- **CI pipeline** (GitHub Actions): tests, gofmt, the design token lint gates (`scripts/lint-tokens.sh`) and builds for Linux (WebKitGTK 4.0 and 4.1), Windows (portable exe and NSIS installer) and macOS (universal app) on every push and pull request; a pushed version tag publishes the release with all builds and checksums.

## [0.5.0] - 2026-11-01

The biggest release so far: a new design, account and password administration for Active Directory, OpenLDAP and 389 Directory Server, bulk changes with dry runs, and a rebuilt AI assistant that only writes after you approve. Every entry point (346 of them) was walked through on all three lab servers and the findings were fixed in four rounds; the open points left after that walkthrough were built and integrated before the release (see "Added after the walkthrough").

### Connections and authentication
- New bind methods: **NTLM**, **Kerberos / GSSAPI** (password or credential cache, KDC and SPN overrides; SSPI for the logged-on user on Windows) and **SASL EXTERNAL**.
- TLS trust per connection: custom **CA certificates** (also taken over from the server), client certificates, **certificate pinning** (SHA-256) and a trust prompt that shows the chain; a changed pinned certificate is called out with old and new fingerprints.
- Connection presets (AD, AD Global Catalog, OpenLDAP, 389 Directory Server, FreeIPA), a detailed **Test Connection** (server type, vendor, TLS version, identity, naming contexts), "Create and Connect".
- Password prompt when no password is stored, readable bind error hints (AD sub-codes 525, 52e, 775, …), a visible "connection lost" state with automatic reconnect, read-only profiles enforced in the backend.
- Profile import / export without secrets; `connections.json` edited outside LDAPilot is re-read instead of overwritten.
- Referrals send credentials only to trusted servers (same host and port, or the profile's own domains on standard ports); TLS profiles never follow a referral in plaintext.

### Passwords
- **Password storage policy per connection** — automatic, a fixed client-side scheme, server-side hashing, or ask — applied to every write path that touches `userPassword` (attribute table, Edit Entry, New / Copy Entry, bulk modify, LDIF import, AI). Closes #1.
- Client-side schemes `{SSHA}`, `{SSHA256}`, `{SSHA512}`, `{PBKDF2-SHA256}`, `{PBKDF2-SHA512}`, `{ARGON2}`, `{CRYPT}` SHA-256 / SHA-512-crypt and bcrypt; already hashed values are recognised and kept, unknown `{…}` prefixes are treated as cleartext.
- **RFC 3062 Password Modify**, AD `unicodePwd` resets with "must change at next logon" and unlock in the same request; cleartext passwords over an unencrypted connection need a confirmation (`unicodePwd` never goes over plain LDAP).
- The stored value is read back after every write: cleartext values and hashes the server cannot verify are reported with "Remove Value" / "Reset Password…".
- Reset Password dialog with generator, strength meter aware of account names and the password policy, and the account options.

### Accounts
- Account status for AD (userAccountControl, computed lockout, fine-grained password policies), OpenLDAP ppolicy and 389DS (nsAccountLock, roles, lockout).
- Actions: unlock, enable / disable, must change password, password never expires, account expiry, userAccountControl flag editor with a warning for weakening changes; disabled OpenLDAP accounts stay disabled across password changes.
- Account tab per entry, status chips in tree, results, lists and tabs.
- Reports: locked-out users, disabled accounts, expiring / expired passwords, never logged on, users without e-mail, password never expires / not required, admin accounts, privileged group members (nested), empty groups, POSIX users and groups, computers.

### Directory content
- **Effective group membership** in both directions with depth, "via" paths, cycle detection and the AD primary group; Add to Group… for one or many entries.
- **AD Deleted Objects**: restore and restore to, with the attributes and memberships a tombstone lost.
- **Recursive delete** with descendant count (tree delete control, or client-side with progress and stop) and typed confirmation for naming contexts and large deletes.
- **Bulk modify** with value templates and a **dry run** (before → after per entry), progress, stop and retry; **LDIF change files** (RFC 2849) with the same dry run, AD uniqueness checks, rebasing into another container and a run report.
- All AD naming contexts as tree roots (forest domains, DNS zones, **Configuration**, **Schema**); naming contexts on OpenLDAP and 389DS.
- Binary values: photo preview and upload, **X.509** and **PKCS #7** decoding, hex dump, save / upload from file; values round-trip losslessly through edit, LDIF and CSV.
- New Entry templates per server type, account-safe Copy Entry, Move with a container picker, drag and drop with confirmation and Undo.
- Importable LDIF / CSV export of an entry, a selection, one level or a subtree.
- Audit log with old → new values, history of an entry across renames, secrets masked.

### Search
- Quick search by name and object type (users, contacts, groups, computers, OUs per server family), advanced search with a live-validated filter and a filter builder that round-trips with the filter text.
- AD controls (Show Deleted, Show Recycled) and ManageDsaIT only where supported; paged results with size limit and "Load all".
- History, saved searches and result columns per connection; CSV / TSV / LDIF of the visible table.

### Design and keyboard
- New design system with a **light and a dark theme** (or follow the system), compact density and zoom.
- **Command palette** (`Ctrl+K`) for entries, commands, DNs and LDAP URLs; every menu and shortcut comes from one command registry (`Ctrl+/` lists them).
- Preview tabs, Back / Forward, editable breadcrumb, Contents list per container, unsaved edits kept per tab and guarded on close and quit.
- Toasts with Undo and a notification bell; no toasts for plain reads.

### AI assistant
- New harness: OpenAI-compatible providers (OpenAI, LiteLLM, vLLM, LM Studio, Ollama `/v1`), native **Ollama**, **Anthropic**, and the **Claude Code headless engine** (`claude -p` with a private, per-run MCP server).
- **Model auto-detection** (context window, tool support), a provider check before each run with clear "unreachable" errors.
- Safety enforced in the backend: per-connection access none / ask / read / write, an **approval** with exact diff and decoded values for every change, read-only profiles always refuse, writes audited "via AI".
- Privacy: secret attributes never read, a redaction list, passwords typed into the chat are never sent, generated passwords shown only to you, chats stored encrypted.
- "Ask AI about …" from every entry menu (also for results of another connection), DN links with Show in Tree, the chat docked to the side bar or to the right of the editor.

### Fixes from the UX walkthrough
- The walkthrough of 346 entry points found 214 issues (none critical, 44 with a broken or misleading function); they were fixed as 118 consolidated items, followed by three re-walks with fix rounds. Among the last fixes: the bind password field gets focus on "Edit…" of a refused bind, renames and moves keep unsaved drafts, 389DS lockouts and "must change" show in search results, saved quick searches without a filter on this server are not run, Show History no longer leaves another connection's audit log filtered, and "Reload" of the AI settings no longer undoes an access grant made in a chat.
- Workflow click counts went down, e.g. creating an AD user with password and group from 21 to 10 interactions, a bulk change with dry run from 11 to 10, "what changed today" from 3 to 2.

### Build and development
- Go 1.26, Wails 2.17, React 19, Vite 8, TypeScript 7, Tailwind CSS 4; Node.js 22.12+ (frontend tests 22.18+).
- `scripts/build.sh` stamps version, commit and build date (Help ▸ About, Copy diagnostics, Report Issue); the version is declared in `wails.json`, `frontend/package.json` and `services.ReleaseVersion`.
- Docker test lab with OpenLDAP, 389 Directory Server and a Samba AD DC, all seeded with edge cases.
- Go unit tests, node tests for the frontend logic and the AI chat, an event contract test between Go and TypeScript.

### Added after the walkthrough

#### Connections
- **Ask for the password on every connect** per connection: nothing is stored, the typed password is used for that connection only; Test Connection asks too. Exports keep the setting, imports list such profiles separately.
- The Connections list supports **multi-selection** (Ctrl / Shift, Ctrl+A): delete or export several connections at once with one confirmation that names them.
- **Export Connections…** opens a checklist of the profiles to export.
- Pinned certificates show subject, issuer and expiry ("Refresh details from the server" for older pins); the "certificate changed" prompt shows the old certificate's details.
- The CA certificate file and pasted PEM text are checked while you type; for Kerberos with an IP address or alias the dialog looks up the server's name and offers the SPN `ldap/<name>` (also after a failed Kerberos test).
- The side bar panel and the bottom panel are restored after a restart; a new logo that reads on the dark and the light theme.

#### Entries
- **Edit as LDIF…**: edit a whole entry as LDIF text, with a dry run that re-reads the entry and shows exactly what will be sent (rename included, password storage policy applied, concurrent server changes flagged), then one atomic modify.
- Certificate cards show the purpose, alternative names (UPN, e-mail, DNS), expiry warnings and, in the details, key usage, AD CS template, the strong-mapping SID, CRL / OCSP URLs and policies; cards and photos fit narrow editor widths.
- Entries with several photos or certificates ask which value to save, replace or remove (also Download Photo… / Download Certificate… and Upload Photo…).
- New User on OpenLDAP and 389 Directory Server offers "User must change password at next logon" according to the server's password policy; AD entries are created with the server's DN spelling.
- Schema aliases (e.g. `rfc822Mailbox` for `mail`, `userid` for `uid`) are understood everywhere: required-attribute checks, Edit Entry, New Entry, the schema browser and its tabs.
- Reset Password: **Generate** also copies the new password to the clipboard (with a short confirmation).

#### Search, reports and bulk changes
- **Open Results as Tab** keeps a snapshot of the results in its own tab (own selection, sort, columns, Run Again / Cancel, export and bulk actions) while the bottom panel stays live.
- **Every report runs into its own tab**, re-used when it runs again; the search panel's results are left alone. Account actions from a report row update the row without running the report again.
- One **Columns** chooser in the results toolbar (show / hide, reorder, add and remove attribute columns).
- **Open in List** after an LDIF import or a batch modify shows the created and changed entries; "Recent LDIF changes" groups the audit rows by import run.
- **One move flow** for Move… and the batch dialog's Move tab: a dry run as the confirmation ("2 will move · 1 already there · 1 will fail"), progress, retry — and **Undo** like a drag-and-drop move.
- Ctrl+Enter starts the advanced search from every field; results emptied by deletions say so instead of "No entries found".

#### Navigation and keyboard
- **Undo** (Edit ▸ Undo, Ctrl+Z, the toast and the notification bell) for moves and removed bookmarks.
- **Bookmarks** follow their entry by its server id (objectGUID / nsUniqueId / entryUUID) after renames and moves made elsewhere, can be renamed (F2) and reordered (Alt+↑ / Alt+↓, drag); the welcome screen uses the same names and order.
- Menus support type-ahead; the palette names hits like their tabs, preselects the entry's main account action on Tab and runs it with Shift+Enter.
- The delete confirmation lists the first entries below each deleted container; the tree's selection toolbar offers "Add n Entries to Group…"; an OpenLDAP suffix shows as a domain.

#### AI assistant
- Stop / Esc also cancel the provider check and a run that is still contacting the provider; the message is kept.
- DN links in answers resolve to the DN the tools returned (also with copied JSON escaping); chat titles describe the topic and are refined once.
- Docked to the right on a small window, the chat and then the side bar shrink to their minimum widths before the editor does (the saved widths come back on a wider window), and toasts stay left of the chat.

#### Under the hood
- Account policies (OpenLDAP ppolicy, 389DS, AD domain policy / PSOs) are cached per connection for a minute and dropped on every write that touches them; the Reset Password dialog reads the entry once.
- Result views that show the same entry share one read after an account action or a rename.

#### Last leftovers
- **Statistics can be stopped**: Stop while counting (and closing the dialog) cancels the search on the server; a stopped count shows no numbers and offers Count Again; a count that hit the 50,000-entry limit is marked as a lower bound.
- **One "send the password unencrypted?" confirmation** everywhere — Reset Password, password edits in the attribute table / Edit Entry / New and Copy Entry / bulk modify / LDIF import, and the AI approval card: the same consent box, Cancel first, Continue only after ticking it. The connect prompt of a plain-LDAP simple bind says that the password crosses the network in cleartext. unicodePwd over plain LDAP stays refused.
- The batch dialog's **Move tab closes after a fully successful move** like Move… does (same toast with Undo); with a failure it keeps the result and "Retry".
- While an entry tab's connection is lost, the editor header's main button is **Reconnect**; afterwards the account action returns and the keyboard focus goes to the breadcrumb.
- New **app icons** (taskbar, dock, installer, Linux window icon) from the new logo, readable on light and dark backgrounds.
- Linux native window: **Ctrl+Shift+Tab** (previous tab), Shift+Tab in dialogs and in the palette work again (WebKitGTK reported Shift+Tab as an unknown key).
- Automatic reconnect no longer gives up with "the server rejected the credentials" when the server only dropped the connection during the bind (a restart, a proxy without a backend); it keeps retrying.
- F5 or expanding a container in the tree while the connection is lost no longer adds a "Failed to expand …" error toast; the connection banner and the status bar already say the connection is lost.
- Clean-ups: the old live "Search Results" tab code is gone (an old tab of that kind shows a note instead of an empty editor), Go sources are gofmt-clean.

### Known issues
- macOS is not built or tested for this release (no Mac build host yet); Windows (amd64) and Linux (amd64) binaries are attached.
- The Linux binary is built against WebKitGTK 4.0 (`libwebkit2gtk-4.0-37`); on Debian 13+ / distributions with only WebKitGTK 4.1 build from source with `-tags webkit2_41`.
- Windows needs the Microsoft Edge WebView2 runtime (preinstalled on Windows 10/11).

Earlier versions: see the [GitHub releases](https://github.com/DPicillo/LDAPilot/releases).

[0.5.0]: https://github.com/DPicillo/LDAPilot/compare/v0.4...v0.5.0
