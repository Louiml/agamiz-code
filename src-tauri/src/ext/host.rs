//! Extension lifecycle: discover → load → activate → dispatch → deactivate.
//!
//! The invariant that shapes this file: **an extension can fail, but the IDE
//! cannot.** Every entry point that runs third-party Lua does so inside
//! `catch_unwind` as well as `pcall`, because `pcall` only catches Lua errors —
//! a Rust panic raised inside an `agamiz.*` callback would otherwise unwind
//! through the Lua C stack. A failing extension is reported in the Extensions
//! panel and disabled for the session; it never takes the process down.
//!
//! Activation is lazy, driven by `activationEvents`, so opening a Python file
//! does not pay to start a Rust-language extension.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mlua::{Function, Lua, LuaSerdeExt, MultiValue, Table, Value};

use crate::ext::manifest::load_manifest;
use crate::ext::sandbox;
use crate::ext::{ExtensionHost, ExtensionRecord, ExtensionManifest};

/// Sub-folder of the install root whose contents are watched and hot-reloaded.
pub const DEV_DIR: &str = "dev";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Scan the install root and refresh [`ExtensionHost::discovered`].
///
/// Two layouts are scanned: `extensions/<id>/` for installed extensions, and
/// `extensions/dev/<id>/` for ones under development. A directory that is not
/// itself an extension (like `dev/`) is simply skipped, so the two-level scan
/// is what keeps them from colliding.
pub fn discover(host: &ExtensionHost) -> Vec<ExtensionRecord> {
    let mut found: BTreeMap<String, ExtensionRecord> = BTreeMap::new();
    let mut locations: BTreeMap<String, PathBuf> = BTreeMap::new();

    for (dir, source) in scan_dirs(&host.root) {
        let name = match dir.file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => continue,
        };
        if !dir.join("extension.json").is_file() {
            continue;
        }

        let (record, error) = match load_manifest(&dir) {
            Ok(manifest) => (build_record(host, &manifest, &dir, source, None), None),
            Err(e) => {
                let record =
                    build_record(host, &fallback_manifest(&name), &dir, source, Some(e.clone()));
                (record, Some(e))
            }
        };

        // The directory name is authoritative for identity: a manifest that
        // fails to parse still needs a stable row in the panel so the user can
        // see *why* it failed and uninstall it.
        let id = record.id.clone();
        locations.insert(id.clone(), dir);
        found.insert(id.clone(), record);
        if let Some(e) = error {
            if let Ok(mut registry) = host.registry.lock() {
                registry.errors.insert(id, e);
            }
        }
    }

    if let Ok(mut discovered) = host.discovered.lock() {
        *discovered = locations;
    }

    found.into_values().collect()
}

/// `(directory, source)` pairs to inspect: the root's children, plus each
/// child of `dev/`.
fn scan_dirs(root: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut dirs = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return dirs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if name == DEV_DIR {
            if let Ok(children) = std::fs::read_dir(&path) {
                for child in children.flatten() {
                    if child.path().is_dir() {
                        dirs.push((child.path(), "dev"));
                    }
                }
            }
            continue;
        }
        dirs.push((path, "installed"));
    }
    dirs
}

/// Stand-in manifest so a broken `extension.json` still renders a row.
fn fallback_manifest(dir_name: &str) -> ExtensionManifest {
    ExtensionManifest {
        name: if crate::ext::manifest::is_valid_extension_id(dir_name) {
            dir_name.to_string()
        } else {
            "unknown".to_string()
        },
        display_name: Some(dir_name.to_string()),
        version: "0.0.0".to_string(),
        description: None,
        author: None,
        repository: None,
        main: "extension.lua".to_string(),
        files: Vec::new(),
        activation_events: Vec::new(),
        permissions: Vec::new(),
    }
}

