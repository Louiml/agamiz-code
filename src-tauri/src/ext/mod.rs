//! The Lua extension host.
//!
//! Ownership model, which is the part worth understanding before reading the
//! individual files:
//!
//! * **One `Lua` state per extension.** A Lua VM is `Send` but *not* `Sync`,
//!   so each state lives in its own `Mutex`. Nothing but a locked guard ever
//!   touches a VM.
//! * **No `Function<'_>` is ever stored in Rust.** Callbacks live in a handler
//!   table *inside* the VM (see [`sandbox::HANDLERS_KEY`]). Rust borrows the
//!   state, looks a callback up by id, and calls it. This keeps the state free
//!   of self-references and means "call extension X's command" needs one lock.
//! * **The registry holds no Lua handles.** Everything the UI renders —
//!   commands, status-bar items, sidebar panels — is plain serializable data
//!   in a separate mutex, so the UI can be refreshed while Lua is running.
//! * **Lock order is always `vms` → `registry` → `snapshot`.** The `agamiz.*`
//!   functions only ever take `registry`/`snapshot`, never `vms`, which is what
//!   makes a Lua callback that itself calls `agamiz.*` safe (no re-entrancy on
//!   the VM lock).
//! * **Editor and workspace state is pushed in, not pulled.** The frontend
//!   calls `ext_sync_workspace` whenever the buffer changes, so
//!   `agamiz.editor.get_active_text()` is a synchronous in-memory read. If Lua
//!   instead had to round-trip to the webview and block, every command
//!   handler would hold the VM lock across an IPC wait.

pub mod api;
pub mod commands;
pub mod host;
pub mod install;
pub mod manifest;
pub mod sandbox;
pub mod watcher;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use mlua::Lua;
use serde::Serialize;

pub use manifest::ExtensionManifest;

/// Channel names for Rust → webview traffic. Namespaced so they cannot collide
/// with the existing `rak-output` / `lsp-message` / `proc-*` channels.
pub mod events {
    /// Full extension list changed (installed, enabled, activated, errored).
    pub const EXTENSIONS: &str = "ext://extensions";
    /// Contribution registry changed (commands, status items, panels).
    pub const REGISTRY: &str = "ext://registry";
    /// A notification the extension asked to show.
    pub const NOTICE: &str = "ext://notice";
    /// A line for the output panel.
    pub const LOG: &str = "ext://log";
    /// A request for the editor to act (insert text, replace selection).
    pub const EDITOR: &str = "ext://editor";
}

// ---------------------------------------------------------------------------
// Registry — plain data describing everything extensions have contributed
// ---------------------------------------------------------------------------

/// A command palette entry contributed by an extension.
#[derive(Serialize, Clone, Debug)]
pub struct CommandRecord {
    pub id: String,
    pub extension_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
}

/// A status-bar entry contributed by an extension.
#[derive(Serialize, Clone, Debug)]
pub struct StatusRecord {
    /// `"{extension_id}:{item_id}"` — namespaced so two extensions can both
    /// use the local id `"status"`.
    pub key: String,
    pub extension_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// `left` | `right`.
    pub alignment: String,
    pub priority: i64,
}

/// A left-sidebar panel contributed by an extension.
#[derive(Serialize, Clone, Debug)]
pub struct PanelRecord {
    pub id: String,
    pub extension_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Extension-defined body rendered as inert text plus a `refresh` action.
    /// The host deliberately does not evaluate extension-supplied markup.
    pub body: String,
}

/// One file an extension wants written into a new project.
///
/// `path` is relative and slash-separated regardless of platform; the Rust
/// side hands it to `create_project`, which resolves it against the project
/// root and refuses anything that escapes.
#[derive(Serialize, Clone, Debug)]
pub struct ProjectTemplateFile {
    pub path: String,
    pub content: String,
}

/// A "New Project" template contributed by an extension.
///
/// Deliberately a *static* file list plus an optional command hook, not a
/// callback: the wizard needs to render a file-tree preview and compute
/// collisions *before* the user commits, which is impossible for a function
/// that only runs at creation time. Extensions that need to shell out to a
/// real generator (a `create-*` CLI, for instance) name a command in
/// `create_command`, which the host invokes with the new project root after the
/// files are on disk.
#[derive(Serialize, Clone, Debug)]
pub struct ProjectTemplateRecord {
    pub id: String,
    pub extension_id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub tags: Vec<String>,
    /// Command run in the new project root after the files are written. Needs
    /// the extension to hold a `process:exec` permission.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_command: Option<String>,
    /// Shown in the terminal after creation, e.g. `npm install`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    /// Relative path opened as the first tab once the project is created.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_file: Option<String>,
    pub files: Vec<ProjectTemplateFile>,
    /// Paths the `create_command` generator is expected to produce, so the
    /// wizard can show them in its preview.
    ///
    /// The host never writes these — the generator does. They exist because a
    /// template that shells out to a real CLI would otherwise preview as an
    /// almost-empty folder, hiding the very files the user is creating the
    /// project *for*. Path-only, no content, and validated as relative.
    pub declared_outputs: Vec<String>,
}

