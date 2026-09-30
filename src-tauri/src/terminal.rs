//! Real PTY sessions for the integrated terminal.
//!
//! The panel used to fake a shell: it spawned `cmd /C <line>` per command and
//! rendered the captured output into `<div>`s. That cannot show ANSI colour,
//! progress bars, curses UIs (vim, fzf, htop) or anything that expects a TTY.
//! This module replaces that with actual pseudo-terminals via `portable-pty`
//! (ConPTY on Windows, `forkpty` on Unix).
//!
//! # Threading model
//!
//! Each session owns two background threads:
//!   * a **reader** blocked in `read()`; it base64-encodes each chunk and
//!     emits `pty-output`,
//!   * a **waiter** polling `Child::try_wait`; it emits `pty-exit` and then
//!     drops the session.
//!
//! Keystrokes and `resize` are handled inline on the Tauri command thread.
//! The master handle and the writer are locked separately so a slow reader
//! never blocks typing.
//!
//! # Wire format
//!
//! Terminal output is arbitrary bytes (not valid UTF-8 in general ג€” box
//! drawing, TUI escapes, partial multi-byte sequences at chunk edges). It is
//! base64-encoded on the Rust side and decoded in the browser before being fed
//! to xterm.js, which is byte-accurate.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// A chunk of PTY output. `data` is base64 of the raw bytes.
#[derive(Serialize, Clone)]
pub struct PtyOutput {
    pub id: u64,
    pub data: String,
}

/// Emitted when the shell process terminates.
#[derive(Serialize, Clone)]
pub struct PtyExit {
    pub id: u64,
    pub code: i32,
}

/// A shell profile as offered in the "new terminal" dropdown.
///
/// Mirrors VS Code's `terminal.integrated.profiles` shape: built-in profiles
/// are probed on the host, `custom` entries come from user settings.
#[derive(Serialize, Clone, Deserialize)]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub program: String,
    /// Default argv (e.g. `["-d", "Ubuntu"]` for WSL). Empty means "no args".
    #[serde(default)]
    pub args: Vec<String>,
    pub available: bool,
    #[serde(default)]
    pub is_default: bool,
    /// Working directory override; empty means "inherit the workspace root".
    #[serde(default)]
    pub cwd: String,
    /// Extra `KEY=VALUE` pairs injected on top of the inherited environment.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Short label used in the session list, e.g. `pwsh`.
    #[serde(default)]
    pub short: String,
    /// Accent colour for the session tab strip.
    #[serde(default)]
    pub color: String,
}

// ---------------------------------------------------------------------------
// Base64 (avoids pulling in a dependency for ~25 lines)
// ---------------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn b64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for b in input.bytes() {
        if b == b'=' || b.is_ascii_whitespace() {
            continue;
        }
        let Some(v) = B64.iter().position(|&x| x == b) else {
            return Err(format!("invalid base64 byte {b}"));
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

/// A live PTY: the master handle (for `resize`), the write half, and the
/// child process. Each field is locked independently so a slow reader never
/// blocks keystrokes.
pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

/// Tauri-managed registry of live PTYs.
///
/// Held as managed state rather than a `static` so the app owns the lifetime
/// and the waiter thread can reach it through the app handle.
pub struct PtyRegistry {
    map: Mutex<HashMap<u64, Arc<PtySession>>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, id: u64) -> Option<Arc<PtySession>> {
        self.map.lock().unwrap().get(&id).cloned()
    }

    fn insert(&self, id: u64, session: PtySession) -> Arc<PtySession> {
        let session = Arc::new(session);
        self.map.lock().unwrap().insert(id, session.clone());
        session
    }

    fn remove(&self, id: u64) -> Option<Arc<PtySession>> {
        self.map.lock().unwrap().remove(&id)
    }
}

impl Default for PtyRegistry {
    fn default() -> Self {
        Self::new()
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Borrow a session out of the managed registry.
fn session_of(app: &AppHandle, id: u64) -> Result<Arc<PtySession>, String> {
    app.try_state::<PtyRegistry>()
        .and_then(|r| r.get(id))
        .ok_or_else(|| "terminal session not found".to_string())
}

// ---------------------------------------------------------------------------
// Shell discovery
// ---------------------------------------------------------------------------

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

#[cfg(target_os = "windows")]
fn first_existing(candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|c| PathBuf::from(c).is_file())
        .map(|c| c.to_string())
}

/// Installed WSL distributions.
///
/// `wsl --list --quiet` writes UTF-16LE (and a NUL byte on some Windows
/// builds), so the raw bytes are decoded rather than assumed to be UTF-8.
#[cfg(target_os = "windows")]
fn wsl_distros() -> Vec<String> {
    let Ok(out) = Command::new("wsl").args(["--list", "--quiet"]).output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let bytes = out.stdout;
    let text = if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };
    text.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("Windows Subsystem"))
        .collect()
}