fn build_record(
    host: &ExtensionHost,
    manifest: &ExtensionManifest,
    dir: &Path,
    source: &str,
    error: Option<String>,
) -> ExtensionRecord {
    let id = manifest.name.clone();
    let (commands, status_items, panels, project_templates) = {
        let owned = host
            .registry
            .lock()
            .ok()
            .and_then(|r| r.by_extension.get(&id).cloned())
            .unwrap_or_default();
        (
            owned.commands,
            owned.status,
            owned.panels,
            owned.project_templates,
        )
    };

    ExtensionRecord {
        id: id.clone(),
        display_name: manifest.label().to_string(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        author: manifest.author.clone(),
        repository: manifest.repository.clone(),
        path: dir.to_string_lossy().to_string(),
        source: source.to_string(),
        enabled: host.is_enabled(&id),
        active: host
            .vms
            .lock()
            .map(|vms| vms.contains_key(&id))
            .unwrap_or(false),
        permissions: manifest.permissions.clone(),
        activation_events: manifest.activation_events.clone(),
        error,
        commands,
        status_items,
        panels,
        project_templates,
    }
}

/// Find an extension's directory by id, preferring the `dev/` copy.
///
/// The id is validated first. `uninstall` and `destination_for` both check
/// `is_valid_extension_id`, but `locate` did not — and `id` is joined onto the
/// extensions root, so `invoke('ext_reload', { id: '../../repos/evil' })` where
/// that folder happens to contain an `extension.json` would load and execute its
/// `main` chunk from outside the extensions root. Reachable from
/// `ext_open_folder`, `ext_set_enabled`, `ext_reload`, `ext_run_command` and
/// `ext_activate_for`.
pub fn locate(host: &ExtensionHost, id: &str) -> Option<PathBuf> {
    if !crate::ext::manifest::is_valid_extension_id(id) {
        log::warn!("[ext] rejected invalid extension id {id:?}");
        return None;
    }
    let dev = host.root.join(DEV_DIR).join(id);
    if dev.join("extension.json").is_file() {
        return Some(dev);
    }
    let installed = host.root.join(id);
    if installed.join("extension.json").is_file() {
        return Some(installed);
    }
    None
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/// Whether `event` is one of `manifest`'s activation events.
pub fn matches_activation(manifest: &ExtensionManifest, event: &str) -> bool {
    manifest.activation_events.iter().any(|declared| {
        declared == event || declared == "*" && matches!(event, "onStartup")
    })
}

/// True when the extension wants to be running as soon as the IDE starts.
pub fn wants_startup(manifest: &ExtensionManifest) -> bool {
    manifest
        .activation_events
        .iter()
        .any(|e| e == "*" || e == "onStartup")
}

/// Load every extension that asked to be active at startup.
///
/// Individual failures are recorded on the extension's row rather than
/// aborting the sweep, so one bad extension cannot hide the rest.
pub fn activate_startup(host: &ExtensionHost) {
    let records = discover(host);
    for record in records {
        if !record.enabled || record.error.is_some() {
            continue;
        }
        let Some(dir) = locate(host, &record.id) else {
            continue;
        };
        let Ok(manifest) = load_manifest(&dir) else {
            continue;
        };
        if !wants_startup(&manifest) {
            log::debug!(
                "[ext] {} is lazy (activationEvents={:?})",
                record.id,
                manifest.activation_events
            );
            continue;
        }
        if let Err(e) = activate(host, &record.id, &dir, &manifest) {
            log::warn!("[ext] {} failed to activate: {e}", record.id);
        }
    }
}

/// Build a VM for `id`, run its entry chunk, and call `activate(context)`.
///
/// The whole body runs under `catch_unwind` (see the module docs). On success
/// the VM is published into `host.vms`; on failure it is dropped and the
/// error is recorded, so a broken extension costs nothing but a red row.
pub fn activate(
    host: &ExtensionHost,
    id: &str,
    dir: &Path,
    manifest: &ExtensionManifest,
) -> Result<(), String> {
    if host.is_active(id) {
        return Ok(());
    }

    let Some(ctx) = host.context_for(id, dir, &manifest.permissions) else {
        return Err("extension host is not attached to an application".to_string());
    };

    // A fresh state per activation is the isolation boundary: globals, module
    // cache, hooks and memory limits all start clean, and dropping the state
    // on deactivate releases every callback the extension ever registered.
    let lua = Lua::new();

    let entry = manifest
        .resolve_within(dir, &manifest.main)
        .map_err(|e| format!("entry point: {e}"))?;
    let source = std::fs::read_to_string(&entry)
        .map_err(|e| format!("could not read {}: {e}", entry.display()))?;

    // Scoped so the `Table`/`Function` handles — which borrow the VM — are
    // dropped before `lua` is moved into the registry below.
    {
        let env = sandbox::build_env(&lua, ctx.clone())
            .map_err(|e| format!("sandbox setup failed: {e}"))?;

        // Deliberately *not* the absolute path. Lua truncates long chunk names
        // to ~60 characters with an ellipsis in the middle, so a full path
        // produces errors like `[string "C:\Users\...\agamiz-ext-te..."]` —
        // which does not say which file failed. `<id>/<main>` stays short and
        // identifies the extension unambiguously.
        let chunk_name = format!("{id}/{}", manifest.main);
        guard("loading the entry point", || {
            lua.load(&source)
                .set_name(chunk_name.clone())
                .set_environment(env.clone())
                .exec()
        })?;

        // `activate(context)` is optional: an extension may be a passive bundle
        // of contributed metadata with no lifecycle at all.
        if let Ok(Value::Function(activate_fn)) = env.get::<_, Value>("activate") {
            let context = build_context(&lua, &ctx).map_err(|e| e.to_string())?;
            guard("running activate()", || activate_fn.call::<_, MultiValue>(context))
                .map_err(|e| format!("activate() failed: {e}"))?;
        }
    }

    host.vms
        .lock()
        .map_err(|_| "VM map lock poisoned".to_string())?
        .insert(id.to_string(), Arc::new(std::sync::Mutex::new(lua)));

    if let Ok(mut registry) = host.registry.lock() {
        registry.errors.remove(id);
    }
    log::info!("[ext] {id} activated");
    Ok(())
}

/// The table handed to `activate(context)`.
fn build_context<'lua>(lua: &'lua Lua, ctx: &sandbox::ExtCtx) -> mlua::Result<Table<'lua>> {
    let table = lua.create_table()?;
    table.set("id", ctx.id.as_str())?;
    table.set("root", ctx.root.to_string_lossy().as_ref())?;

    let permissions = lua.create_table()?;
    for permission in ctx.permissions.iter() {
        permissions.set(permission.as_str(), true)?;
    }
    table.set("permissions", permissions)?;

    // `subscriptions` mirrors the disposable convention the JS extension
    // context already uses, so an author can `table.insert(ctx.subscriptions,
    // d)` and forget about it — `deactivate` drops the VM and the VM drops
    // the callbacks.
    let subscriptions = lua.create_table()?;
    table.set("subscriptions", subscriptions)?;
    Ok(table)
}

