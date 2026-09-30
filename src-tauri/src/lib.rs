use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicU64;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

#[cfg(target_os = "windows")]
mod thumbbar;

// Polyglot execution stack: interpreter discovery, the routed run engine, and
// the Debug Adapter Protocol transport.
mod dap;
mod executor;
mod interpreter;
mod terminal;

// Lua extension framework: manifest validation, the sandboxed mlua host, the
// `agamiz` API, and the installer that populates `~/.agamizcode/extensions`.
pub mod cli;
mod ext;

#[cfg(test)]
mod project_tests;

use std::sync::Arc as StdArc;

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(serde::Serialize, Clone)]
struct RakLine {
    stream: String,
    text: String,
}

#[derive(serde::Serialize)]
struct ExecResult {
    code: i32,
    stdout: String,
    stderr: String,
}

#[derive(serde::Serialize, Clone)]
struct ProcLine {
    id: u64,
    stream: String,
    text: String,
}

#[derive(serde::Serialize, Clone)]
struct ProcDone {
    id: u64,
    code: i32,
}

/// A shell that can back a terminal session (see `list_shells`).
#[derive(serde::Serialize, Clone)]
struct ShellInfo {
    /// Stable id: "powershell" | "cmd" | "wsl" | "shell".
    id: String,
    /// Human-readable display name.
    name: String,
    /// Executable the frontend should spawn for this shell.
    program: String,
    /// Whether the shell is installed/usable on this machine.
    available: bool,
    /// Whether this is the suggested default shell.
    is_default: bool,
}

static RUNNING: Mutex<Option<Child>> = Mutex::new(None);
static PROCS: LazyLock<Mutex<HashMap<u64, Child>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static PROC_STDIN: LazyLock<Mutex<HashMap<u64, std::process::ChildStdin>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static WIN_SEQ: AtomicU64 = AtomicU64::new(1);
static LSP: Mutex<Option<Child>> = Mutex::new(None);
static LSP_STDIN: Mutex<Option<std::process::ChildStdin>> = Mutex::new(None);

/// Label prefix for every window created by New Window.
///
/// This string is load-bearing in two places that live in different files and
/// cannot share a constant:
///
/// 1. [`window_label`], which builds `editor-1`, `editor-2`, …
/// 2. `capabilities/default.json`, whose `windows` list grants the IPC
///    permissions (`core:default`, `dialog:*`, `core:window:*`) to
///    `editor-*`.
///
/// If the two ever drift apart, a new window still *opens* but every IPC call
/// inside it is rejected — open folder, save, terminal, all of it — which
/// presents as "the new window is broken". `window_label_matches_capability`
/// below fails the build if that happens.
const WINDOW_LABEL_PREFIX: &str = "editor";

/// Build the label for the `n`-th New Window.
fn window_label(n: u64) -> String {
    format!("{WINDOW_LABEL_PREFIX}-{n}")
}

fn rakc_binary() -> Option<String> {
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let mut candidates = vec!["rakc".to_string()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("rakc").to_string_lossy().to_string());
            candidates.push(
                parent
                    .join(format!("rakc{}", ext))
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../../target/release/rakc{}", ext))
            .to_string_lossy()
            .to_string(),
    );
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../../target/debug/rakc{}", ext))
            .to_string_lossy()
            .to_string(),
    );
    candidates.into_iter().find(|c| {
        Command::new(c)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
    })
}

#[tauri::command]
fn rakc_version() -> Result<String, String> {
    match rakc_binary() {
        Some(b) => match Command::new(&b).arg("--version").output() {
            Ok(o) => Ok(String::from_utf8_lossy(&o.stdout).trim().to_string()),
            Err(e) => Err(e.to_string()),
        },
        None => Err("rakc binary not found".to_string()),
    }
}

#[tauri::command]
fn run_rak(app: AppHandle, mode: String, source: String) -> Result<(), String> {
    let cmd = match mode.as_str() {
        "vm" => "vm",
        "bench" => "bench",
        _ => "run",
    };
    let bin = rakc_binary().ok_or("rakc binary not found")?;
    let mut tmp = std::env::temp_dir();
    tmp.push(format!("rak_ide_{}.rak", std::process::id()));
    fs::write(&tmp, &source).map_err(|e| e.to_string())?;

    let mut child = Command::new(&bin)
        .arg(cmd)
        .arg(&tmp)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = RUNNING.lock().unwrap();
        if let Some(mut prev) = guard.take() {
            let _ = prev.kill();
            let _ = prev.wait();
        }
        *guard = Some(child);
    }

    if let Some(out) = stdout {
        let app2 = app.clone();
        std::thread::spawn(move || {
            // `map_while(Result::ok)`, not `flatten()`: `Lines` is an infinite
            // iterator, so a reader that keeps returning `Err` (a detached pipe,
            // a full disk) would make `flatten()` spin forever on the same error
            // instead of ending the stream.
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app2.emit(
                    "rak-output",
                    RakLine {
                        stream: "stdout".into(),
                        text: line,
                    },
                );
            }
        });
    }
    if let Some(err) = stderr {
        let app2 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app2.emit(
                    "rak-output",
                    RakLine {
                        stream: "stderr".into(),
                        text: line,
                    },
                );
            }
        });
    }

    let app3 = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let finished = {
            let mut guard = RUNNING.lock().unwrap();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => {
                        *guard = None;
                        true
                    }
                    Ok(None) => false,
                    Err(_) => {
                        *guard = None;
                        true
                    }
                },
                None => true,
            }
        };
        if finished {
            let _ = app3.emit("rak-done", ());
            break;
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_rak() -> Result<(), String> {
    let mut guard = RUNNING.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Terminal shell management (multi-session terminal)
// ---------------------------------------------------------------------------

/// Check whether an executable exists on PATH (fast, no process spawn).
/// Windows-only: appends the `.exe` extension when missing.
#[cfg(target_os = "windows")]
fn find_on_path(program: &str) -> bool {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if dir.join(format!("{program}.exe")).is_file() || dir.join(program).is_file() {
                return true;
            }
        }
    }
    false
}

/// Probe whether WSL is actually usable: the `wsl.exe` stub must respond and
/// at least one distribution must be installed (`wsl --list --quiet` prints
/// nothing — but exits 0 — when WSL is present without any distro). WSL's
/// output is UTF-16LE, so NUL bytes are tolerated when checking for content.
#[cfg(target_os = "windows")]
fn wsl_available() -> bool {
    match Command::new("wsl").args(["--list", "--quiet"]).output() {
        Ok(o) => o.status.success() && o.stdout.iter().any(|b| !b.is_ascii_whitespace() && *b != 0),
        Err(_) => false,
    }
}

