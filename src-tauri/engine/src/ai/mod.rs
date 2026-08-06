//! AI subsystem — in-memory vector store, local embeddings, hybrid search,
//! and context gathering for the assistant / inline completion UI.

pub mod embed;
pub mod store;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::PROJECT_ROOT;

use store::ChunkStore;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: std::env::var("AGAMIZ_AI_BASE_URL").unwrap_or_default(),
            api_key: std::env::var("AGAMIZ_AI_API_KEY").unwrap_or_default(),
            model: std::env::var("AGAMIZ_AI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into()),
        }
    }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSearchResult {
    pub file: String,
    pub start_line: u64,
    pub end_line: u64,
    pub text: String,
    pub symbol: String,
    pub score: f64,
    pub kind: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContextBundle {
    pub file: String,
    pub symbols: Vec<String>,
    pub related: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiIndexProgress {
    pub files_scanned: usize,
    pub chunks_indexed: usize,
    pub duration_ms: u64,
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

pub struct AiManager {
    store: Mutex<Option<Arc<ChunkStore>>>,
    config: Mutex<AiConfig>,
}

static AI: std::sync::LazyLock<Arc<AiManager>> =
    std::sync::LazyLock::new(|| Arc::new(AiManager::new()));

impl AiManager {
    fn new() -> Self {
        Self {
            store: Mutex::new(None),
            config: Mutex::new(AiConfig::default()),
        }
    }

    pub fn global() -> &'static Arc<AiManager> {
        &AI
    }

    pub fn config(&self) -> AiConfig {
        self.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, c: AiConfig) {
        *self.config.lock().unwrap() = c;
    }

    // -- store lifecycle --

    fn root_path() -> Result<PathBuf, String> {
        let guard = PROJECT_ROOT.try_read().map_err(|e| e.to_string())?;
        guard
            .clone()
            .ok_or_else(|| "no project open".to_string())
    }

    fn ensure_store(&self) -> Result<Arc<ChunkStore>, String> {
        let mut guard = self.store.lock().unwrap();
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let root = Self::root_path()?;
        let store = ChunkStore::load(&root)?;
        let store = Arc::new(store);
        *guard = Some(store.clone());
        Ok(store)
    }

    /// Build the vector store from scratch by walking the workspace and
    /// chunking+embedding every supported file. Runs synchronously (call via
    /// spawn_blocking).
    fn build_store(&self) -> Result<Arc<ChunkStore>, String> {
        let root = Self::root_path()?;
        let store = crate::indexer::build_chunk_store(&root)?;
        store.save(&root)?;
        let store = Arc::new(store);
        *self.store.lock().unwrap() = Some(store.clone());
        Ok(store)
    }

    fn store(&self) -> Result<Arc<ChunkStore>, String> {
        let guard = self.store.lock().unwrap();
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        drop(guard);
        self.build_store()
    }

    // -- index ----------------------------------------------------------

    pub fn chunk_count(&self) -> usize {
        self.store
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.len())
            .unwrap_or(0)
    }

    /// Build/replace the workspace index. Run on a background thread.
    pub fn rebuild_index(&self) -> Result<usize, String> {
        let store = self.build_store()?;
        Ok(store.len())
    }

    // -- search ----------------------------------------------------------

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<AiSearchResult>, String> {
        let store = self.store()?;
        let hits = store.search_hybrid(query, limit);
        Ok(hits.into_iter().map(|h| AiSearchResult {
            file: h.chunk.file.to_string_lossy().to_string(),
            start_line: h.chunk.start_line as u64,
            end_line: h.chunk.end_line as u64,
            text: h.chunk.text.clone(),
            symbol: h.chunk.symbol.clone(),
            score: h.score as f64,
            kind: h.chunk.kind.clone(),
        }).collect())
    }

    // -- context ----------------------------------------------------------

    pub fn context_for_file(&self, file_path: &str) -> Result<AiContextBundle, String> {
        let store = self.store()?;
        let file = Path::new(file_path);
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let hits = store.search_symbols(&stem, 15);
        let symbols: Vec<String> = hits
            .iter()
            .filter(|h| !h.chunk.symbol.is_empty())
            .map(|h| h.chunk.symbol.clone())
            .collect();
        let related: Vec<String> = hits
            .into_iter()
            .filter(|h| {
                h.chunk.file.to_string_lossy().replace('\\', "/")
                    == file_path.replace('\\', "/")
            })
            .map(|h| h.chunk.text.clone())
            .collect();
        Ok(AiContextBundle {
            file: file_path.to_string(),
            symbols,
            related,
        })
    }

    // -- completion (local heuristic) ------------------------------------

    /// Generate a fast, deterministic inline completion from the code prefix.
    /// The frontend calls this to populate the ghost-text gutter.
    pub fn complete_local(&self, prefix: &str) -> Option<String> {
        let trimmed = prefix.trim();
        if trimmed.is_empty() {
            return None;
        }
        // Heuristic: if the last line contains an opening brace/paren and is
        // incomplete, close it. Also suggest a simple inline doc comment.
        let last_line = prefix.lines().last().unwrap_or("").trim();
        let open = last_line
            .chars()
            .filter(|&c| matches!(c, '(' | '{' | '['))
            .count();
        let close = last_line
            .chars()
            .filter(|&c| matches!(c, ')' | '}' | ']'))
            .count();
        if open > close {
            return Some(close_delimiter(&last_line));
        }
        if last_line.ends_with("=>") {
            return Some("".to_string());
        }
        // Try to find the next token from the most similar indexed chunk and
        // produce its following line as a suggestion.
        if let Ok(store) = self.store() {
            let hits = store.search_by_embed(prefix, 3);
            for h in hits {
                let lines: Vec<&str> = h.chunk.text.lines().collect();
                if lines.len() > 1 {
                    let next = lines.into_iter()
                        .skip_while(|l| l.trim().is_empty())
                        .nth(1)
                        .map(|s| s.to_string());
                    if let Some(sug) = next {
                        if !sug.trim().is_empty() {
                            return Some(sug.trim().to_string());
                        }
                    }
                }
            }
        }
        None
    }

    pub fn complete_local_stream(
        &self,
        prefix: &str,
        cb: impl FnOnce(String),
    ) {
        if let Some(sug) = self.complete_local(prefix) {
            cb(sug);
        }
    }
}

fn close_delimiter(last_line: &str) -> String {
    let open_curly = last_line.matches('{').count().saturating_sub(last_line.matches('}').count());
    let open_paren = last_line.matches('(').count().saturating_sub(last_line.matches(')').count());
    let open_sq = last_line.matches('[').count().saturating_sub(last_line.matches(']').count());
    let mut s = String::new();
    for _ in 0..open_curly {
        s.push('}');
    }
    for _ in 0..open_paren {
        s.push(')');
    }
    for _ in 0..open_sq {
        s.push(']');
    }
    s
}