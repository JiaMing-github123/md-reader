use serde::{Deserialize, Serialize};
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
    revision: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileRevision {
    status: FileRevisionStatus,
    revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FileRevisionStatus {
    Exists,
    Missing,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RecoveryDraft {
    canonical_path: String,
    filename: String,
    draft_content: String,
    base_revision: String,
    updated_timestamp: u64,
    app_version: String,
    schema_version: u32,
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
const RECOVERY_SCHEMA_VERSION: u32 = 1;
const MAX_RECOVERY_DRAFTS: usize = 20;
const RECOVERY_CLEANUP_AGE_SECONDS: u64 = 30 * 24 * 60 * 60;

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

fn fingerprint_bytes(bytes: &[u8]) -> u64 {
    // Stable FNV-1a: unlike mtime or file length alone, this changes when equal-sized
    // Markdown contents change and is deterministic across application launches.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn content_revision(content: &str) -> String {
    format!("v1-{:016x}-{}", fingerprint_bytes(content.as_bytes()), content.len())
}

fn file_revision_impl(path: &Path) -> Result<FileRevision, String> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            let content = normalized_utf8_content(path)
                .map_err(|error| format!("Could not read the file revision: {error}"))?;
            Ok(FileRevision {
                status: FileRevisionStatus::Exists,
                revision: Some(content_revision(&content)),
            })
        }
        Ok(_) => Err("The Markdown path is no longer an ordinary file.".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(FileRevision {
            status: FileRevisionStatus::Missing,
            revision: None,
        }),
        Err(error) => Err(format!("Could not inspect the file revision: {error}")),
    }
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
        revision: content_revision(&content),
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

fn recovery_path_identity(path: &str) -> Result<String, String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Recovery paths must be absolute document paths.".to_string());
    }

    let resolved = requested.canonicalize().unwrap_or(requested);
    let identity = resolved.to_string_lossy().into_owned();
    #[cfg(windows)]
    let identity = identity.replace('/', "\\").to_lowercase();
    Ok(identity)
}

fn resolved_document_path(path: &str) -> Result<String, String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Recovery paths must be absolute document paths.".to_string());
    }
    Ok(requested
        .canonicalize()
        .unwrap_or(requested)
        .to_string_lossy()
        .into_owned())
}

fn recovery_record_id(path: &str) -> Result<String, String> {
    let identity = recovery_path_identity(path)?;
    let first = fingerprint_bytes(identity.as_bytes());
    let mut salted = b"md-reader-recovery-v1\0".to_vec();
    salted.extend_from_slice(identity.as_bytes());
    let second = fingerprint_bytes(&salted);
    Ok(format!("{first:016x}{second:016x}"))
}

fn recovery_record_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let id = recovery_record_id(path)?;
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The recovery record id is invalid.".to_string());
    }
    Ok(root.join(format!("{id}.json")))
}

fn create_recovery_temporary_file(root: &Path) -> Result<(PathBuf, File), String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for attempt in 0..64_u8 {
        let temporary_path = root.join(format!(
            ".recovery-{}-{nonce}-{attempt}.tmp",
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
                return Err(format!(
                    "Could not create a temporary recovery file: {error}"
                ));
            }
        }
    }

    Err("Could not create a unique temporary recovery file.".to_string())
}

fn atomic_write_recovery_with<F>(
    root: &Path,
    target: &Path,
    bytes: &[u8],
    replace: F,
) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create the recovery directory: {error}"))?;
    let (temporary_path, mut temporary_file) = create_recovery_temporary_file(root)?;
    let write_result = temporary_file.write_all(bytes).and_then(|_| temporary_file.sync_all());
    drop(temporary_file);

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!("Could not write the recovery draft safely: {error}"));
    }

    if let Err(error) = replace(&temporary_path, target) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Could not replace the recovery draft; the previous draft was preserved: {error}"
        ));
    }
    Ok(())
}

fn atomic_write_recovery(root: &Path, target: &Path, bytes: &[u8]) -> Result<(), String> {
    let target_exists = target.exists();
    atomic_write_recovery_with(root, target, bytes, move |temporary_path, target_path| {
        if target_exists {
            replace_file(temporary_path, target_path)
        } else {
            fs::rename(temporary_path, target_path)
        }
    })
}

