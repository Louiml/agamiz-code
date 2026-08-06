use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use serde::Serialize;

static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
pub struct RunConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub kind: String,
}

struct RunningProcess {
    child: Child,
}

pub struct Runner {
    processes: Mutex<HashMap<u64, RunningProcess>>,
}

impl Runner {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    pub fn detect_configs(&self, root: &Path) -> Vec<RunConfig> {
        let mut configs = Vec::new();

        let pkg = root.join("package.json");
        if let Ok(text) = std::fs::read_to_string(&pkg) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                    for (name, cmd) in scripts {
                        if let Some(cmd) = cmd.as_str() {
                            configs.push(RunConfig {
                                id: format!("npm:{}", name),
                                name: name.clone(),
                                command: cmd.to_string(),
                                kind: "npm-script".to_string(),
                            });
                        }
                    }
                }
            }
        }

        if root.join("Cargo.toml").exists() {
            configs.push(RunConfig {
                id: "cargo:run".to_string(),
                name: "cargo run".to_string(),
                command: "cargo run".to_string(),
                kind: "cargo".to_string(),
            });
            configs.push(RunConfig {
                id: "cargo:build".to_string(),
                name: "cargo build".to_string(),
                command: "cargo build".to_string(),
                kind: "cargo".to_string(),
            });
            configs.push(RunConfig {
                id: "cargo:test".to_string(),
                name: "cargo test".to_string(),
                command: "cargo test".to_string(),
                kind: "cargo".to_string(),
            });
        }

        configs
    }

    pub fn run(
        self: &Arc<Self>,
        config: &RunConfig,
        debug: bool,
        root: &Path,
        app: AppHandle,
    ) -> Result<u64, String> {        let id = NEXT_RUN_ID.fetch_add(1, Ordering::SeqCst);

        let shell = shell_command(&config.command);
        let mut cmd = Command::new(&shell.0);
        cmd.args(&shell.1);

        if debug {
            match config.kind.as_str() {
                "npm-script" => {
                    let has_node =
                        config.command.contains("node") || config.command.contains("npm");
                    if has_node {
                        cmd.env("NODE_OPTIONS", "--inspect=9229");
                    }
                }
                _ => {}
            }
        }

        cmd.current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("failed to launch: {e}"))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let app_clone = app.clone();
        if let Some(out) = stdout {
            std::thread::spawn(move || {
                let reader = BufReader::new(out);
                for line in reader.lines() {
                    let line = line.unwrap_or_default();
                    let _ = app_clone.emit("run:output", (id, "stdout", line));
                }
            });
        }

        let app_clone = app.clone();
        if let Some(err) = stderr {
            std::thread::spawn(move || {
                let reader = BufReader::new(err);
                for line in reader.lines() {
                    let line = line.unwrap_or_default();
                    let _ = app_clone.emit("run:output", (id, "stderr", line));
                }
            });
        }

        self.processes
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, RunningProcess { child });

        let app_clone = app.clone();
        let name = config.name.clone();
        let runner = Arc::clone(self);
        std::thread::spawn(move || {
            let proc = {
                let mut guard = match runner.processes.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                match guard.remove(&id) {
                    Some(p) => p,
                    None => return,
                }
            };
            let mut proc = proc;
            let status = proc.child.wait();
            let exit = status
                .ok()
                .map(|s| s.code().unwrap_or(-1))
                .unwrap_or(-1);
            let _ = app_clone.emit("run:exit", (id, exit, name));
        });

        Ok(id)
    }

    pub fn stop(&self, id: u64) -> Result<(), String> {
        let mut guard = self.processes.lock().map_err(|e| e.to_string())?;
        if let Some(mut proc) = guard.remove(&id) {
            kill_proc(&proc.child);
            let _ = proc.child.kill();
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        if let Ok(mut guard) = self.processes.lock() {
            for (_, mut proc) in guard.drain() {
                kill_proc(&proc.child);
                let _ = proc.child.kill();
            }
        }
    }

    pub fn is_running(&self, id: u64) -> bool {
        self.processes.lock().map(|g| g.contains_key(&id)).unwrap_or(false)
    }
}

fn kill_proc(child: &Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(windows)]
fn shell_command(command: &str) -> (String, Vec<String>) {
    ("cmd".to_string(), vec!["/C".to_string(), command.to_string()])
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> (String, Vec<String>) {
    ("sh".to_string(), vec!["-c".to_string(), command.to_string()])
}

pub static RUNNER: std::sync::LazyLock<Arc<Runner>> =
    std::sync::LazyLock::new(|| Arc::new(Runner::new()));
