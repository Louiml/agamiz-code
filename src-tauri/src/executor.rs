//! Executer Service — turns "run this file" into a concrete chain of
//! processes, and drives that chain with live stdio streaming.
//!
//! A *plan* is an ordered list of [`RunStep`]s. Most languages need exactly
//! one (interpret); native languages need two or more (compile, then execute
//! the produced binary). Routing lives here rather than in TypeScript for two
//! reasons: the argv construction needs the resolved compiler path anyway, and
//! the backend is the only place that can see the filesystem layout (`--version`
//! probing, `Cargo.toml` sniffing, temp build directories).
//!
//! ## Routing table
//!
//! | Language    | Steps                                                        |
//! |-------------|--------------------------------------------------------------|
//! | Python      | `python -u <file>`                                           |
//! | C           | `gcc/clang <file> -o <tmp>` then `<tmp>`                     |
//! | C++         | `g++/clang++ <file> -o <tmp>` then `<tmp>`                   |
//! | JavaScript  | `node <file>`                                                |
//! | TypeScript  | `ts-node` → `bun` → `deno` → `node --experimental-strip-types` |
//! | Go          | `go run <file>`                                              |
//! | Rust        | `cargo run` (crate detected) or `rustc` then the binary     |
//! | Java        | `javac <file> -d <tmp>` then `java -cp <tmp> <Class>`        |
//! | Shell/Pwsh  | `bash <file>` / `pwsh -File <file>`                          |
//! | Rak         | routed to the native `run_rak` bridge (see `kind: "rak"`)    |
//!
//! Anything else is reported as `unsupported` with actionable guidance rather
//! than failing silently; the escape hatch is a `tasks.json` entry the frontend
//! sends back through `run_target`'s explicit `program`/`argv` parameters.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Emitter};

use crate::interpreter;

/// Live child processes keyed by the session id the frontend allocated.
static RUN_PROCS: LazyLock<Mutex<HashMap<u64, Child>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// stdin pipes for interactive sessions (a Python REPL, `node`, a shell).
static RUN_STDIN: LazyLock<Mutex<HashMap<u64, ChildStdin>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// One process in a run plan.
#[derive(serde::Serialize, Clone)]
pub struct RunStep {
    pub program: String,
    pub args: Vec<String>,
    /// `build` or `run`. The UI labels build output differently so compile
    /// errors are not mistaken for program output.
    pub role: String,
    /// Human-readable purpose, e.g. `Compile` / `Run`.
    pub label: String,
}

/// What the header controls and status bar need in order to render themselves
/// without spawning anything. Deliberately free of I/O — the version string is
/// resolved by the frontend from its cached interpreter list, keyed by `tool`.
#[derive(serde::Serialize, Clone)]
pub struct TargetDescriptor {
    /// Language id, e.g. `python`.
    pub language: String,
    /// `script` | `native` | `shell` | `rak` | `unsupported`.
    pub kind: String,
    pub runnable: bool,
    pub debuggable: bool,
    /// Debug adapter id: `debugpy`, `node-inspector`, or empty.
    pub adapter: String,
    /// Spec id of the tool that would be used (`python`, `gcc`, …). Empty when
    /// the caller supplies an explicit program.
    pub tool: String,
    /// Command preview shown under the interpreter picker.
    pub preview: String,
    /// Short caveat, e.g. "compiles first, then runs the binary".
    pub note: String,
    /// True when the plan compiles before running, so the UI can show a
    /// "Building…" state instead of implying the program is already live.
    pub buildstep: bool,
}

/// A resolved plan plus the metadata the UI renders.
pub struct Plan {
    pub steps: Vec<RunStep>,
    pub descriptor: TargetDescriptor,
}

/// Line of output streamed back to the frontend.
#[derive(serde::Serialize, Clone)]
struct RunLine {
    session: u64,
    step: u32,
    role: String,
    stream: String,
    text: String,
}

/// Terminal state of a session.
#[derive(serde::Serialize, Clone)]
struct RunFinished {
    session: u64,
    code: i32,
    ok: bool,
    error: Option<String>,
}

