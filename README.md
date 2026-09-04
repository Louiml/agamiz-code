<div align="center">

# Agamiz Code

An experiment to create an IDE, an interesting project overall

[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-blue?style=for-the-badge)](https://github.com/Louiml/agamiz-code)
[![License](https://img.shields.io/badge/License-GNU-green?style=for-the-badge)](LICENSE)

---

#### **Core Tech Stack**

[![Tauri](https://img.shields.io/badge/tauri-%2324C8DB.svg?style=for-the-badge&logo=tauri&logoColor=black)](https://tauri.app)
[![Rust](https://img.shields.io/badge/rust-%23000000.svg?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/react-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

---

</div>

## Features

### Code Editing & Syntax Highlighting
* **Multi-language support** with fast syntax highlighting
* **CodeMirror integration** for code completion, folding, and indentation
* **Integrated terminal** for running commands, scripts, and build tasks directly within the IDE

### Workspace & File Management
* A project file tree navigation
* File search, text find/replace across entire workspace folders

---

## Getting Started

### Prerequisites
* **Node.js**: 20+
* **Rust**: 1.75+
* **OS Tools**:
  * **Windows**: Visual Studio Build Tools & WebView2
  * **Linux**: WebKitGTK & libssl

### Quickstart

```bash
# Clone repository
git clone [https://github.com/Louiml/agamiz-code.git](https://github.com/Louiml/agamiz-code.git)
cd agamiz-code

# Install dependencies
npm install

# Run web dev server
npm run dev

# Launch desktop app via Tauri
npm run tauri dev
