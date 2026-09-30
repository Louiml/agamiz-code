//! Debug Adapter Manager — a Debug Adapter Protocol (DAP) transport plus the
//! adapter registry that decides which adapter debugs which language.
//!
//! DAP is a JSON-RPC-ish protocol over a byte stream with `Content-Length`
//! headers, so the transport mirrors the existing LSP plumbing: spawn the
//! adapter over stdio, frame outgoing messages, and surface incoming ones as
//! `dap-message` events carrying the raw JSON body. All request/response
//! correlation, event routing and state tracking lives in the TypeScript
//! `DebugSession` client; Rust owns only the pipe.
//!
//! Node is deliberately *not* here. `node --inspect-brk` speaks the Chrome
//! DevTools Protocol, and the existing CDP client in `debug.ts` already drives
//! it well, so the adapter registry reports `node-inspector` as the adapter
//! id and the frontend picks the transport.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Emitter};

/// A running adapter session.
struct Adapter {
    child: Child,
    stdin: ChildStdin,
}

static ADAPTERS: LazyLock<Mutex<HashMap<u64, Adapter>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// A debug adapter the manager can launch.
#[derive(serde::Serialize, Clone)]
pub struct AdapterInfo {
    pub id: String,
    pub label: String,
    /// Language ids this adapter can debug.
    pub languages: Vec<String>,
    /// True when the adapter's entry point resolved on this machine.
    pub available: bool,
    /// How the manager knows: `path` or `module`.
    pub source: String,
    /// Program to launch, for display and diagnostics.
    pub program: String,
}

/// Resolve a program name to an absolute path, tolerating a missing PATH.
fn which(program: &str) -> Option<String> {
    crate::interpreter::which(program)
}

/// Run a command to completion and capture stdout (used to prove an adapter is
/// actually importable, not merely present on PATH).
fn capture(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Static table of known adapters.
///
/// `entry` is either a bare executable (`codelldb`) or a Python module invoked
/// as `python -m <module>` (`debugpy`), which is why `module` adapters carry a
/// `module` field.
struct AdapterSpec {
    id: &'static str,
    label: &'static str,
    languages: &'static [&'static str],
    /// Executable to look for, when the adapter is a standalone binary.
    program: &'static str,
    /// Python module, for adapters installed inside an interpreter.
    module: Option<&'static str>,
    /// Interpreter spec id used to run `module` adapters.
    host: Option<&'static str>,
}

const ADAPTER_SPECS: &[AdapterSpec] = &[
    AdapterSpec {
        id: "debugpy",
        label: "Python (debugpy)",
        languages: &["python"],
        program: "debugpy",
        module: Some("debugpy"),
        host: Some("python"),
    },
    AdapterSpec {
        id: "codelldb",
        label: "C/C++ (LLDB via CodeLLDB)",
        languages: &["c", "cpp"],
        program: "codelldb",
        module: None,
        host: None,
    },
    AdapterSpec {
        id: "gdb",
        label: "C/C++ (GDB)",
        languages: &["c", "cpp"],
        program: "gdb",
        module: None,
        host: None,
    },
    AdapterSpec {
        id: "lldb",
        label: "C/C++ (LLDB)",
        languages: &["c", "cpp"],
        program: "lldb",
        module: None,
        host: None,
    },
    AdapterSpec {
        id: "dlv",
        label: "Go (Delve)",
        languages: &["go"],
        program: "dlv",
        module: None,
        host: None,
    },
];

/// Candidate adapters for a language, in preference order.
fn specs_for(language: &str) -> Vec<&'static AdapterSpec> {
    ADAPTER_SPECS
        .iter()
        .filter(|spec| spec.languages.contains(&language))
        .collect()
}

/// List every known adapter with its availability on this machine.
///
/// Availability is not just "on PATH": `debugpy` is installed as a Python
/// module in the active interpreter far more often than as a script, so the
/// probe falls back to `python -m debugpy --version`.
#[tauri::command]
pub fn list_debug_adapters(language: String, tools: HashMap<String, String>) -> Vec<AdapterInfo> {
    let mut out = Vec::new();
    let wanted = specs_for(&language);

    for spec in &wanted {
        let standalone = which(spec.program);
        // Module adapters run through their host interpreter, which must honour
        // the user's pinned virtualenv — resolving via `interpreter` applies
        // both the workspace override and the PATH fallback ladder.
        let host = spec
            .host
            .map(|host_id| crate::interpreter::resolve_tool(host_id, &tools));

        let (available, program, source) = match (spec.module, host) {
            // Module adapter: only usable if the host interpreter can import it.
            (Some(module), Some(host_program)) => {
                let ok = capture(&host_program, &["-m", module, "--version"]).is_some();
                (ok, host_program, "module".to_string())
            }
            (Some(_), None) => (false, String::new(), "module".to_string()),
            (None, _) => match &standalone {
                Some(path) => (true, path.clone(), "path".to_string()),
                None => (false, spec.program.to_string(), "path".to_string()),
            },
        };

        out.push(AdapterInfo {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            languages: spec.languages.iter().map(|l| l.to_string()).collect(),
            available,
            source,
            program,
        });
    }

    out
}