/// Announcement that a plan step is about to start.
///
/// This is what lets the UI say "Building…" during a compile and "Running…"
/// afterwards, instead of guessing from output content. Without it a C++ run
/// would claim to be running while `g++` was still working.
#[derive(serde::Serialize, Clone)]
struct RunStepStarted {
    session: u64,
    step: u32,
    role: String,
    label: String,
}

/// Map a file path to a language id. Kept deliberately independent of the
/// syntax-highlighting registry: highlighting is a UI concern and several
/// extensions (`.h`, `.mjs`, `.tsx`) resolve differently for highlighting than
/// for execution.
pub fn language_for(file: &str) -> &'static str {
    let lower = file.to_ascii_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();

    match ext.as_str() {
        "py" | "pyw" | "pyi" => "python",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "c++" | "hpp" | "hh" | "hxx" => "cpp",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "go" => "go",
        "rs" => "rust",
        "java" => "java",
        "sh" | "bash" | "zsh" | "ksh" => "shellscript",
        "ps1" | "psm1" | "psd1" => "powershell",
        "php" => "php",
        "rb" => "ruby",
        "rak" => "rak",
        _ => "plaintext",
    }
}

/// Executable extension for the machine we are running on.
fn exe_suffix() -> &'static str {
    if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    }
}

