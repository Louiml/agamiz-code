pub mod client;
pub mod protocol;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use client::{DapClient, DapSessionStatus};
use protocol::Message;

/// Describes a runnable debug configuration (adapter + program arguments).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfig {
    pub name: String,
    /// Debug adapter binary, e.g. `node --inspect` vs a DAP server.
    pub adapter: String,
    /// Optional CLI args for the adapter process.
    #[serde(default)]
    pub args: Vec<String>,
    /// `launch` or `attach`.
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Program / target arguments passed to the adapter.
    pub program: String,
    #[serde(rename = "cwd")]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

fn default_mode() -> String {
    "launch".to_string()
}

/// A single active debug session. Kept alive from launch/detach until disconnect.
struct Session {
    client: DapClient,
    config: DebugConfig,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("config", &self.config.name)
            .field("status", &self.client.status())
            .finish()
    }
}

pub struct DapManager {
    sessions: Mutex<HashMap<u64, Arc<Mutex<Session>>>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl DapManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Resolve the adapter binary to a command + args. If the configured
    /// `adapter` actually embeds the program (already a DAP server binary),
    /// we just run it; otherwise we synthesize a node/dap adapter stub.
    fn resolve_command(&self, config: &DebugConfig) -> (PathBuf, Vec<String>) {
        let bin = PathBuf::from(&config.adapter);
        let mut args = config.args.clone();
        // For Node, allow a plain script with `--inspect-brk` via a small DAP-ish wrapper.
        // Most adapters (vscode-js-debug) take the program directly; we forward it.
        if bin.exists() {
            return (bin, args);
        }
        // Fall back: treat adapter as a bootstrap script in the repo, or shell it out.
        let program = PathBuf::from(&config.program);
        if program.exists() {
            // Best-effort: launch the target if it self-hosts DAP (e.g. codelldb, node-debug2).
            args.insert(0, program.to_string_lossy().to_string());
            return (bin, args);
        }
        (bin, args)
    }

    pub fn start(
        &self,
        config: DebugConfig,
        app: AppHandle,
    ) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (binary, args) = self.resolve_command(&config);

        let on_event_app = app.clone();
        let on_event: Arc<dyn Fn(Message) + Send + Sync> = Arc::new(move |msg| {
            if let Message::Event { event, body, .. } = msg {
                let event_name = format!("dap:event:{}", event);
                let _ = on_event_app.emit(&event_name, (id, body));
            }
        });

        let on_exit_app = app.clone();
        let on_exit: Arc<dyn Fn(Option<i64>) + Send + Sync> =
            Arc::new(move |code| {
                let _ = on_exit_app.emit("dap:exit", (id, code));
            });

        let cwd = config
            .cwd
            .clone()
            .unwrap_or(std::env::current_dir().unwrap_or_default());
        let client = DapClient::spawn(&binary, &args, &cwd, Some(on_event), Some(on_exit))
            .map_err(|e| format!("failed to start debug adapter: {e}"))?;

        let session = Session {
            client,
            config,
        };
        self.sessions.lock().unwrap().insert(id, Arc::new(Mutex::new(session)));
        let _ = app.emit("dap:started", (id, ()));
        Ok(id)
    }

    fn with_session<T>(
        &self,
        id: u64,
        f: impl FnOnce(&DapClient) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self
            .sessions
            .lock()
            .map_err(|e| e.to_string())?;
        let session = guard.get(&id).ok_or("no such debug session")?.clone();
        drop(guard);
        let session_guard = session.lock().map_err(|e| e.to_string())?;
        f(&session_guard.client)
    }

    pub fn install_breakpoints(
        &self,
        id: u64,
        source_path: &str,
        lines: Vec<i64>,
    ) -> Result<Vec<protocol::Breakpoint>, String> {
        self.with_session(id, |c| c.set_breakpoints(source_path, &lines))
    }

    pub fn initialize(&self, id: u64, adapter_id: &str) -> Result<serde_json::Value, String> {
        self.with_session(id, |c| c.initialize(adapter_id))
    }

    pub fn launch(
        &self,
        id: u64,
        args: serde_json::Value,
        configuration_done: bool,
    ) -> Result<(), String> {
        self.with_session(id, |c| {
            c.launch(args)?;
            if configuration_done {
                c.configuration_done()?;
            }
            Ok(())
        })
    }

    pub fn attach(
        &self,
        id: u64,
        args: serde_json::Value,
        configuration_done: bool,
    ) -> Result<(), String> {
        self.with_session(id, |c| {
            c.attach(args)?;
            if configuration_done {
                c.configuration_done()?;
            }
            Ok(())
        })
    }

    pub fn threads(&self, id: u64) -> Result<Vec<protocol::Thread>, String> {
        self.with_session(id, |c| c.threads())
    }

    pub fn stack_trace(&self, id: u64, thread_id: i64) -> Result<Vec<protocol::StackFrame>, String> {
        self.with_session(id, |c| c.stack_trace(thread_id, None))
    }

    pub fn scopes(&self, id: u64, frame_id: i64) -> Result<Vec<protocol::Scope>, String> {
        self.with_session(id, |c| c.scopes(frame_id))
    }

    pub fn variables(&self, id: u64, var_ref: i64) -> Result<Vec<protocol::Variable>, String> {
        self.with_session(id, |c| c.variables(var_ref))
    }

    pub fn continue_run(&self, id: u64, thread_id: i64) -> Result<(), String> {
        self.with_session(id, |c| {
            c.continue_run(thread_id)?;
            c.set_status(DapSessionStatus::Running);
            Ok(())
        })
    }

    pub fn next(&self, id: u64, thread_id: i64) -> Result<(), String> {
        self.with_session(id, |c| c.next(thread_id))
    }

    pub fn step_in(&self, id: u64, thread_id: i64) -> Result<(), String> {
        self.with_session(id, |c| c.step_in(thread_id))
    }

    pub fn step_out(&self, id: u64, thread_id: i64) -> Result<(), String> {
        self.with_session(id, |c| c.step_out(thread_id))
    }

    pub fn pause(&self, id: u64, thread_id: i64) -> Result<(), String> {
        self.with_session(id, |c| c.pause(thread_id))
    }

    /// Detach / terminate a session. Graceful when the adapter is running,
    /// always best-effort so a dead adapter cannot wedge the debugger.
    pub fn stop(&self, id: u64) -> Result<(), String> {
        let session = {
            let guard = self.sessions.lock().map_err(|e| e.to_string())?;
            let session = guard.get(&id).cloned().ok_or("no such debug session")?;
            session
        };
        let mut guard = session.lock().map_err(|e| e.to_string())?;
        let _ = guard.client.disconnect();
        Ok(())
    }

    pub fn running(&self, id: u64) -> bool {
        let session = self
            .sessions
            .lock()
            .ok()
            .and_then(|g| g.get(&id).cloned());
        match session {
            Some(s) => s
                .lock()
                .map(|guard| guard.client.status() == DapSessionStatus::Running)
                .unwrap_or(false),
            None => false,
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<u64> = self
            .sessions
            .lock()
            .map(|g| g.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            let _ = self.stop(id);
        }
    }
}

impl Default for DapManager {
    fn default() -> Self {
        Self::new()
    }
}

pub static DAP_MANAGER: std::sync::LazyLock<Arc<DapManager>> =
    std::sync::LazyLock::new(|| Arc::new(DapManager::new()));