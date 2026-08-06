use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::dap::{DebugConfig, DAP_MANAGER};
use crate::git::{
    self, branches, checkout, collect_status, commit as git_commit_fn, file_diff,
    stage_all, stage_path, start_status_watcher, GitBranches, GitCommitResult, GitFileDiff,
    GitStatus, GIT,
};
use crate::ai::{AiSearchResult, AiContextBundle, AiManager};
use crate::graph::{Diagnostic, FileNode, ProjectIndexStats, Symbol as GraphSymbol};
use crate::lsp::LspClientManager;
use crate::terminal::TERMINAL_MANAGER;

use super::indexer;
use super::{PROJECT_ROOT, LSP_MANAGER};

#[tauri::command]
pub async fn open_project(
    path: String,
    app: AppHandle,
) -> Result<ProjectIndexStats, String> {
    let root = PathBuf::from(&path);
    *PROJECT_ROOT.write().await = Some(root.clone());
    let root_for_index = root.clone();
    let stats = tokio::task::spawn_blocking(move || indexer::index_project(&root_for_index))
        .await
        .map_err(|e| e.to_string())?;

    // Bind source control monitoring and emit an initial snapshot.
    {
        let root_for_git = root.clone();
        let app_for_git = app.clone();
        tokio::task::spawn_blocking(move || {
            git::bind_root(&root_for_git);
            let status = GIT.status();
            if let Ok(s) = status {
                let _ = app_for_git.emit("git:status", s);
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        start_status_watcher(root.clone(), app.clone());
    }

    // (Re)create the LSP manager and bridge server diagnostics to the UI.
    let manager = LspClientManager::new(root.clone());
    let (tx, rx) = crossbeam_channel::unbounded::<Diagnostic>();
    manager.set_diagnostics_sink(tx);
    let app_clone = app.clone();
    std::thread::spawn(move || {
        // Coalesce diagnostics per file then emit — batched, non-blocking for the UI.
        let mut map: std::collections::HashMap<String, Vec<Diagnostic>> =
            std::collections::HashMap::new();
        while let Ok(diag) = rx.recv() {
            let file = diag.file.clone();
            map.entry(file).or_default().push(diag);
            if map.len() >= 16 {
                for (file, diags) in map.drain() {
                    let _ = app_clone.emit("lsp:diagnostics", (file, diags));
                }
            }
        }
        for (file, diags) in map.drain() {
            let _ = app_clone.emit("lsp:diagnostics", (file, diags));
        }
    });

    *LSP_MANAGER.write().await = Some(Arc::new(manager));

    // Build the AI workspace index in the background.
    {
        let root_ai = root.clone();
        let app_ai = app.clone();
        tokio::task::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = AiManager::global().rebuild_index();
                let _ = app_ai.emit("ai:index-done", AiManager::global().chunk_count());
            })
            .await;
        });
    }

    app.emit("index:progress", stats.clone()).map_err(|e| e.to_string())?;
    Ok(stats)
}

#[tauri::command]
pub async fn close_project() -> Result<(), String> {
    *PROJECT_ROOT.write().await = None;
    Ok(())
}

#[tauri::command]
pub async fn get_file_tree(path: String) -> Result<Vec<FileNode>, String> {
    let root = PathBuf::from(&path);
    let entries = walk_dir(&root).map_err(|e| e.to_string())?;
    Ok(entries)
}

