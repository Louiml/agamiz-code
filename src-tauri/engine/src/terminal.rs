use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::HashMap;
use portable_pty::{native_pty_system, Child, MasterPty, PtySize, CommandBuilder};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    reader: Option<Box<dyn std::io::Read + Send>>,
}

impl TerminalSession {
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        use std::io::Write;
        self.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn take_reader(&mut self) -> Option<Box<dyn std::io::Read + Send>> {
        self.reader.take()
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<u64, TerminalSession>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn(&self, cwd: Option<&std::path::Path>) -> Result<u64, String> {
        let pty_system = native_pty_system();
        let shell = default_shell();
        let mut cmd = CommandBuilder::new(&shell);

        #[cfg(windows)]
        cmd.args(["-NoLogo"]);

        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;
        let master = pair.master;
        let writer = master.take_writer().map_err(|e| e.to_string())?;
        let reader = master
            .try_clone_reader()
            .map_err(|e| format!("read clone failed: {e}"))?;

        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let session = TerminalSession {
            master,
            writer,
            child,
            reader: Some(reader),
        };

        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, session);

        Ok(id)
    }

    pub fn take_reader(&self, id: u64) -> Result<Box<dyn std::io::Read + Send>, String> {
        let mut guard = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = guard.get_mut(&id).ok_or_else(|| "terminal not found".to_string())?;
        session.take_reader().ok_or_else(|| "reader already taken".to_string())
    }

    pub fn write(&self, id: u64, data: &str) -> Result<(), String> {
        let mut guard = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = guard.get_mut(&id).ok_or_else(|| "terminal not found".to_string())?;
        session.write(data)
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), String> {
        let mut guard = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = guard.get_mut(&id).ok_or_else(|| "terminal not found".to_string())?;
        session.resize(cols, rows)
    }

    pub fn close(&self, id: u64) {
        if let Ok(mut guard) = self.sessions.lock() {
            guard.remove(&id);
        }
    }
}

#[cfg(windows)]
fn default_shell() -> String {
    let programfiles = std::env::var("PROGRAMFILES").unwrap_or_default();
    let systemroot = std::env::var("SYSTEMROOT").unwrap_or_default();
    let pwsh = std::path::Path::new(&programfiles).join("PowerShell/7/pwsh.exe");
    if pwsh.exists() {
        return pwsh.to_string_lossy().to_string();
    }
    let powershell = std::path::Path::new(&systemroot)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if powershell.exists() {
        return powershell.to_string_lossy().to_string();
    }
    "powershell.exe".to_string()
}

#[cfg(not(windows))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
}

pub static TERMINAL_MANAGER: std::sync::LazyLock<Arc<TerminalManager>> =
    std::sync::LazyLock::new(|| Arc::new(TerminalManager::new()));