/// Which shells can back a terminal session on this machine. The frontend uses
/// this to populate the "new session" picker (unavailable shells are omitted)
/// and to know which executable each entry spawns.
#[tauri::command]
fn list_shells() -> Vec<ShellInfo> {
    let mut shells: Vec<ShellInfo> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // PowerShell: prefer PowerShell 7+ (pwsh) when installed, fall back to
        // the built-in Windows PowerShell 5.1.
        let (ps_program, ps_name) = if find_on_path("pwsh") {
            ("pwsh", "PowerShell")
        } else if find_on_path("powershell")
            || PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe").is_file()
        {
            ("powershell", "Windows PowerShell")
        } else {
            ("", "")
        };
        let ps_available = !ps_program.is_empty();
        shells.push(ShellInfo {
            id: "powershell".into(),
            name: if ps_available {
                ps_name.into()
            } else {
                "PowerShell".into()
            },
            program: if ps_available {
                ps_program.into()
            } else {
                "powershell".into()
            },
            available: ps_available,
            is_default: ps_available,
        });

        let cmd_available =
            find_on_path("cmd") || PathBuf::from(r"C:\Windows\System32\cmd.exe").is_file();
        shells.push(ShellInfo {
            id: "cmd".into(),
            name: "Command Prompt".into(),
            program: "cmd".into(),
            available: cmd_available,
            is_default: false,
        });

        let wsl_ok = wsl_available();
        shells.push(ShellInfo {
            id: "wsl".into(),
            name: "WSL".into(),
            program: "wsl".into(),
            available: wsl_ok,
            is_default: false,
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix: use the user's login shell ($SHELL) when it exists, else sh.
        let program = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty() && PathBuf::from(s).is_file())
            .unwrap_or_else(|| "sh".into());
        let basename = program.rsplit('/').next().unwrap_or("shell").to_string();
        let display = match basename.as_str() {
            "bash" => "Bash".to_string(),
            "zsh" => "Zsh".to_string(),
            "fish" => "Fish".to_string(),
            other => format!("Shell ({other})"),
        };
        shells.push(ShellInfo {
            id: "shell".into(),
            name: display,
            program,
            available: true,
            is_default: true,
        });
    }

    shells
}

/// Kill one tracked process by id, so each terminal session can interrupt its
/// own command (Ctrl+C) without touching other sessions or the debug runner.
#[tauri::command]
fn proc_kill(id: u64) -> Result<(), String> {
    let pid = {
        let mut map = PROCS.lock().unwrap();
        match map.remove(&id) {
            Some(mut child) => {
                let pid = child.id();
                let _ = child.kill();
                let _ = child.wait();
                pid
            }
            None => return Err("process not running".into()),
        }
    };
    PROC_STDIN.lock().unwrap().remove(&id);
    #[cfg(target_os = "windows")]
    {
        // Tree-kill: the direct child may have spawned its own children
        // (e.g. `cmd /C long_task`) — take the whole tree down with it. If the
        // direct kill above already worked, taskkill fails silently.
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    Ok(())
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    let resolved = confine(&path)?;
    fs::write(&resolved, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let resolved = confine(&path)?;
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

/// What lives at `path`, without reading it.
///
/// The file explorer's rename and drag-to-move need to know whether the
/// destination already exists and whether a move is of a file or a directory.
/// `list_dir` cannot answer either: it returns an empty vec both for a missing
/// path and for an empty directory, and it silently swallows a read error.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PathInfo {
    exists: bool,
    is_dir: bool,
    is_file: bool,
}

#[tauri::command]
fn path_info(path: String) -> PathInfo {
    // Confined too: an unvalidated probe is an existence oracle over the whole
    // filesystem, which is exactly what the allow-list exists to prevent.
    let resolved = match confine(&path) {
        Ok(resolved) => resolved,
        // Outside the workspace: report "does not exist" rather than leaking
        // whether the path is really there.
        Err(_) => {
            return PathInfo {
                exists: false,
                is_dir: false,
                is_file: false,
            }
        }
    };
    match fs::metadata(&resolved) {
        Ok(meta) => PathInfo {
            exists: true,
            is_dir: meta.is_dir(),
            is_file: meta.is_file(),
        },
        // A missing path is an answer, not an error: the caller is probing.
        Err(_) => PathInfo {
            exists: false,
            is_dir: false,
            is_file: false,
        },
    }
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    let path = confine(&path)?;

    if let Ok(read_dir) = fs::read_dir(&path) {
        for entry in read_dir.flatten() {
            if let Ok(metadata) = entry.metadata() {
                let name = entry.file_name().to_string_lossy().to_string();
                let entry_path = entry.path().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                entries.push(FileEntry {
                    name,
                    path: entry_path,
                    is_dir: metadata.is_dir(),
                });
            }
        }
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
fn list_files_recursive(path: String, ext: String) -> Result<Vec<FileEntry>, String> {
    let mut results = Vec::new();
    fn walk(dir: &PathBuf, ext: &str, results: &mut Vec<FileEntry>) {
        if let Ok(read_dir) = fs::read_dir(dir) {
            for entry in read_dir.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with('.')
                        || name == "node_modules"
                        || name == "target"
                        || name == "out"
                    {
                        continue;
                    }
                    let path = entry.path();
                    if metadata.is_dir() {
                        walk(&path, ext, results);
                    } else if ext.is_empty() || name.ends_with(&ext) {
                        results.push(FileEntry {
                            name,
                            path: path.to_string_lossy().to_string(),
                            is_dir: false,
                        });
                    }
                }
            }
        }
    }
    let root = confine(&path)?;
    walk(&root, &ext, &mut results);
    results.sort_by_key(|f| f.name.to_lowercase());
    Ok(results)
}

#[tauri::command]
fn current_dir() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let resolved = confine(&path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&resolved, "").map_err(|e| e.to_string())
}

/// Per-user configuration directory for Agamiz Code (created on demand).
///
/// The frontend needs a stable location for `settings.json` and the persisted
/// workspace session. Resolving it here keeps platform details (APPDATA vs
/// HOME) out of the webview, which has no reliable way to ask. We deliberately
/// avoid pulling in a `dirs`-style crate for two environment variables: on
/// Windows config lives under `%APPDATA%`, everywhere else under `$HOME` (and
/// `$XDG_CONFIG_HOME` when set, matching the XDG spec users expect).
#[tauri::command]
fn user_config_dir() -> Result<String, String> {
    let base = if cfg!(target_os = "windows") {
        std::env::var("APPDATA").ok()
    } else {
        std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| std::env::var("HOME").ok())
    }
    .ok_or_else(|| "could not resolve a user config directory".to_string())?;

    let dir = PathBuf::from(base).join("AgamizCode");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    let resolved = confine(&path)?;
    fs::create_dir_all(&resolved).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Project scaffolding — backing the "New Project" wizard
// ---------------------------------------------------------------------------

/// One file a project template wants written, as a path relative to the
/// project root. `content` is the literal text to write.
#[derive(serde::Deserialize)]
struct ProjectFile {
    path: String,
    content: String,
}

/// Per-file "is something already there" report, so the wizard can ask about a
/// collision *before* it starts writing rather than failing halfway through.
#[derive(serde::Serialize)]
struct PathStatus {
    path: String,
    exists: bool,
}

/// Resolve a template-supplied relative path against `root`, refusing anything
/// that would escape it.
///
/// The path comes from a project template, which for built-ins is bundled app
/// data but for extensions is third-party Lua. An extension that could smuggle
/// `../../.bashrc` past a naive `root.join(path)` would be a remote-code-
/// execution primitive dressed as a project template, so the check lives here
/// rather than trusting the caller. Only the *normalised* result matters: it
/// must still start with `root` after collapsing `..`.
fn resolve_template_path(root: &std::path::Path, relative: &str) -> Result<PathBuf, String> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err("project template file has an empty path".to_string());
    }
    // Reject absolute paths and Windows drive/UNC prefixes outright. `Path::new`
    // does not consider `C:\x` absolute on Linux, but the root and the target
    // are always the same machine, so a conservative check is free.
    if trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.as_bytes().get(1) == Some(&b':')
    {
        return Err(format!(
            "project template path {trimmed:?} must be relative to the project root"
        ));
    }

    let joined = root.join(trimmed);
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::ParentDir => {
                // Popping past the root would be an escape, not a traversal to
                // be resolved — there is nothing left above the project folder.
                if !normalized.pop() {
                    return Err(format!(
                        "project template path {trimmed:?} escapes the project root"
                    ));
                }
            }
            other => normalized.push(other),
        }
    }

    if !normalized.starts_with(root) {
        return Err(format!(
            "project template path {trimmed:?} escapes the project root"
        ));
    }
    Ok(normalized)
}

