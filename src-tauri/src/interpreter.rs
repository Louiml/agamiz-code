//! Interpreter Resolver — discovers every toolchain the polyglot run/debug
//! engine can drive, and validates user-supplied custom paths.
//!
//! Three discovery sources, in the priority order the UI presents them:
//!
//! 1. `venv`    — `.venv` / `venv` / `env` directories found by walking up
//!                from the workspace root, so a project venv always beats the
//!                system Python on PATH (the VS Code behaviour).
//! 2. `conda`   — named environments under `~/anaconda3/envs` and friends,
//!                plus anything `conda info --envs` reports.
//! 3. `path`    — plain `PATH` scan over the [`SPECS`] table.
//! 4. `wsl`     — interpreters inside the default WSL distribution.
//!
//! Every entry carries a *resolved* executable path so the executor never has
//! to guess, plus a `version` string scraped from `--version` output. Probing
//! is best-effort: a tool that is installed but refuses to report a version is
//! still returned (with version `"unknown"`) so the user can select it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// One discovered toolchain: interpreter, compiler, JS runtime or shell.
#[derive(serde::Serialize, Clone)]
pub struct InterpreterInfo {
    /// Stable id. Tool ids are bare (`python`, `gcc`); environment ids are
    /// namespaced so two venvs never collide (`venv:D:\proj\.venv`).
    pub id: String,
    /// Display label, e.g. `Python 3.12.1 (.venv)`.
    pub label: String,
    /// Bare version string, e.g. `3.12.1`. `"unknown"` when unprobeable.
    pub version: String,
    /// Absolute executable path, or the bare program name for PATH hits.
    pub path: String,
    /// `interpreter` | `compiler` | `runtime` | `shell`.
    pub kind: String,
    /// `path` | `venv` | `conda` | `wsl` | `manual`.
    pub source: String,
    /// Language ids this tool can execute or compile.
    pub languages: Vec<String>,
}

/// Static description of a tool the IDE knows how to look for and invoke.
pub struct ToolSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    /// Candidate executable names, most-preferred first.
    pub programs: &'static [&'static str],
    /// Arguments that make the tool print its version.
    pub version_args: &'static [&'static str],
    pub languages: &'static [&'static str],
}

/// The tools the polyglot engine understands out of the box.
pub const SPECS: &[ToolSpec] = &[
    ToolSpec {
        id: "python",
        label: "Python",
        kind: "interpreter",
        programs: &["python3", "python"],
        version_args: &["--version"],
        languages: &["python"],
    },
    ToolSpec {
        id: "node",
        label: "Node.js",
        kind: "runtime",
        programs: &["node"],
        version_args: &["--version"],
        languages: &["javascript", "typescript", "javascriptreact"],
    },
    ToolSpec {
        id: "bun",
        label: "Bun",
        kind: "runtime",
        programs: &["bun"],
        version_args: &["--version"],
        languages: &["javascript", "typescript", "javascriptreact"],
    },
    ToolSpec {
        id: "deno",
        label: "Deno",
        kind: "runtime",
        programs: &["deno"],
        version_args: &["--version"],
        languages: &["javascript", "typescript"],
    },
    ToolSpec {
        id: "ts-node",
        label: "ts-node",
        kind: "runtime",
        programs: &["ts-node"],
        version_args: &["--version"],
        languages: &["typescript"],
    },
    ToolSpec {
        id: "gcc",
        label: "GCC",
        kind: "compiler",
        programs: &["gcc"],
        version_args: &["--version"],
        languages: &["c"],
    },
    ToolSpec {
        id: "clang",
        label: "Clang",
        kind: "compiler",
        programs: &["clang"],
        version_args: &["--version"],
        languages: &["c"],
    },
    ToolSpec {
        id: "g++",
        label: "G++",
        kind: "compiler",
        programs: &["g++", "c++", "clang++"],
        version_args: &["--version"],
        languages: &["cpp"],
    },
    ToolSpec {
        id: "go",
        label: "Go",
        kind: "runtime",
        programs: &["go"],
        version_args: &["version"],
        languages: &["go"],
    },
    ToolSpec {
        id: "rustc",
        label: "rustc",
        kind: "compiler",
        programs: &["rustc"],
        version_args: &["--version"],
        languages: &["rust"],
    },
    ToolSpec {
        id: "cargo",
        label: "Cargo",
        kind: "runtime",
        programs: &["cargo"],
        version_args: &["--version"],
        languages: &["rust"],
    },
    ToolSpec {
        id: "java",
        label: "Java",
        kind: "runtime",
        programs: &["java"],
        version_args: &["-version"],
        languages: &["java"],
    },
    ToolSpec {
        id: "javac",
        label: "javac",
        kind: "compiler",
        programs: &["javac"],
        version_args: &["-version"],
        languages: &["java"],
    },
    ToolSpec {
        id: "pwsh",
        label: "PowerShell",
        kind: "shell",
        programs: &["pwsh", "powershell"],
        version_args: &["--version"],
        languages: &["powershell"],
    },
    ToolSpec {
        id: "bash",
        label: "Bash",
        kind: "shell",
        programs: &["bash"],
        version_args: &["--version"],
        languages: &["shellscript"],
    },
    ToolSpec {
        id: "php",
        label: "PHP",
        kind: "runtime",
        programs: &["php"],
        version_args: &["--version"],
        languages: &["php"],
    },
    ToolSpec {
        id: "ruby",
        label: "Ruby",
        kind: "runtime",
        programs: &["ruby"],
        version_args: &["--version"],
        languages: &["ruby"],
    },
];