/// Call `deactivate()` and discard the VM and all its contributions.
pub fn deactivate(host: &ExtensionHost, id: &str) -> Result<(), String> {
    // Take the VM out first: after this point nothing can call into it, so a
    // failing `deactivate` cannot leave a half-live extension behind.
    let vm = host.vms.lock().ok().and_then(|mut vms| vms.remove(id));
    let Some(vm) = vm else {
        revoke(host, id);
        return Ok(());
    };

    let lua = vm.lock().map_err(|_| "VM lock poisoned".to_string())?;
    if let Ok(handlers) = sandbox::handlers(&lua) {
        if let Ok(Some(env)) = handlers.get::<_, Option<Table>>("env") {
            if let Ok(Value::Function(deactivate_fn)) = env.get::<_, Value>("deactivate") {
                if let Err(e) = guard("running deactivate()", || {
                    deactivate_fn.call::<_, MultiValue>(())
                }) {
                    log::warn!("[ext] {id} deactivate() failed: {e}");
                }
            }
        }
    }
    drop(lua);

    revoke(host, id);
    log::info!("[ext] {id} deactivated");
    Ok(())
}

/// Remove everything an extension contributed and drop its error row.
fn revoke(host: &ExtensionHost, id: &str) {
    if let Ok(mut registry) = host.registry.lock() {
        registry.revoke(id);
    }
}

/// Tear an extension down and bring it back up — the hot-reload path.
pub fn reload(host: &ExtensionHost, id: &str) -> Result<(), String> {
    deactivate(host, id)?;
    let Some(dir) = locate(host, id) else {
        return Err(format!("extension {id:?} is not installed"));
    };
    let manifest = load_manifest(&dir)?;
    if !host.is_enabled(id) {
        return Ok(());
    }
    activate(host, id, &dir, &manifest)
}

