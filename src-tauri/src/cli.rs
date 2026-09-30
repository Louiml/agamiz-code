//! `agamizcode extension …` — the command-line half of the extension tooling.
//!
//! A subcommand of the existing binary rather than a separate crate, so it can
//! share [`crate::ext::manifest`] — the scaffolder and the host validate an
//! `extension.json` with exactly the same code, which means a generated
//! extension cannot be one the IDE then rejects.
//!
//!     agamizcode extension init my-extension
//!
//! Missing manifest fields are prompted for when a terminal is attached, and
//! fall back to sensible defaults otherwise (so the command works in CI and in
//! package scripts without hanging on a read that will never return).

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use crate::ext::manifest::is_valid_extension_id;

/// Entry point from `main`. Returns a process exit code.
pub fn run(args: &[String]) -> i32 {
    attach_parent_console();

    match args.first().map(String::as_str) {
        Some("init") => match init(&args[1..]) {
            Ok(path) => {
                println!("Created extension scaffold at {}", path.display());
                println!("\nNext steps:");
                println!("  1. cd {}", path.display());
                println!("  2. edit extension.lua");
                println!("  3. install it from the Extensions panel, or copy it into");
                println!("     {}/dev/", display_dev_root());
                0
            }
            Err(e) => {
                eprintln!("agamizcode: {e}");
                1
            }
        },
        Some("list") => match list() {
            Ok(entries) => {
                if entries.is_empty() {
                    println!("No extensions installed in {}", display_root());
                } else {
                    for entry in entries {
                        println!("{entry}");
                    }
                }
                0
            }
            Err(e) => {
                eprintln!("agamizcode: {e}");
                1
            }
        },
        Some(other) => {
            eprintln!("agamizcode: unknown subcommand {other:?}\n");
            eprintln!("Usage:");
            eprintln!("  agamizcode extension init [name] [options]  Scaffold a new extension");
            eprintln!("  agamizcode extension list                  List installed extensions");
            2
        }
        None => {
            eprintln!("agamizcode extension <init|list>");
            2
        }
    }
}

/// Options accepted by `init`, parsed from `--flag value` pairs.
struct Options {
    name: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    author: Option<String>,
    repository: Option<String>,
    directory: Option<PathBuf>,
    non_interactive: bool,
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut options = Options {
        name: None,
        display_name: None,
        description: None,
        author: None,
        repository: None,
        directory: None,
        non_interactive: false,
    };

    let mut iter = args.iter().peekable();
    let mut positional: Vec<String> = Vec::new();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--display-name" | "--description" | "--author" | "--repository" | "--dir" => {
                let value = iter
                    .next()
                    .ok_or_else(|| format!("{arg} needs a value"))?
                    .clone();
                match arg.as_str() {
                    "--display-name" => options.display_name = Some(value),
                    "--description" => options.description = Some(value),
                    "--author" => options.author = Some(value),
                    "--repository" => options.repository = Some(value),
                    _ => options.directory = Some(PathBuf::from(value)),
                }
            }
            "--yes" | "-y" => options.non_interactive = true,
            "-h" | "--help" => {
                return Err("help".to_string());
            }
            other if other.starts_with('-') => {
                return Err(format!("unknown option {other:?}"));
            }
            other => positional.push(other.to_string()),
        }
    }

    if positional.len() > 1 {
        return Err(format!(
            "expected at most one extension name, got {}",
            positional.len()
        ));
    }
    options.name = positional.into_iter().next();
    Ok(options)
}