#[tauri::command]
pub async fn read_file_content(path: &str) -> Result<String, String> {
    tokio::fs::read_to_string(PathBuf::from(path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file_content(path: &str, content: &str) -> Result<(), String> {
    tokio::fs::write(PathBuf::from(path), content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn query_symbols(query: &str) -> Result<Vec<GraphSymbol>, String> {
    let q = query.to_string();
    let pooled = tokio::task::spawn_blocking(move || indexer::all_symbols_for_query(&q))
        .await
        .map_err(|e| e.to_string())?;
    Ok(pooled)
}

#[tauri::command]
pub async fn get_diagnostics(_path: &str) -> Result<Vec<Diagnostic>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn rename_symbol(
    file: &str,
    name: &str,
    replacement: &str,
) -> Result<(), String> {
    let content = tokio::fs::read_to_string(PathBuf::from(file))
        .await
        .map_err(|e| e.to_string())?;
    let replaced = content.replace(name, replacement);
    tokio::fs::write(PathBuf::from(file), replaced)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_git_status(path: &str) -> Result<String, String> {
    let repo = git2::Repository::discover(PathBuf::from(path)).map_err(|e| e.to_string())?;
    let reference = repo
        .head()
        .map_err(|e| e.to_string())?
        .shorthand()
        .unwrap_or("main")
        .to_string();
    let statuses = repo
        .statuses(None)
        .map_err(|e| e.to_string())?
        .len();
    Ok(format!("{} [+{}]", reference, statuses))
}

#[tauri::command]
pub async fn get_git_graph(path: &str) -> Result<String, String> {
    get_git_status(path).await
}

#[tauri::command]
pub async fn create_file(path: &str) -> Result<(), String> {
    std::fs::File::create(PathBuf::from(path))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_folder(path: &str) -> Result<(), String> {
    std::fs::create_dir_all(PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_path(path: &str, recursive: bool) -> Result<(), String> {
    let p = PathBuf::from(path);
    let err = |e: std::io::Error| e.to_string();
    if p.is_dir() {
        if recursive {
            std::fs::remove_dir_all(&p).map_err(err)
        } else {
            std::fs::remove_dir(&p).map_err(err)
        }
    } else {
        std::fs::remove_file(&p).map_err(err)
    }
}

#[tauri::command]
pub async fn rename_path(old_path: &str, new_path: &str) -> Result<(), String> {
    std::fs::rename(PathBuf::from(old_path), PathBuf::from(new_path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn duplicate_path(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    #[allow(unused_mut)]
    let mut new_name = format!("{} copy", p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
    if let Some(ext) = p.extension().map(|e| e.to_string_lossy().to_string()) {
        new_name = format!("{}.{}", new_name, ext);
    }
    let new_path = p.with_file_name(&new_name);
    if p.is_dir() {
        copy_dir(&p, &new_path).map_err(|e| e.to_string())
    } else {
        std::fs::copy(&p, &new_path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn reveal_in_explorer(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    #[cfg(target_os = "windows")]
    {
        let parent = p.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        let name = p.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        let _ = std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&p.to_string_lossy().to_string())
            .spawn();
        let _ = parent;
        let _ = name;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&p).spawn();
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
) -> Result<u64, String> {
    use std::io::Read;

    let root = PROJECT_ROOT.read().await.clone();
    let mgr = Arc::clone(&TERMINAL_MANAGER);
    let id = mgr.spawn(root.as_deref())?;
    let app_clone = app.clone();
    let mgr_clone = Arc::clone(&mgr);
    std::thread::spawn(move || {
        let mut reader = match mgr_clone.take_reader(id) {
            Ok(r) => r,
            Err(e) => {
                let _ = app_clone.emit("terminal:output", (id, e));
                return;
            }
        };
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit("terminal:output", (id, data));
                }
                Err(_) => break,
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn terminal_write(id: u64, data: String) -> Result<(), String> {
    TERMINAL_MANAGER.write(id, &data)
}

#[tauri::command]
pub async fn terminal_resize(id: u64, cols: u16, rows: u16) -> Result<(), String> {
    TERMINAL_MANAGER.resize(id, cols, rows)
}

#[tauri::command]
pub async fn terminal_close(id: u64) -> Result<(), String> {
    TERMINAL_MANAGER.close(id);
    Ok(())
}

#[tauri::command]
pub async fn get_run_configs() -> Result<Vec<crate::runner::RunConfig>, String> {
    let root = PROJECT_ROOT.read().await.clone();
    let root = root.ok_or_else(|| "no project open".to_string())?;
    Ok(crate::runner::RUNNER.detect_configs(&root))
}

#[tauri::command]
pub async fn run_project(config_id: String, debug: bool, app: AppHandle) -> Result<u64, String> {
    let root = PROJECT_ROOT.read().await.clone();
    let root = root.ok_or_else(|| "no project open".to_string())?;
    let configs = crate::runner::RUNNER.detect_configs(&root);
    let config = configs
        .into_iter()
        .find(|c| c.id == config_id)
        .ok_or_else(|| "run config not found".to_string())?;
    crate::runner::RUNNER.run(&config, debug, &root, app)
}

#[tauri::command]
pub async fn stop_run(id: u64) -> Result<(), String> {
    crate::runner::RUNNER.stop(id)
}

async fn lsp_manager() -> Result<Arc<LspClientManager>, String> {
    let guard = super::LSP_MANAGER.read().await.clone();
    guard.ok_or_else(|| "no project open".to_string())
}

#[tauri::command]
pub async fn lsp_open(uri: String, language: String, text: String) -> Result<(), String> {
    let manager = lsp_manager().await?;
    let manager = manager.clone();
    tokio::task::spawn_blocking(move || manager.open(uri, language, text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_change(uri: String, text: String) -> Result<(), String> {
    let manager = lsp_manager().await?;
    let manager = manager.clone();
    tokio::task::spawn_blocking(move || manager.change(&uri, &text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_close(uri: String) -> Result<(), String> {
    let manager = lsp_manager().await?;
    let manager = manager.clone();
    tokio::task::spawn_blocking(move || manager.close(&uri))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_completion(
    uri: String,
    line: u32,
    character: u32,
) -> Result<Vec<crate::lsp::protocol::CompletionItem>, String> {
    let manager = lsp_manager().await?;
    let manager = manager.clone();
    tokio::task::spawn_blocking(move || manager.completion(&uri, line, character))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_hover(
    uri: String,
    line: u32,
    character: u32,
) -> Result<serde_json::Value, String> {
    let manager = lsp_manager().await?;
    let manager = manager.clone();
    let result = tokio::task::spawn_blocking(move || manager.hover(&uri, line, character))
        .await
        .map_err(|e| e.to_string())??;
    Ok(serde_json::to_value(result).unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn lsp_definition(
    uri: String,
    line: u32,
    character: u32,
) -> Result<Vec<crate::lsp::protocol::Location>, String> {
    let manager = lsp_manager().await?;
    let manager = manager.clone();
    tokio::task::spawn_blocking(move || manager.definition(&uri, line, character))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Debug Adapter Protocol
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn dap_start(config: DebugConfig, app: AppHandle) -> Result<u64, String> {
    DAP_MANAGER.start(config, app)
}

#[tauri::command]
pub async fn dap_stop(session_id: u64) -> Result<(), String> {
    DAP_MANAGER.stop(session_id)
}

#[tauri::command]
pub async fn dap_initialize(
    session_id: u64,
    adapter_id: String,
) -> Result<serde_json::Value, String> {
    DAP_MANAGER.initialize(session_id, &adapter_id)
}

#[tauri::command]
pub async fn dap_launch(
    session_id: u64,
    args: serde_json::Value,
    configuration_done: bool,
) -> Result<(), String> {
    DAP_MANAGER.launch(session_id, args, configuration_done)
}

#[tauri::command]
pub async fn dap_attach(
    session_id: u64,
    args: serde_json::Value,
    configuration_done: bool,
) -> Result<(), String> {
    DAP_MANAGER.attach(session_id, args, configuration_done)
}

#[tauri::command]
pub async fn dap_set_breakpoints(
    session_id: u64,
    source_path: String,
    lines: Vec<i64>,
) -> Result<Vec<crate::dap::protocol::Breakpoint>, String> {
    DAP_MANAGER.install_breakpoints(session_id, &source_path, lines)
}

#[tauri::command]
pub async fn dap_threads(
    session_id: u64,
) -> Result<Vec<crate::dap::protocol::Thread>, String> {
    DAP_MANAGER.threads(session_id)
}

#[tauri::command]
pub async fn dap_stack_trace(
    session_id: u64,
    thread_id: i64,
) -> Result<Vec<crate::dap::protocol::StackFrame>, String> {
    DAP_MANAGER.stack_trace(session_id, thread_id)
}

#[tauri::command]
pub async fn dap_scopes(
    session_id: u64,
    frame_id: i64,
) -> Result<Vec<crate::dap::protocol::Scope>, String> {
    DAP_MANAGER.scopes(session_id, frame_id)
}

#[tauri::command]
pub async fn dap_variables(
    session_id: u64,
    variables_reference: i64,
) -> Result<Vec<crate::dap::protocol::Variable>, String> {
    DAP_MANAGER.variables(session_id, variables_reference)
}

#[tauri::command]
pub async fn dap_continue(session_id: u64, thread_id: i64) -> Result<(), String> {
    DAP_MANAGER.continue_run(session_id, thread_id)
}

#[tauri::command]
pub async fn dap_next(session_id: u64, thread_id: i64) -> Result<(), String> {
    DAP_MANAGER.next(session_id, thread_id)
}

#[tauri::command]
pub async fn dap_step_in(session_id: u64, thread_id: i64) -> Result<(), String> {
    DAP_MANAGER.step_in(session_id, thread_id)
}

#[tauri::command]
pub async fn dap_step_out(session_id: u64, thread_id: i64) -> Result<(), String> {
    DAP_MANAGER.step_out(session_id, thread_id)
}

#[tauri::command]
pub async fn dap_pause(session_id: u64, thread_id: i64) -> Result<(), String> {
    DAP_MANAGER.pause(session_id, thread_id)
}

// ---------------------------------------------------------------------------
// Git source control
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_status() -> Result<GitStatus, String> {
    GIT.status()
}

#[tauri::command]
pub async fn git_diff(path: String) -> Result<GitFileDiff, String> {
    let repo = GIT.open_for_ipc()?;
    file_diff(&repo, &path)
}

#[tauri::command]
pub async fn git_stage(path: String, staged: bool) -> Result<GitStatus, String> {
    let repo = GIT.open_for_ipc()?;
    stage_path(&repo, &path, staged)?;
    collect_status(&repo)
}

#[tauri::command]
pub async fn git_stage_all() -> Result<GitStatus, String> {
    let repo = GIT.open_for_ipc()?;
    stage_all(&repo)?;
    collect_status(&repo)
}

#[tauri::command]
pub async fn git_commit(message: String) -> Result<GitCommitResult, String> {
    let repo = GIT.open_for_ipc()?;
    git_commit_fn(&repo, &message)
}

#[tauri::command]
pub async fn git_branches() -> Result<GitBranches, String> {
    let repo = GIT.open_for_ipc()?;
    branches(&repo)
}

#[tauri::command]
pub async fn git_checkout(branch: String) -> Result<GitStatus, String> {
    let repo = GIT.open_for_ipc()?;
    checkout(&repo, &branch)?;
    collect_status(&repo)
}

// ---------------------------------------------------------------------------
// AI features
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_build_index(app: AppHandle) -> Result<usize, String> {
    use crate::ai::AiIndexProgress;
    app.emit("ai:index-progress", AiIndexProgress { files_scanned: 0, chunks_indexed: 0, duration_ms: 0 }).ok();
    let manager = crate::ai::AiManager::global().clone();
    let result = tokio::task::spawn_blocking(move || manager.rebuild_index())
        .await
        .map_err(|e| e.to_string())??;
    app.emit("ai:index-done", result).ok();
    Ok(result)
}

#[tauri::command]
pub async fn ai_search(query: String, limit: usize) -> Result<Vec<AiSearchResult>, String> {
    crate::ai::AiManager::global().search(&query, limit.max(1).min(50))
}

#[tauri::command]
pub async fn ai_context(file: String) -> Result<AiContextBundle, String> {
    crate::ai::AiManager::global().context_for_file(&file)
}

#[tauri::command]
pub async fn ai_complete(prefix: String) -> Result<Option<String>, String> {
    Ok(crate::ai::AiManager::global().complete_local(&prefix))
}

#[tauri::command]
pub async fn ai_index_status() -> Result<usize, String> {
    Ok(crate::ai::AiManager::global().chunk_count())
}

// ---- helpers -----------------------------------------------------------

fn walk_dir(dir: &PathBuf) -> Result<Vec<FileNode>, std::io::Error> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        entries.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: None,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}