fn load_recovery_draft_impl(root: &Path, path: &str) -> Result<Option<RecoveryDraft>, String> {
    let target = recovery_record_path(root, path)?;
    let bytes = match fs::read(&target) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read this recovery draft: {error}")),
    };
    let record: RecoveryDraft = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "This recovery draft is damaged and was left untouched ({}): {error}",
            target.to_string_lossy()
        )
    })?;
    if record.schema_version != RECOVERY_SCHEMA_VERSION {
        return Err(format!(
            "This recovery draft uses unsupported schema version {} and was left untouched.",
            record.schema_version
        ));
    }
    if recovery_path_identity(&record.canonical_path)? != recovery_path_identity(path)? {
        return Err("The recovery draft path does not match the requested document.".to_string());
    }
    Ok(Some(record))
}

fn delete_recovery_draft_impl(root: &Path, path: &str) -> Result<(), String> {
    let target = recovery_record_path(root, path)?;
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not delete the recovery draft: {error}")),
    }
}

fn recovery_record_is_safe_to_clean(record: &RecoveryDraft, now: u64) -> bool {
    if now.saturating_sub(record.updated_timestamp) < RECOVERY_CLEANUP_AGE_SECONDS {
        return false;
    }
    normalized_utf8_content(Path::new(&record.canonical_path))
        .map(|disk_content| disk_content == record.draft_content)
        .unwrap_or(false)
}

fn ensure_recovery_capacity(root: &Path, target: &Path, now: u64) -> Result<(), String> {
    if target.exists() {
        return Ok(());
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create the recovery directory: {error}"))?;

    let mut records = Vec::new();
    for entry in fs::read_dir(root)
        .map_err(|error| format!("Could not inspect recovery storage: {error}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let parsed = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RecoveryDraft>(&bytes).ok());
        records.push((path, parsed));
    }

    if records.len() < MAX_RECOVERY_DRAFTS {
        return Ok(());
    }

    let mut cleanable: Vec<_> = records
        .iter()
        .filter_map(|(path, record)| {
            let record = record.as_ref()?;
            recovery_record_is_safe_to_clean(record, now)
                .then_some((record.updated_timestamp, path.clone()))
        })
        .collect();
    cleanable.sort_by_key(|(updated, _)| *updated);

    let mut remaining = records.len();
    for (_, path) in cleanable {
        if remaining < MAX_RECOVERY_DRAFTS {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            remaining -= 1;
        }
    }

    if remaining >= MAX_RECOVERY_DRAFTS {
        return Err(format!(
            "Recovery storage already contains {MAX_RECOVERY_DRAFTS} protected unsaved drafts. No valid draft was deleted."
        ));
    }
    Ok(())
}

fn save_recovery_draft_impl(
    root: &Path,
    path: &str,
    draft_content: &str,
    base_revision: &str,
    now: u64,
) -> Result<RecoveryDraft, String> {
    let canonical_path = resolved_document_path(path)?;
    let target = recovery_record_path(root, &canonical_path)?;
    ensure_recovery_capacity(root, &target, now)?;
    let filename = Path::new(&canonical_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("document.md")
        .to_string();
    let record = RecoveryDraft {
        canonical_path,
        filename,
        draft_content: draft_content.to_string(),
        base_revision: base_revision.to_string(),
        updated_timestamp: now,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: RECOVERY_SCHEMA_VERSION,
    };
    let bytes = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("Could not serialize the recovery draft: {error}"))?;
    atomic_write_recovery(root, &target, &bytes)?;
    Ok(record)
}

fn recovery_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("recovery"))
        .map_err(|error| format!("Could not resolve the application data directory: {error}"))
}

#[tauri::command]
fn save_recovery_draft(
    app: tauri::AppHandle,
    path: String,
    draft_content: String,
    base_revision: String,
) -> Result<RecoveryDraft, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    save_recovery_draft_impl(
        &recovery_root(&app)?,
        &path,
        &draft_content,
        &base_revision,
        now,
    )
}