/* ------------------------------------------------------------------ */
/* Path confinement                                                    */
/* ------------------------------------------------------------------ */

/// Roots a renderer-supplied path is allowed to name.
///
/// A Tauri command receives whatever the webview sends it. `save_file` and
/// friends taking a raw `path: String` and handing it to `fs::*` means anything
/// that reaches the webview — a Lua extension's editor-request bridge, an
/// injected `fetch`, a future HTML sink — can call
/// `invoke('read_file', { path: 'C:/Users/me/.ssh/id_rsa' })`, and
/// `delete_file` on a directory is a recursive delete of an arbitrary tree.
///
/// So the path commands check against this allow-list. Membership is by
/// *canonical* path, which is what makes `..` and symlink tricks collapse to
/// the thing they actually point at rather than to their spelling.
///
/// Roots enter the list from three places, all of them deliberate user actions:
///   - the workspace folder, via `register_workspace_root`
///   - any path a native open/save dialog returned
///   - the app's own config directory, added at startup
static ALLOWED_ROOTS: LazyLock<Mutex<Vec<PathBuf>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// Poison-tolerant lock. A panic while the lock was held must not permanently
/// disable every file command in the app.
fn roots_lock() -> std::sync::MutexGuard<'static, Vec<PathBuf>> {
    ALLOWED_ROOTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Canonicalize as much of `path` as exists.
///
/// `canonicalize` fails on a path whose leaf does not exist yet, which is the
/// normal case for `create_file` and for a save to a new name. Walking up to
/// the deepest existing ancestor and re-appending the missing tail gives a real
/// filesystem answer, so a symlinked parent cannot be used to smuggle a write
/// outside the root.
fn canonicalize_lenient(path: &std::path::Path) -> Result<PathBuf, String> {
    if let Ok(canonical) = path.canonicalize() {
        return Ok(canonical);
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    loop {
        match cursor.parent() {
            Some(parent) => {
                let Some(name) = cursor.file_name() else {
                    return Err(format!("cannot resolve path {}", path.display()));
                };
                tail.push(name.to_os_string());
                cursor = parent;
                if let Ok(canonical) = cursor.canonicalize() {
                    let mut resolved = canonical;
                    for segment in tail.iter().rev() {
                        resolved.push(segment);
                    }
                    return Ok(resolved);
                }
                if cursor.parent().is_none() {
                    return Err(format!("cannot resolve path {}", path.display()));
                }
            }
            None => return Err(format!("cannot resolve path {}", path.display())),
        }
    }
}

/// True when `candidate` is `root` or lives underneath it.
fn is_within(candidate: &std::path::Path, root: &std::path::Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

/// Validate a renderer-supplied path against the allow-list.
///
/// Returns the canonical form so callers do not have to re-derive it, and so
/// the check and the subsequent `fs::*` call operate on the same resolved path.
fn confine(path: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(path);
    if requested.as_os_str().is_empty() {
        return Err("path is empty".to_string());
    }
    let candidate = canonicalize_lenient(&requested)?;

    let roots = roots_lock();
    if roots.iter().any(|root| is_within(&candidate, root)) {
        Ok(candidate)
    } else {
        Err(format!(
            "path {} is outside the open workspace",
            requested.display()
        ))
    }
}

/// Like [`confine`], but additionally requires the path to be inside the
/// *workspace* root specifically.
///
/// `delete_file` uses this: a recursive delete is qualitatively more dangerous
/// than a read or a write, so it is not allowed to target a dialog-picked
/// location or the config directory, only the folder the user actually opened.
fn confine_to_workspace(path: &str) -> Result<PathBuf, String> {
    let candidate = confine(path)?;
    let root = workspace_root_lock()
        .clone()
        .ok_or_else(|| "no workspace is open".to_string())?;
    if is_within(&candidate, &root) {
        Ok(candidate)
    } else {
        Err(format!(
            "path {} is outside the open workspace",
            PathBuf::from(path).display()
        ))
    }
}

/// The currently open workspace folder, if any.
static WORKSPACE_ROOT: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));

fn workspace_root_lock() -> std::sync::MutexGuard<'static, Option<PathBuf>> {
    WORKSPACE_ROOT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn add_allowed_root(canonical: PathBuf) {
    let mut roots = roots_lock();
    if !roots.contains(&canonical) {
        roots.push(canonical);
    }
}