/// `init [name]` — create a new extension folder in the current directory.
fn init(args: &[String]) -> Result<PathBuf, String> {
    let options = parse_options(args)?;
    if std::io::stdout().is_terminal() && !options.non_interactive {
        println!("agamizcode extension init");
    }

    // The name is the one field we cannot invent: it becomes the folder name,
    // the install id and the prefix every contributed id should carry.
    let name = match options.name.clone() {
        Some(name) => name,
        None => prompt("Extension name (lowercase, dash-separated)", "my-extension")?,
    };
    if !is_valid_extension_id(&name) {
        return Err(format!(
            "{name:?} is not a valid extension name — use lowercase letters, \
             digits and dashes, starting with a letter or digit"
        ));
    }

    let interactive = std::io::stdin().is_terminal() && !options.non_interactive;

    let display_name = match options.display_name.clone() {
        Some(value) => value,
        None if interactive => prompt("Display name", &humanize(&name))?,
        None => humanize(&name),
    };
    let description = match options.description.clone() {
        Some(value) => value,
        None if interactive => prompt(
            "Description",
            "Adds custom productivity tools to Agamiz Code.",
        )?,
        None => "Adds custom productivity tools to Agamiz Code.".to_string(),
    };
    let author = match options.author.clone() {
        Some(value) => value,
        None if interactive => prompt("Author", &whoami())?,
        None => whoami(),
    };
    let repository = match options.repository.clone() {
        Some(value) => value,
        None if interactive => {
            // Optional: an empty answer is a valid manifest (the field is
            // omitted), so this prompt may be skipped.
            prompt("Git repository URL (optional)", "")?
        }
        None => String::new(),
    };

    let base = options
        .directory
        .clone()
        .unwrap_or_else(|| PathBuf::from("."));
    let root = base.join(&name);
    if root.exists() {
        return Err(format!("{} already exists", root.display()));
    }

    std::fs::create_dir_all(root.join("src"))
        .map_err(|e| format!("could not create {}: {e}", root.display()))?;

    write_file(
        &root.join("extension.json"),
        &manifest_json(&ManifestInput {
            name: &name,
            display_name: &display_name,
            description: &description,
            author: &author,
            repository: &repository,
        }),
    )?;
    write_file(
        &root.join("extension.lua"),
        &entry_point(&name, &display_name),
    )?;
    write_file(&root.join("src/utils.lua"), UTILS_TEMPLATE)?;
    write_file(
        &root.join("README.md"),
        &readme(&name, &display_name, &description),
    )?;
    write_file(&root.join(".gitignore"), GITIGNORE)?;

    // Prove the scaffold is loadable before reporting success. A generated
    // extension that the host would reject is worse than a failed command.
    crate::ext::manifest::load_manifest(&root)
        .map_err(|e| format!("the generated extension is not valid: {e}"))?;

    Ok(root)
}

/// `list` — print `id  version  path` for everything installed.
fn list() -> Result<Vec<String>, String> {
    let root = crate::ext::commands::ensure_root()?;
    let mut out = Vec::new();
    for dir in [root.clone(), root.join(crate::ext::host::DEV_DIR)] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.join("extension.json").is_file() {
                continue;
            }
            match crate::ext::manifest::load_manifest(&path) {
                Ok(manifest) => out.push(format!(
                    "{}\t{}\t{}",
                    manifest.name,
                    manifest.version,
                    path.display()
                )),
                Err(e) => out.push(format!(
                    "{}\t<invalid>\t{}: {e}",
                    entry.file_name().to_string_lossy(),
                    path.display()
                )),
            }
        }
    }
    out.sort();
    Ok(out)
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

struct ManifestInput<'a> {
    name: &'a str,
    display_name: &'a str,
    description: &'a str,
    author: &'a str,
    repository: &'a str,
}

/// Render the manifest by hand rather than via `serde_json::to_string_pretty`.
///
/// The field order and inline arrays are what make the generated file pleasant
/// to read and diff, and the escape helper keeps a quote in a description from
/// producing a manifest that will not parse.
fn manifest_json(input: &ManifestInput) -> String {
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(&format!("  \"name\": \"{}\",\n", escape(input.name)));
    out.push_str(&format!(
        "  \"displayName\": \"{}\",\n",
        escape(input.display_name)
    ));
    out.push_str("  \"version\": \"1.0.0\",\n");
    out.push_str(&format!(
        "  \"description\": \"{}\",\n",
        escape(input.description)
    ));
    out.push_str(&format!("  \"author\": \"{}\",\n", escape(input.author)));
    if !input.repository.trim().is_empty() {
        out.push_str(&format!(
            "  \"repository\": \"{}\",\n",
            escape(input.repository)
        ));
    }
    out.push_str("  \"main\": \"extension.lua\",\n");
    out.push_str("  \"files\": [\n");
    out.push_str("    \"extension.lua\",\n");
    out.push_str("    \"src/utils.lua\"\n");
    out.push_str("  ],\n");
    out.push_str("  \"activationEvents\": [\n");
    out.push_str(&format!("    \"onCommand:{}.run\",\n", input.name));
    out.push_str("    \"onLanguage:plaintext\"\n");
    out.push_str("  ],\n");
    out.push_str("  \"permissions\": [\n");
    out.push_str("    \"ui:notification\",\n");
    out.push_str("    \"ui:statusbar\"\n");
    out.push_str("  ]\n");
    out.push_str("}\n");
    out
}

