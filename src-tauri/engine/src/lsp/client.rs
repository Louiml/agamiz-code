use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crossbeam_channel::Sender;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::jsonrpc::{decode_message, encode_message, Id, RpcMessage};
use super::protocol::{
    CompletionItem, CompletionParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams,
    DidOpenTextDocumentParams, HoverResult, InitializeParams, InitializeResult, Location,
    TextDocumentPositionParams,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LspServerStatus {
    Starting,
    Initializing,
    Running,
    Closed,
}

type PendingMap = std::collections::HashMap<Id, Sender<Result<Value, String>>>;

/// A handle to a live LSP server process. All I/O happens on background threads
/// so the calling (Tauri command) thread is never blocked.
pub struct LspClient {
    child: Child,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<PendingMap>>,
    status: Arc<std::sync::RwLock<LspServerStatus>>,
    root: PathBuf,
}

impl std::fmt::Debug for LspClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LspClient")
            .field("root", &self.root)
            .field("status", &*self.status.read().unwrap())
            .finish()
    }
}

impl LspClient {
    /// Spawn a language server binary.
    pub fn spawn(
        server_path: &Path,
        args: &[String],
        root: &Path,
        on_notification: Option<Arc<dyn Fn(RpcMessage) + Send + Sync>>,
    ) -> Result<Self, String> {
        let mut command = Command::new(server_path);
        command
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|e| format!("spawn {}: {e}", server_path.display()))?;

        let stdin = child.stdin.take().ok_or("missing stdin handle")?;
        let stdout = child.stdout.take().ok_or("missing stdout handle")?;

        let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(PendingMap::new()));
        let status = std::sync::Arc::new(std::sync::RwLock::new(LspServerStatus::Starting));
        let child_id = child.id();

        // stderr diagnostic thread.
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    eprintln!("[lsp:{child_id}] {}", line.unwrap_or_default());
                }
            });
        }

        // Reader thread drains the response stream and routes responses/notifications.
        let pending_reader = Arc::clone(&pending);
        let status_reader = Arc::clone(&status);
        std::thread::spawn(move || {
            read_loop(stdout, pending_reader, status_reader, on_notification);
        });

        Ok(LspClient {
            child,
            stdin: Mutex::new(stdin),
            pending,
            status,
            root: root.to_path_buf(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn status(&self) -> LspServerStatus {
        *self.status.read().unwrap()
    }

    fn next_id() -> Id {
        Id::Number(NEXT_ID.fetch_add(1, Ordering::SeqCst) as i64)
    }

    fn write_message(&self, msg: &RpcMessage) -> Result<(), String> {
        let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        let framed = encode_message(&body);
        let mut guard = self.stdin.lock().unwrap();
        guard.write_all(&framed).map_err(|e| format!("write to LSP failed: {e}"))
    }

    /// Send a request and block (on a background worker) for the response.
    pub fn request<Req: Serialize, Res: DeserializeOwned>(
        &self,
        method: &str,
        params: Req,
        timeout: std::time::Duration,
    ) -> Result<Res, String> {
        let id = Self::next_id();
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let msg = RpcMessage::request(id.clone(), method, serde_json::to_value(params).map_err(|e| e.to_string())?);
        if let Err(e) = self.write_message(&msg) {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(value)) => serde_json::from_value(value).map_err(|e| e.to_string()),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("LSP request '{method}' timed out"))
            }
        }
    }

    pub fn notify<Req: Serialize>(&self, method: &str, params: Req) -> Result<(), String> {
        let msg = RpcMessage::notification(method, serde_json::to_value(params).map_err(|e| e.to_string())?);
        self.write_message(&msg)
    }

    pub fn initialize(&self, root_uri: &str) -> Result<InitializeResult, String> {
        *self.status.write().unwrap() = LspServerStatus::Initializing;
        let params = InitializeParams {
            process_id: Some(std::process::id()),
            root_uri: Some(root_uri.to_string()),
            capabilities: super::protocol::ClientCapabilities {
                text_document: Some(serde_json::json!({
                    "synchronization": { "didSave": true },
                    "completion": { "completionItem": { "snippetSupport": true } },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": {},
                    "publishDiagnostics": { "relatedInformation": true }
                })),
                workspace: Some(serde_json::json!({})),
            },
        };
        let result: InitializeResult =
            self.request("initialize", params, std::time::Duration::from_secs(15))?;
        self.notify("initialized", serde_json::json!({}))?;
        *self.status.write().unwrap() = LspServerStatus::Running;
        Ok(result)
    }

    pub fn did_open(&self, params: DidOpenTextDocumentParams) -> Result<(), String> {
        self.notify("textDocument/didOpen", params)
    }

    pub fn did_change(&self, params: DidChangeTextDocumentParams) -> Result<(), String> {
        self.notify("textDocument/didChange", params)
    }

    pub fn did_close(&self, params: DidCloseTextDocumentParams) -> Result<(), String> {
        self.notify("textDocument/didClose", params)
    }

    pub fn completion(&self, params: CompletionParams) -> Result<Vec<CompletionItem>, String> {
        let result: super::protocol::CompletionResult =
            self.request("textDocument/completion", params, std::time::Duration::from_secs(5))?;
        Ok(match result {
            super::protocol::CompletionResult::Std(items) => items,
            super::protocol::CompletionResult::List(list) => list.items,
        })
    }

    pub fn hover(&self, params: TextDocumentPositionParams) -> Result<Option<HoverResult>, String> {
        self.request("textDocument/hover", params, std::time::Duration::from_secs(5))
    }

    pub fn definition(&self, params: TextDocumentPositionParams) -> Result<Vec<Location>, String> {
        let result: Option<super::protocol::Definition> =
            self.request("textDocument/definition", params, std::time::Duration::from_secs(5))?;
        Ok(match result {
            Some(super::protocol::Definition::Single(l)) => vec![l],
            Some(super::protocol::Definition::Multiple(l)) => l,
            None => vec![],
        })
    }

    /// Graceful shutdown, best-effort.
    pub fn shutdown(&mut self) -> Result<(), String> {
        if self.status() == LspServerStatus::Running {
            let _ = self.request::<_, Value>("shutdown", serde_json::json!(null), std::time::Duration::from_secs(3));
            let _ = self.notify("exit", serde_json::json!(null));
        }
        *self.status.write().unwrap() = LspServerStatus::Closed;
        let _ = self.child.kill();
        let _ = self.child.wait();
        Ok(())
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn read_loop(
    stdout: ChildStdout,
    pending: Arc<Mutex<PendingMap>>,
    status: Arc<std::sync::RwLock<LspServerStatus>>,
    on_notification: Option<Arc<dyn Fn(RpcMessage) + Send + Sync>>,
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
    *status.write().unwrap() = LspServerStatus::Closed;
}

fn drain_messages(
    buffer: &mut Vec<u8>,
    pending: &Arc<Mutex<PendingMap>>,
    on_notification: &Option<Arc<dyn Fn(RpcMessage) + Send + Sync>>,
) {
    loop {
        let Some((body, consumed)) = decode_message(buffer) else {
            return;
        };
        buffer.drain(..consumed);
        let Ok(msg) = serde_json::from_slice::<RpcMessage>(&body) else {
            continue;
        };
        match msg {
            RpcMessage::Response { id, result, error, .. } => {
                let tx = pending.lock().unwrap().remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(match (result, error) {
                        (Some(r), _) => Ok(r),
                        (None, Some(e)) => Err(format!("{:?}: {}", e.code, e.message)),
                        (None, None) => Err("empty response".into()),
                    });
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