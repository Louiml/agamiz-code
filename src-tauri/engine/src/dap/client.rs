use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use crossbeam_channel::Sender;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::protocol::{
    Breakpoint, ContinueArguments, DisconnectArguments, InitializeRequestArguments,
    Message, Scope, ScopesArguments, ScopesResponseBody, SetBreakpointsArguments,
    SetBreakpointsResponseBody, Source, SourceBreakpoint, StackFrame, StackTraceArguments,
    StackTraceResponseBody, StepInArguments, StepOutArguments, Thread, ThreadsResponseBody,
    Variable, VariablesArguments, VariablesResponseBody,
};
use crate::lsp::jsonrpc::{decode_message, encode_message};

static NEXT_SEQ: AtomicI64 = AtomicI64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DapSessionStatus {
    Starting,
    Running,
    Stopped,
    Exited,
    Error,
}

pub type PendingMap = std::collections::HashMap<i64, Sender<Result<Value, String>>>;

/// A live debug adapter process speaking DAP over stdio.
pub struct DapClient {
    child: Child,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<PendingMap>>,
    status: Arc<std::sync::RwLock<DapSessionStatus>>,
    /// Verified breakpoint lines keyed by source path (kept across launch).
    breakpoints: Arc<Mutex<std::collections::HashMap<String, Vec<i64>>>>,
}

impl std::fmt::Debug for DapClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DapClient")
            .field("status", &*self.status.read().unwrap())
            .finish()
    }
}