/// Minimal JSON string escaping for the fields we generate.
fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn entry_point(name: &str, display_name: &str) -> String {
    format!(
        r#"-- {display_name}
--
-- Lifecycle contract:
--   activate(context)  called when the extension is enabled and one of its
--                       activationEvents matches. `context.id`, `context.root`
--                       and `context.subscriptions` are available.
--   deactivate()        called when the extension is disabled, reloaded, or the
--                       IDE shuts down. Release anything you allocated.
--
-- The `agamiz` global is the only bridge into the IDE. Every call is checked
-- against the "permissions" array in extension.json, so a call you did not
-- request fails with an explanatory error rather than silently doing nothing.

local utils = require("src.utils")

--- Extension Activation Entry Point
function activate(context)
    agamiz.window.show_message("info", "{display_name} is now active!")

    agamiz.commands.register("{name}.run", {{
        title = "{display_name}: Run",
        shortcut = "Ctrl+Shift+E",
    }}, function()
        local text = agamiz.editor.get_active_text()
        local stats = utils.count_words(text)

        agamiz.statusbar.set_item("summary", string.format(
            "%d words / %d lines", stats.words, stats.lines))

        agamiz.window.show_message("info", string.format(
            "Analysed %d words across %d lines.", stats.words, stats.lines))
    end)

    agamiz.commands.register("{name}.insertBanner", function()
        agamiz.editor.insert_text_at(1, 0, utils.banner("{display_name}"))
    end)

    -- Panel bodies are plain text: the host never evaluates extension-supplied
    -- markup, so this cannot inject anything into the IDE's own UI.
    agamiz.ui.register_sidebar_panel("{name}.info", "{display_name}", {{
        icon = "sparkles",
        body = "Run `{name}.run` to analyse the active buffer.",
    }})

    context.subscriptions[#context.subscriptions + 1] =
        agamiz.workspace.on_did_save_file(function(path)
            agamiz.log("saved: " .. path)
        end)
end

--- Extension Deactivation Cleanup
function deactivate()
    -- The VM is discarded wholesale, so registered commands, listeners and
    -- status-bar items are released automatically. Call this only for work
    -- that lives outside the VM (a spawned process, a temp file).
    agamiz.log("{display_name} deactivated.")
end
"#
    )
}

const UTILS_TEMPLATE: &str = r#"-- Helper module for the extension.
--
-- `require("src.utils")` resolves to this file. The host's `require` is
-- sandboxed: it only reads .lua files inside this extension's own folder, so
-- a module name can never reach the rest of the filesystem.

local utils = {}

--- Count words and lines in a chunk of text.
function utils.count_words(text)
    local words, lines = 0, 1
    for _ in text:gmatch("%S+") do
        words = words + 1
    end
    for _ in text:gmatch("\n") do
        lines = lines + 1
    end
    return { words = words, lines = lines }
end

--- A comment banner suitable for inserting at the top of a file.
function utils.banner(title)
    return string.format("-- ==== %s ====\n\n", title)
end

return utils
"#;

fn readme(name: &str, display_name: &str, description: &str) -> String {
    format!(
        r#"# {display_name}

{description}

## Install

Copy this folder into the Agamiz Code extensions directory:

- **Installed:** `~/.agamizcode/extensions/{name}`
- **Development (hot-reloads on save):** `~/.agamizcode/extensions/dev/{name}`

Or use the Extensions panel: *Import & Load Extensions → Import from Local Folder*.

## Layout

```
{name}/
├── extension.json   manifest: metadata, entry point, permissions
├── extension.lua    activate() / deactivate()
├── src/
│   └── utils.lua    required as `require("src.utils")`
└── README.md
```

## API

| Call | Needs permission |
| --- | --- |
| `agamiz.commands.register(id, callback)` | — |
| `agamiz.editor.get_active_text()` | — |
| `agamiz.editor.insert_text_at(line, col, text)` | — |
| `agamiz.window.show_message(type, msg)` | `ui:notification` |
| `agamiz.statusbar.set_item(id, text)` | `ui:statusbar` |
| `agamiz.workspace.get_root_path()` | `workspace:read` |
| `agamiz.workspace.on_did_save_file(cb)` | `workspace:read` |
| `agamiz.ui.register_sidebar_panel(id, title, cfg)` | `ui:sidebar` |
| `agamiz.fs.read_file(path)` | `fs:read` |
| `agamiz.process.exec(program, args, cwd)` | `process:exec` |
| `agamiz.http.get(url)` | `network:http` |

## Permissions

`os.execute`, `io`, `package`, `require` (the real one), `load`, `dofile` and
`loadfile` are not reachable. Add a capability by extending the `permissions`
array in `extension.json`; unknown permission names are rejected at load time.

The VM also has an instruction budget and a heap cap, so an accidental
infinite loop fails the extension instead of freezing the IDE.
"#
    )
}

const GITIGNORE: &str = r#"# Build output
build/
dist/
*.zip

# Editor / OS noise
.DS_Store
Thumbs.db
*.swp
*~
"#;

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

/// Read one line, returning `default` on an empty answer or EOF.
fn prompt(question: &str, default: &str) -> Result<String, String> {
    print!("{question}");
    if !default.is_empty() {
        print!(" [{default}]");
    }
    print!(": ");
    std::io::stdout()
        .flush()
        .map_err(|e| format!("could not write to the terminal: {e}"))?;

    let mut line = String::new();
    let read = std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| format!("could not read from the terminal: {e}"))?;
    if read == 0 {
        // EOF (piped input exhausted): keep the default rather than hanging.
        println!();
        return Ok(default.to_string());
    }
    let answer = line.trim();
    if answer.is_empty() {
        Ok(default.to_string())
    } else {
        Ok(answer.to_string())
    }
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// `my-extension` → `My Extension`.
fn humanize(name: &str) -> String {
    name.split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn whoami() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
}

fn display_root() -> String {
    crate::ext::commands::default_root()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "~/.agamizcode/extensions".to_string())
}

