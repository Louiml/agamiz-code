pub mod client;
pub mod jsonrpc;
pub mod protocol;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use client::LspClient;
use crossbeam_channel::Sender;

/// Canonical `file://` URI from a filesystem path.
pub fn path_to_uri(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string());
    let normalized = canonical.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{}", normalized)
    } else {
        format!("file:///{}", normalized.trim_start_matches('/'))
    }
}

/// Denormalize a `file://` URI back into a filesystem path (best effort).
pub fn uri_to_path(uri: &str) -> String {
    let stripped = uri
        .strip_prefix("file://")
        .unwrap_or(uri)
        .trim_start_matches('/');
    let cut = stripped.find(['?', '#']).unwrap_or(stripped.len());
    let cleaned = &stripped[..cut];
    if cfg!(windows) {
        cleaned.replace('/', "\\")
    } else {
        cleaned.to_string()
    }
}

/// Resolve the binary + args for a given language (from PATH / known locations).
pub fn resolve_server(language: &str) -> Option<(String, Vec<String>)> {
    let candidates: &[(&str, &[&str])] = match language {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => &[
            ("vtsls", &["--stdio"]),
            ("typescript-language-server", &["--stdio"]),
        ],
        "rust" => &[("rust-analyzer", &[])],
        "python" => &[("pyright-langserver", &["--stdio"])],
        "go" => &[("gopls", &["serve"])],
        _ => &[],
    };

    for (bin, args) in candidates {
        if let Some(path) = find_binary(bin) {
            return Some((path, args.iter().map(|s| s.to_string()).collect()));
        }
    }
    None
}

