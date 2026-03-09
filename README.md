
<h1 align="center">🧭 LDAPilot</h1>

<h4 align="center">A Modern, Fast, and Cross-Platform <strong>LDAP Browser</strong> and Directory Management Tool.</h4>

<p align="center">
  <a href="#key-features">Key Features</a> •
  <a href="#ai-assistant">AI Assistant</a> •
  <a href="#why-ldapilot">Why LDAPilot?</a> •
  <a href="#installation">Installation</a> •
  <a href="#technologies">Technologies</a> •
  <a href="#development">Development</a>
</p>

---

## 🚀 Overview

**LDAPilot** is a state-of-the-art **LDAP Browser** and **Active Directory Management Tool** designed for system administrators, identity access management engineers, and developers who need a reliable, modern interface to interact with Directory Services.

Whether you are managing **Active Directory**, **OpenLDAP**, **FreeIPA**, or any other LDAP v3 compliant server, LDAPilot provides an elegant, intuitive GUI to streamline your workflow — from simple browsing to advanced multi-directory operations.

If you are looking for an open-source alternative to legacy LDAP clients (Apache Directory Studio, LDAP Admin, Softerra) with a sleek dark-mode interface, AI-powered queries, comprehensive schema browsing, and cross-platform support, **LDAPilot** is the tool for you.

## ✨ Key Features

### 🌳 Directory Tree Explorer
- **Virtualized tree rendering** — Handles directories with thousands of entries smoothly
- **Smart AD forest support** — Automatically discovers naming contexts, DNS zones, and domain partitions
- **Drag & drop** — Move entries between containers by dragging
- **Multi-select** — Ctrl+Click and Shift+Click for batch operations
- **Quick search** — Server-side LDAP search directly in the tree filter
- **Sort modes** — Alphabetical, by object type, or default server order
- **Object statistics** — Count objects by type (users, groups, OUs, computers) under any container

### 🔍 Advanced Search
- **LDAP filter builder** with syntax validation
- **Configurable result columns** — Choose which attributes to display (cn, mail, department, etc.)
- **Search history** — Access previous searches quickly
- **Saved searches** — Persist frequently used searches with localStorage
- **Scope control** — Base, one-level, or subtree searches
- **Cross-directory search** — Search across multiple connected directories simultaneously

### ✏️ Entry Management
- **Attribute editor** — Inline editing with metadata display (syntax, single/multi-valued)
- **Entry creation** — Create new entries with template support
- **Copy entries** — Duplicate entries to new locations
- **Rename/Move entries** — ModifyDN operations with drag & drop support
- **Password management** — Set passwords with strength indicator (AD unicodePwd support)
- **Membership management** — Add/remove group members with nested group viewer
- **Batch operations** — Multi-select delete, export, or copy DNs
- **Compare entries** — Side-by-side comparison of two entries

### 🤖 AI Assistant
- **Natural language queries** — Ask questions like "Find all locked users" or "Who is John's manager?"
- **Tool-calling** — AI can search LDAP, read entries, and browse trees autonomously
- **Multi-directory aware** — AI can search across all connected directories
- **Token-efficient** — Smart context management with attribute filtering and result compression
- **Rate limit handling** — Automatic retry with exponential backoff for 429/529 errors
- **Persistent conversations** — Chat history saved across sessions
- **Provider agnostic** — Works with OpenAI, Anthropic (via LiteLLM), Ollama, or any OpenAI-compatible API

### 📊 Reports & Analytics
- **Locked accounts** — Find accounts locked out due to failed login attempts
- **Disabled accounts** — List all disabled user accounts
- **Expiring passwords** — Identify users whose passwords will expire soon
- **Object statistics** — Breakdown of objects by type under any container

### 🔐 Security & Connections
- **TLS/SSL & StartTLS** — Secure connections with certificate validation or skip-verify
- **Multiple connections** — Connect to multiple directories simultaneously
- **Connection profiles** — Save and organize connection settings
- **Encrypted password storage** — AES-256-GCM encryption for saved credentials
- **Referral following** — Cross-domain referrals in AD forests
- **Connection import/export** — Share connection profiles as JSON

### 📖 Schema Browser
- Browse **object classes**, **attributes**, and their relationships
- View attribute syntax, constraints, and usage
- Cached schema for fast repeated access