/// Pick the adapter to use for a language, honouring an explicit choice and
/// otherwise taking the first available one.
#[tauri::command]
pub fn select_debug_adapter(
    language: String,
    preferred: String,
    tools: HashMap<String, String>,
) -> Option<String> {
    if !preferred.is_empty() {
        return Some(preferred);
    }
    list_debug_adapters(language, tools)
        .into_iter()
        .find(|a| a.available)
        .map(|a| a.id)
}

/// Read `Content-Length` framed DAP messages from the adapter and re-emit each
/// JSON body as a `dap-message` event.
fn pump_messages(app: AppHandle, session: u64, stdout: std::process::ChildStdout) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut content_length: Option<usize> = None;

            // Header block: `Key: value` lines terminated by a blank line.
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => return, // adapter closed stdout
                    Ok(_) => {}
                    Err(_) => return,
                }
                let trimmed = line.trim_end();
                if trimmed.is_empty() {
                    break; // end of headers
                }
                if let Some((name, value)) = trimmed.split_once(':') {
                    if name.trim().eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse::<usize>().ok();
                    }
                }
            }

            let Some(length) = content_length else {
                continue; // malformed header block; resynchronise
            };

            let mut body = vec![0u8; length];
            if reader.read_exact(&mut body).is_err() {
                return;
            }
            let text = String::from_utf8_lossy(&body).to_string();
            if app
                .emit("dap-message", DapMessage { session, text })
                .is_err()
            {
                return;
            }
        }
    });
}

/// A decoded DAP message body forwarded to the frontend.
#[derive(serde::Serialize, Clone)]
struct DapMessage {
    session: u64,
    text: String,
}

/// Spawn an adapter and start pumping its messages.
///
/// Launch shape depends on the adapter: standalone binaries are executed
/// directly, while module adapters (debugpy) are launched through their host
/// interpreter. `port` is embedded in debugpy's `--port` form so the frontend
/// can show which port is in use.
#[tauri::command]
pub fn dap_start(
    app: AppHandle,
    session: u64,
    adapter: String,
    tools: HashMap<String, String>,
    port: u16,
) -> Result<String, String> {
    let spec = ADAPTER_SPECS
        .iter()
        .find(|s| s.id == adapter)
        .ok_or_else(|| format!("Unknown debug adapter: {adapter}"))?;

    // Replace any adapter already running under this session.
    if let Some(mut old) = ADAPTERS.lock().unwrap().remove(&session) {
        let _ = old.child.kill();
        let _ = old.child.wait();
    }

    let (program, args): (String, Vec<String>) = match (spec.module, spec.host) {
        (Some(module), Some(host)) => {
            let host_program = crate::interpreter::resolve_tool(host, &tools);
            let mut args = vec!["-m".to_string(), module.to_string()];
            if adapter == "debugpy" {
                // `--port` makes the adapter listen instead of spawning a
                // debuggee itself; the frontend launches the program itself so
                // build steps stay in the executor.
                args.push("--port".to_string());
                args.push(port.to_string());
                args.push("--wait-for-client".to_string());
            }
            (host_program, args)
        }
        // Standalone binary: adapters such as codelldb take the program path
        // as their first positional argument.
        _ => {
            let path = which(spec.program)
                .ok_or_else(|| format!("`{}` is not installed or not on PATH.", spec.program))?;
            (path, Vec::new())
        }
    };

    let mut child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start adapter `{adapter}`: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Adapter stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Adapter stdout unavailable".to_string())?;

    ADAPTERS
        .lock()
        .unwrap()
        .insert(session, Adapter { child, stdin });

    pump_messages(app, session, stdout);
    Ok(program)
}

/// Send a raw DAP message body; framing headers are added here.
#[tauri::command]
pub fn dap_send(session: u64, json: String) -> Result<(), String> {
    let mut adapters = ADAPTERS.lock().unwrap();
    let adapter = adapters
        .get_mut(&session)
        .ok_or_else(|| "No debug adapter is running for this session.".to_string())?;
    // `str::len()` is the UTF-8 byte count, which is what Content-Length is
    // specified in. Under-reporting a non-ASCII payload desynchronises the
    // adapter's frame parser.
    let payload = format!("Content-Length: {}\r\n\r\n{}", json.len(), json);
    adapter
        .stdin
        .write_all(payload.as_bytes())
        .and_then(|_| adapter.stdin.flush())
        .map_err(|e| format!("Failed writing to adapter: {e}"))
}

/// Terminate the adapter for a session.
#[tauri::command]
pub fn dap_stop(session: u64) -> Result<(), String> {
    if let Some(mut adapter) = ADAPTERS.lock().unwrap().remove(&session) {
        let _ = adapter.child.kill();
        let _ = adapter.child.wait();
    }
    Ok(())
}

/// True when an adapter session is still alive (used to reconcile UI state
/// after a crash or an external stop).
#[tauri::command]
pub fn dap_alive(session: u64) -> bool {
    ADAPTERS.lock().unwrap().contains_key(&session)
}
