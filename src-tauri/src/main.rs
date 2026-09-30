// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `agamizcode extension …` is a developer-facing subcommand, so it has to
    // run before the GUI takes over. Dispatching on argv here (rather than in
    // the library) keeps the Tauri builder free of CLI concerns and means the
    // same binary serves both roles.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("extension") {
        std::process::exit(app_lib::cli::run(&args[1..]));
    }
    app_lib::run();
}
