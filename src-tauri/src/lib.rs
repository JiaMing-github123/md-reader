use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::HashSet,
    fs::{self, ReadDir},
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownDocument {
    path: String,
    name: String,
    content: String,
}

#[derive(Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FileTreeNodeKind {
    Folder,
    File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeNode {
    name: String,
    path: String,
    kind: FileTreeNodeKind,
    children: Vec<FileTreeNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum PathKind {
    Folder,
    Markdown,
    Unsupported,
}

const IGNORED_DIRECTORIES: [&str; 4] = [".git", "node_modules", "dist", "target"];

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
        .unwrap_or(false)
}

fn is_ignored_directory(name: &str) -> bool {
    IGNORED_DIRECTORIES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

fn compare_tree_nodes(left: &FileTreeNode, right: &FileTreeNode) -> Ordering {
    let left_rank = if left.kind == FileTreeNodeKind::Folder { 0 } else { 1 };
    let right_rank = if right.kind == FileTreeNodeKind::Folder { 0 } else { 1 };

    left_rank
        .cmp(&right_rank)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        .then_with(|| left.name.cmp(&right.name))
        .then_with(|| left.path.cmp(&right.path))
}

fn scan_entries(
    entries: ReadDir,
    root: &Path,
    visited_directories: &mut HashSet<PathBuf>,
) -> Vec<FileTreeNode> {
    let mut nodes = Vec::new();

    for entry in entries.filter_map(Result::ok) {
        let entry_path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        if file_type.is_symlink() {
            continue;
        }

        let canonical_path = match entry_path.canonicalize() {
            Ok(path) if path.starts_with(root) => path,
            _ => continue,
        };

        let name = entry.file_name().to_string_lossy().into_owned();

        if file_type.is_dir() {
            if is_ignored_directory(&name)
                || !visited_directories.insert(canonical_path.clone())
            {
                continue;
            }

            let child_entries = match fs::read_dir(&canonical_path) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            let children = scan_entries(child_entries, root, visited_directories);

            // The tree only contains folders that lead to Markdown documents.
            if !children.is_empty() {
                nodes.push(FileTreeNode {
                    name,
                    path: canonical_path.to_string_lossy().into_owned(),
                    kind: FileTreeNodeKind::Folder,
                    children,
                });
            }
        } else if file_type.is_file() && is_markdown_path(&canonical_path) {
            nodes.push(FileTreeNode {
                name,
                path: canonical_path.to_string_lossy().into_owned(),
                kind: FileTreeNodeKind::File,
                children: Vec::new(),
            });
        }
    }

    nodes.sort_by(compare_tree_nodes);
    nodes
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
fn classify_path(path: String) -> PathKind {
    let requested_path = PathBuf::from(path);
    let metadata = match fs::symlink_metadata(&requested_path) {
        Ok(metadata) => metadata,
        Err(_) => return PathKind::Unsupported,
    };

    if metadata.file_type().is_symlink() {
        PathKind::Unsupported
    } else if metadata.is_dir() {
        PathKind::Folder
    } else if metadata.is_file() && is_markdown_path(&requested_path) {
        PathKind::Markdown
    } else {
        PathKind::Unsupported
    }
}

#[tauri::command]
fn scan_markdown_folder(path: String) -> Result<FileTreeNode, String> {
    let requested_path = PathBuf::from(path);
    let requested_metadata = fs::symlink_metadata(&requested_path)
        .map_err(|error| format!("Could not open this folder: {error}"))?;

    if requested_metadata.file_type().is_symlink() {
        return Err("Symbolic-link folders cannot be scanned.".to_string());
    }

    if !requested_metadata.is_dir() {
        return Err("The selected path is not a folder.".to_string());
    }

    let canonical_root = requested_path
        .canonicalize()
        .map_err(|error| format!("Could not open this folder: {error}"))?;
    let entries = fs::read_dir(&canonical_root)
        .map_err(|error| format!("Could not read this folder: {error}"))?;
    let root_name = canonical_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| canonical_root.to_string_lossy().into_owned());
    let mut visited_directories = HashSet::from([canonical_root.clone()]);
    let children = scan_entries(entries, &canonical_root, &mut visited_directories);

    Ok(FileTreeNode {
        name: root_name,
        path: canonical_root.to_string_lossy().into_owned(),
        kind: FileTreeNodeKind::Folder,
        children,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_test_folder() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("scan-test-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn scans_nested_markdown_files_in_stable_folder_first_order() {
        let root = temporary_test_folder();
        fs::create_dir_all(root.join("folderA").join("nested")).unwrap();
        fs::create_dir_all(root.join("FolderB")).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::create_dir_all(root.join("NODE_MODULES")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("folderA").join("z.md"), "# Z").unwrap();
        fs::write(root.join("folderA").join("A.markdown"), "# A").unwrap();
        fs::write(root.join("folderA").join("nested").join("deep.md"), "# Deep").unwrap();
        fs::write(root.join("FolderB").join("readme.md"), "# B").unwrap();
        fs::write(root.join("NODE_MODULES").join("hidden.md"), "# Hidden").unwrap();
        fs::write(root.join(".git").join("hidden.md"), "# Hidden").unwrap();
        fs::write(root.join("dist").join("hidden.md"), "# Hidden").unwrap();
        fs::write(root.join("target").join("hidden.md"), "# Hidden").unwrap();
        fs::write(root.join("Alpha.markdown"), "# Alpha").unwrap();
        fs::write(root.join("beta.MD"), "# Beta").unwrap();
        fs::write(root.join("notes.txt"), "not Markdown").unwrap();

        let tree = scan_markdown_folder(root.to_string_lossy().into_owned()).unwrap();
        let names: Vec<_> = tree.children.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, ["folderA", "FolderB", "Alpha.markdown", "beta.MD"]);

        let folder_a = &tree.children[0];
        let folder_a_names: Vec<_> = folder_a
            .children
            .iter()
            .map(|node| node.name.as_str())
            .collect();
        assert_eq!(folder_a_names, ["nested", "A.markdown", "z.md"]);
        assert!(tree.children.iter().all(|node| node.name != "NODE_MODULES"));
        assert!(tree.children.iter().all(|node| node.name != ".git"));
        assert!(tree.children.iter().all(|node| node.name != "dist"));
        assert!(tree.children.iter().all(|node| node.name != "target"));
        assert!(tree.children.iter().all(|node| node.name != "empty"));

        fs::remove_dir_all(root).unwrap();
    }
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
            classify_path,
            scan_markdown_folder,
            read_markdown_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running MD Reader");
}