impl DapClient {
    pub fn spawn(
        adapter_path: &Path,
        args: &[String],
        cwd: &Path,
        on_event: Option<Arc<dyn Fn(Message) + Send + Sync>>,
        on_exit: Option<Arc<dyn Fn(Option<i64>) + Send + Sync>>,
    ) -> Result<Self, String> {
        let mut command = Command::new(adapter_path);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|e| format!("spawn debug adapter: {e}"))?;
        let stdin = child.stdin.take().ok_or("missing stdin handle")?;
        let stdout = child.stdout.take().ok_or("missing stdout handle")?;

        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(PendingMap::new()));
        let status = Arc::new(std::sync::RwLock::new(DapSessionStatus::Starting));
        let child_id = child.id();

        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    eprintln!("[dap:{child_id}] {}", line.unwrap_or_default());
                }
            });
        }

        let pending_reader = Arc::clone(&pending);
        let status_reader = Arc::clone(&status);
        std::thread::spawn(move || {
            read_loop(stdout, pending_reader, status_reader, on_event, on_exit);
        });

        Ok(DapClient {
            child,
            stdin: Mutex::new(stdin),
            pending,
            status,
            breakpoints: Arc::new(Mutex::new(std::collections::HashMap::new())),
        })
    }

    pub fn status(&self) -> DapSessionStatus {
        *self.status.read().unwrap()
    }

    pub fn set_status(&self, s: DapSessionStatus) {
        *self.status.write().unwrap() = s;
    }

    fn next_seq() -> i64 {
        NEXT_SEQ.fetch_add(1, Ordering::SeqCst)
    }

    fn write_message(&self, msg: &Message) -> Result<(), String> {
        let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        let framed = encode_message(&body);
        self.stdin
            .lock()
            .unwrap()
            .write_all(&framed)
            .map_err(|e| format!("write to DAP failed: {e}"))
    }

    /// Send a request and block for the response.
    pub fn request<Req: Serialize, Res: DeserializeOwned>(
        &self,
        command: &str,
        arguments: Req,
        timeout: std::time::Duration,
    ) -> Result<Res, String> {
        let seq = Self::next_seq();
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.pending.lock().unwrap().insert(seq, tx);
        let msg = Message::request(
            seq,
            command,
            serde_json::to_value(arguments).map_err(|e| e.to_string())?,
        );
        if let Err(e) = self.write_message(&msg) {
            self.pending.lock().unwrap().remove(&seq);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(value)) => serde_json::from_value(value).map_err(|e| e.to_string()),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                self.pending.lock().unwrap().remove(&seq);
                Err(format!("DAP request '{command}' timed out"))
            }
        }
    }

    pub fn notify<Req: Serialize>(&self, command: &str, arguments: Req) -> Result<(), String> {
        let seq = Self::next_seq();
        let msg = Message::request(
            seq,
            command,
            serde_json::to_value(arguments).map_err(|e| e.to_string())?,
        );
        self.write_message(&msg)
    }

    pub fn initialize(&self, adapter_id: &str) -> Result<Value, String> {
        let params = InitializeRequestArguments {
            client_id: Some("agamiz-code".into()),
            client_name: Some("Agamiz Code".into()),
            adapter_id: adapter_id.into(),
            path_format: Some("path".into()),
            lines_start_at_1: Some(true),
            columns_start_at_1: Some(true),
            supports_variable_type: Some(true),
            supports_variable_paging: Some(false),
            supports_run_in_terminal_request: Some(false),
            locale: Some("en".into()),
        };
        self.set_status(DapSessionStatus::Starting);
        let result =
            self.request::<_, Value>("initialize", params, std::time::Duration::from_secs(15))?;
        let _ = self.notify("initialized", serde_json::json!({}));
        self.set_status(DapSessionStatus::Running);
        Ok(result)
    }

    pub fn launch(&self, args: Value) -> Result<Value, String> {
        self.request("launch", args, std::time::Duration::from_secs(20))
    }

    pub fn attach(&self, args: Value) -> Result<Value, String> {
        self.request("attach", args, std::time::Duration::from_secs(20))
    }

    pub fn configuration_done(&self) -> Result<(), String> {
        self.request::<_, Value>(
            "configurationDone",
            serde_json::json!({}),
            std::time::Duration::from_secs(10),
        )
        .map(|_| ())
    }

    pub fn set_breakpoints(
        &self,
        source_path: &str,
        lines: &[i64],
    ) -> Result<Vec<Breakpoint>, String> {
        let breakpoints: Vec<SourceBreakpoint> = lines
            .iter()
            .map(|l| SourceBreakpoint {
                line: *l,
                condition: None,
                hit_condition: None,
                log_message: None,
            })
            .collect();
        let args = SetBreakpointsArguments {
            source: Source {
                name: Path::new(source_path)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string()),
                path: Some(source_path.into()),
                source_reference: None,
                presentation_hint: None,
            },
            breakpoints,
            breakpoints_updated: None,
            source_modified: None,
        };
        let result: SetBreakpointsResponseBody =
            self.request("setBreakpoints", args, std::time::Duration::from_secs(10))?;
        let verified: Vec<i64> = result
            .breakpoints
            .iter()
            .filter(|b| b.verified)
            .filter_map(|b| b.line)
            .collect();
        self.breakpoints.lock().unwrap().insert(source_path.to_string(), verified);
        Ok(result.breakpoints)
    }

    pub fn threads(&self) -> Result<Vec<Thread>, String> {
        let result: ThreadsResponseBody =
            self.request("threads", serde_json::json!({}), std::time::Duration::from_secs(10))?;
        Ok(result.threads)
    }

    pub fn stack_trace(
        &self,
        thread_id: i64,
        levels: Option<i64>,
    ) -> Result<Vec<StackFrame>, String> {
        let args = StackTraceArguments {
            thread_id,
            start_frame: Some(0),
            levels: levels.or(Some(50)),
        };
        let result: StackTraceResponseBody =
            self.request("stackTrace", args, std::time::Duration::from_secs(10))?;
        Ok(result.stack_frames)
    }

    pub fn scopes(&self, frame_id: i64) -> Result<Vec<Scope>, String> {
        let result: ScopesResponseBody =
            self.request("scopes", ScopesArguments { frame_id }, std::time::Duration::from_secs(10))?;
        Ok(result.scopes)
    }

    pub fn variables(&self, variables_reference: i64) -> Result<Vec<Variable>, String> {
        let result: VariablesResponseBody = self.request(
            "variables",
            VariablesArguments {
                variables_reference,
                filter: None,
                start: None,
                count: None,
            },
            std::time::Duration::from_secs(10),
        )?;
        Ok(result.variables)
    }

    pub fn continue_run(&self, thread_id: i64) -> Result<(), String> {
        self.request::<_, Value>(
            "continue",
            ContinueArguments {
                thread_id,
                single_thread: Some(false),
            },
            std::time::Duration::from_secs(10),
        )
        .map(|_| ())
    }

    pub fn next(&self, thread_id: i64) -> Result<(), String> {
        self.request::<_, Value>(
            "next",
            super::protocol::NextArguments {
                thread_id,
                granularity: None,
            },
            std::time::Duration::from_secs(10),
        )
        .map(|_| ())
    }

    pub fn step_in(&self, thread_id: i64) -> Result<(), String> {
        self.request::<_, Value>(
            "stepIn",
            StepInArguments {
                thread_id,
                granularity: None,
            },
            std::time::Duration::from_secs(10),
        )
        .map(|_| ())
    }

    pub fn step_out(&self, thread_id: i64) -> Result<(), String> {
        self.request::<_, Value>(
            "stepOut",
            StepOutArguments {
                thread_id,
                granularity: None,
            },
            std::time::Duration::from_secs(10),
        )
        .map(|_| ())
    }

    pub fn pause(&self, thread_id: i64) -> Result<(), String> {
        self.request::<_, Value>(
            "pause",
            serde_json::json!({ "threadId": thread_id }),
            std::time::Duration::from_secs(10),
        )
        .map(|_| ())
    }

    pub fn disconnect(&mut self) -> Result<(), String> {
        if self.status() == DapSessionStatus::Running {
            let _ = self.request::<_, Value>(
                "disconnect",
                DisconnectArguments {
                    restart: None,
                    terminate_debuggee: None,
                },
                std::time::Duration::from_secs(3),
            );
        }
        self.set_status(DapSessionStatus::Exited);
        let _ = self.child.kill();
        let _ = self.child.wait();
        Ok(())
    }
}