/// Everything the Extensions UI, palette and status bar need in one payload.
#[derive(Serialize, Clone, Debug, Default)]
pub struct RegistrySnapshot {
    pub commands: Vec<CommandRecord>,
    pub status: Vec<StatusRecord>,
    pub panels: Vec<PanelRecord>,
    /// New Project templates, so the wizard can offer extension-contributed
    /// starters alongside the built-in ones.
    pub project_templates: Vec<ProjectTemplateRecord>,
}

/// Mutable contribution store, shared between the host and every Lua VM.
#[derive(Default)]
pub struct Registry {
    pub commands: BTreeMap<String, CommandRecord>,
    pub status: BTreeMap<String, StatusRecord>,
    pub panels: BTreeMap<String, PanelRecord>,
    pub project_templates: BTreeMap<String, ProjectTemplateRecord>,
    /// Extension id → the error that stopped it loading, if any.
    pub errors: BTreeMap<String, String>,
    /// Extension id → ordered list of that extension's contributed ids, so
    /// deactivation can revoke exactly its own contributions.
    pub by_extension: BTreeMap<String, OwnedIds>,
}

/// The ids one extension owns, so they can be removed in one pass.
#[derive(Default, Clone, Debug)]
pub struct OwnedIds {
    pub commands: Vec<String>,
    pub status: Vec<String>,
    pub panels: Vec<String>,
    pub project_templates: Vec<String>,
}

impl Registry {
    /// Remove every contribution belonging to `extension_id`.
    pub fn revoke(&mut self, extension_id: &str) {
        if let Some(owned) = self.by_extension.remove(extension_id) {
            for id in owned.commands {
                self.commands.remove(&id);
            }
            for key in owned.status {
                self.status.remove(&key);
            }
            for id in owned.panels {
                self.panels.remove(&id);
            }
            for id in owned.project_templates {
                self.project_templates.remove(&id);
            }
        }
        self.errors.remove(extension_id);
    }

    /// Record an id as owned, replacing any previous entry for that kind.
    fn own(&mut self, extension_id: &str, slot: fn(&mut OwnedIds) -> &mut Vec<String>, id: String) {
        let entry = self.by_extension.entry(extension_id.to_string()).or_default();
        let list = slot(entry);
        // Re-registering the same id must not duplicate it, or `revoke` would
        // try to remove it twice (harmless, but the list would grow on every
        // hot reload for the lifetime of the session).
        if !list.contains(&id) {
            list.push(id);
        }
    }

    /// Sorted snapshot. `BTreeMap` iteration already gives the ordering;
    /// status items are ordered by descending priority for the status bar.
    pub fn snapshot(&self) -> RegistrySnapshot {
        let mut status: Vec<StatusRecord> = self.status.values().cloned().collect();
        // Highest priority first, then stable by key.
        status.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.key.cmp(&b.key)));
        RegistrySnapshot {
            commands: self.commands.values().cloned().collect(),
            status,
            panels: self.panels.values().cloned().collect(),
            project_templates: self.project_templates.values().cloned().collect(),
        }
    }
}

// ---------------------------------------------------------------------------
// Workspace snapshot — editor state pushed in from the frontend
// ---------------------------------------------------------------------------

#[derive(Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TextPosition {
    /// Zero-based, matching the LSP/editor convention the frontend uses.
    pub line: u32,
    pub character: u32,
}

#[derive(
    Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord,
)]
pub struct TextRange {
    pub start: TextPosition,
    pub end: TextPosition,
}

impl Default for TextPosition {
    fn default() -> Self {
        TextPosition {
            line: 0,
            character: 0,
        }
    }
}

/// The current editor/workspace state, mirrored from the webview.
#[derive(Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct WorkspaceSnapshot {
    pub root: String,
    pub active_path: String,
    pub active_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<TextRange>,
    pub cursor: TextPosition,
    pub language_id: String,
}

