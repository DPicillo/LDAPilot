# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LDAPilot is a cross-platform LDAP browser and management GUI built with the [Wails v2](https://wails.io/) framework — a Go backend with a React/TypeScript frontend compiled into a single native binary.

## Development Commands

```bash
# Live development (hot-reload frontend + auto-recompile Go backend)
wails dev

# Production build (outputs to build/bin/)
wails build

# Cross-compile for Windows
wails build -platform windows/amd64

# Frontend only (from frontend/ directory)
cd frontend && npm install && npm run dev
```

Prerequisites: Go 1.23+, Node.js 18+, Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`).

There are currently no tests in the project.

## Architecture

### Backend (Go)

The backend follows a layered architecture:

- **`main.go`** — Wails app entry point. Creates all services and binds them to the frontend via `wails.Run()`. Embeds `frontend/dist` via `//go:embed`.
- **`services/`** — Wails-bound service layer. Each `*Service` struct has exported methods callable from the frontend JS. Services: `ConnectionService`, `BrowserService`, `EditorService`, `SearchService`, `ExportService`, `SchemaService`, `LogService`.
- **`internal/ldap/`** — Core LDAP logic using `go-ldap/ldap/v3` (aliased as `goldap`). `Client` wraps a single LDAP connection; `Pool` manages multiple concurrent connections keyed by profile ID.
- **`internal/models/`** — Shared data types (`ConnectionProfile`, `TreeNode`, `LDAPEntry`, `SearchParams`, etc.) serialized as JSON to/from the frontend.
- **`internal/config/`** — `Store` persists connection profiles to a JSON file on disk with encrypted passwords (`crypto.go`).
- **`internal/ldif/`** — LDIF and CSV import/export logic.

### Frontend (React + TypeScript)

- **`frontend/src/lib/wails.ts`** — Wrapper layer that calls Go services via `window.go.services.*` at runtime. All backend calls go through this file.
- **`frontend/src/stores/`** — Zustand stores for state management: `connectionStore`, `treeStore`, `editorStore`, `searchStore`, `uiStore`.
- **`frontend/src/types/ldap.ts`** — TypeScript interfaces that mirror the Go models. When changing Go models, update this file to match.
- **`frontend/src/components/`** — React components organized by feature: `layout/`, `tree/`, `editor/`, `search/`, `connection/`, `export/`, `schema/`, `ui/`.
- Styling: Tailwind CSS with a dark theme. UI utilities in `lib/utils.ts` (cn helper using clsx + tailwind-merge).

### Frontend-Backend Contract

Go service methods are exposed to JavaScript via Wails bindings. The frontend accesses them through `frontend/src/lib/wails.ts` which dynamically reads `window.go.services.<ServiceName>`. TypeScript types in `types/ldap.ts` must stay in sync with Go structs in `internal/models/`.
