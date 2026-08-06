use std::sync::LazyLock;
use dashmap::DashMap;

pub mod graph;
pub mod indexer;
pub mod ipc;
pub mod lsp;
pub mod parser;
pub mod runner;
pub mod terminal;
pub mod watcher;
pub mod dap;
pub mod git;
pub mod ai;

pub static SYMBOL_REGISTRY: LazyLock<DashMap<graph::NodeId, graph::Symbol>> =
    LazyLock::new(DashMap::new);

pub static PROJECT_ROOT: LazyLock<tokio::sync::RwLock<Option<std::path::PathBuf>>> =
    LazyLock::new(|| tokio::sync::RwLock::new(None));

/// Active LSP manager for the currently open project, if any.
pub static LSP_MANAGER: LazyLock<tokio::sync::RwLock<Option<std::sync::Arc<lsp::LspClientManager>>>> =
    LazyLock::new(|| tokio::sync::RwLock::new(None));