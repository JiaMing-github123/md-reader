# MD Reader

MD Reader is a lightweight, local-first Markdown reader for Windows. It is built with Tauri, React, TypeScript, Vite, and Tailwind CSS. It has no accounts, telemetry, database, backend server, or cloud features.

## Features

- Open `.md` and `.markdown` files with the picker, drag and drop, command-line arguments, or Windows file associations.
- Render GitHub Flavored Markdown, tables, task lists, local images, and sanitized links.
- Browse an automatically generated H1–H3 table of contents.
- Search the current document with highlighted matches and next/previous controls.
- Use light, dark, or system theme and keep reader preferences locally.
- Copy syntax-highlighted code blocks and adjust reading size from the keyboard.

> Markdown content is treated as untrusted text. Raw HTML and JavaScript are not executed.

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a Markdown file |
| `Ctrl+F` | Find in the current document |
| `Ctrl++` | Increase text size |
| `Ctrl+-` | Decrease text size |
| `Ctrl+0` | Reset text size |
| `Esc` | Close search |

## Development

Install the prerequisites once:

- Node.js 20 or newer
- Rust stable with the `x86_64-pc-windows-msvc` toolchain
- Visual Studio 2022 Desktop development with C++ workload
- Microsoft Edge WebView2 Runtime (included with current Windows releases)

Then install dependencies and start the desktop app:

```powershell
npm install
npm run desktop:dev
```

Run the checks independently with:

```powershell
npm run check
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Windows build

Create the release executable and Windows installers:

```powershell
npm run desktop:build
```

Generated artifacts are placed under:

- Portable application executable: `src-tauri/target/release/md-reader.exe`
- MSI installer: `src-tauri/target/release/bundle/msi/`
- NSIS setup executable: `src-tauri/target/release/bundle/nsis/`

Installing either bundle registers `.md` and `.markdown` as supported file types. Windows may still ask which app should be the default because MD Reader does not silently replace an existing association.

## Project map

- `src/App.tsx` — application state, shortcuts, file opening, theme, window settings, and native events
- `src/components/` — toolbar, table of contents, search, empty state, Markdown view, and code blocks
- `src/components/MarkdownView.tsx` — safe Markdown rendering, links, images, tables, and code-block integration
- `src/lib/markdown.ts` — heading extraction, URL filtering, and local path resolution
- `src/lib/settings.ts` — local settings and recent-file persistence
- `src/index.css` — application and document visual styling
- `src-tauri/src/lib.rs` — validated local Markdown reads and Windows command-line/file-association handling
- `src-tauri/tauri.conf.json` — Tauri window, security, icons, file associations, and installer configuration

## Design notes

- [x] Settings remain on this computer in WebView local storage.
- [x] Only UTF-8 `.md` and `.markdown` text files are accepted.
- [x] Missing images show a readable fallback instead of breaking the document.
- [x] Recent files are capped at ten entries.
- [x] No future service or account is required to keep using the app.