fn find_binary(bin: &str) -> Option<String> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let execs: [&str; 1] = if cfg!(windows) { ["x"] } else { [""] };
    let _ = execs;
    for dir in path_var.split(';') {
        let dir = dir.trim();
        if dir.is_empty() {
            continue;
        }
        for ext in if cfg!(windows) {
            vec!["exe", "cmd", "bat", "ps1"]
        } else {
            vec![""]
        } {
            let name = if cfg!(windows) && !ext.is_empty() {
                format!("{}.{}", bin, ext)
            } else {
                bin.to_string()
            };
            let candidate = Path::new(dir).join(&name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// The `LSPClientManager` is the public abstraction the IDE talks to. It owns one
/// language-server process per language and routes document lifecycle + requests.
pub struct LspClientManager {
    root: PathBuf,
    servers: Mutex<HashMap<String, Arc<LspClient>>>,
    opened: Mutex<HashMap<String, OpenedDocument>>,
    /// Sink that `PublishDiagnostics` rows are forwarded into for the UI.
    sink: Arc<Mutex<Option<Sender<crate::graph::Diagnostic>>>>,
}

#[derive(Clone)]
struct OpenedDocument {
    version: u32,
    language: String,
}

impl std::fmt::Debug for LspClientManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LspClientManager")
            .field("root", &self.root)
            .field("open_documents", &self.opened.lock().unwrap().len())
            .finish()
    }
}

impl LspClientManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            servers: Mutex::new(HashMap::new()),
            opened: Mutex::new(HashMap::new()),
            sink: Arc::new(Mutex::new(None)),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Set the sink that receives parsed diagnostics for the UI.
    pub fn set_diagnostics_sink(&self, tx: Sender<crate::graph::Diagnostic>) {
        *self.sink.lock().unwrap() = Some(tx);
    }

    /// Ensure a client for `language` exists and is initialized.
    pub fn ensure_server(&self, language: &str) -> Result<Arc<LspClient>, String> {
        {
            let servers = self.servers.lock().unwrap();
            if let Some(existing) = servers.get(language) {
                if existing.status() == client::LspServerStatus::Running {
                    return Ok(existing.clone());
                }
            }
        }

        let (binary, args) = resolve_server(language)
            .ok_or_else(|| format!("no language server found for '{language}'"))?;

        let root_uri = crate::lsp::path_to_uri(&self.root);
        let sink = self.sink.clone();

        let on_notification: Arc<dyn Fn(jsonrpc::RpcMessage) + Send + Sync> =
            Arc::new(move |msg: jsonrpc::RpcMessage| {
                if let jsonrpc::RpcMessage::Notification { method, params, .. } = &msg {
                    if method == "textDocument/publishDiagnostics" {
                        if let Some(params) = params {
                            if let Ok(p) =
                                serde_json::from_value::<protocol::PublishDiagnosticsParams>(params.clone())
                            {
                                let rows: Vec<crate::graph::Diagnostic> = p
                                    .diagnostics
                                    .iter()
                                    .map(|d| crate::graph::Diagnostic {
                                        file: uri_to_path(&p.uri),
                                        line: d.range.start.line as usize,
                                        col: d.range.start.character as usize,
                                        end_line: d.range.end.line as usize,
                                        end_col: d.range.end.character as usize,
                                        severity: match d.severity {
                                            Some(protocol::DiagnosticSeverity::Error) => {
                                                crate::graph::DiagnosticSeverity::Error
                                            }
                                            Some(protocol::DiagnosticSeverity::Warning) => {
                                                crate::graph::DiagnosticSeverity::Warning
                                            }
                                            Some(protocol::DiagnosticSeverity::Information) => {
                                                crate::graph::DiagnosticSeverity::Info
                                            }
                                            _ => crate::graph::DiagnosticSeverity::Hint,
                                        },
                                        message: d.message.clone(),
                                        source: d.source.clone().unwrap_or_else(|| "lsp".into()),
                                    })
                                    .collect();
                                if let Some(tx) = sink.lock().unwrap().as_ref() {
                                    for d in rows {
                                        let _ = tx.send(d);
                                    }
                                }
                            }
                        }
                    }
                }
            });

        let client = LspClient::spawn(Path::new(&binary), &args, &self.root, Some(on_notification))?;
        client.initialize(&root_uri)?;

        let arc = Arc::new(client);
        self.servers.lock().unwrap().insert(language.to_string(), arc.clone());
        Ok(arc)
    }

    pub fn open(&self, uri: String, language: String, text: String) -> Result<(), String> {
        let server = self.ensure_server(&language)?;
        server.did_open(protocol::DidOpenTextDocumentParams {
            text_document: protocol::TextDocumentItem {
                uri: uri.clone(),
                language_id: language.clone(),
                version: 1,
                text,
            },
        })?;
        self.opened.lock().unwrap().insert(
            uri.clone(),
            OpenedDocument { version: 1, language },
        );
        Ok(())
    }

    pub fn change(&self, uri: &str, text: &str) -> Result<(), String> {
        let doc = self
            .opened
            .lock()
            .unwrap()
            .get(uri)
            .cloned()
            .ok_or_else(|| format!("document '{uri}' not open"))?;
        let server = self.ensure_server(&doc.language)?;
        let version = doc.version + 1;
        let mut opened = self.opened.lock().unwrap();
        if let Some(d) = opened.get_mut(uri) {
            d.version = version;
        }
        drop(opened);
        server.did_change(protocol::DidChangeTextDocumentParams {
            text_document: protocol::VersionedTextDocumentIdentifier {
                uri: uri.to_string(),
                version: version as i32,
            },
            content_changes: vec![protocol::TextDocumentContentChangeEvent {
                range: None,
                text: text.to_string(),
            }],
        })
    }

    pub fn close(&self, uri: &str) -> Result<(), String> {
        let doc = self.opened.lock().unwrap().remove(uri);
        if let Some(doc) = doc {
            if let Some(server) = self.servers.lock().unwrap().get(&doc.language) {
                let _ = server.did_close(protocol::DidCloseTextDocumentParams {
                    text_document: protocol::TextDocumentIdentifier { uri: uri.to_string() },
                });
            }
        }
        Ok(())
    }

    pub fn completion(&self, uri: &str, line: u32, character: u32) -> Result<Vec<protocol::CompletionItem>, String> {
        let doc = self
            .opened
            .lock()
            .unwrap()
            .get(uri)
            .cloned()
            .ok_or_else(|| "document not open".to_string())?;
        let server = self.ensure_server(&doc.language)?;
        server.completion(protocol::CompletionParams {
            text_document: protocol::TextDocumentIdentifier { uri: uri.to_string() },
            position: protocol::Position { line, character },
            context: None,
        })
    }

    pub fn hover(&self, uri: &str, line: u32, character: u32) -> Result<Option<protocol::HoverResult>, String> {
        let doc = self
            .opened
            .lock()
            .unwrap()
            .get(uri)
            .cloned()
            .ok_or_else(|| "document not open".to_string())?;
        let server = self.ensure_server(&doc.language)?;
        server.hover(protocol::TextDocumentPositionParams {
            text_document: protocol::TextDocumentIdentifier { uri: uri.to_string() },
            position: protocol::Position { line, character },
        })
    }

    pub fn definition(&self, uri: &str, line: u32, character: u32) -> Result<Vec<protocol::Location>, String> {
        let doc = self
            .opened
            .lock()
            .unwrap()
            .get(uri)
            .cloned()
            .ok_or_else(|| "document not open".to_string())?;
        let server = self.ensure_server(&doc.language)?;
        server.definition(protocol::TextDocumentPositionParams {
            text_document: protocol::TextDocumentIdentifier { uri: uri.to_string() },
            position: protocol::Position { line, character },
        })
    }

    pub fn shutdown(&self) {
        self.servers.lock().unwrap().clear();
        self.opened.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_roundtrip_windows_style() {
        let p = std::path::Path::new("C:/dev/proj/src/main.ts");
        let uri = path_to_uri(p);
        assert!(uri.starts_with("file:///"));
        let back = uri_to_path(&uri);
        #[cfg(windows)]
        assert_eq!(back.replace('/', "\\"), "C:\\dev\\proj\\src\\main.ts");
    }

    #[test]
    fn resolve_is_empty_for_unknown_language() {
        assert!(resolve_server("cobol").is_none());
    }
}