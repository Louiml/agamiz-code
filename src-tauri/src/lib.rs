use agamiz_engine::ipc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_decorations(false).ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::open_project,
            ipc::close_project,
            ipc::get_file_tree,
            ipc::read_file_content,
            ipc::write_file_content,
            ipc::query_symbols,
            ipc::get_diagnostics,
            ipc::rename_symbol,
            ipc::get_git_status,
            ipc::get_git_graph,
            ipc::create_file,
            ipc::create_folder,
            ipc::delete_path,
            ipc::rename_path,
            ipc::duplicate_path,
            ipc::reveal_in_explorer,
            ipc::terminal_spawn,
            ipc::terminal_write,
            ipc::terminal_resize,
            ipc::terminal_close,
            ipc::get_run_configs,
            ipc::run_project,
            ipc::stop_run,
            ipc::lsp_open,
            ipc::lsp_change,
            ipc::lsp_close,
            ipc::lsp_completion,
            ipc::lsp_hover,
            ipc::lsp_definition,
            ipc::dap_start,
            ipc::dap_stop,
            ipc::dap_initialize,
            ipc::dap_launch,
            ipc::dap_attach,
            ipc::dap_set_breakpoints,
            ipc::dap_threads,
            ipc::dap_stack_trace,
            ipc::dap_scopes,
            ipc::dap_variables,
            ipc::dap_continue,
            ipc::dap_next,
            ipc::dap_step_in,
            ipc::dap_step_out,
            ipc::dap_pause,
            ipc::git_status,
            ipc::git_diff,
            ipc::git_stage,
            ipc::git_stage_all,
            ipc::git_commit,
            ipc::git_branches,
            ipc::git_checkout,
            ipc::ai_build_index,
            ipc::ai_search,
            ipc::ai_context,
            ipc::ai_complete,
            ipc::ai_index_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}