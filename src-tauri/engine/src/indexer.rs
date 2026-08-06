use std::path::Path;

use crate::graph::{ProjectIndexStats, Symbol};
use crate::SYMBOL_REGISTRY;
use crate::parser;

const SUPPORTED_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "mts", "cjs", "cts", "rs",
];
const IGNORED_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".git", ".next", ".cache", ".svelte-kit",
];

pub fn index_project(root: &Path) -> ProjectIndexStats {
    let start = std::time::Instant::now();
    let mut files_scanned = 0;
    let mut symbols_found = 0;

    if root.is_file() {
        let s = index_file(root);
        return s;
    }

    walk_and_index(root, &mut files_scanned, &mut symbols_found);

    ProjectIndexStats {
        files_scanned,
        symbols_found,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

fn walk_and_index(dir: &Path, files_scanned: &mut usize, symbols_found: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_and_index(&path, files_scanned, symbols_found);
        } else if is_supported(&path) {
            let stats = index_file(&path);
            *files_scanned += stats.files_scanned;
            *symbols_found += stats.symbols_found;
        }
    }
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTS.contains(&e))
        .unwrap_or(false)
}

pub fn index_file(path: &Path) -> ProjectIndexStats {
    let start = std::time::Instant::now();
    let ext = path
        .extension()
        .map(|e| e.to_str().unwrap_or(""))
        .unwrap_or("");
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return ProjectIndexStats {
            files_scanned: 0,
            symbols_found: 0,
            duration_ms: start.elapsed().as_millis() as u64,
        },
    };

    let path_str = path.to_string_lossy().to_string();
    let mut id_counter = SYMBOL_REGISTRY.len() as u64;

    let graph = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "mts" | "cjs" | "cts" => {
            parser::ts::parse_document(&content, &path_str, &mut id_counter)
        }
        "rs" => {
            parser::rs::parse_document(&content, &path_str, &mut id_counter)
        }
        _ => return ProjectIndexStats {
            files_scanned: 0,
            symbols_found: 0,
            duration_ms: start.elapsed().as_millis() as u64,
        },
    };

    let count = graph.symbols.len();
    for sym in graph.symbols {
        SYMBOL_REGISTRY.insert(sym.id, sym);
    }

    ProjectIndexStats {
        files_scanned: 1,
        symbols_found: count,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

#[allow(unused)]
pub fn reparse_file(path: &Path) {
    let key = path.to_string_lossy().to_string();
    SYMBOL_REGISTRY.retain(|_k, v| {
        v.id.to_string() != key
    });
    index_file(path);
}

pub fn all_symbols_for_query(query: &str) -> Vec<Symbol> {
    let lower = query.to_lowercase();
    let mut results = Vec::new();
    for entry in SYMBOL_REGISTRY.iter() {
        let name = &entry.value().name;
        if name.to_lowercase().contains(&lower) {
            results.push(entry.value().clone());
        }
    }
    results
}

pub fn remove_file_from_index(path: &Path) {
    let key = path.to_string_lossy().to_string();
    SYMBOL_REGISTRY.retain(|_id, sym| sym.location.file.to_string_lossy() != key);
}

// -----------------------------------------------------------------------
// AI vector-store builder
// -----------------------------------------------------------------------

use crate::ai::store::{ChunkStore, chunk_file};

/// Walk the project root, chunk every supported source file into sliding
/// windows, compute embeddings, and insert them all into a fresh ChunkStore.
/// This can be called on project open and from the explicit "rebuild" command.
pub fn build_chunk_store(root: &Path) -> Result<ChunkStore, String> {
    let store = ChunkStore::new();
    walk_and_chunk(root, &store)?;
    Ok(store)
}

fn walk_and_chunk(dir: &Path, store: &ChunkStore) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_and_chunk(&path, store)?;
        } else if is_supported(&path) {
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let texts = chunk_file(&content);
            for text in texts {
                let embed = crate::ai::embed::embed(&text);
                store.insert(crate::ai::store::Chunk {
                    id: 0,
                    file: path.clone(),
                    start_line: 0,
                    end_line: 0,
                    kind: String::new(),
                    symbol: String::new(),
                    text,
                    embed,
                });
            }
        }
    }
    Ok(())
}