/// Point the confinement allow-list at a new workspace folder.
///
/// Replaces the previous workspace root but keeps roots the user picked through
/// a native dialog, so "save as somewhere else" keeps working after the next
/// folder switch.
#[tauri::command]
fn register_workspace_root(path: String) -> Result<(), String> {
    let canonical = canonicalize_lenient(PathBuf::from(&path).as_path())?;
    *workspace_root_lock() = Some(canonical.clone());
    add_allowed_root(canonical);
    Ok(())
}

/// Allow one extra path without making it the workspace.
///
/// Used for the target of a native open/save dialog: the user chose that
/// location explicitly, so refusing it would be wrong, but it must not be
/// usable as a general write target.
#[tauri::command]
fn register_allowed_root(path: String) -> Result<(), String> {
    add_allowed_root(canonicalize_lenient(PathBuf::from(&path).as_path())?);
    Ok(())
}

/// Seed the allow-list with the app's own config directory.
///
/// Settings and the extension store live here, so the settings read/write
/// commands keep working before a workspace is ever opened.
fn seed_config_root() {
    if let Ok(dir) = user_config_dir() {
        if let Ok(canonical) = canonicalize_lenient(PathBuf::from(&dir).as_path()) {
            add_allowed_root(canonical);
        }
    }
}

/// The user's home directory.
///
/// Kept beside `user_config_dir` and resolved the same way: Windows has
/// `USERPROFILE`, everything else has `HOME` (with `XDG` not applying to the
/// home directory itself). The New Project wizard uses it to default the
/// destination to `~/AgamizCode` without the webview having to guess at `~`.
#[tauri::command]
fn home_dir() -> Result<String, String> {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }
    .filter(|v| !v.is_empty())
    .ok_or_else(|| "could not resolve the user home directory".to_string())?;
    Ok(home)
}

/// Report which of the template's target paths already exist under `root`.
///
/// Returns one entry per file in request order so the wizard can render the
/// collision list without re-sorting. Never fails: an unreadable path is
/// reported as "does not exist", because that is what it effectively is as far
/// as the wizard is concerned, and the subsequent write will surface the real
/// error.
#[tauri::command]
fn inspect_project(root: String, files: Vec<ProjectFile>) -> Result<Vec<PathStatus>, String> {
    let base = PathBuf::from(&root);
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        let exists = match resolve_template_path(&base, &file.path) {
            Ok(target) => target.exists(),
            Err(_) => false,
        };
        out.push(PathStatus {
            path: file.path,
            exists,
        });
    }
    Ok(out)
}

