use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownDocument {
    path: String,
    name: String,
    content: String,
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
        .unwrap_or(false)
}

fn markdown_argument(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| is_markdown_path(path) && path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_startup_file() -> Option<String> {
    markdown_argument(std::env::args())
}

#[tauri::command]
fn read_markdown_file(app: tauri::AppHandle, path: String) -> Result<MarkdownDocument, String> {
    let requested_path = PathBuf::from(path);

    if !is_markdown_path(&requested_path) {
        return Err("Only .md and .markdown files can be opened.".to_string());
    }

    let canonical_path = requested_path
        .canonicalize()
        .map_err(|error| format!("Could not open this file: {error}"))?;

    if !canonical_path.is_file() {
        return Err("The selected path is not a file.".to_string());
    }

    if let Some(document_directory) = canonical_path.parent() {
        app.asset_protocol_scope()
            .allow_directory(document_directory, true)
            .map_err(|error| format!("Could not allow local document images: {error}"))?;
    }

    let content = std::fs::read_to_string(&canonical_path)
        .map_err(|error| format!("Could not read this file as UTF-8 text: {error}"))?;
    let content = content.trim_start_matches('\u{feff}').to_string();
    let name = canonical_path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or("Untitled.md")
        .to_string();

    Ok(MarkdownDocument {
        path: canonical_path.to_string_lossy().into_owned(),
        name,
        content,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _working_directory| {
            if let Some(path) = markdown_argument(args) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("open-file-requested", path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_startup_file,
            read_markdown_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running MD Reader");
}