/// Run `f`, converting both Lua errors and Rust panics into a `String`.
///
/// `catch_unwind` is what makes "an extension can never crash the IDE" true in
/// practice: a panic inside a native callback would otherwise unwind through
/// the Lua interpreter's C frames.
///
/// The return value is deliberately discarded. Every guarded call is a
/// lifecycle hook or a callback whose result nobody needs, and pinning it to
/// `()` keeps the `MultiValue` (which carries a borrow of the VM) from leaking
/// into the caller's error handling.
fn guard<T>(what: &str, f: impl FnOnce() -> mlua::Result<T>) -> Result<(), String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map(|_| ()).map_err(|e| format!("{what}: {e}")),
        Err(panic) => {
            let detail = panic
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            log::error!("[ext] panic while {what}: {detail}");
            Err(format!("{what}: extension panicked ({detail})"))
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatch: frontend → Lua
// ---------------------------------------------------------------------------

impl ExtensionHost {
    /// Whether `id` currently has a live VM.
    pub fn is_active(&self, id: &str) -> bool {
        self.vms
            .lock()
            .map(|vms| vms.contains_key(id))
            .unwrap_or(false)
    }
}

/// Invoke a registered command.
///
/// The callback is looked up inside the extension's own VM, so a command id can
/// never reach across extension boundaries, and the whole call is guarded.
pub fn run_command(host: &ExtensionHost, command_id: &str, args: Vec<String>) -> Result<(), String> {
    let extension_id = {
        let registry = host.registry.lock().map_err(|_| "registry lock poisoned")?;
        registry
            .commands
            .get(command_id)
            .map(|c| c.extension_id.clone())
            .ok_or_else(|| format!("unknown command {command_id:?}"))?
    };

    if !host.is_active(&extension_id) {
        return Err(format!(
            "extension {extension_id:?} is not active, so {command_id:?} cannot run"
        ));
    }

    let vm = {
        let vms = host.vms.lock().map_err(|_| "VM map lock poisoned")?;
        Arc::clone(vms.get(&extension_id).ok_or("extension is no longer active")?)
    };
    let lua = vm.lock().map_err(|_| "VM lock poisoned".to_string())?;

    guard(&format!("running command {command_id:?}"), || {
        let handlers = sandbox::handlers(&lua)?;
        let commands: Table = handlers.get::<_, Table>("commands")?;
        let callback: Function = commands.get::<_, Function>(command_id)?;
        // Arguments are passed as a single table so an extension can accept a
        // variadic list without the host having to know its arity.
        let args_table = lua.create_table()?;
        for (index, value) in args.iter().enumerate() {
            args_table.set(index + 1, value.as_str())?;
        }
        callback.call::<_, MultiValue>(args_table)
    })
}

/// Deliver a frontend-originated event to `agamiz.on` listeners.
///
/// A no-op when the extension is not active, because a lazy extension that has
/// not been activated has nothing listening yet — and because silently
/// buffering events for extensions that may never activate is a memory leak
/// with no payoff.
pub fn dispatch_event(
    host: &ExtensionHost,
    extension_id: &str,
    event: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    if !host.is_active(extension_id) {
        return Ok(());
    }
    let vm = {
        let vms = host.vms.lock().map_err(|_| "VM map lock poisoned")?;
        match vms.get(extension_id) {
            Some(vm) => Arc::clone(vm),
            None => return Ok(()),
        }
    };
    let lua = vm.lock().map_err(|_| "VM lock poisoned".to_string())?;

    guard(&format!("dispatching {event:?}"), || {
        let handlers = sandbox::handlers(&lua)?;
        let events: Table = handlers.get::<_, Table>("events")?;
        match events.get::<_, Value>(event)? {
            Value::Function(callback) => {
                let payload_table = lua.to_value(payload)?;
                callback.call::<_, MultiValue>((event, payload_table))
            }
            _ => Ok(MultiValue::new()),
        }
    })
}

/// Tell an extension a file was saved (`agamiz.workspace.on_did_save_file`).
pub fn notify_save(host: &ExtensionHost, path: &str) -> Result<(), String> {
    let targets: Vec<String> = {
        let vms = host.vms.lock().map_err(|_| "VM map lock poisoned")?;
        vms.keys().cloned().collect()
    };

    for extension_id in targets {
        let vm = {
            let vms = host.vms.lock().map_err(|_| "VM map lock poisoned")?;
            match vms.get(&extension_id) {
                Some(vm) => Arc::clone(vm),
                None => continue,
            }
        };
        let lua = vm.lock().map_err(|_| "VM lock poisoned".to_string())?;
        let result = guard(&format!("notifying save to {extension_id}"), || {
            let handlers = sandbox::handlers(&lua)?;
            let workspace: Table = handlers.get::<_, Table>("workspace")?;
            match workspace.get::<_, Value>("on_did_save_file")? {
                Value::Function(callback) => callback.call::<_, MultiValue>((path,)),
                _ => Ok(MultiValue::new()),
            }
        });
        if let Err(e) = result {
            log::warn!("[ext] {extension_id} on_did_save_file failed: {e}");
        }
    }
    Ok(())
}