/// Materialise a project tree: create the root, then every parent directory and
/// file the template declares.
///
/// `overwrite` is not a UI convenience — it is the second half of the wizard's
/// collision confirmation. The frontend already asked the user, but an
/// `overwrite: false` write is refused here so the guarantee does not depend on
/// the frontend having asked. Validation runs over *all* files before anything
/// is written, so a template with one bad path cannot leave a half-built tree
/// behind.
#[tauri::command]
fn create_project(root: String, files: Vec<ProjectFile>, overwrite: bool) -> Result<(), String> {
    let base = PathBuf::from(&root);

    // Resolve everything first: a path-escape or an unconfirmed overwrite must
    // abort before the first `create_dir_all`.
    let mut targets = Vec::with_capacity(files.len());
    for file in &files {
        let target = resolve_template_path(&base, &file.path)?;
        if target.exists() && !overwrite {
            return Err(format!(
                "{} already exists — confirm the overwrite to continue",
                file.path
            ));
        }
        targets.push(target);
    }

    fs::create_dir_all(&base).map_err(|e| format!("could not create {}: {e}", base.display()))?;

    for (file, target) in files.iter().zip(targets.iter()) {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        fs::write(target, &file.content)
            .map_err(|e| format!("could not write {}: {e}", file.path))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    // The most dangerous command in the set — a directory here is a recursive
    // delete of a whole tree — so it is confined to the workspace root rather
    // than to the wider allow-list.
    let path = confine_to_workspace(&path)?;
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    // Both ends. Confining only the source would turn rename into a write
    // primitive: move a workspace file out to anywhere the allow-list reaches.
    let from = confine_to_workspace(&old_path)?;
    let to = confine(&new_path)?;
    if from == to {
        return Ok(());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn duplicate_file(src: String) -> Result<(), String> {
    let src_path = confine(&src)?;
    let stem = src_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = src_path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let parent = src_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let mut dst = parent.join(format!("{}_copy{}", stem, ext));
    let mut i = 2;
    while dst.exists() {
        dst = parent.join(format!("{}_copy{}{}", stem, i, ext));
        i += 1;
    }
    fs::copy(&src_path, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    // This hands a path to a *shell-adjacent* program, so it is confined like
    // the read/write commands — an unvalidated path here is a way to make the
    // OS open an arbitrary location.
    let resolved = confine(&path)?;
    let path = resolved.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Generic process execution (run configurations, debugging, AI tools)
// ---------------------------------------------------------------------------

/// Run a non-interactive command to completion and return stdout/stderr/code.
/// Used by Git, run configurations (for quick builds/checks), and AI tools.
#[tauri::command]
fn exec_result(args: Vec<String>, cwd: String) -> Result<ExecResult, String> {
    if args.is_empty() {
        return Err("empty command".into());
    }
    let program = &args[0];
    let out = Command::new(program)
        .args(&args[1..])
        .current_dir(if cwd.is_empty() { "." } else { &cwd })
        .output()
        .map_err(|e| e.to_string())?;
    Ok(ExecResult {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

fn forward_proc_output(app: AppHandle, id: u64, reader: std::process::ChildStdout) {
    std::thread::spawn(move || {
        // `map_while(Result::ok)`, not `flatten()`: see `run_rak` above.
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = app.emit(
                "proc-output",
                ProcLine {
                    id,
                    stream: "stdout".into(),
                    text: line,
                },
            );
        }
    });
}

fn forward_proc_error(app: AppHandle, id: u64, reader: std::process::ChildStderr) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = app.emit(
                "proc-output",
                ProcLine {
                    id,
                    stream: "stderr".into(),
                    text: line,
                },
            );
        }
    });
}

fn wait_proc(app: AppHandle, id: u64) {
    std::thread::spawn(move || {
        let mut code = -1;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let finished = {
                let mut map = PROCS.lock().unwrap();
                match map.get_mut(&id) {
                    Some(child) => match child.try_wait() {
                        Ok(Some(st)) => {
                            code = st.code().unwrap_or(-1);
                            map.remove(&id);
                            PROC_STDIN.lock().unwrap().remove(&id);
                            true
                        }
                        Ok(None) => false,
                        Err(_) => {
                            map.remove(&id);
                            PROC_STDIN.lock().unwrap().remove(&id);
                            true
                        }
                    },
                    None => true,
                }
            };
            if finished {
                let _ = app.emit("proc-done", ProcDone { id, code });
                break;
            }
        }
    });
}
/// Spawn a long-running program (interactive run / debug target). Writes go to
/// `proc-output`, completion to `proc-done`. The caller supplies `id` so it can
/// correlate output; stdin is available via `proc_write`.
#[tauri::command]
fn spawn_program(
    app: AppHandle,
    id: u64,
    program: String,
    args: Vec<String>,
    cwd: String,
) -> Result<u64, String> {
    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(if cwd.is_empty() { "." } else { &cwd })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    {
        let mut map = PROCS.lock().unwrap();
        if let Some(mut prev) = map.remove(&id) {
            let _ = prev.kill();
            let _ = prev.wait();
        }
        map.insert(id, child);
    }
    if let Some(si) = stdin {
        PROC_STDIN.lock().unwrap().insert(id, si);
    }

    forward_proc_output(app.clone(), id, stdout);
    forward_proc_error(app.clone(), id, stderr);
    wait_proc(app.clone(), id);
    Ok(id)
}

/// Write a line (plus newline) to a running process's stdin.
#[tauri::command]
fn proc_write(id: u64, input: String) -> Result<(), String> {
    let mut map = PROC_STDIN.lock().unwrap();
    if let Some(stdin) = map.get_mut(&id) {
        let _ = stdin.write_all(input.as_bytes());
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
        Ok(())
    } else {
        Err("process not running or has no stdin".into())
    }
}

/// Kill every tracked process (used by Stop / session teardown).
#[tauri::command]
fn proc_stop() -> Result<(), String> {
    let mut map = PROCS.lock().unwrap();
    for (_, mut child) in map.drain() {
        let _ = child.kill();
        let _ = child.wait();
    }
    PROC_STDIN.lock().unwrap().clear();
    Ok(())
}

/// Start a Node.js inspector session for debugging. Boots `node` in
/// `--inspect-brk` mode, parses the `ws://` debugging port from stderr, streams
/// program output to `proc-output`, emits `proc-done`, and returns the WS URL.
#[tauri::command]
fn node_inspect(
    app: AppHandle,
    id: u64,
    script: String,
    cwd: String,
    port: u16,
) -> Result<String, String> {
    let mut child = Command::new("node")
        .arg(format!("--inspect-brk=127.0.0.1:{}", port))
        .arg(&script)
        .current_dir(if cwd.is_empty() { "." } else { &cwd })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start node: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    {
        let mut map = PROCS.lock().unwrap();
        if let Some(mut prev) = map.remove(&id) {
            let _ = prev.kill();
            let _ = prev.wait();
        }
        map.insert(id, child);
    }

    let mut ws_url: Option<String> = None;
    {
        let mut reader = BufReader::new(stderr);
        let mut buffer = Vec::new();
        while let Ok(n) = reader.read_until(b'\n', &mut buffer) {
            if n == 0 {
                break;
            }
            let line = String::from_utf8_lossy(&buffer).to_string();
            if ws_url.is_none() {
                if let Some(idx) = line.find("ws://") {
                    let url = line[idx..].trim().to_string();
                    ws_url = Some(url);
                } else {
                    let text = line.trim_end().to_string();
                    if !text.is_empty() {
                        let _ = app.emit(
                            "proc-output",
                            ProcLine {
                                id,
                                stream: "stderr".into(),
                                text,
                            },
                        );
                    }
                }
            } else if !line.trim().is_empty() {
                let text = line.trim_end().to_string();
                let _ = app.emit(
                    "proc-output",
                    ProcLine {
                        id,
                        stream: "stderr".into(),
                        text,
                    },
                );
            }
            buffer.clear();
        }
    }

    forward_proc_output(app.clone(), id, stdout);
    wait_proc(app.clone(), id);

    match ws_url {
        Some(u) => Ok(u),
        None => {
            let _ = proc_stop();
            Err("could not find node inspector WebSocket URL; is `node` on PATH and does the script run?".into())
        }
    }
}

// ---------------------------------------------------------------------------
// Language Server Protocol transport (spawn, send JSON-RPC, stop)
// ---------------------------------------------------------------------------

/// Spawn an external LSP server over stdio, framing LSP/JSON-RPC messages with
/// the Content-Length header. Incoming messages are emitted as `lsp-message`
/// events (JSON string). Only one server runs at a time.
#[tauri::command]
fn lsp_start(
    app: AppHandle,
    program: String,
    args: Vec<String>,
    cwd: String,
) -> Result<(), String> {
    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(if cwd.is_empty() { "." } else { &cwd })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start LSP server: {}", e))?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take().unwrap();

    {
        let mut g = LSP.lock().unwrap();
        if let Some(mut prev) = g.take() {
            let _ = prev.kill();
            let _ = prev.wait();
        }
        let _ = g.insert(child);
    }
    *LSP_STDIN.lock().unwrap() = stdin;

    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut content_length: Option<usize> = None;
            let mut line = String::new();
            // Read headers up to the blank line.
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(_) => return,
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(v) = trimmed.strip_prefix("Content-Length:") {
                    content_length = v.trim().parse().ok();
                }
            }
            let Some(len) = content_length else { continue };
            let mut buf = vec![0u8; len];
            let mut filled = 0;
            while filled < len {
                match reader.read(&mut buf[filled..]) {
                    Ok(0) => return,
                    Ok(n) => filled += n,
                    Err(_) => return,
                }
            }
            if let Ok(json) = String::from_utf8(buf) {
                let _ = app.emit("lsp-message", json);
            }
        }
    });

    Ok(())
}