### 📥 Export & Import
- **LDIF export** — Single entries or entire subtrees
- **CSV export** — Configurable columns for spreadsheet analysis
- **LDIF import** — Apply LDIF files to modify directories

### ⚡ Performance
- **Go backend** — Native LDAP operations without overhead
- **Paged results** — Handles containers with 10,000+ entries
- **Virtualized rendering** — Smooth scrolling through large trees
- **Connection pooling** — Efficient connection management across features

## 🎯 Why LDAPilot?

LDAPilot was built to fill the gap for a **Modern LDAP Client** and **Active Directory Explorer**. Traditional tools like Apache Directory Studio or LDAP Admin are powerful but can feel archaic or resource-intensive. LDAPilot combines the familiarity of a classic **Directory Services Management Tool** with modern UI paradigms.

*Keywords:* `LDAP Browser`, `Active Directory User Management`, `Modern LDAP Client`, `Open Source LDAP GUI`, `Cross-platform LDAP Tool`, `LDAP Schema Viewer`, `AD Explorer Alternative`, `React LDAP Client`, `Go LDAP Tool`, `AI LDAP Assistant`, `Active Directory Management Tool`.

## 💻 Installation

### Pre-built Binaries

Pre-compiled binaries for Windows, macOS, and Linux are available in the [Releases](https://github.com/DPicillo/LDAPilot/releases) section.

### Docker

```bash
docker compose up -d
```

### Build from Source

#### Prerequisites
- [Go 1.21+](https://golang.org/dl/)
- [Node.js 18+](https://nodejs.org/en/download/)
- [Wails CLI v2](https://wails.io/docs/gettingstarted/installation) (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`)

```bash
git clone https://github.com/DPicillo/LDAPilot.git
cd LDAPilot
wails build
```

For Linux with WebKit2GTK 4.1:
```bash
wails build -tags webkit2_41
```

## 🛠️ Technologies

LDAPilot leverages the power of the **Wails** framework, bridging a fast backend with a dynamic frontend:

| Component | Technology |
|-----------|------------|
| **Backend** | [Go](https://go.dev/) — LDAP operations, schema parsing, connection management |
| **Frontend** | [React](https://reactjs.org/) + [TypeScript](https://www.typescriptlang.org/) — Reactive UI components |
| **Styling** | [Tailwind CSS](https://tailwindcss.com/) — Dark-mode compatible design system |
| **State** | [Zustand](https://zustand-demo.pmnd.rs/) — Lightweight state management |
| **Virtualization** | [@tanstack/react-virtual](https://tanstack.com/virtual) — High-performance list rendering |
| **Icons** | [Lucide React](https://lucide.dev/) — Consistent, modern icon set |
| **Desktop** | [Wails v2](https://wails.io/) — Native desktop app without Electron overhead |
| **LDAP** | [go-ldap/ldap/v3](https://github.com/go-ldap/ldap) — Full LDAP v3 protocol support |

## 👨‍💻 Development

### Quick Start

```bash
git clone https://github.com/DPicillo/LDAPilot.git
cd LDAPilot
wails dev -s -tags webkit2_41
```

This starts a live development server with:
- **Hot-reload** for frontend changes (Vite)
- **Auto-recompile** for Go backend changes  
- **Browser access** at `http://localhost:34115`

### Project Structure

```
LDAPilot/
├── frontend/           # React + TypeScript frontend
│   ├── src/
│   │   ├── components/ # UI components (tree, editor, search, ai, ...)
│   │   ├── stores/     # Zustand state stores
│   │   ├── hooks/      # Custom React hooks
│   │   ├── lib/        # Utilities and constants
│   │   └── types/      # TypeScript type definitions
├── internal/           # Internal Go packages
│   ├── ldap/           # LDAP client, connection management
│   ├── models/         # Data models
│   └── config/         # Configuration and persistence
├── services/           # Wails-bound service layer
│   ├── browser_service.go    # Tree browsing, forest discovery
│   ├── connection_service.go # Connection management
│   ├── ai_service.go         # AI chat with tool-calling
│   ├── export_service.go     # LDIF/CSV export
│   └── schema_service.go     # Schema browsing
└── docker/             # Docker configuration
```

### Build for Production

```bash
# Linux
wails build -tags webkit2_41

# Windows
wails build -platform windows/amd64

# macOS
wails build -platform darwin/universal
```

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---
*Developed with ❤️ by [David Picillo](https://www.picillo.de)*
