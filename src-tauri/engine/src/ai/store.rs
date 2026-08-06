use dashmap::DashMap;
use std::path::{Path, PathBuf};

/// A code chunk stored in the vector index with its f32 embedding.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub id: u64,
    pub file: PathBuf,
    pub start_line: usize,
    pub end_line: usize,
    pub kind: String,
    pub symbol: String,
    pub text: String,
    pub embed: Vec<f32>,
}

/// Result of a retrieval query.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub chunk: Chunk,
    pub score: f32,
}

/// In-memory vector store using DashMap for concurrent access.
pub struct ChunkStore {
    map: DashMap<u64, Chunk>,
    next_id: std::sync::atomic::AtomicU64,
}

impl ChunkStore {
    pub fn new() -> Self {
        Self {
            map: DashMap::new(),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Insert a chunk (id will be overridden with auto-increment).
    pub fn insert(&self, mut chunk: Chunk) -> u64 {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        chunk.id = id;
        self.map.insert(id, chunk);
        id
    }

    /// Remove all chunks belonging to the given file path.
    pub fn remove_file(&self, file: &Path) {
        let key = file.to_string_lossy().replace('\\', "/");
        self.map
            .retain(|_, v| v.file.to_string_lossy().replace('\\', "/") != key);
    }

    /// k-NN cosine search.
    pub fn search_by_embed(&self, query: &str, k: usize) -> Vec<Hit> {
        let qv = super::embed::embed(query);
        let mut vec: Vec<Hit> = Vec::new();
        for entry in &self.map {
            let chunk = entry.value();
            let score = super::embed::cosine(&qv, &chunk.embed);
            if score > 1e-4 {
                vec.push(Hit {
                    score,
                    chunk: chunk.clone(),
                });
            }
        }
        vec.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        vec.truncate(k);
        vec
    }

    /// Symbol name substring search (case-insensitive).
    pub fn search_symbols(&self, query: &str, k: usize) -> Vec<Hit> {
        let lower = query.to_lowercase();
        let mut vec: Vec<Hit> = Vec::new();
        for entry in &self.map {
            let chunk = entry.value();
            let sym = chunk.symbol.to_lowercase();
            let score = if !sym.is_empty() && sym.contains(&lower) {
                1.0
            } else {
                let txt = chunk.text.to_lowercase();
                if txt.contains(&lower) {
                    0.5
                } else {
                    0.0
                }
            };
            if score > 0.0 {
                vec.push(Hit {
                    score,
                    chunk: chunk.clone(),
                });
            }
        }
        vec.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        vec.truncate(k);
        vec
    }

    /// Hybrid retrieval: weighted semantic + symbol match.
    pub fn search_hybrid(&self, query: &str, k: usize) -> Vec<Hit> {
        let sem = self.search_by_embed(query, k * 4);
        let sym = self.search_symbols(query, k * 4);

        let mut merged: std::collections::BTreeMap<u64, f32> = std::collections::BTreeMap::new();
        let mut by_id: std::collections::BTreeMap<u64, Chunk> = std::collections::BTreeMap::new();

        for h in &sem {
            by_id.insert(h.chunk.id, h.chunk.clone());
            *merged.entry(h.chunk.id).or_insert(0.0) += 0.7 * h.score;
        }
        for h in &sym {
            by_id.insert(h.chunk.id, h.chunk.clone());
            *merged.entry(h.chunk.id).or_insert(0.0) += 0.3 * h.score;
        }

        let mut out: Vec<Hit> = Vec::new();
        for (id, score) in merged {
            if let Some(chunk) = by_id.get(&id) {
                out.push(Hit {
                    score,
                    chunk: chunk.clone(),
                });
            }
        }
        out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        out.truncate(k);
        out
    }

    /// Export all chunks into a Vec for JSON persistence.
    pub fn all_chunks(&self) -> Vec<Chunk> {
        self.map.iter().map(|e| e.value().clone()).collect()
    }

    /// Persist all chunks to <root-dir>/.agamiz-index.json
    pub fn save(&self, root: &Path) -> Result<(), String> {
        let chunks = self.all_chunks();
        let json = serde_json::to_string(&chunks).map_err(|e| e.to_string())?;
        let dest = root.join(".agamiz-index.json");
        std::fs::write(&dest, json).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Load a previously saved index.
    pub fn load(root: &Path) -> Result<Self, String> {
        let dest = root.join(".agamiz-index.json");
        if !dest.exists() {
            return Ok(Self::new());
        }
        let data = std::fs::read_to_string(&dest).map_err(|e| e.to_string())?;
        let chunks: Vec<Chunk> = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        let store = Self::new();
        for c in chunks {
            let cid = c.id;
            store.map.insert(cid, c);
            if cid >= store.next_id.load(std::sync::atomic::Ordering::Relaxed) {
                store.next_id.store(cid + 1, std::sync::atomic::Ordering::Relaxed);
            }
        }
        Ok(store)
    }

    /// Inner dash map access for the chunker.
    pub fn insert_raw(&self, chunk: Chunk) {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.map.insert(id, chunk);
    }
}

/// Build chunks from a source file.
pub fn chunk_file(source: &str) -> Vec<String> {
    let lines: Vec<&str> = source.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    const WINDOW: usize = 30;
    const STEP: usize = 15;
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let end = (i + WINDOW).min(lines.len());
        let text = lines[i..end].join("\n");
        out.push(text);
        i += STEP;
    }
    out
}