/// Write a framed LSP message (JSON string) to the running server's stdin.
#[tauri::command]
fn lsp_send(json: String) -> Result<(), String> {
    let mut g = LSP_STDIN.lock().unwrap();
    match g.as_mut() {
        Some(stdin) => {
            // `str::len()` is already the UTF-8 byte count, which is what
            // Content-Length is specified in — not a character count. A
            // non-ASCII message body must not be under-reported here or the
            // server will desynchronise on the next frame.
            let header = format!("Content-Length: {}\r\n\r\n", json.len());
            stdin
                .write_all(header.as_bytes())
                .map_err(|e| e.to_string())?;
            stdin
                .write_all(json.as_bytes())
                .map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err("LSP server not running".into()),
    }
}

/// Terminate the running LSP server.
#[tauri::command]
fn lsp_stop() -> Result<(), String> {
    let mut g = LSP.lock().unwrap();
    if let Some(mut child) = g.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *LSP_STDIN.lock().unwrap() = None;
    Ok(())
}

/// Where the next New Window goes, relative to the window that asked for it.
///
/// Cascading (rather than centring) is deliberate: a centred borderless
/// 1280x800 window lands squarely inside a maximised 1400x900 parent and reads
/// as an in-app overlay rather than a second window. A ~40px step makes the
/// relationship obvious and keeps the title bar of the new window visible, so
/// the user can grab it. The step is applied per-window from the *most
/// recently focused* window, so a run of New Windows forms a staircase
/// instead of piling onto the same offset and hiding each other.
const CASCADE_STEP: (f64, f64) = (36.0, 30.0);

/// Refuse to open a window that is going to load nothing.
///
/// In a dev build every window loads the Next dev server over HTTP
/// (`build.dev_url`). The *first* window is created by Tauri right after
/// `beforeDevCommand` finishes, so it lands on a live server — but a New
/// Window is created whenever the user feels like it, long after that. If the
/// dev server has since died, been restarted elsewhere, or lost a race with a
/// second `next dev` instance fighting over the port, the new webview renders
/// WebView2's `ERR_CONNECTION_REFUSED` page. That looks exactly like the
/// "window opens but is blank/white" report, and because `new_window` used to
/// return `Ok(())` as soon as the *window* existed, the UI toasted
/// "Opened a new window" on top of it.
///
/// Checking first turns a mystery window into an actionable message. A bare
/// TCP connect is enough: it costs about a millisecond locally and cannot
/// itself fail for reasons that would make this a false alarm.
///
/// Gated on `cfg(dev)`, which `tauri-build` sets from the cargo profile.
/// It deliberately does *not* key off `config.build.dev_url.is_some()`: that
/// field is populated from `tauri.conf.json` in release builds too, so testing
/// it would make a packaged app demand a local dev server before it is
/// allowed to open a window.
#[cfg(not(dev))]
fn ensure_dev_server_reachable(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(dev)]
fn ensure_dev_server_reachable(app: &AppHandle) -> Result<(), String> {
    use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let Some(dev_url) = app.config().build.dev_url.as_ref() else {
        return Ok(());
    };
    let host = dev_url
        .host_str()
        .ok_or_else(|| format!("dev URL {dev_url} has no host"))?;
    let port = dev_url.port_or_known_default().unwrap_or(80);

    let addrs: Vec<SocketAddr> = match (host, port).to_socket_addrs() {
        Ok(it) => it.collect(),
        Err(e) => {
            return Err(format!(
                "The dev server URL {dev_url} could not be resolved: {e}"
            ))
        }
    };

    let mut last_error = String::from("no addresses resolved");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
            Ok(_) => return Ok(()),
            Err(e) => last_error = e.to_string(),
        }
    }

    Err(format!(
        "The dev server at {dev_url} is not reachable ({last_error}), so a new window \
         would open blank. Start it with `npm run dev` — or run `npm run tauri:dev`, \
         which starts and stops it for you. If another `next dev` is already using \
         port {port}, stop it first."
    ))
}

/// Background painted before the first frame of the webview arrives.
///
/// Without this the platform paints its default (white on Windows), so a
/// window that takes a moment to load reads as a blank white rectangle — the
/// single most misleading symptom this feature has had. It matches the app's
/// base surface so the loading period looks like part of the IDE.
const WINDOW_BACKGROUND: (u8, u8, u8) = (9, 9, 11);

/// Open a fresh IDE window and return its label.
///
/// Shared by the `new_window` IPC command and the taskbar thumbnail-toolbar
/// button (see `thumbbar.rs`).
///
/// Why it is shaped this way:
///
/// * **Cascaded, never centred** — see [`CASCADE_STEP`].
/// * **Created visible and focused.** An earlier revision created it hidden
///   and revealed it after page load, to dodge a WebView2 first-frame quirk.
///   That made things worse: the reveal arrived on the wrong frame and users
///   reported "it opens like an overlay inside the current window, input is
///   dead". Showing immediately and painting the background ourselves is both
///   simpler and observably correct.
/// * **Dark pre-paint background** — see [`WINDOW_BACKGROUND`].
/// * **Dev server checked first** — see [`ensure_dev_server_reachable`].
/// * **Reported, not assumed.** Returning the label lets the caller name the
///   window in a success message and, more importantly, lets a *failure* be
///   surfaced instead of silently toasting "opened" over a dead window.
pub(crate) fn spawn_editor_window(app: &AppHandle) -> Result<String, String> {
    let n = WIN_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = window_label(n);

    ensure_dev_server_reachable(app)?;

    // Cascade from the window the user is actually looking at. The main window
    // is the fallback when nothing is focused (e.g. the thumbbar button was
    // clicked while the app was in the background).
    let parent = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    let (mut x, mut y) = match parent.as_ref().and_then(|w| w.outer_position().ok()) {
        Some(p) => (p.x as f64, p.y as f64),
        None => (80.0, 60.0),
    };
    x += CASCADE_STEP.0;
    y += CASCADE_STEP.1;

    let window =
        tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title("Agamiz Code")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .decorations(false)
            // `main` disables drag-drop because the custom title bar implements its
            // own window dragging; match it so the two windows behave identically.
            .disable_drag_drop_handler()
            .background_color(tauri::window::Color(
                WINDOW_BACKGROUND.0,
                WINDOW_BACKGROUND.1,
                WINDOW_BACKGROUND.2,
                0xff,
            ))
            .position(x, y)
            .visible(true)
            .focused(true)
            .build()
            .map_err(|e| format!("{label}: {e}"))?;

    // Belt and braces: the creation-time focus hint is advisory, and a window
    // that opens behind its parent reads as "nothing happened".
    let _ = window.set_focus();
    log::info!(
        "[new-window] {label} shown at {:?} size {:?}",
        window.outer_position().map(|p| (p.x, p.y)),
        window.inner_size().map(|s| (s.width, s.height))
    );

    // Give the new window its own taskbar thumbnail-toolbar buttons. If the
    // taskbar button does not exist yet this fails; the focus hook in
    // `on_window_event` retries it.
    #[cfg(target_os = "windows")]
    if let Err(e) = thumbbar::install(app, &window) {
        log::warn!("[thumbbar] {label}: {e} (will retry when focused)");
    }
    Ok(label)
}

/// IPC command wrapper around [`spawn_editor_window`].
///
/// Returns the new window's label on success. The frontend shows the label in
/// its confirmation so the user can tell *which* window opened, and — the
/// point of returning a `Result` at all — so a rejection becomes a real error
/// message instead of an unconditional success toast over a window that never
/// appeared.
#[tauri::command]
fn new_window(app: AppHandle) -> Result<String, String> {
    spawn_editor_window(&app)
}