#[tauri::command]
fn load_recovery_draft(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<RecoveryDraft>, String> {
    load_recovery_draft_impl(&recovery_root(&app)?, &path)
}

#[tauri::command]
fn delete_recovery_draft(app: tauri::AppHandle, path: String) -> Result<(), String> {
    delete_recovery_draft_impl(&recovery_root(&app)?, &path)
}

#[tauri::command]
fn get_file_revision(path: String) -> Result<FileRevision, String> {
    file_revision_impl(Path::new(&path))
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    app.exit(0);
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
    fn saves_loads_and_deletes_recovery_draft() {
        let temporary = TestDirectory::new("recovery-lifecycle");
        let recovery = temporary.path.join("recovery");
        let document = temporary.path.join("notes.md");
        fs::write(&document, "disk").unwrap();

        let saved = save_recovery_draft_impl(
            &recovery,
            document.to_str().unwrap(),
            "local draft",
            "revision-before",
            1234,
        )
        .unwrap();
        assert_eq!(saved.draft_content, "local draft");
        assert_eq!(saved.schema_version, RECOVERY_SCHEMA_VERSION);

        let loaded = load_recovery_draft_impl(&recovery, document.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(loaded, saved);

        delete_recovery_draft_impl(&recovery, document.to_str().unwrap()).unwrap();
        assert!(load_recovery_draft_impl(&recovery, document.to_str().unwrap())
            .unwrap()
            .is_none());
    }

    #[test]
    fn recovery_supports_unicode_paths_and_content() {
        let temporary = TestDirectory::new("recovery-unicode");
        let recovery = temporary.path.join("恢复草稿");
        let document = temporary.path.join("中文笔记.md");
        fs::write(&document, "磁盘内容").unwrap();
        let draft = "# 恢复\n\n你好，世界 🌏";

        save_recovery_draft_impl(
            &recovery,
            document.to_str().unwrap(),
            draft,
            "版本一",
            4567,
        )
        .unwrap();
        let loaded = load_recovery_draft_impl(&recovery, document.to_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(loaded.filename, "中文笔记.md");
        assert_eq!(loaded.draft_content, draft);
    }

    #[test]
    fn damaged_recovery_record_does_not_remove_other_records() {
        let temporary = TestDirectory::new("recovery-damage");
        let recovery = temporary.path.join("recovery");
        let first = temporary.path.join("first.md");
        let second = temporary.path.join("second.md");
        fs::write(&first, "first disk").unwrap();
        fs::write(&second, "second disk").unwrap();
        save_recovery_draft_impl(
            &recovery,
            first.to_str().unwrap(),
            "first draft",
            "r1",
            1,
        )
        .unwrap();
        save_recovery_draft_impl(
            &recovery,
            second.to_str().unwrap(),
            "second draft",
            "r2",
            2,
        )
        .unwrap();

        let damaged_path = recovery_record_path(&recovery, first.to_str().unwrap()).unwrap();
        fs::write(&damaged_path, b"{not valid json").unwrap();
        let error = load_recovery_draft_impl(&recovery, first.to_str().unwrap()).unwrap_err();
        assert!(error.contains("damaged"));
        assert!(damaged_path.exists());
        assert_eq!(
            load_recovery_draft_impl(&recovery, second.to_str().unwrap())
                .unwrap()
                .unwrap()
                .draft_content,
            "second draft"
        );
    }

    #[test]
    fn failed_recovery_replace_preserves_previous_record() {
        let temporary = TestDirectory::new("recovery-atomic-failure");
        let recovery = temporary.path.join("recovery");
        fs::create_dir_all(&recovery).unwrap();
        let target = recovery.join("record.json");
        fs::write(&target, b"previous valid record").unwrap();

        let error = atomic_write_recovery_with(
            &recovery,
            &target,
            b"new record",
            |_temporary, _target| Err(io::Error::new(io::ErrorKind::Other, "injected failure")),
        )
        .unwrap_err();
        assert!(error.contains("previous draft was preserved"));
        assert_eq!(fs::read(&target).unwrap(), b"previous valid record");
    }

    #[test]
    fn recovery_paths_cannot_escape_storage_directory() {
        let temporary = TestDirectory::new("recovery-path-safety");
        let recovery = temporary.path.join("recovery");
        assert!(recovery_record_path(&recovery, "..\\escape.md").is_err());

        let outside = temporary.path.join("nested").join("..").join("outside.md");
        let target = recovery_record_path(&recovery, outside.to_str().unwrap()).unwrap();
        assert_eq!(target.parent(), Some(recovery.as_path()));
        let filename = target.file_name().unwrap().to_string_lossy();
        assert!(filename.ends_with(".json"));
        assert!(!filename.contains(".."));
        assert!(!filename.contains('/') && !filename.contains('\\'));
    }

    #[test]
    fn recovery_capacity_only_removes_old_drafts_already_on_disk() {
        let temporary = TestDirectory::new("recovery-capacity");
        let recovery = temporary.path.join("recovery");
        let now = RECOVERY_CLEANUP_AGE_SECONDS + 10_000;
        let mut paths = Vec::new();

        for index in 0..MAX_RECOVERY_DRAFTS {
            let document = temporary.path.join(format!("note-{index}.md"));
            fs::write(&document, "disk").unwrap();
            save_recovery_draft_impl(
                &recovery,
                document.to_str().unwrap(),
                &format!("draft-{index}"),
                "base",
                if index == 0 { 1 } else { now },
            )
            .unwrap();
            paths.push(document);
        }

        let newest = temporary.path.join("newest.md");
        fs::write(&newest, "disk").unwrap();
        let capacity_error = save_recovery_draft_impl(
            &recovery,
            newest.to_str().unwrap(),
            "newest draft",
            "base",
            now,
        )
        .unwrap_err();
        assert!(capacity_error.contains("No valid draft was deleted"));

        // Only this old record is safe: its recovered content is already on disk.
        fs::write(&paths[0], "draft-0").unwrap();
        save_recovery_draft_impl(
            &recovery,
            newest.to_str().unwrap(),
            "newest draft",
            "base",
            now,
        )
        .unwrap();

        assert!(load_recovery_draft_impl(&recovery, paths[0].to_str().unwrap())
            .unwrap()
            .is_none());
        assert!(load_recovery_draft_impl(&recovery, paths[1].to_str().unwrap())
            .unwrap()
            .is_some());
        assert!(load_recovery_draft_impl(&recovery, newest.to_str().unwrap())
            .unwrap()
            .is_some());
        assert_eq!(
            fs::read_dir(&recovery)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
                .count(),
            MAX_RECOVERY_DRAFTS
        );
    }

    #[test]
    fn revision_detects_equal_length_content_changes_and_deletion() {
        let temporary = TestDirectory::new("revision");
        let document = temporary.path.join("notes.md");
        fs::write(&document, "alpha").unwrap();
        let first = file_revision_impl(&document).unwrap();
        fs::write(&document, "bravo").unwrap();
        let second = file_revision_impl(&document).unwrap();
        assert_eq!(first.status, FileRevisionStatus::Exists);
        assert_eq!(second.status, FileRevisionStatus::Exists);
        assert_ne!(first.revision, second.revision);

        fs::remove_file(&document).unwrap();
        assert_eq!(
            file_revision_impl(&document).unwrap(),
            FileRevision {
                status: FileRevisionStatus::Missing,
                revision: None,
            }
        );
    }

    #[test]
    fn save_conflict_preserves_original_and_recovery_draft() {
        let temporary = TestDirectory::new("save-conflict-recovery");
        let recovery = temporary.path.join("recovery");
        let document = temporary.path.join("notes.md");
        fs::write(&document, "original").unwrap();
        save_recovery_draft_impl(
            &recovery,
            document.to_str().unwrap(),
            "local draft",
            "base",
            10,
        )
        .unwrap();
        fs::write(&document, "external").unwrap();

        let error = write_markdown_file_impl(
            document.to_str().unwrap(),
            "local draft",
            "original",
            false,
        )
        .unwrap_err();
        assert_eq!(error.kind, WriteErrorKind::Conflict);
        assert_eq!(fs::read_to_string(&document).unwrap(), "external");
        assert!(load_recovery_draft_impl(&recovery, document.to_str().unwrap())
            .unwrap()
            .is_some());
    }

    #[test]
    fn write_failure_preserves_original_bytes_and_recovery_draft() {
        let temporary = TestDirectory::new("write-failure-recovery");
        let recovery = temporary.path.join("recovery");
        let document = temporary.path.join("invalid.md");
        let original = [0xff, 0xfe, 0x00, 0x61];
        fs::write(&document, original).unwrap();
        save_recovery_draft_impl(
            &recovery,
            document.to_str().unwrap(),
            "protected local draft",
            "base",
            11,
        )
        .unwrap();

        let error = write_markdown_file_impl(
            document.to_str().unwrap(),
            "replacement",
            "expected",
            false,
        )
        .unwrap_err();
        assert_eq!(error.kind, WriteErrorKind::WriteFailure);
        assert_eq!(fs::read(&document).unwrap(), original);
        assert!(load_recovery_draft_impl(&recovery, document.to_str().unwrap())
            .unwrap()
            .is_some());
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
            write_markdown_file,
            save_recovery_draft,
            load_recovery_draft,
            delete_recovery_draft,
            get_file_revision,
            exit_application
        ])
        .run(tauri::generate_context!())
        .expect("error while running MD Reader");
}