fn display_dev_root() -> String {
    display_root()
}

/// Re-attach the parent console on Windows.
///
/// A release build sets `windows_subsystem = "windows"`, so the binary has no
/// console of its own and anything printed would vanish. Attaching to the
/// parent console is what makes `agamizcode extension init` usable from a
/// normal terminal in a shipped build rather than only under `cargo run`.
///
/// `AttachConsole` is sufficient on its own: for a process without standard
/// handles, Windows points them at the console's, so `std::io::stdout()` starts
/// working without re-binding the std streams by hand. Failure is expected and
/// ignored — it just means a console is already attached, or there is none.
#[cfg(target_os = "windows")]
fn attach_parent_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    // SAFETY: a plain Win32 call with no arguments to get wrong; the error is
    // deliberately ignored.
    let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
}

#[cfg(not(target_os = "windows"))]
fn attach_parent_console() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_output_is_valid_json() {
        let json = manifest_json(&ManifestInput {
            name: "my-extension",
            display_name: "My Extension",
            description: "Does \"things\"",
            author: "A\\B",
            repository: "",
        });
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["name"], "my-extension");
        assert_eq!(parsed["displayName"], "My Extension");
        assert_eq!(parsed["description"], "Does \"things\"");
        assert_eq!(parsed["author"], "A\\B");
        // An empty repository is omitted rather than emitted as "".
        assert!(parsed.get("repository").is_none());
    }

    #[test]
    fn generated_manifest_passes_host_validation() {
        let json = manifest_json(&ManifestInput {
            name: "my-extension",
            display_name: "My Extension",
            description: "A description.",
            author: "Someone",
            repository: "https://github.com/example/my-extension",
        });
        let manifest: crate::ext::manifest::ExtensionManifest =
            serde_json::from_str(&json).expect("valid manifest");
        manifest
            .validate()
            .expect("host accepts generated manifest");
    }

    #[test]
    fn humanize_reads_well() {
        assert_eq!(humanize("my-extension"), "My Extension");
        assert_eq!(humanize("a-b_c"), "A B C");
    }

    #[test]
    fn option_parsing() {
        let args = stringify(&["name", "--author", "Me", "--yes"]);
        let options = parse_options(&args).unwrap();
        assert_eq!(options.name.as_deref(), Some("name"));
        assert_eq!(options.author.as_deref(), Some("Me"));
        assert!(options.non_interactive);

        assert!(parse_options(&stringify(&["--author"])).is_err());
        assert!(parse_options(&stringify(&["a", "b"])).is_err());
    }

    /// Build the `Vec<String>` a real invocation would hand `parse_options`.
    fn stringify(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).to_string()).collect()
    }
}
