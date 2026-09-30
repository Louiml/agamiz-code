//! Tauri IPC surface for the extension host.
//!
//! Every command here is a thin, validating wrapper: the interesting logic
//! lives in [`super::host`], [`super::install`] and [`super::manifest`], and
//! these functions exist to turn those into the argument/return shapes the
//! webview expects. Keeping them thin means the host can be driven by the
//! watcher, the CLI or a test without an `AppHandle` in the way.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::ext::{
    host, install, manifest, watcher, ExtensionHost, ExtensionRecord, RegistrySnapshot,
    TextPosition, TextRange, WorkspaceSnapshot,
};

type Host<'a> = State<'a, Arc<ExtensionHost>>;

/// Default install root, created on demand.
///
/// `~/.agamizcode/extensions` rather than the `%APPDATA%/AgamizCode` location
/// the existing `user_config_dir` command uses: extensions are a Unix-style
/// developer tree (folders, git checkouts, a watched `dev/` subfolder), and
/// keeping it in a predictable dot-directory is what makes the CLI and the IDE
/// agree on where things are without extra configuration.
pub fn default_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "could not resolve a home directory".to_string())?;
    Ok(PathBuf::from(home).join(".agamizcode").join("extensions"))
}

/// The extensions root, ensuring it exists.
pub fn ensure_root() -> Result<PathBuf, String> {
    let root = default_root()?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("could not create {}: {e}", root.display()))?;
    std::fs::create_dir_all(root.join(host::DEV_DIR))
        .map_err(|e| format!("could not create the dev folder: {e}"))?;
    Ok(root)
}