/// Keep a user-controlled file stem from escaping the temp directory.
fn sanitize(stem: &str) -> String {
    stem.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Per-language scratch directory for build artifacts (binaries, `.class`
/// files). Namespaced by file stem so two `main.cpp` files in different
/// folders never collide.
fn build_dir(file: &str) -> PathBuf {
    let stem = Path::new(file)
        .file_stem()
        .map(|s| sanitize(&s.to_string_lossy()))
        .unwrap_or_else(|| "target".to_string());
    let dir = std::env::temp_dir().join("agamiz-build").join(stem);
    let _ = fs::create_dir_all(&dir);
    dir
}

/// First of `ids` that the user pinned explicitly or that exists on `PATH`.
///
/// Explicit overrides win even when the binary is missing, so a mistyped path
/// surfaces as a real error message instead of silently falling back.
fn first_installed<'a>(
    ids: &[&'a str],
    tools: &HashMap<String, String>,
) -> Option<(&'a str, String)> {
    for id in ids {
        if let Some(custom) = tools.get(*id) {
            if !custom.trim().is_empty() {
                let resolved = interpreter::which(custom).unwrap_or_else(|| custom.clone());
                return Some((id, resolved));
            }
        }
        if let Some(found) = interpreter::which(id) {
            return Some((id, found));
        }
    }
    None
}

fn step(program: String, args: Vec<String>, role: &str, label: &str) -> RunStep {
    RunStep {
        program,
        args,
        role: role.to_string(),
        label: label.to_string(),
    }
}

/// Render a step the way a shell would show it, for the command preview.
fn preview_of(steps: &[RunStep]) -> String {
    steps
        .iter()
        .map(|s| {
            let mut parts = vec![format!("\"{}\"", s.program)];
            parts.extend(s.args.iter().map(|a| format!("\"{a}\"")));
            parts.join(" ")
        })
        .collect::<Vec<_>>()
        .join(" && ")
}

fn descriptor(
    language: &str,
    kind: &str,
    runnable: bool,
    debuggable: bool,
    adapter: &str,
    tool: &str,
    note: &str,
) -> TargetDescriptor {
    TargetDescriptor {
        language: language.to_string(),
        kind: kind.to_string(),
        runnable,
        debuggable,
        adapter: adapter.to_string(),
        tool: tool.to_string(),
        preview: String::new(),
        note: note.to_string(),
        buildstep: false,
    }
}

/// Re-stamp the descriptor from the final step list.
///
/// Deriving `buildstep` and `preview` in one place keeps them honest when a
/// routing branch is added or changed, instead of trusting every branch to
/// remember both.
fn with_steps(desc: TargetDescriptor, steps: &[RunStep]) -> TargetDescriptor {
    if steps.is_empty() {
        // Branches with no steps (unsupported types, native Rak) carry a
        // hand-written preview that must survive.
        return desc;
    }
    TargetDescriptor {
        buildstep: steps.iter().any(|s| s.role == "build"),
        preview: preview_of(steps),
        ..desc
    }
}

/// Build the ordered process chain for `file`.
///
/// `tools` maps spec ids (`python`, `gcc`, `node`, …) to user-pinned absolute
/// paths coming from `.agamiz/settings.json`. `extra` is the program arguments
/// supplied by the active run configuration.
pub fn build_plan(
    file: &str,
    tools: &HashMap<String, String>,
    extra: &[String],
) -> Result<Plan, String> {
    let language = language_for(file);
    let file_dir = Path::new(file)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "main".to_string());
    let out_dir = build_dir(file);

    let mut steps: Vec<RunStep> = Vec::new();
    // Every arm of the routing match below assigns this exactly once.
    let mut desc: TargetDescriptor;

    match language {
        // ---- Interpreted: one step, no build. -----------------------------
        "python" => {
            let py = interpreter::resolve_tool("python", tools);
            steps.push(step(
                py.clone(),
                ["-u".to_string(), file.to_string()]
                    .into_iter()
                    .chain(extra.iter().cloned())
                    .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "script",
                true,
                true,
                "debugpy",
                "python",
                "Unbuffered output; stdin is forwarded to the REPL.",
            );
        }

        "javascript" => {
            let node = interpreter::resolve_tool("node", tools);
            steps.push(step(
                node,
                [file.to_string()]
                    .into_iter()
                    .chain(extra.iter().cloned())
                    .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "script",
                true,
                true,
                "node-inspector",
                "node",
                "Debugged through the Node inspector (CDP).",
            );
        }

        // TypeScript has no single canonical runner, so pick the fastest one
        // installed and fall back through the ladder.
        "typescript" | "typescriptreact" => {
            let (runner, runner_args, note) = match first_installed(
                &["ts-node", "bun", "deno"],
                tools,
            ) {
                // ts-node/bun/deno all take a bare file path.
                Some((_, path)) => (
                    path,
                    vec![file.to_string()],
                    "Runs the TypeScript source directly.".to_string(),
                ),
                None => {
                    // Node >= 22.6 strips types itself. Older versions need
                    // the loader flag and still reject unsupported syntax,
                    // so this fallback is explicitly degraded.
                    (
                            interpreter::resolve_tool("node", tools),
                            vec!["--experimental-strip-types".to_string(), file.to_string()],
                            "No ts-node/bun/deno found — falling back to Node type stripping (needs Node 22.6+).".to_string(),
                        )
                }
            };

            steps.push(step(
                runner,
                runner_args
                    .into_iter()
                    .chain(extra.iter().cloned())
                    .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "script",
                true,
                true,
                "node-inspector",
                "node",
                &note,
            );
        }

        "go" => {
            let go = interpreter::resolve_tool("go", tools);
            steps.push(step(
                go,
                ["run".to_string(), file.to_string()]
                    .into_iter()
                    .chain(extra.iter().cloned())
                    .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "native",
                true,
                false,
                "",
                "go",
                "Compiled and executed by `go run` in one step.",
            );
        }

        "php" => {
            let php = interpreter::resolve_tool("php", tools);
            steps.push(step(
                php,
                [file.to_string()]
                    .into_iter()
                    .chain(extra.iter().cloned())
                    .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "script",
                true,
                false,
                "",
                "php",
                "Runs via `php`.",
            );
        }

        "ruby" => {
            let ruby = interpreter::resolve_tool("ruby", tools);
            steps.push(step(
                ruby,
                [file.to_string()]
                    .into_iter()
                    .chain(extra.iter().cloned())
                    .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "script",
                true,
                false,
                "",
                "ruby",
                "Runs via `ruby`.",
            );
        }

        // ---- Compiled: build step, then execute the artifact. ---------------
        "c" => {
            let Some((tool_id, cc)) = first_installed(&["gcc", "clang"], tools) else {
                return Err(
                    "No C compiler found. Install gcc/clang or pin one in the interpreter picker."
                        .to_string(),
                );
            };
            let bin = out_dir.join(format!("{}{}", stem, exe_suffix()));
            steps.push(step(
                cc,
                vec![
                    file.to_string(),
                    "-o".to_string(),
                    bin.to_string_lossy().to_string(),
                ],
                "build",
                "Compile",
            ));
            steps.push(step(
                bin.to_string_lossy().to_string(),
                extra.to_vec(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "native",
                true,
                false,
                "",
                tool_id,
                &format!("Compiled to {}", bin.to_string_lossy()),
            );
        }

        "cpp" => {
            let Some((tool_id, cxx)) = first_installed(&["g++", "clang++", "c++"], tools) else {
                return Err(
                    "No C++ compiler found. Install g++/clang++ or pin one in the interpreter picker."
                        .to_string(),
                );
            };
            let bin = out_dir.join(format!("{}{}", stem, exe_suffix()));
            steps.push(step(
                cxx,
                vec![
                    file.to_string(),
                    "-o".to_string(),
                    bin.to_string_lossy().to_string(),
                ],
                "build",
                "Compile",
            ));
            steps.push(step(
                bin.to_string_lossy().to_string(),
                extra.to_vec(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "native",
                true,
                false,
                "",
                tool_id,
                &format!("Compiled to {}", bin.to_string_lossy()),
            );
        }

        "rust" => {
            // A crate is the only correct way to build a Rust program with
            // dependencies; a bare `rustc` only works for dependency-free
            // single files, so prefer the manifest when one is next to it.
            if file_dir.join("Cargo.toml").is_file() {
                let cargo = interpreter::resolve_tool("cargo", tools);
                steps.push(step(
                    cargo,
                    ["run".to_string()]
                        .into_iter()
                        .chain(extra.iter().cloned())
                        .collect(),
                    "run",
                    "Run",
                ));
                desc = descriptor(
                    language,
                    "native",
                    true,
                    false,
                    "",
                    "cargo",
                    "Cargo.toml detected — running the crate.",
                );
            } else {
                let rustc = interpreter::resolve_tool("rustc", tools);
                let bin = out_dir.join(format!("{}{}", stem, exe_suffix()));
                steps.push(step(
                    rustc,
                    vec![
                        file.to_string(),
                        "-o".to_string(),
                        bin.to_string_lossy().to_string(),
                    ],
                    "build",
                    "Compile",
                ));
                steps.push(step(
                    bin.to_string_lossy().to_string(),
                    extra.to_vec(),
                    "run",
                    "Run",
                ));
                desc = descriptor(
                    language,
                    "native",
                    true,
                    false,
                    "",
                    "rustc",
                    "Single file — compiled with rustc.",
                );
            }
        }

        "java" => {
            let Some((_, javac)) = first_installed(&["javac"], tools) else {
                return Err("javac not found on PATH.".to_string());
            };
            let java = interpreter::resolve_tool("java", tools);
            // Nested/inner classes are addressed as `Outer$Inner`; taking the
            // text before `$` gives the class javac actually wrote.
            let class_name = stem.split('$').next().unwrap_or(&stem).to_string();
            steps.push(step(
                javac,
                vec![
                    file.to_string(),
                    "-d".to_string(),
                    out_dir.to_string_lossy().to_string(),
                ],
                "build",
                "Compile",
            ));
            steps.push(step(
                java,
                [
                    "-cp".to_string(),
                    out_dir.to_string_lossy().to_string(),
                    class_name.clone(),
                ]
                .into_iter()
                .chain(extra.iter().cloned())
                .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "native",
                true,
                false,
                "",
                "javac",
                &format!("Compiled class `{class_name}`, then run with `java`."),
            );
        }

        // ---- Shells --------------------------------------------------------
        "shellscript" => {
            let bash = interpreter::resolve_tool("bash", tools);
            steps.push(step(
                bash,
                [file.to_string()]
                    .into_iter()
                    .chain(extra.iter().cloned())
                    .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(language, "shell", true, false, "", "bash", "Runs via bash.");
        }

        "powershell" => {
            let shell = interpreter::resolve_tool("pwsh", tools);
            steps.push(step(
                shell,
                [
                    "-NoProfile".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-File".to_string(),
                    file.to_string(),
                ]
                .into_iter()
                .chain(extra.iter().cloned())
                .collect(),
                "run",
                "Run",
            ));
            desc = descriptor(
                language,
                "shell",
                true,
                false,
                "",
                "pwsh",
                "Runs via PowerShell with the profile bypassed.",
            );
        }

        // ---- Native Rak: handled by the dedicated `run_rak` bridge so the
        // interpreter/VM/bench modes keep working. The frontend reads `kind`
        // and dispatches accordingly.
        "rak" => {
            desc = descriptor(
                language,
                "rak",
                true,
                false,
                "",
                "",
                "Runs on the native Rak VM (Interpreter / VM / Bench).",
            );
            desc.preview = "rakc --mode <interp|vm|bench>".to_string();
        }

        _ => {
            desc = descriptor(
                language,
                "unsupported",
                false,
                false,
                "",
                "",
                "No built-in runner for this file type. Add a run configuration to tasks.json to run it anyway.",
            );
        }
    }

    if steps.is_empty() && desc.runnable {
        return Err(format!("No runnable step could be built for {file}."));
    }

    Ok(Plan {
        descriptor: with_steps(desc, &steps),
        steps,
    })
}

/// Describe the run/debug affordances for a file without executing anything.
///
/// Powers the status-bar interpreter badge and the enabled/disabled state of
/// the header controls.
#[tauri::command]
pub fn describe_target(
    file: String,
    tools: HashMap<String, String>,
) -> Result<TargetDescriptor, String> {
    let plan = build_plan(&file, &tools, &[])?;
    Ok(plan.descriptor)
}

// ---------------------------------------------------------------------------
// Session execution
// ---------------------------------------------------------------------------

fn emit_line(
    app: &AppHandle,
    session: u64,
    step_index: u32,
    role: &str,
    stream: &str,
    text: String,
) {
    let _ = app.emit(
        "run-output",
        RunLine {
            session,
            step: step_index,
            role: role.to_string(),
            stream: stream.to_string(),
            text,
        },
    );
}

fn emit_finished(app: &AppHandle, session: u64, code: i32, ok: bool, error: Option<String>) {
    let _ = app.emit(
        "run-done",
        RunFinished {
            session,
            code,
            ok,
            error,
        },
    );
}

/// Pump one pipe into `run-output` events on its own thread.
fn forward_pipe<R: Read + Send + 'static>(
    app: AppHandle,
    session: u64,
    step_index: u32,
    role: String,
    stream: &'static str,
    reader: R,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            emit_line(&app, session, step_index, &role, stream, line);
        }
    });
}

fn spawn_step(step_def: &RunStep, cwd: &str, with_stdin: bool) -> Result<Child, String> {
    let mut cmd = Command::new(&step_def.program);
    cmd.args(&step_def.args);
    if !cwd.trim().is_empty() {
        cmd.current_dir(cwd);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if with_stdin {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.spawn()
        .map_err(|e| format!("Failed to start `{}`: {}", step_def.program, e))
}

/// Wait for the interactive (final) process to exit, then announce completion.
///
/// Polls rather than blocking a thread on `wait()` so the registry lock is
/// never held across a blocking call.
fn wait_for_exit(app: AppHandle, session: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(80));

        // `Some(Some(code))` = exited here, `Some(None)` = already reaped by a
        // stop, `None` = still running. Locks are released between the two
        // registries so this can never invert against `stop_session`.
        let outcome = {
            let mut procs = RUN_PROCS.lock().unwrap();
            match procs.get_mut(&session) {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        procs.remove(&session);
                        Some(Some(status.code().unwrap_or(-1)))
                    }
                    Ok(None) => None,
                    Err(_) => {
                        procs.remove(&session);
                        Some(Some(-1))
                    }
                },
                None => Some(None),
            }
        };

        if let Some(code) = outcome {
            RUN_STDIN.lock().unwrap().remove(&session);
            if let Some(code) = code {
                emit_finished(&app, session, code, code == 0, None);
            }
            return;
        }
    });
}

/// Execute a plan: build steps run to completion first, then the final step is
/// registered as the interactive session (stdin forwarding + stop support).
fn drive(app: AppHandle, session: u64, steps: Vec<RunStep>, cwd: String) {
    std::thread::spawn(move || {
        for (index, step_def) in steps.iter().enumerate() {
            let is_last = index + 1 == steps.len();

            let _ = app.emit(
                "run-step",
                RunStepStarted {
                    session,
                    step: index as u32,
                    role: step_def.role.clone(),
                    label: step_def.label.clone(),
                },
            );

            let mut child = match spawn_step(step_def, &cwd, is_last) {
                Ok(child) => child,
                Err(message) => {
                    emit_line(
                        &app,
                        session,
                        index as u32,
                        "error",
                        "stderr",
                        message.clone(),
                    );
                    emit_finished(&app, session, -1, false, Some(message));
                    return;
                }
            };

            let role = step_def.role.clone();
            if let Some(stdout) = child.stdout.take() {
                forward_pipe(
                    app.clone(),
                    session,
                    index as u32,
                    role.clone(),
                    "stdout",
                    stdout,
                );
            }
            if let Some(stderr) = child.stderr.take() {
                forward_pipe(app.clone(), session, index as u32, role, "stderr", stderr);
            }

            if is_last {
                if let Some(stdin) = child.stdin.take() {
                    RUN_STDIN.lock().unwrap().insert(session, stdin);
                }
                // Replacing an existing session must not leak the old process.
                let previous = RUN_PROCS.lock().unwrap().insert(session, child);
                if let Some(mut old) = previous {
                    let _ = old.kill();
                    let _ = old.wait();
                }
                wait_for_exit(app, session);
                return;
            }

            // Build step: block until it finishes so a compile error stops the
            // chain before anything is executed.
            match child.wait() {
                Ok(status) => {
                    let code = status.code().unwrap_or(-1);
                    if code != 0 {
                        emit_finished(
                            &app,
                            session,
                            code,
                            false,
                            Some(format!(
                                "`{}` failed with exit code {code}.",
                                step_def.label
                            )),
                        );
                        return;
                    }
                }
                Err(_) => {
                    emit_finished(&app, session, -1, false, None);
                    return;
                }
            }
        }
    });
}

/// Start a run session.
///
/// Two entry points:
/// * **Routed** — pass `file` (plus optional `tools` overrides and `args`) and
///   the backend builds the plan from the extension.
/// * **Explicit** — pass `program`/`argv`, used for custom `tasks.json`
///   commands and for the native Rak modes, where the frontend already owns
///   the argv.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn run_target(
    app: AppHandle,
    session: u64,
    file: String,
    cwd: String,
    tools: HashMap<String, String>,
    args: Vec<String>,
    program: Option<String>,
    argv: Vec<String>,
) -> Result<TargetDescriptor, String> {
    // Stop anything already running under this session id so a double-click
    // on Run never orphans a process.
    let _ = stop_session(session);

    let (steps, desc) = match program {
        Some(explicit) => {
            let mut desc = descriptor(
                language_for(&file),
                "command",
                true,
                false,
                "",
                "",
                "Custom command.",
            );
            desc.preview = {
                let s = step(explicit.clone(), argv.clone(), "run", "Run");
                preview_of(std::slice::from_ref(&s))
            };
            (vec![step(explicit, argv, "run", "Run")], desc)
        }
        None => {
            let plan = build_plan(&file, &tools, &args)?;
            (plan.steps, plan.descriptor)
        }
    };

    if steps.is_empty() {
        return Err("Nothing to run for this file type.".to_string());
    }

    drive(app.clone(), session, steps, cwd);
    Ok(desc)
}

/// Write a line to a live session's stdin (REPL support).
#[tauri::command]
pub fn run_write(session: u64, input: String) -> Result<(), String> {
    let mut map = RUN_STDIN.lock().unwrap();
    let stdin = map
        .get_mut(&session)
        .ok_or_else(|| "That run has already finished.".to_string())?;
    stdin
        .write_all(input.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

/// Kill a single run session. Unlike the legacy `proc_stop`, this leaves other
/// sessions (and the terminal's PTY) untouched.
#[tauri::command]
pub fn run_stop(session: u64) -> Result<(), String> {
    stop_session(session)
}

fn stop_session(session: u64) -> Result<(), String> {
    // Take the child out first, then clear stdin: the two mutexes are never
    // held simultaneously, matching the order `wait_for_exit` uses.
    let previous = RUN_PROCS.lock().unwrap().remove(&session);
    RUN_STDIN.lock().unwrap().remove(&session);
    if let Some(mut child) = previous {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}
