# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LDAPilot is a cross-platform LDAP browser and management GUI built with the [Wails v2](https://wails.io/) framework — a Go backend with a React/TypeScript frontend compiled into a single native binary.

## Development Commands

```bash
# Live development (hot-reload frontend + auto-recompile Go backend)
# Use -s to skip frontend build (Vite serves it via hot-reload)
wails dev -s

# On Debian 13+ where only webkit2gtk-4.1 is available:
wails dev -s -tags webkit2_41

# Production build (outputs to build/bin/)
wails build

# Cross-compile for Windows
wails build -platform windows/amd64

# Frontend only (from frontend/ directory)
cd frontend && npm install && npm run dev
```

Prerequisites: Go 1.23+, Node.js 18+, Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`).

On Debian 13+: `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev` (note: 4.1 not 4.0).

There are currently no tests in the project.

## Architecture

### Backend (Go)

The backend follows a layered architecture:

- **`main.go`** — Wails app entry point. Creates all services and binds them to the frontend via `wails.Run()`. Embeds `frontend/dist` via `//go:embed`. Frameless window with custom title bar.
- **`services/`** — Wails-bound service layer. Each `*Service` struct has exported methods callable from the frontend JS.
  - `ConnectionService` — Profile CRUD, connect/disconnect, reconnect, ping, import/export connections
  - `BrowserService` — Tree browsing, AD forest discovery via RootDSE + Partitions, GetStatistics
  - `EditorService` — Entry CRUD, attribute modifications, unicodePwd encoding
  - `SearchService` — LDAP search with paged results, filter validation
  - `ExportService` — LDIF/CSV export, LDIF import, file dialogs via Wails runtime
  - `SchemaService` — Schema discovery and caching
  - `LogService` — Operation logging with Wails event streaming
  - `AuditService` — Persistent audit log on disk
  - `AIService` — AI chat with tool-calling (search_ldap, get_entry, get_children, list_connections), multi-directory support, persistent chat history
- **`internal/ldap/`** — Core LDAP logic using `go-ldap/ldap/v3` (aliased as `goldap`).
  - `client.go` — Connection, search, CRUD, ranged attribute retrieval, referral following
  - `referral.go` — LDAP referral URL parsing and cross-server query execution
  - `pool.go` — Connection pool keyed by profile ID, `GetConnected()` for multi-directory AI
  - `schema.go` — Schema attribute/objectClass discovery
- **`internal/models/`** — Shared data types (`ConnectionProfile`, `TreeNode`, `LDAPEntry`, `SearchParams`, etc.) serialized as JSON to/from the frontend.
- **`internal/config/`** — Persistent storage:
  - `store.go` — Connection profiles (JSON + encrypted passwords)
  - `crypto.go` — AES-256-GCM encryption for passwords and API keys
  - `ai_config.go` — AI provider config (provider, URL, API key, model)
  - `chat_store.go` — Persistent chat conversations (one JSON file per chat)
  - `audit.go` — Audit log entries
  - `paths.go` — Config directory resolution (`~/.config/LDAPilot/`)
- **`internal/ldif/`** — LDIF and CSV import/export logic.

### Frontend (React + TypeScript)

- **`frontend/src/lib/wails.ts`** — Wrapper layer that calls Go services via `window.go.services.*` at runtime. All backend calls go through this file.
- **`frontend/src/stores/`** — Zustand stores: `connectionStore`, `treeStore` (multi-select, sort, locate), `editorStore` (recent entries tracking), `searchStore`, `uiStore` (zoom), `bookmarkStore`.
- **`frontend/src/types/`** — `ldap.ts` mirrors Go models, `ui.ts` defines Activity type and EditorTab.
- **`frontend/src/components/`** — React components organized by feature:
  - `layout/` — TitleBar (custom menu bar), ActivityBar, Sidebar, MainPanel (tab bar + overflow menu), BottomPanel (operations log, audit log, search results), StatusBar (connection switcher, zoom, reconnect)
  - `tree/` — DirectoryTree (virtualized with @tanstack/react-virtual, multi-select, sort, batch operations), TreeNodeRow, TreeContextMenu, StatisticsDialog
  - `editor/` — EntryEditor (attribute table + membership + LDIF viewer tabs), AttributeTable (schema tooltips, filter highlighting), MembershipPanel (members + memberOf with add/remove), CompareDialog, CopyEntryDialog, NewEntryDialog, EditEntryDialog, RenameEntryDialog, PasswordDialog (generator + strength)
  - `search/` — SearchPanel (quick + advanced), FilterBuilder, SearchResults
  - `connection/` — ConnectionManager, ConnectionCard (clone), ConnectionDialog, ServerInfo (RootDSE viewer)
  - `ai/` — AIChatPanel (chat selector, settings, markdown rendering)
  - `export/` — ExportDialog, ImportDialog
  - `schema/` — SchemaBrowser
  - `bookmarks/` — BookmarkPanel
  - `ui/` — Toast, ConfirmDialog, ErrorBoundary, KeyboardShortcutsDialog, GoToDNDialog (LDAP URL support)
- **`frontend/src/lib/`** — `wails.ts` (bindings), `utils.ts` (cn helper), `ad-constants.ts` (UAC flags, DN refs, photo attrs), `ldap-icons.ts` (icon mapping)

### Frontend-Backend Contract

Go service methods are exposed to JavaScript via Wails bindings. The frontend accesses them through `frontend/src/lib/wails.ts` which dynamically reads `window.go.services.<ServiceName>`. TypeScript types in `types/ldap.ts` must stay in sync with Go structs in `internal/models/`.

## Gotchas

- **Password/API key encryption**: Both connection passwords and AI API keys are encrypted at rest via AES-256-GCM (`internal/config/crypto.go`). Never store plaintext secrets.
- **Referral following**: `internal/ldap/referral.go` handles LDAP referral chasing. BER class constants: `ClassContext=128`, `TypeConstructed=32` (not 2/1). Referrals are extracted from the error packet, not the result.
- **AD forest discovery**: `BrowserService.GetRootEntries` reads RootDSE + `CN=Partitions,CN=Configuration,...` for all forest domains. Child domains are injected as children of their parent domain node. `filterTopLevelNCs` only removes CN-prefixed sub-partitions (not DC-prefixed child domains).
- **Virtual scrolling**: Tree uses `@tanstack/react-virtual`. The `flatRows` memo flattens the tree respecting expand/collapse state. Row height is fixed at 22px.
- **Zoom**: App uses `transform: scale()` wrapper in `App.tsx`. All dialogs use `fixed` positioning (relative to transform container per CSS spec). Context menus divide `clientX/clientY` by `zoomLevel`. Dialog sizing uses `%` not `vh`/`vw`.
- **Multi-select**: Tree store uses `selectedNodes: Set<string>` with Ctrl+Click (toggle) and Shift+Click (range via flatDNs array).
- **AI Chat**: Config stored in `~/.config/LDAPilot/ai_config.json`, chats in `~/.config/LDAPilot/chats/`. Supports LiteLLM, Ollama, OpenAI providers. Context trimming limits messages to 60k chars.
- **Bookmarks + Recent entries**: Both use `localStorage`, not the Go backend.
- **No linter/formatter configured**: No ESLint, Prettier, or golangci-lint.
- **Debian 13 / webkit2gtk-4.1**: Use build tag `webkit2_41` or set `"build:tags": "webkit2_41"` in `wails.json`.
