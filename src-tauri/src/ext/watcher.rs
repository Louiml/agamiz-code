//! Hot reload for extensions under `~/.agamizcode/extensions/dev/`.
//!
//! Only the `dev/` subtree is watched. Production extensions are treated as
//! immutable once installed, so a stray editor write or a background tool
//! touching an installed folder cannot cause a surprise reload.
//!
//! Edits are debounced because editors do not save atomically in practice: a
//! single logical save routinely produces several filesystem events (write,
//! rename-in, metadata touch), and reloading on each one would re-run
//! `activate()` two or three times per save.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};

use crate::ext::host;
use crate::ext::ExtensionHost;

/// Quiet period after the last filesystem event before reloading.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// How often the loop wakes to service pending reloads.
const TICK: Duration = Duration::from_millis(120);

/// Start watching the dev folder. Returns immediately; reloads happen on a
/// background thread and announce themselves on the `ext://extensions` channel.
///
/// A watcher that fails to start is logged and forgotten: hot reload is a
/// developer convenience, and losing it must not stop the IDE from booting.
pub fn start(app: tauri::AppHandle, host: Arc<ExtensionHost>) {
    let dev_root = host.root.join(host::DEV_DIR);
    if let Err(e) = std::fs::create_dir_all(&dev_root) {
        log::warn!("[ext] could not create {}: {e}", dev_root.display());
        return;
    }
    if !dev_root.exists() {
        return;
    }

    let (tx, rx) = channel::<PathBuf>();

    let mut watcher: notify::RecommendedWatcher = match notify::recommended_watcher(
        move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            if !matches!(
                event.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Remove(_)
            ) {
                return;
            }
            let Some(path) = event.paths.first() else {
                return;
            };
            // Ignore the noise a git checkout or an editor backup leaves
            // behind.
            if !is_noise(path) {
                let _ = tx.send(path.to_path_buf());
            }
        },
    ) {
        Ok(watcher) => watcher,
        Err(e) => {
            log::warn!("[ext] hot reload unavailable: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&dev_root, RecursiveMode::Recursive) {
        log::warn!("[ext] could not watch {}: {e}", dev_root.display());
        return;
    }

    // The watcher must outlive this function, so it is moved into the thread
    // rather than dropped.
    std::thread::Builder::new()
        .name("agamiz-ext-watch".to_string())
        .spawn(move || {
            let _watcher = watcher;
            let mut pending: HashMap<String, Instant> = HashMap::new();

            loop {
                match rx.recv_timeout(TICK) {
                    Ok(path) => {
                        if let Some(id) = extension_id_for(&host, &path) {
                            pending.insert(id, Instant::now());
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    // The sender is owned by the watcher, which lives as long
                    // as this thread, so a disconnect means it is shutting
                    // down.
                    Err(RecvTimeoutError::Disconnected) => break,
                }

                let now = Instant::now();
                let ready: Vec<String> = pending
                    .iter()
                    .filter(|(_, at)| now.duration_since(**at) >= DEBOUNCE)
                    .map(|(id, _)| id.clone())
                    .collect();

                for id in ready {
                    pending.remove(&id);
                    log::info!("[ext] hot reloading {id}");
                    if let Err(e) = host::reload(&host, &id) {
                        log::warn!("[ext] hot reload of {id} failed: {e}");
                    }
                    crate::ext::commands::publish(&app, &host);
                }
            }
            log::debug!("[ext] hot reload watcher stopped");
        })
        .ok();
}

/// Extensions live at `dev/<id>/…`; map any path under the dev root to its id.
fn extension_id_for(host: &ExtensionHost, path: &std::path::Path) -> Option<String> {
    let dev_root = host.root.join(host::DEV_DIR);
    let relative = path.strip_prefix(&dev_root).ok()?;
    let mut components = relative.components();
    let id = components.next()?.as_os_str().to_string_lossy().to_string();
    if id.starts_with('.') || id.is_empty() {
        return None;
    }
    Some(id)
}

/// Filter out paths that produce events but never change what Lua sees.
fn is_noise(path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    if name.starts_with('.') {
        return true;
    }
    if name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".swx")
        || name.ends_with(".tmp")
        || name.ends_with(".bak")
    {
        return true;
    }
    // Only Lua sources and the manifest can change an extension's behaviour.
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("lua") | Some("json")
    )
}
