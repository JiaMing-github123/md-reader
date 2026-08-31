use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::HashSet,
    fs::{self, File, OpenOptions, ReadDir},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum WriteErrorKind {
    Conflict,
    PermissionDenied,
    FileMissing,
    InvalidExtension,
    WriteFailure,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteMarkdownError {
    kind: WriteErrorKind,
    message: String,
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

fn write_error(kind: WriteErrorKind, message: impl Into<String>) -> WriteMarkdownError {
    WriteMarkdownError {
        kind,
        message: message.into(),
    }
}

fn io_write_error(error: io::Error, context: &str) -> WriteMarkdownError {
    let kind = match error.kind() {
        io::ErrorKind::PermissionDenied => WriteErrorKind::PermissionDenied,
        io::ErrorKind::NotFound => WriteErrorKind::FileMissing,
        _ => WriteErrorKind::WriteFailure,
    };
    write_error(kind, format!("{context}: {error}"))
}

fn normalized_utf8_content(path: &Path) -> io::Result<String> {
    fs::read_to_string(path).map(|content| content.trim_start_matches('\u{feff}').to_string())
}

fn markdown_document_from_path(path: &Path, content: String) -> MarkdownDocument {
    let name = path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or("Untitled.md")
        .to_string();

    MarkdownDocument {
        path: path.to_string_lossy().into_owned(),
        name,
        content,
    }
}

fn create_temporary_file(target: &Path) -> Result<(PathBuf, File), WriteMarkdownError> {
    let parent = target.parent().ok_or_else(|| {
        write_error(
            WriteErrorKind::WriteFailure,
            "The Markdown file has no parent directory.",
        )
    })?;
    let filename = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.md");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for attempt in 0..64_u8 {
        let temporary_path = parent.join(format!(
            ".{filename}.md-reader-{}-{nonce}-{attempt}.tmp",
            std::process::id()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => return Ok((temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(io_write_error(
                    error,
                    "Could not create a temporary file beside the Markdown file",
                ));
            }
        }
    }

    Err(write_error(
        WriteErrorKind::WriteFailure,
        "Could not create a unique temporary file beside the Markdown file.",
    ))
}

#[cfg(windows)]
fn replace_file(temporary_path: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }

    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let temporary_wide: Vec<u16> = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            ptr::null(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };

    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(temporary_path: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temporary_path, target)
}

fn write_markdown_file_impl(
    path: &str,
    content: &str,
    expected_content: &str,
    overwrite_conflict: bool,
) -> Result<MarkdownDocument, WriteMarkdownError> {
    let requested_path = PathBuf::from(path);
    if !is_markdown_path(&requested_path) {
        return Err(write_error(
            WriteErrorKind::InvalidExtension,
            "Only .md and .markdown files can be saved.",
        ));
    }

    let canonical_path = requested_path.canonicalize().map_err(|error| {
        io_write_error(error, "Could not resolve the Markdown file before saving")
    })?;
    let metadata = fs::metadata(&canonical_path)
        .map_err(|error| io_write_error(error, "Could not inspect the Markdown file"))?;
    if !metadata.is_file() {
        return Err(write_error(
            WriteErrorKind::FileMissing,
            "The selected Markdown path is not an existing ordinary file.",
        ));
    }

    let current_content = normalized_utf8_content(&canonical_path).map_err(|error| {
        io_write_error(error, "Could not read the Markdown file before saving")
    })?;
    if !overwrite_conflict && current_content != expected_content {
        return Err(write_error(
            WriteErrorKind::Conflict,
            "The file changed on disk after it was opened. Reload it or explicitly overwrite it.",
        ));
    }

    let (temporary_path, mut temporary_file) = create_temporary_file(&canonical_path)?;
    let write_result = temporary_file
        .write_all(content.as_bytes())
        .and_then(|_| temporary_file.sync_all());
    drop(temporary_file);

    if let Err(error) = write_result {
        let cleanup = fs::remove_file(&temporary_path);
        let cleanup_note = cleanup
            .err()
            .map(|cleanup_error| {
                format!(
                    " The incomplete temporary file remains at {} because cleanup failed: {cleanup_error}",
                    temporary_path.to_string_lossy()
                )
            })
            .unwrap_or_default();
        let mut save_error = io_write_error(error, "Could not write the temporary Markdown file");
        save_error.message.push_str(&cleanup_note);
        return Err(save_error);
    }

    if !overwrite_conflict {
        match normalized_utf8_content(&canonical_path) {
            Ok(latest_content) if latest_content != expected_content => {
                let _ = fs::remove_file(&temporary_path);
                return Err(write_error(
                    WriteErrorKind::Conflict,
                    "The file changed on disk while the save was being prepared. The original file was left unchanged.",
                ));
            }
            Ok(_) => {}
            Err(error) => {
                let cleanup = fs::remove_file(&temporary_path);
                let cleanup_note = cleanup
                    .err()
                    .map(|cleanup_error| {
                        format!(
                            " The complete temporary draft remains at {} because cleanup failed: {cleanup_error}",
                            temporary_path.to_string_lossy()
                        )
                    })
                    .unwrap_or_default();
                let mut save_error =
                    io_write_error(error, "Could not verify the Markdown file before replacement");
                save_error.message.push_str(&cleanup_note);
                return Err(save_error);
            }
        }
    }

    if let Err(error) = replace_file(&temporary_path, &canonical_path) {
        let cleanup = fs::remove_file(&temporary_path);
        let cleanup_note = cleanup
            .err()
            .map(|cleanup_error| {
                format!(
                    " The complete temporary draft remains at {} because cleanup failed: {cleanup_error}",
                    temporary_path.to_string_lossy()
                )
            })
            .unwrap_or_else(|| " The temporary file was removed.".to_string());
        let mut save_error = io_write_error(
            error,
            "Could not replace the original Markdown file; the original was left unchanged",
        );
        save_error.message.push_str(&cleanup_note);
        return Err(save_error);
    }

    let saved_content = normalized_utf8_content(&canonical_path)
        .map_err(|error| io_write_error(error, "The file was saved but could not be read back"))?;
    Ok(markdown_document_from_path(&canonical_path, saved_content))
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

    let content = normalized_utf8_content(&canonical_path)
        .map_err(|error| format!("Could not read this file as UTF-8 text: {error}"))?;
    Ok(markdown_document_from_path(&canonical_path, content))
}

#[tauri::command]
fn write_markdown_file(
    path: String,
    content: String,
    expected_content: String,
    overwrite_conflict: Option<bool>,
) -> Result<MarkdownDocument, WriteMarkdownError> {
    write_markdown_file_impl(
        &path,
        &content,
        &expected_content,
        overwrite_conflict.unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = temporary_test_folder(label);
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn temporary_test_folder(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "md-reader-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn scans_nested_markdown_files_in_stable_folder_first_order() {
        let temporary = TestDirectory::new("scan");
        let root = temporary.path.clone();
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
    }

    #[test]
    fn saves_existing_markdown_file() {
        let temporary = TestDirectory::new("save");
        let path = temporary.path.join("notes.md");
        fs::write(&path, "before").unwrap();

        let saved = write_markdown_file_impl(
            path.to_str().unwrap(),
            "after\n",
            "before",
            false,
        )
        .unwrap();

        assert_eq!(saved.content, "after\n");
        assert_eq!(fs::read_to_string(path).unwrap(), "after\n");
    }

    #[test]
    fn rejects_non_markdown_extension_without_changing_file() {
        let temporary = TestDirectory::new("invalid-extension");
        let path = temporary.path.join("notes.txt");
        fs::write(&path, "original").unwrap();

        let error = write_markdown_file_impl(
            path.to_str().unwrap(),
            "replacement",
            "original",
            false,
        )
        .unwrap_err();

        assert_eq!(error.kind, WriteErrorKind::InvalidExtension);
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }

    #[test]
    fn detects_conflict_without_changing_external_content() {
        let temporary = TestDirectory::new("conflict");
        let path = temporary.path.join("notes.markdown");
        fs::write(&path, "external change").unwrap();

        let error = write_markdown_file_impl(
            path.to_str().unwrap(),
            "local draft",
            "previous disk content",
            false,
        )
        .unwrap_err();

        assert_eq!(error.kind, WriteErrorKind::Conflict);
        assert_eq!(fs::read_to_string(path).unwrap(), "external change");
    }

    #[test]
    fn read_failure_does_not_change_original_bytes() {
        let temporary = TestDirectory::new("read-failure");
        let path = temporary.path.join("invalid-utf8.md");
        let original = [0xff, 0xfe, 0x00, 0x61];
        fs::write(&path, original).unwrap();

        let error = write_markdown_file_impl(
            path.to_str().unwrap(),
            "replacement",
            "expected text",
            false,
        )
        .unwrap_err();

        assert_eq!(error.kind, WriteErrorKind::WriteFailure);
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn explicit_overwrite_replaces_conflicting_content() {
        let temporary = TestDirectory::new("overwrite");
        let path = temporary.path.join("notes.md");
        fs::write(&path, "external change").unwrap();

        let saved = write_markdown_file_impl(
            path.to_str().unwrap(),
            "explicit local version",
            "previous disk content",
            true,
        )
        .unwrap();

        assert_eq!(saved.content, "explicit local version");
        assert_eq!(fs::read_to_string(path).unwrap(), "explicit local version");
    }

    #[test]
    fn saves_unicode_and_chinese_as_utf8() {
        let temporary = TestDirectory::new("unicode");
        let path = temporary.path.join("中文笔记.md");
        fs::write(&path, "旧内容").unwrap();
        let content = "# 安全编辑\n\n你好，世界 🌏\n";

        let saved = write_markdown_file_impl(
            path.to_str().unwrap(),
            content,
            "旧内容",
            false,
        )
        .unwrap();

        assert_eq!(saved.content, content);
        assert_eq!(fs::read_to_string(path).unwrap(), content);
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
            read_markdown_file,
            write_markdown_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running MD Reader");
}
