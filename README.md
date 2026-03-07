
<h4 align="center">A Modern, Fast, and Cross-Platform <strong>LDAP Browser</strong> and Management Tool.</h4>

<p align="center">
  <a href="#key-features">Key Features</a> •
  <a href="#why-ldapilot">Why LDAPilot?</a> •
  <a href="#installation">Installation</a> •
  <a href="#technologies">Technologies</a> •
  <a href="#development">Development</a>
</p>

---

## 🚀 Overview

**LDAPilot** is a state-of-the-art **LDAP Browser** designed for system administrators, identity access management engineers, and developers who need a reliable, modern interface to interact with Directory Services. Whether you are managing **Active Directory**, **OpenLDAP**, **FreeIPA**, or any other LDAP v3 compliant server, LDAPilot provides an elegant, intuitive GUI to streamline your workflow.

If you are looking for an open-source alternative to legacy LDAP clients with a sleek user interface, comprehensive schema browsing, robust search capabilities, and cross-platform support, LDAPilot is the tool for you.

## ✨ Key Features

- **🛡️ Secure Connections:** TLS/SSL support to secure your directory data in transit. Connect seamlessly to multiple directories.
- **🌳 Intuitive Tree Explorer:** Navigate large and complex directory trees (DIT) with an easy-to-use, responsive file-explorer-like interface.
- **🔍 Advanced LDAP Search:** Execute complex LDAP queries with ease. Filter, sort, and find the exact objects you need.
- **📖 Schema Viewer:** Browse the LDAP schema directly. View object classes, attributes, and their relationships.
- **📥 Export Data:** Export directory searches and structures effortlessly for offline analysis, auditing, or migration planning.
- **⚡ Super Fast:** Built on a lightweight Go backend with a modern React frontend, delivering native-like performance without the electron bloat.

## 🎯 Why LDAPilot? 

LDAPilot was built to fill the gap for a **Modern LDAP Client** and **Active Directory Explorer**. Traditional tools like Apache Directory Studio or LDAP Admin are powerful but can feel archaic or resource-intensive. LDAPilot combines the familiarity of a classic **Directory Services Management Tool** with modern UI paradigms.

*Keywords:* `LDAP Browser`, `Active Directory User Management`, `Modern LDAP Client`, `Open Source LDAP GUI`, `Cross-platform LDAP Tool`, `LDAP Schema Viewer`, `AD Explorer Alternative`, `React LDAP Client`, `Go LDAP Tool`.

## 💻 Installation

Currently, LDAPilot is in active development. To run it, you can build from source. Pre-compiled binaries for Windows, macOS, and Linux will be available in the [Releases](https://github.com/DPicillo/LDAPilot/releases) section soon.

### Prerequisites
- [Go 1.21+](https://golang.org/dl/)
- [Node.js 18+](https://nodejs.org/en/download/)
- [Wails CLI](https://wails.io/docs/gettingstarted/installation) (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`)

## 🛠️ Technologies

LDAPilot leverages the power of the **Wails** framework, bridging a fast backend with a dynamic frontend:

- **Backend:** [Go](https://go.dev/) (Golang) - Handles raw LDAP connections, queries, and schema parsing efficiently.
- **Frontend:** [React.js](https://reactjs.org/) + [TypeScript](https://www.typescriptlang.org/) + [Tailwind CSS](https://tailwindcss.com/) - Provides a snappy, beautiful, and dark-mode compatible user interface.
- **Icons:** [Lucide React](https://lucide.dev/)

## 👨‍💻 Development

Want to contribute or run the development server?

1. **Clone the repository:**
   ```bash
   git clone https://github.com/DPicillo/LDAPilot.git
   cd LDAPilot
   ```

2. **Run the Live Development Server:**
   ```bash
   wails dev
   ```
   This will start a Vite development server with hot-reload for your frontend changes and automatically recompile your Go backend when modified.

3. **Build for Production:**
   ```bash
   wails build
   wails build -platform windows/amd64
   ```
   This creates a native, standalone, statically linked binary in the `build/bin` directory.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---
*Developed with ❤️ by [David Picillo](https://www.picillo.de)*