/// Add a folder/file to the OS "Recent" list (Windows taskbar jump list).
/// No-op on non-Windows platforms.
#[tauri::command]
fn add_recent(path: String) -> Result<(), String> {
    add_recent_impl(&path)
}

#[cfg(target_os = "windows")]
fn add_recent_impl(path: &str) -> Result<(), String> {
    use windows::Win32::UI::Shell::{SHAddToRecentDocs, SHARD_PATHW};
    let mut wide: Vec<u16> = path.encode_utf16().collect();
    wide.push(0);
    unsafe {
        SHAddToRecentDocs(
            SHARD_PATHW.0 as u32,
            Some(wide.as_ptr() as *const core::ffi::c_void),
        );
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn add_recent_impl(_path: &str) -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The path-confinement allow-list starts holding the app's own
            // config directory, so `settings.json` and the extension store are
            // reachable before a workspace is ever opened. Without this, the
            // first `read_file` on the config dir would be rejected.
            seed_config_root();

            if cfg!(debug_assertions) {
                let _ = app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                );
            }

            // --- Extension host -------------------------------------------------
            // The host needs an AppHandle (to emit events) and a root
            // directory, so it is created here and published as Tauri managed
            // state. Startup activation and the hot-reload watcher are kicked
            // off on a background thread: a slow or broken extension must not
            // delay the first window paint.
            let handle = app.handle().clone();
            match ext::commands::ensure_root() {
                Ok(root) => {
                    let host = StdArc::new(ext::ExtensionHost::new(root));
                    host.set_sink(StdArc::new(ext::AppEventSink(handle.clone())));
                    app.manage(StdArc::clone(&host));

                    let boot_handle = handle.clone();
                    std::thread::Builder::new()
                        .name("agamiz-ext-boot".to_string())
                        .spawn(move || {
                            // Deref coercion: `&Arc<ExtensionHost>` -> `&ExtensionHost`.
                            let host_ref: &ext::ExtensionHost = &host;
                            ext::host::activate_startup(host_ref);
                            ext::commands::start_watcher(&boot_handle, &host);
                        })
                        .ok();
                }
                Err(e) => log::error!("[ext] disabled: {e}"),
            }

            #[cfg(target_os = "windows")]
            {
                // Thumbnail-toolbar buttons on the main window's taskbar
                // hover preview. Editor windows get their own set when they
                // are created (see `spawn_editor_window`).
                let handle = app.handle().clone();
                if let Some(main) = handle.get_webview_window("main") {
                    if let Err(e) = thumbbar::install(&handle, &main) {
                        log::warn!("[thumbbar] main window: {e} (will retry when focused)");
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Extensions hold Lua VMs that are shared by every window, so they
            // must outlive any single window. Tearing them down on *any*
            // `Destroyed` meant closing one New Window silently killed every
            // extension in the surviving windows — their language servers,
            // formatters and command contributions vanished with no error.
            //
            // They are only released once the last window is gone, which is
            // the point where nothing can observe them any more.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let app_handle = window.app_handle().clone();
                // `Destroyed` can arrive before the window leaves the manager's
                // registry, so exclude this one explicitly before counting.
                let remaining = app_handle
                    .webview_windows()
                    .keys()
                    .filter(|label| label.as_str() != window.label())
                    .count();
                if remaining == 0 {
                    if let Some(host) = app_handle.try_state::<StdArc<ext::ExtensionHost>>() {
                        // Deref coercion: `State<Arc<ExtensionHost>>` -> `&ExtensionHost`.
                        let host_ref: &ext::ExtensionHost = &host;
                        ext::commands::deactivate_all(&app_handle, host_ref);
                    }
                }
            }
            // Safety net: if ThumbBarAddButtons ran before the taskbar button
            // existed, retry the first time the window is focused.
            if let tauri::WindowEvent::Focused(true) = event {
                #[cfg(target_os = "windows")]
                {
                    let handle = window.app_handle().clone();
                    // `on_window_event` hands us the plain `Window`, but the
                    // thumbbar API needs the `WebviewWindow` — look it up
                    // by the window's label.
                    if let Some(wv) = handle.get_webview_window(window.label()) {
                        if let Err(e) = thumbbar::install(&handle, &wv) {
                            log::debug!("[thumbbar] {} retry failed: {e}", window.label());
                        }
                    }
                }
                #[cfg(not(target_os = "windows"))]
                let _ = window;
            }
        })
        .invoke_handler(tauri::generate_handler![
            run_rak,
            stop_rak,
            rakc_version,
            list_shells,
            proc_kill,
            save_file,
            read_file,
            path_info,
            list_dir,
            list_files_recursive,
            current_dir,
            create_file,
            create_dir,
            delete_file,
            user_config_dir,
            register_workspace_root,
            register_allowed_root,
            home_dir,
            inspect_project,
            create_project,
            rename_file,
            duplicate_file,
            open_in_explorer,
            exec_result,
            spawn_program,
            proc_write,
            proc_stop,
            node_inspect,
            lsp_start,
            lsp_send,
            lsp_stop,
            terminal::pty_profiles,
            terminal::pty_spawn,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_kill,
            new_window,
            add_recent,
            // Polyglot run/debug: interpreter discovery, routed execution, DAP.
            interpreter::detect_interpreters,
            interpreter::probe_interpreter,
            executor::describe_target,
            executor::run_target,
            executor::run_write,
            executor::run_stop,
            dap::list_debug_adapters,
            dap::select_debug_adapter,
            dap::dap_start,
            dap::dap_send,
            dap::dap_stop,
            dap::dap_alive,
            // Lua extension framework.
            ext::commands::ext_list,
            ext::commands::ext_registry,
            ext::commands::ext_root,
            ext::commands::ext_open_folder,
            ext::commands::ext_set_enabled,
            ext::commands::ext_reload,
            ext::commands::ext_deactivate_all,
            ext::commands::ext_run_command,
            ext::commands::ext_install_folder,
            ext::commands::ext_install_zip,
            ext::commands::ext_install_git,
            ext::commands::ext_install_dev,
            ext::commands::ext_uninstall,
            ext::commands::ext_sync_workspace,
            ext::commands::ext_emit_event,
            ext::commands::ext_broadcast_event,
            ext::commands::ext_notify_save,
            ext::commands::ext_activate_for
        ])
        .manage(terminal::PtyRegistry::new())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod confine_tests {
    use super::*;

    /// A scratch directory that stands in for a workspace root.
    struct Fixture {
        root: PathBuf,
        outside: PathBuf,
    }

    impl Fixture {
        fn new(tag: &str) -> Self {
            let base =
                std::env::temp_dir().join(format!("agamiz-confine-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            let root = base.join("workspace");
            let outside = base.join("elsewhere");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir_all(&outside).unwrap();
            fs::write(root.join("a.ts"), "hello").unwrap();
            fs::write(outside.join("secret"), "nope").unwrap();
            Fixture { root, outside }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(base) = self.root.parent() {
                let _ = fs::remove_dir_all(base);
            }
        }
    }

    /// The allow-list and the workspace root are process-global, so these tests
    /// must not run concurrently — each one replaces both, and without this
    /// they clobber each other and fail intermittently depending on ordering.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Run `f` with `root` as the only allowed root and the active workspace.
    ///
    /// The root is canonicalized on the way in, exactly as
    /// `register_workspace_root` does in production. This matters: `confine`
    /// canonicalizes the *candidate*, so an allow-list holding a non-canonical
    /// root never matches — `std::env::temp_dir()` in particular is not
    /// canonical on Windows and is a symlink on macOS.
    fn with_roots<T>(root: &std::path::Path, f: impl FnOnce() -> T) -> T {
        let _guard = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let canonical = root.canonicalize().expect("fixture root must exist");
        *workspace_root_lock() = Some(canonical.clone());
        {
            let mut roots = roots_lock();
            roots.clear();
            roots.push(canonical);
        }
        let out = f();
        // Leave the process in a clean state for whatever runs next.
        *workspace_root_lock() = None;
        roots_lock().clear();
        out
    }

    #[test]
    fn accepts_a_path_inside_the_root() {
        let f = Fixture::new("inside");
        with_roots(&f.root, || {
            let path = f.root.join("a.ts");
            assert!(confine(&path.to_string_lossy()).is_ok());
        });
    }

    #[test]
    fn accepts_a_path_that_does_not_exist_yet() {
        // `create_file` and Save As both name a file that is not there yet, and
        // `canonicalize` fails on that — so the lenient ancestor walk is what
        // makes them work at all.
        let f = Fixture::new("missing");
        with_roots(&f.root, || {
            let path = f.root.join("new").join("deep").join("b.ts");
            assert!(confine(&path.to_string_lossy()).is_ok());
        });
    }

    #[test]
    fn rejects_a_sibling_with_a_shared_prefix() {
        let f = Fixture::new("prefix");
        with_roots(&f.root, || {
            let sibling = f.root.parent().unwrap().join("workspace-evil").join("a.ts");
            fs::create_dir_all(sibling.parent().unwrap()).unwrap();
            assert!(confine(&sibling.to_string_lossy()).is_err());
        });
    }

    #[test]
    fn rejects_an_unrelated_path() {
        let f = Fixture::new("outside");
        with_roots(&f.root, || {
            let secret = f.outside.join("secret");
            assert!(
                confine(&secret.to_string_lossy()).is_err(),
                "a path outside every allowed root must be refused"
            );
        });
    }

    #[test]
    fn rejects_a_traversal_that_escapes_the_root() {
        let f = Fixture::new("traversal");
        with_roots(&f.root, || {
            let escape = format!("{}/../elsewhere/secret", f.root.to_string_lossy());
            assert!(confine(&escape).is_err());
        });
    }

    #[test]
    fn rejects_an_empty_path() {
        let f = Fixture::new("empty");
        with_roots(&f.root, || {
            assert!(confine("").is_err());
        });
    }

    #[test]
    fn extra_allowed_roots_are_honoured() {
        let f = Fixture::new("allowed");
        with_roots(&f.root, || {
            let secret = f.outside.join("secret");
            assert!(confine(&secret.to_string_lossy()).is_err());
            add_allowed_root(f.outside.canonicalize().unwrap());
            assert!(
                confine(&secret.to_string_lossy()).is_ok(),
                "a path the user picked in a dialog must become reachable"
            );
        });
    }

    #[test]
    fn delete_scope_is_the_workspace_only() {
        let f = Fixture::new("deletescope");
        with_roots(&f.root, || {
            // Inside the workspace: allowed.
            let inside = f.root.join("a.ts");
            assert!(confine_to_workspace(&inside.to_string_lossy()).is_ok());
            // Allowed by the wider list, but not by the workspace: refused,
            // because `delete_file` on a directory is a recursive delete.
            add_allowed_root(f.outside.canonicalize().unwrap());
            let outside = f.outside.join("secret");
            assert!(confine(&outside.to_string_lossy()).is_ok());
            assert!(confine_to_workspace(&outside.to_string_lossy()).is_err());
        });
    }

    #[test]
    fn no_workspace_means_no_deletes() {
        let f = Fixture::new("noworkspace");
        let _guard = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        *workspace_root_lock() = None;
        {
            let mut roots = roots_lock();
            roots.clear();
            roots.push(f.root.canonicalize().unwrap());
        }
        let inside = f.root.join("a.ts");
        assert!(confine(&inside.to_string_lossy()).is_ok());
        assert!(confine_to_workspace(&inside.to_string_lossy()).is_err());
        *workspace_root_lock() = None;
        roots_lock().clear();
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;

    /// The capability file grants IPC permissions to `"main"` and to the glob
    /// `"editor-*"`. Tauri resolves that glob at window-creation time, so a
    /// label that does not match gets a window with *no* permissions at all —
    /// it renders, but open-folder, save, the terminal and New Window itself
    /// are all rejected inside it. That failure is silent at build time and
    /// looks nothing like its cause, which is why it is pinned here.
    const CAPABILITIES: &str = include_str!("../capabilities/default.json");

    #[test]
    fn window_label_matches_capability() {
        let expected_glob = format!("\"{WINDOW_LABEL_PREFIX}-*\"");
        assert!(
            CAPABILITIES.contains(&expected_glob),
            "capabilities/default.json must grant permissions to {expected_glob} so that \
             windows built by `window_label` ({}) can use IPC. Without it, every New \
             Window opens with zero permissions and no error.",
            window_label(1)
        );
    }

    #[test]
    fn window_labels_are_unique_and_glob_compatible() {
        let labels: Vec<String> = (1..=4).map(window_label).collect();
        // Unique: the manager keys windows by label, so a collision would make
        // `build()` fail with `WebviewLabelAlreadyExists`.
        let mut sorted = labels.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            labels.len(),
            "labels must be unique: {labels:?}"
        );
        // Glob-compatible: the `*` in `editor-*` has to be able to swallow the
        // counter, so the prefix must not itself contain a separator.
        assert!(
            !WINDOW_LABEL_PREFIX.contains('-'),
            "prefix must be a single segment"
        );
        for label in &labels {
            assert!(
                label.starts_with(&format!("{WINDOW_LABEL_PREFIX}-")),
                "{label}"
            );
        }
    }
}
