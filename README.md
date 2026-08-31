# MD Reader

> A private, local-first Markdown reader and editor for Windows.

MD Reader turns local `.md` and `.markdown` files into a focused reading and writing workspace. Open one document or an entire folder, navigate long notes quickly, switch to a live editing preview, and save with recovery and conflict protection.

There are no accounts, analytics, telemetry, database, sync service, or backend server. Settings and recovery drafts stay on your computer. A document can still load a remote image or open an external link when its Markdown explicitly references one.

## Download

| Windows build | Download | Best for |
| --- | --- | --- |
| Installer | **[Download MD Reader Setup](https://github.com/JiaMing-github123/md-reader/releases/latest/download/MD-Reader-Setup.exe)** | Most users; installs the app and registers Markdown file associations |
| Portable | **[Download MD Reader Portable](https://github.com/JiaMing-github123/md-reader/releases/latest/download/MD-Reader-Portable.exe)** | Run directly without an installer |

You can also browse the [release history](https://github.com/JiaMing-github123/md-reader/releases). Windows may show an unknown-publisher warning because the current builds are not code-signed.

## Highlights

### Read comfortably

- Render GitHub Flavored Markdown, tables, task lists, links, local or remote images, and syntax-highlighted code blocks.
- Navigate with an automatically generated H1–H3 table of contents and active-section tracking.
- Search the current document with highlighted matches and next/previous navigation.
- Choose light, dark, or system theme, resize the reading text, and resume from remembered scroll positions.
- Copy code blocks with one click and follow relative links to other Markdown files.

### Work across a folder

- Open a folder as a Markdown workspace and browse its nested document tree.
- Refresh, collapse, and resize the file/contents sidebar.
- Reopen recent files and restore the last document and workspace on launch.
- Open files through the picker, drag and drop, command-line arguments, relative links, or Windows file associations.

### Edit with protection

- Switch between editor-only, resizable split, and preview-only layouts.
- Save manually with `Ctrl+S` or enable Auto Save with a 2, 3, 5, or 10 second delay.
- Recover protected drafts after an interrupted session without silently overwriting the original file.
- Detect changes made by another application and choose whether to reload or explicitly overwrite them.
- Guard unsaved changes when opening another file, returning home, or closing the app.
- Write through a temporary file and replace the original only after the save is ready.

> Raw HTML and JavaScript in Markdown are sanitized and never executed. Auto Save is disabled by default and never overwrites an external-change conflict.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a Markdown file |
| `Ctrl+Shift+O` | Open a folder |
| `Ctrl+S` | Save the current document |
| `Ctrl+F` | Find in the current document |
| `F3` / `Shift+F3` | Next / previous search result |
| `Ctrl++` | Increase reading text size |
| `Ctrl+-` | Decrease reading text size |
| `Ctrl+0` | Reset reading text size |
| `Esc` | Close search or dismiss a dialog |

## Build from source

### Prerequisites

- Windows 10 or 11
- Node.js 20 or newer
- Rust stable with the `x86_64-pc-windows-msvc` toolchain
- Visual Studio 2022 with the **Desktop development with C++** workload
- Microsoft Edge WebView2 Runtime (included with current Windows releases)

Clone the repository, install dependencies, and start the desktop app:

```powershell
git clone https://github.com/JiaMing-github123/md-reader.git
cd md-reader
npm install
npm run desktop:dev
```

Run the frontend checks and Rust tests independently:

```powershell
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Create a Windows build

Build the release executable and Windows installers:

```powershell
npm run desktop:build
```

The generated artifacts are placed under:

| Artifact | Location |
| --- | --- |
| Portable executable | `src-tauri/target/release/md-reader.exe` |
| MSI installer | `src-tauri/target/release/bundle/msi/` |
| NSIS setup executable | `src-tauri/target/release/bundle/nsis/` |

The MSI and NSIS installers register `.md` and `.markdown` as supported file types. Windows may still ask which application should be the default because MD Reader does not silently replace an existing association.

## Current scope

- MD Reader currently targets Windows.
- Only existing UTF-8 `.md` and `.markdown` files can be opened and saved.
- Creating new files and **Save As** are not available yet.
- Folder workspaces ignore `.git`, `node_modules`, `dist`, `target`, and symbolic links.
- Up to 10 recent files, 50 scroll positions, and 20 protected recovery drafts are retained locally.

## Project structure

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Application state, file/folder workflows, shortcuts, saving, recovery, and native events |
| `src/components/` | Reader toolbar, sidebar, search, Markdown view, editor, preview, and dialogs |
| `src/components/MarkdownView.tsx` | Sanitized Markdown rendering, links, images, tables, and code blocks |
| `src/components/EditWorkspace.tsx` | Editor/preview layouts, resizable split, and Auto Save controls |
| `src/hooks/useDocumentSearch.ts` | In-document search and match navigation |
| `src/lib/markdown.ts` | Heading extraction, URL filtering, and local path resolution |
| `src/lib/settings.ts` | Local preferences, recent files, and scroll-position persistence |
| `src/index.css` | Application and rendered-document styling |
| `src-tauri/src/lib.rs` | Validated reads, safe writes, recovery drafts, folder scans, and Windows integration |
| `src-tauri/tauri.conf.json` | Window, security, bundle, icon, and file-association configuration |

## Tech stack

[Tauri 2](https://tauri.app/) · [React 18](https://react.dev/) · [TypeScript](https://www.typescriptlang.org/) · [Vite](https://vite.dev/) · [Tailwind CSS](https://tailwindcss.com/) · [Rust](https://www.rust-lang.org/)