/// Push the full extension list and contribution registry to the webview.
///
/// Called after anything that can change either: install, uninstall, enable,
/// activate, deactivate, reload.
pub fn publish(app: &AppHandle, host: &ExtensionHost) {
    let _ = app.emit(crate::ext::events::EXTENSIONS, host::discover(host));
    let snapshot = host
        .registry
        .lock()
        .map(|registry| registry.snapshot())
        .unwrap_or_default();
    let _ = app.emit(crate::ext::events::REGISTRY, snapshot);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ext_list(host: Host) -> Vec<ExtensionRecord> {
    host::discover(&host)
}

#[tauri::command]
pub fn ext_registry(host: Host) -> RegistrySnapshot {
    host.registry
        .lock()
        .map(|registry| registry.snapshot())
        .unwrap_or_default()
}

#[tauri::command]
pub fn ext_root() -> Result<String, String> {
    Ok(ensure_root()?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ext_open_folder(app: AppHandle, id: String) -> Result<(), String> {
    let dir = host::locate(&app.state::<Arc<ExtensionHost>>(), &id)
        .ok_or_else(|| format!("extension {id:?} is not installed"))?;
    let program = if cfg!(target_os = "windows") {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ext_set_enabled(
    app: AppHandle,
    host: Host,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    if let Ok(mut flags) = host.enabled.lock() {
        flags.insert(id.clone(), enabled);
    }

    if enabled {
        // Enabling is only meaningful if the extension wants to be running; a
        // lazy one activates on its first matching event.
        if let Some(dir) = host::locate(&host, &id) {
            if let Ok(manifest) = manifest::load_manifest(&dir) {
                if host::wants_startup(&manifest) {
                    if let Err(e) = host::activate(&host, &id, &dir, &manifest) {
                        publish(&app, &host);
                        return Err(e);
                    }
                }
            }
        }
    } else if let Err(e) = host::deactivate(&host, &id) {
        publish(&app, &host);
        return Err(e);
    }

    publish(&app, &host);
    Ok(())
}

#[tauri::command]
pub fn ext_reload(app: AppHandle, host: Host, id: String) -> Result<(), String> {
    let result = host::reload(&host, &id);
    publish(&app, &host);
    result
}

#[tauri::command]
pub fn ext_deactivate_all(app: AppHandle, host: Host) {
    deactivate_all(&app, &host);
}

/// Non-`#[tauri::command]` core, so `on_window_event` can call it directly.
pub fn deactivate_all(app: &AppHandle, host: &ExtensionHost) {
    let ids: Vec<String> = host
        .vms
        .lock()
        .map(|vms| vms.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        if let Err(e) = host::deactivate(host, &id) {
            log::warn!("[ext] {id} failed to deactivate cleanly: {e}");
        }
    }
    publish(app, host);
}

#[tauri::command]
pub fn ext_run_command(
    app: AppHandle,
    host: Host,
    id: String,
    args: Option<Vec<String>>,
) -> Result<(), String> {
    let result = host::run_command(&host, &id, args.unwrap_or_default());
    if result.is_err() {
        // Surface the failure in the output channel too: a command that throws
        // should say so where the user is already looking.
        let message = result.clone().err().unwrap_or_default();
        let _ = app.emit(
            crate::ext::events::LOG,
            serde_json::json!({
                "extensionId": "",
                "level": "error",
                "text": format!("command {id}: {message}"),
            }),
        );
    }
    result
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ext_install_folder(
    app: AppHandle,
    host: Host,
    path: String,
) -> Result<ExtensionRecord, String> {
    let root = ensure_root()?;
    let installed = install::install_from_folder(&root, std::path::Path::new(&path))?;
    let _ = host::activate(
        &host,
        &installed.id,
        &installed.path,
        &manifest::load_manifest(&installed.path)?,
    );
    publish(&app, &host);
    find_record(&app, &installed.id)
}

#[tauri::command]
pub fn ext_install_zip(
    app: AppHandle,
    host: Host,
    path: String,
) -> Result<ExtensionRecord, String> {
    let root = ensure_root()?;
    let installed = install::install_from_zip(&root, std::path::Path::new(&path))?;
    let _ = host::activate(
        &host,
        &installed.id,
        &installed.path,
        &manifest::load_manifest(&installed.path)?,
    );
    publish(&app, &host);
    find_record(&app, &installed.id)
}

#[tauri::command]
pub fn ext_install_git(
    app: AppHandle,
    host: Host,
    url: String,
    reference: Option<String>,
) -> Result<ExtensionRecord, String> {
    let root = ensure_root()?;
    let installed = install::install_from_git(&root, &url, reference.as_deref())?;
    let _ = host::activate(
        &host,
        &installed.id,
        &installed.path,
        &manifest::load_manifest(&installed.path)?,
    );
    publish(&app, &host);
    find_record(&app, &installed.id)
}

#[tauri::command]
pub fn ext_uninstall(app: AppHandle, host: Host, id: String) -> Result<(), String> {
    host::deactivate(&host, &id)?;
    let root = ensure_root()?;
    install::uninstall(&root, &id)?;
    if let Ok(mut flags) = host.enabled.lock() {
        flags.remove(&id);
    }
    publish(&app, &host);
    Ok(())
}

/// Install straight into the watched `dev/` folder, so it hot-reloads.
#[tauri::command]
pub fn ext_install_dev(
    app: AppHandle,
    host: Host,
    path: String,
) -> Result<ExtensionRecord, String> {
    let root = ensure_root()?;
    let staged =
        install::install_from_folder(&root.join(host::DEV_DIR), std::path::Path::new(&path))?;
    let _ = host::activate(
        &host,
        &staged.id,
        &staged.path,
        &manifest::load_manifest(&staged.path)?,
    );
    publish(&app, &host);
    find_record(&app, &staged.id)
}

fn find_record(app: &AppHandle, id: &str) -> Result<ExtensionRecord, String> {
    host::discover(&app.state::<Arc<ExtensionHost>>())
        .into_iter()
        .find(|record| record.id == id)
        .ok_or_else(|| format!("extension {id:?} was installed but did not appear in the list"))
}

// ---------------------------------------------------------------------------
// Frontend → Lua
// ---------------------------------------------------------------------------

/// Mirror the editor and workspace state so the Lua API can answer
/// synchronously. See the ownership note in [`crate::ext`].
#[tauri::command]
pub fn ext_sync_workspace(host: Host, snapshot: WorkspaceSnapshot) -> Result<(), String> {
    let mut guard = host
        .snapshot
        .write()
        .map_err(|_| "workspace snapshot lock poisoned".to_string())?;
    *guard = normalize(snapshot);
    Ok(())
}

/// Clamp incoming positions and normalise an absent selection.
///
/// The webview is trusted to be well-behaved but not to be *correct*: a stale
/// cursor line can exceed a buffer that was just replaced. Clamping here keeps
/// a bad snapshot from turning into a panic inside an extension.
fn normalize(mut snapshot: WorkspaceSnapshot) -> WorkspaceSnapshot {
    fn clamp(position: TextPosition, text: &str) -> TextPosition {
        let lines: Vec<&str> = text.split('\n').collect();
        let line = position.line.min(lines.len().saturating_sub(1) as u32);
        let width = lines
            .get(line as usize)
            .map(|l| l.chars().count() as u32)
            .unwrap_or(0);
        TextPosition {
            line,
            character: position.character.min(width),
        }
    }

    if let Some(range) = snapshot.selection {
        let start = clamp(range.start, &snapshot.active_text);
        let end = clamp(range.end, &snapshot.active_text);
        snapshot.selection = Some(if start <= end {
            TextRange { start, end }
        } else {
            TextRange {
                start: end,
                end: start,
            }
        });
    }
    snapshot.cursor = clamp(snapshot.cursor, &snapshot.active_text);
    snapshot
}

/// Deliver an event to `agamiz.on` listeners in one extension.
#[tauri::command]
pub fn ext_emit_event(
    host: Host,
    extension_id: String,
    event: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    host::dispatch_event(&host, &extension_id, &event, &payload)
}

/// Deliver an event to every active extension (a broadcast).
#[tauri::command]
pub fn ext_broadcast_event(
    host: Host,
    event: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let ids: Vec<String> = host
        .vms
        .lock()
        .map(|vms| vms.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        if let Err(e) = host::dispatch_event(&host, &id, &event, &payload) {
            log::warn!("[ext] broadcast {event:?} to {id} failed: {e}");
        }
    }
    Ok(())
}

/// Tell extensions a file was saved.
#[tauri::command]
pub fn ext_notify_save(host: Host, path: String) -> Result<(), String> {
    host::notify_save(&host, &path)
}

/// Activate anything whose `activationEvents` match `event`, then report which
/// ids are now running. Used for `onLanguage:` and `onCommand:` activation.
#[tauri::command]
pub fn ext_activate_for(app: AppHandle, host: Host, event: String) -> Result<Vec<String>, String> {
    let mut activated = Vec::new();
    for record in host::discover(&host) {
        if !record.enabled || record.error.is_some() || host.is_active(&record.id) {
            continue;
        }
        let Some(dir) = host::locate(&host, &record.id) else {
            continue;
        };
        let Ok(manifest) = manifest::load_manifest(&dir) else {
            continue;
        };
        if !host::matches_activation(&manifest, &event) {
            continue;
        }
        match host::activate(&host, &record.id, &dir, &manifest) {
            Ok(()) => activated.push(record.id),
            Err(e) => log::warn!("[ext] {} failed to activate: {e}", record.id),
        }
    }
    if !activated.is_empty() {
        publish(&app, &host);
    }
    Ok(activated)
}

/// Start the dev-folder hot-reload watcher.
pub fn start_watcher(app: &AppHandle, host: &Arc<ExtensionHost>) {
    watcher::start(app.clone(), Arc::clone(host));
}