/// Git Bash installs, from the standard layouts plus the common portable ones.
#[cfg(target_os = "windows")]
fn git_bash_paths() -> Vec<String> {
    let mut found: Vec<String> = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    ]
    .iter()
    .filter_map(|r| first_existing(&[r]))
    .collect();
    // Scoop / Chocolatey / manually extracted installs.
    for base in [
        r"C:\Program Files\Git",
        r"C:\Program Files (x86)\Git",
        r"C:\tools\git",
        r"C:\ProgramData\chocolatey\bin",
    ] {
        if let Some(base) = first_existing(&[base]) {
            let p = PathBuf::from(base).join("bin").join("bash.exe");
            let s = p.to_string_lossy().to_string();
            if p.is_file() && !found.contains(&s) {
                found.push(s);
            }
        }
    }
    found
}

// Accent colours for the built-in profile list. The Unix-only ones are unused
// in a Windows build, where the palette stops at Git Bash.
const C_PWSH: &str = "#38bdf8";
const C_CMD: &str = "#fbbf24";
const C_WSL: &str = "#a78bfa";
const C_BASH: &str = "#34d399";
#[cfg_attr(target_os = "windows", allow(dead_code))]
const C_ZSH: &str = "#f472b6";
#[cfg_attr(target_os = "windows", allow(dead_code))]
const C_FISH: &str = "#f97316";
#[cfg_attr(target_os = "windows", allow(dead_code))]
const C_SHELL: &str = "#94a3b8";

/// Detect the shells that can back a terminal session on this machine.
///
/// `custom` entries come from user settings and are appended verbatim; an
/// entry whose program does not exist is reported as unavailable so the UI
/// can grey it out instead of silently dropping it.
#[tauri::command]
pub fn pty_profiles(custom: Vec<ShellProfile>) -> Vec<ShellProfile> {
    let mut profiles: Vec<ShellProfile> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // PowerShell 7 (`pwsh`) is preferred when installed; otherwise fall
        // back to the always-present Windows PowerShell 5.1.
        let ps = if find_on_path("pwsh") {
            Some(("pwsh", "PowerShell"))
        } else if find_on_path("powershell")
            || PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe").is_file()
        {
            Some(("powershell", "Windows PowerShell"))
        } else {
            None
        };
        if let Some((program, name)) = ps {
            profiles.push(ShellProfile {
                id: "powershell".into(),
                name: name.into(),
                program: program.into(),
                // `-NoLogo` stops ConPTY echoing a second banner; the user's
                // own profile script is still loaded.
                args: vec!["-NoLogo".into()],
                available: true,
                is_default: true,
                cwd: String::new(),
                env: HashMap::new(),
                short: program.into(),
                color: C_PWSH.into(),
            });
        }

        if find_on_path("cmd") || PathBuf::from(r"C:\Windows\System32\cmd.exe").is_file() {
            profiles.push(ShellProfile {
                id: "cmd".into(),
                name: "Command Prompt".into(),
                program: "cmd".into(),
                args: vec![],
                available: true,
                is_default: false,
                cwd: String::new(),
                env: HashMap::new(),
                short: "cmd".into(),
                color: C_CMD.into(),
            });
        }

        if find_on_path("wsl") {
            let distros = wsl_distros();
            if distros.is_empty() {
                // WSL is installed but has no distro: still surface it so the
                // reason it cannot start is visible in the picker.
                profiles.push(ShellProfile {
                    id: "wsl".into(),
                    name: "WSL (no distribution installed)".into(),
                    program: "wsl".into(),
                    args: vec![],
                    available: false,
                    is_default: false,
                    cwd: String::new(),
                    env: HashMap::new(),
                    short: "wsl".into(),
                    color: C_WSL.into(),
                });
            }
            for d in distros {
                profiles.push(ShellProfile {
                    id: format!("wsl:{}", d.to_lowercase().replace(' ', "-")),
                    name: format!("WSL: {d}"),
                    program: "wsl".into(),
                    args: vec!["-d".into(), d.clone()],
                    available: true,
                    is_default: false,
                    cwd: String::new(),
                    env: HashMap::new(),
                    short: "wsl".into(),
                    color: C_WSL.into(),
                });
            }
        }

        // One entry only. Several layouts can resolve to different `bash.exe`
        // paths on a machine with both a system and a portable Git; offering
        // each would fill the picker with what is visibly the same shell (and
        // would collide on the profile id).
        if let Some(bash) = git_bash_paths().into_iter().next() {
            profiles.push(ShellProfile {
                id: "gitbash".into(),
                name: "Git Bash".into(),
                program: bash,
                // `--login -i` sources profile + bashrc; without `-i` the shell
                // reads the PTY as a script and exits at once.
                args: vec!["--login".into(), "-i".into()],
                available: true,
                is_default: false,
                cwd: String::new(),
                env: HashMap::new(),
                short: "bash".into(),
                color: C_BASH.into(),
            });
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for (name, a, b, color) in [
            ("bash", "/bin/bash", "/usr/bin/bash", C_BASH),
            ("zsh", "/bin/zsh", "/usr/bin/zsh", C_ZSH),
            ("fish", "/usr/bin/fish", "/bin/fish", C_FISH),
        ] {
            let program = if PathBuf::from(a).is_file() {
                Some(a.to_string())
            } else if PathBuf::from(b).is_file() {
                Some(b.to_string())
            } else {
                None
            };
            let Some(program) = program else { continue };
            let mut chars = name.chars();
            let pretty = match chars.next() {
                Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
                None => name.to_string(),
            };
            profiles.push(ShellProfile {
                id: name.into(),
                name: pretty,
                program,
                // `-i` keeps bash/zsh interactive inside a PTY and makes them
                // install their prompt and line editor.
                args: vec!["-i".into()],
                available: true,
                is_default: false,
                cwd: String::new(),
                env: HashMap::new(),
                short: name.into(),
                color: color.into(),
            });
        }

        // The login shell always comes last and is the default.
        let login = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty() && PathBuf::from(s).is_file())
            .unwrap_or_else(|| "sh".into());
        let short = login.rsplit('/').next().unwrap_or("sh").to_string();
        profiles.push(ShellProfile {
            id: "shell".into(),
            name: format!("{short} (login shell)"),
            program: login,
            args: vec!["-i".into()],
            available: true,
            is_default: true,
            cwd: String::new(),
            env: HashMap::new(),
            short,
            color: C_SHELL.into(),
        });
    }

    for mut c in custom {
        if c.program.is_empty() {
            c.available = false;
        }
        profiles.push(c);
    }

    profiles
}