// ---------------------------------------------------------------------------
// Extension records — the per-extension view the UI renders
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct ExtensionRecord {
    pub id: String,
    pub display_name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Absolute install folder.
    pub path: String,
    /// `installed` | `dev` — dev extensions live under `extensions/dev` and are
    /// hot-reloaded on save.
    pub source: String,
    pub enabled: bool,
    /// Whether `activate()` has run and not yet been torn down.
    pub active: bool,
    pub permissions: Vec<String>,
    pub activation_events: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub commands: Vec<String>,
    pub status_items: Vec<String>,
    pub panels: Vec<String>,
    /// Ids of the "New Project" templates this extension contributed.
    pub project_templates: Vec<String>,
}

// ---------------------------------------------------------------------------
// Event sink
// ---------------------------------------------------------------------------

/// Where host→webview traffic goes.
///
/// Abstracted so the host's core (activate, dispatch, deactivate) can be
/// exercised in a plain unit test with no Tauri application running. Every
/// real path goes through [`AppEventSink`]; tests use a recorder.
pub trait EventSink: Send + Sync + std::fmt::Debug {
    fn emit(&self, channel: &str, payload: serde_json::Value);
}

/// Production sink: forwards to the webview.
#[derive(Debug)]
pub struct AppEventSink(pub tauri::AppHandle);

impl EventSink for AppEventSink {
    fn emit(&self, channel: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.0.emit(channel, payload);
    }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/// Tauri-managed extension host state.
pub struct ExtensionHost {
    /// Install root, e.g. `~/.agamizcode/extensions`.
    pub root: PathBuf,
    /// Live VMs, keyed by extension id.
    pub vms: Mutex<BTreeMap<String, Arc<Mutex<Lua>>>>,
    /// Contribution registry. Shared with every VM through an `Arc`.
    pub registry: Arc<Mutex<Registry>>,
    /// Editor/workspace mirror. Shared with every VM through an `Arc`.
    pub snapshot: Arc<RwLock<WorkspaceSnapshot>>,
    /// Per-extension enable/disable flags, persisted to `state.json`.
    pub enabled: Mutex<BTreeMap<String, bool>>,
    /// Extensions present on disk but not yet loaded, newest scan wins.
    pub discovered: Mutex<BTreeMap<String, PathBuf>>,
    /// Emit target. `None` until `setup` installs the real one.
    pub sink: RwLock<Option<Arc<dyn EventSink>>>,
}

impl ExtensionHost {
    pub fn new(root: PathBuf) -> Self {
        ExtensionHost {
            root,
            vms: Mutex::new(BTreeMap::new()),
            registry: Arc::new(Mutex::new(Registry::default())),
            snapshot: Arc::new(RwLock::new(WorkspaceSnapshot::default())),
            enabled: Mutex::new(BTreeMap::new()),
            discovered: Mutex::new(BTreeMap::new()),
            sink: RwLock::new(None),
        }
    }

    /// Install the emit target.
    pub fn set_sink(&self, sink: Arc<dyn EventSink>) {
        if let Ok(mut slot) = self.sink.write() {
            *slot = Some(sink);
        }
    }

    /// Whether `id` is enabled, defaulting to enabled when unset.
    pub fn is_enabled(&self, id: &str) -> bool {
        self.enabled
            .lock()
            .ok()
            .and_then(|map| map.get(id).copied())
            .unwrap_or(true)
    }

    /// Build the context handed to a VM's `agamiz.*` closures.
    pub fn context_for(
        &self,
        id: &str,
        root: &std::path::Path,
        permissions: &[String],
    ) -> Option<sandbox::ExtCtx> {
        Some(sandbox::ExtCtx {
            id: id.to_string(),
            root: root.to_path_buf(),
            permissions: Arc::new(permissions.iter().cloned().collect()),
            sink: self.sink.read().ok().and_then(|s| s.clone())?,
            registry: Arc::clone(&self.registry),
            snapshot: Arc::clone(&self.snapshot),
        })
    }
}

impl Registry {
    /// Attach ownership bookkeeping for a command.
    pub fn own_command(&mut self, extension_id: &str, id: String) {
        self.own(extension_id, |o| &mut o.commands, id);
    }
    pub fn own_status(&mut self, extension_id: &str, key: String) {
        self.own(extension_id, |o| &mut o.status, key);
    }
    pub fn own_panel(&mut self, extension_id: &str, id: String) {
        self.own(extension_id, |o| &mut o.panels, id);
    }
    pub fn own_project_template(&mut self, extension_id: &str, id: String) {
        self.own(extension_id, |o| &mut o.project_templates, id);
    }
}