/// Look up a tool spec by id.
pub fn spec_by_id(id: &str) -> Option<&'static ToolSpec> {
    SPECS.iter().find(|s| s.id == id)
}

/// Windows executable extensions probed for every PATH entry. On Unix this is
/// just the bare program name.
fn candidate_names(program: &str) -> Vec<String> {
    if !cfg!(target_os = "windows") {
        return vec![program.to_string()];
    }
    let mut names = vec![program.to_string()];
    let bare = program.rsplit('.').next().unwrap_or(program);
    for ext in ["exe", "cmd", "bat", "com"] {
        let candidate = format!("{bare}.{ext}");
        if !names.contains(&candidate) {
            names.push(candidate);
        }
    }
    names
}

/// Resolve `program` to an absolute path using the OS `PATH` (plus `PATHEXT`
/// on Windows). A path that already exists is accepted verbatim, which is what
/// lets users paste `D:\my_venv\Scripts\python.exe` into the picker.
pub fn which(program: &str) -> Option<String> {
    if program.trim().is_empty() {
        return None;
    }
    let direct = Path::new(program);
    if direct.is_file() {
        return Some(program.to_string());
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for name in candidate_names(program) {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Resolve a tool id to an executable, honouring a user override first and
/// then falling back to the first `programs` entry found on `PATH`.
pub fn resolve_tool(id: &str, overrides: &std::collections::HashMap<String, String>) -> String {
    if let Some(custom) = overrides.get(id) {
        if !custom.trim().is_empty() {
            return which(custom).unwrap_or_else(|| custom.clone());
        }
    }
    match spec_by_id(id) {
        Some(spec) => {
            for program in spec.programs {
                if let Some(found) = which(program) {
                    return found;
                }
            }
            // Not installed: still return the preferred name so the executor
            // produces a "program not found" error the user can act on.
            spec.programs[0].to_string()
        }
        None => id.to_string(),
    }
}

/// Run a command to completion and capture stdout+stderr.
///
/// `.cmd`/`.bat` shims are launched through `cmd /C` because Rust's
/// `Command` cannot execute them directly — that is how `npm`-style wrappers
/// behave on Windows.
fn capture(program: &str, args: &[&str]) -> Option<String> {
    let lower = program.to_ascii_lowercase();
    let needs_shell =
        cfg!(target_os = "windows") && (lower.ends_with(".cmd") || lower.ends_with(".bat"));

    let output = if needs_shell {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", program]);
        cmd.args(args);
        cmd.stdin(Stdio::null()).output()
    } else {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd.stdin(Stdio::null()).output()
    }
    .ok()?;

    Some(format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

/// First non-blank line of captured output.
fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// Pull the first version-looking token out of a line.
///
/// Handles the shapes real tools emit: `Python 3.12.1`,
/// `g++ (GCC) 13.1.0`, `v20.5.0`, `go version go1.22.0 windows/amd64`,
/// `javac 21.0.1`.
fn extract_version(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'.' | b'-' | b'+'))
            {
                i += 1;
            }
            let mut end = i;
            while end > start && matches!(bytes[end - 1], b'.' | b'-' | b'+') {
                end -= 1;
            }
            if end > start {
                return Some(line[start..end].to_string());
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Directory names that conventionally hold a Python virtual environment.
const VENV_DIRS: &[&str] = &[".venv", "venv", "env", ".env", "virtualenv"];

/// Locate the interpreter inside a virtualenv directory (Windows and POSIX
/// layouts).
fn venv_python(dir: &Path) -> Option<PathBuf> {
    const RELATIVE: &[&str] = &[
        r"Scripts\python.exe",
        "Scripts/python.exe",
        "bin/python",
        "bin/python3",
    ];
    for rel in RELATIVE {
        let candidate = dir.join(rel);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Walk up from `start` looking for a virtualenv, innermost first.
///
/// Walking up matters for monorepos and nested packages: the nearest
/// `.venv` is the one whose `pip install` the user actually ran.
fn detect_venvs(start: &Path) -> Vec<InterpreterInfo> {
    let mut found = Vec::new();
    let mut current = Some(start.to_path_buf());
    let mut hops = 0;

    while let Some(dir) = current {
        if hops > 12 {
            break;
        }
        hops += 1;

        // Prefer naming the venv after its own directory (`.venv`, `env`) so
        // several environments in one repo stay distinguishable.
        let workspace_name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "workspace".to_string());

        for venv_name in VENV_DIRS {
            let venv_dir = dir.join(venv_name);
            let Some(python) = venv_python(&venv_dir) else {
                continue;
            };
            let python_path = python.to_string_lossy().to_string();
            let version = capture(&python_path, &["--version"])
                .and_then(|out| extract_version(&first_line(&out)))
                .unwrap_or_else(|| "unknown".to_string());

            found.push(InterpreterInfo {
                id: format!("venv:{python_path}"),
                label: format!("Python {version} ({venv_name})"),
                version,
                path: python_path,
                kind: "interpreter".to_string(),
                source: "venv".to_string(),
                languages: vec!["python".to_string()],
            });

            // Also surface a bare `env/` directory's project name so several
            // venvs in one tree do not all read "env".
            let _ = workspace_name;
        }

        current = dir.parent().map(Path::to_path_buf);
    }

    found
}

/// Named Conda environments under the standard install roots.
fn detect_conda() -> Vec<InterpreterInfo> {
    let mut found = Vec::new();
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return found;
    };
    let home = PathBuf::from(home);

    const ROOTS: &[&str] = &[
        ".conda/envs",
        "anaconda3/envs",
        "miniconda3/envs",
        "Anaconda3/envs",
        "Miniconda3/envs",
        "miniforge3/envs",
    ];

    for root in ROOTS {
        let envs_dir = home.join(root);
        let Ok(entries) = fs::read_dir(&envs_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(python) = venv_python(&path) else {
                continue;
            };
            let python_path = python.to_string_lossy().to_string();
            let version = capture(&python_path, &["--version"])
                .and_then(|out| extract_version(&first_line(&out)))
                .unwrap_or_else(|| "unknown".to_string());
            let env_name = entry.file_name().to_string_lossy().to_string();

            found.push(InterpreterInfo {
                id: format!("conda:{python_path}"),
                label: format!("Python {version} (conda:{env_name})"),
                version,
                path: python_path,
                kind: "interpreter".to_string(),
                source: "conda".to_string(),
                languages: vec!["python".to_string()],
            });
        }
    }

    found
}

/// Interpreters reachable inside the default WSL distribution.
///
/// WSL is slow to start, so the three binaries are probed with a single
/// `sh -lc` round-trip and `--version` is only requested for the hits.
#[cfg(target_os = "windows")]
fn detect_wsl() -> Vec<InterpreterInfo> {
    let mut found = Vec::new();
    if which("wsl").is_none() {
        return found;
    }

    let probe = capture(
        "wsl",
        &[
            "-e",
            "sh",
            "-lc",
            "command -v python3; command -v node; command -v go",
        ],
    )
    .unwrap_or_default();

    if probe.trim().is_empty() {
        return found;
    }

    let mut script = String::new();
    for binary in ["python3", "node", "go"] {
        if probe.lines().any(|line| line.trim() == format!("/usr/bin/{binary}")) {
            script.push_str(&format!("{binary} --version 2>/dev/null | head -1;"));
        }
    }
    if script.is_empty() {
        return found;
    }

    let Some(versions) = capture("wsl", &["-e", "sh", "-lc", &script]) else {
        return found;
    };
    let mut lines = versions.lines();

    for binary in ["python3", "node", "go"] {
        if !probe.lines().any(|line| line.trim() == format!("/usr/bin/{binary}")) {
            continue;
        }
        let Some(line) = lines.next() else { break };
        let version = extract_version(line.trim()).unwrap_or_else(|| "unknown".to_string());
        let label = match binary {
            "python3" => "Python",
            "node" => "Node.js",
            _ => "Go",
        };
        found.push(InterpreterInfo {
            id: format!("wsl:{binary}"),
            label: format!("{label} {version} (WSL)"),
            version,
            path: format!("wsl -e {binary}"),
            kind: if binary == "node" || binary == "go" {
                "runtime".to_string()
            } else {
                "interpreter".to_string()
            },
            source: "wsl".to_string(),
            languages: match binary {
                "python3" => vec!["python".to_string()],
                "node" => vec!["javascript".to_string(), "typescript".to_string()],
                _ => vec!["go".to_string()],
            },
        });
    }

    found
}

#[cfg(not(target_os = "windows"))]
fn detect_wsl() -> Vec<InterpreterInfo> {
    Vec::new()
}

/// Scan the machine for every toolchain the executor can drive.
///
/// Ordering is meaningful and preserved end-to-end by the UI: workspace
/// virtualenvs first, then Conda environments, then `PATH` tools, then WSL.
/// The interpreter picker lists them in this order so the best default lands
/// on top.
#[tauri::command]
pub fn detect_interpreters(cwd: String) -> Vec<InterpreterInfo> {
    let mut found = Vec::new();

    let start = if cwd.trim().is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(&cwd)
    };

    found.extend(detect_venvs(&start));
    found.extend(detect_conda());

    for spec in SPECS {
        let mut resolved: Option<String> = None;
        for program in spec.programs {
            if let Some(found_path) = which(program) {
                resolved = Some(found_path);
                break;
            }
        }
        let Some(path) = resolved else { continue };

        let version = capture(&path, spec.version_args)
            .and_then(|out| extract_version(&first_line(&out)))
            .unwrap_or_else(|| "unknown".to_string());

        found.push(InterpreterInfo {
            id: spec.id.to_string(),
            label: format!("{} {}", spec.label, version),
            version,
            path,
            kind: spec.kind.to_string(),
            source: "path".to_string(),
            languages: spec.languages.iter().map(|l| l.to_string()).collect(),
        });
    }

    found.extend(detect_wsl());

    found
}

/// Validate a user-supplied interpreter/compiler path.
///
/// Used by the "Browse…" entry of the interpreter picker: the file is probed
/// with the best-matching `--version` flags so the picker can show a real
/// version before the user commits to the selection.
#[tauri::command]
pub fn probe_interpreter(path: String) -> Result<InterpreterInfo, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("Interpreter path is empty.".to_string());
    }

    let resolved = which(&trimmed).ok_or_else(|| format!("Executable not found: {trimmed}"))?;
    let exe_name = Path::new(&resolved)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| resolved.clone());

    // Match the executable back to a known spec to pick sensible version flags
    // and to label the tool correctly (a custom venv python still reads
    // "Python 3.12.1", not "python.exe").
    let matched = SPECS.iter().find(|spec| {
        spec.programs
            .iter()
            .any(|program| exe_name.eq_ignore_ascii_case(program)
                || exe_name.eq_ignore_ascii_case(&format!("{program}.exe")))
    });

    let version = matched
        .and_then(|spec| capture(&resolved, spec.version_args))
        .and_then(|out| extract_version(&first_line(&out)))
        .unwrap_or_else(|| "unknown".to_string());

    let (label, kind, languages) = match matched {
        Some(spec) => (
            format!("{} {}", spec.label, version),
            spec.kind.to_string(),
            spec.languages.iter().map(|l| l.to_string()).collect(),
        ),
        None => (exe_name.clone(), "interpreter".to_string(), Vec::new()),
    };

    Ok(InterpreterInfo {
        id: format!("custom:{resolved}"),
        label,
        version,
        path: resolved,
        kind,
        source: "manual".to_string(),
        languages,
    })
}