// ---------------------------------------------------------------------------
// PTY lifecycle commands
// ---------------------------------------------------------------------------

/// Start a PTY running `program` and return its session id.
///
/// `cols`/`rows` must match the xterm viewport, otherwise full-screen TUI
/// programs (vim, less) draw at the wrong size until the first resize.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let size = PtySize {
        rows: rows.clamp(1, u16::MAX),
        cols: cols.clamp(1, u16::MAX),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    if !cwd.is_empty() && PathBuf::from(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }
    // The child must believe it is on a colour-capable console, otherwise
    // PowerShell, git and cargo all fall back to 16 colours.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in &env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {program}: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let registry = app
        .try_state::<PtyRegistry>()
        .ok_or_else(|| "terminal registry not initialised".to_string())?;
    let session = registry.insert(
        id,
        PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        },
    );

    // Reader: one blocking read per chunk. 16 KiB keeps syscall overhead low
    // without making the base64 payload so big that decoding janks a frame.
    let app_r = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    break;
                }
                Ok(n) => {
                    let _ = app_r.emit(
                        "pty-output",
                        PtyOutput {
                            id,
                            data: b64_encode(&buf[..n]),
                        },
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    // A read failure kills the pump thread, so the session would
                    // otherwise go silent with no clue why. Record it and let the
                    // waiter thread mark the session exited.
                    log::error!("pty session {id} read failed: {e}");
                    break;
                }
            }
        }
    });

    // Waiter: poll for exit so the UI can mark the session dead, then free it.
    let app_w = app.clone();
    std::thread::spawn(move || {
        let code = loop {
            let exited = {
                let mut child = session.child.lock().unwrap();
                match child.try_wait() {
                    Ok(Some(status)) => Some(status.exit_code() as i32),
                    Ok(None) => None,
                    Err(_) => Some(-1),
                }
            };
            if let Some(code) = exited {
                break code;
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        };
        let _ = app_w.emit("pty-exit", PtyExit { id, code });
        if let Some(registry) = app_w.try_state::<PtyRegistry>() {
            registry.remove(id);
        }
    });

    Ok(id)
}

/// Write raw bytes (keystrokes, pasted text, control sequences) to the PTY.
#[tauri::command]
pub fn pty_write(app: AppHandle, id: u64, data: String) -> Result<(), String> {
    let bytes = b64_decode(&data)?;
    let session = session_of(&app, id)?;
    let mut writer = session.writer.lock().unwrap();
    writer
        .write_all(&bytes)
        .map_err(|e| format!("pty write: {e}"))?;
    writer.flush().map_err(|e| format!("pty flush: {e}"))
}

/// Tell the PTY its window changed size (drives `SIGWINCH` / `TIOCSWINSZ`).
#[tauri::command]
pub fn pty_resize(app: AppHandle, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let session = session_of(&app, id)?;
    let result = {
        let master = session.master.lock().unwrap();
        master
            .resize(PtySize {
                rows: rows.clamp(1, u16::MAX),
                cols: cols.clamp(1, u16::MAX),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize: {e}"))
    };
    result
}

/// Kill the shell process and drop the session (the "Kill Terminal" button).
#[tauri::command]
pub fn pty_kill(app: AppHandle, id: u64) -> Result<(), String> {
    let Some(session) = app.try_state::<PtyRegistry>().and_then(|r| r.remove(id)) else {
        return Ok(());
    };
    let mut child = session.child.lock().unwrap();
    let _ = child.kill();
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.process_id() {
        // The direct child is often `cmd.exe`, which would leave a still
        // running grandchild holding the ConPTY open.
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    let _ = child.try_wait();
    Ok(())
}