impl Drop for DapClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn read_loop(
    stdout: ChildStdout,
    pending: Arc<Mutex<PendingMap>>,
    status: Arc<std::sync::RwLock<DapSessionStatus>>,
    on_notification: Option<Arc<dyn Fn(Message) + Send + Sync>>,
    on_exit: Option<Arc<dyn Fn(Option<i64>) + Send + Sync>>,
) {
    let mut reader = std::io::BufReader::new(stdout);
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let mut chunk = [0u8; 8192];
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
        drain_messages(&mut buffer, &pending, &on_notification);
    }
    *status.write().unwrap() = DapSessionStatus::Exited;
    if let Some(cb) = on_exit {
        cb(None);
    }
}

fn drain_messages(
    buffer: &mut Vec<u8>,
    pending: &Mutex<PendingMap>,
    on_notification: &Option<Arc<dyn Fn(Message) + Send + Sync>>,
) {
    loop {
        let Some((body, consumed)) = decode_message(buffer) else {
            return;
        };
        buffer.drain(..consumed);
        let Ok(msg) = serde_json::from_slice::<Message>(&body) else {
            continue;
        };
        match msg {
            Message::Response {
                request_seq,
                success,
                body,
                message,
                ..
            } => {
                let res = if success {
                    Ok(body.unwrap_or(Value::Null))
                } else {
                    Err(message.unwrap_or_else(|| "DAP request failed".into()))
                };
                if let Some(tx) = pending.lock().unwrap().remove(&request_seq) {
                    let _ = tx.send(res);
                }
            }
            other => {
                if let Some(cb) = on_notification {
                    cb(other);
                }
            }
        }
    }
}
