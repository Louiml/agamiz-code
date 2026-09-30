//! Per-extension sandbox: builds the `_ENV` an extension actually runs in.
//!
//! `Lua::new()` already loads only mlua's "safe" standard-library subset, but
//! "safe" there means *no C modules* — it still leaves `os.execute`,
//! `os.getenv`, `os.remove` and a writable `io` reachable. None of those are
//! acceptable for third-party code, so this module does not rely on the
//! library subset alone. It constructs a **fresh** environment table and copies
//! across an explicit allowlist, then re-attaches only the namespaces the
//! manifest's `permissions` actually grant.
//!
//! What an extension can reach, by construction:
//!
//! * Language core (`assert`, `pcall`, `pairs`, …) and the pure libraries
//!   `string` / `table` / `math` / `coroutine` / `utf8`, minus the few
//!   functions that are unsafe or abusable (`string.dump`).
//! * `os` reduced to `time` / `clock` / `date`.
//! * **Never** `debug`, `package`, `io`, `require`, `load`, `loadstring`,
//!   `dofile`, `loadfile` — the real ones. `require` is re-implemented in Rust
//!   ([`sandbox_require`]) so module resolution cannot escape the extension
//!   folder, and it re-uses the same environment for the loaded chunk.
//! * The `agamiz` namespace from [`crate::ext::api`], whose mutating calls
//!   check the manifest permissions at call time.
//!
//! Two resource limits back this up, because a pure namespace story does not
//! stop `while true do end` or `local t = {} while true do t[#t+1] = {} end`:
//! an instruction budget via a Lua debug hook and a memory cap via
//! `Lua::set_memory_limit`. Both are installed by [`harden`].

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use mlua::{Function, Lua, Table, Value};

/// Name of the global that holds an extension's handler table.
///
/// It lives in the VM's *real* globals rather than the sandbox `_ENV`, which
/// is deliberate on two counts: an extension cannot read or tamper with its
/// own callback table, and Rust can always reach it through
/// `lua.globals()` without needing mlua's feature-gated named-registry API.
/// The name is unguessable from Lua only by convention, so treat the real
/// globals as host-private, not as a security boundary — the sandbox `_ENV`
/// is the boundary.
pub const HANDLERS_GLOBAL: &str = "__agamiz_handlers";

/// Fetch an extension's handler table. Panics are avoided by returning a
/// `Result`: the table is installed by `build_env` before any extension code
/// runs, so a `None` here means the host used the VM incorrectly.
pub fn handlers<'lua>(lua: &'lua Lua) -> mlua::Result<Table<'lua>> {
    lua.globals().get(HANDLERS_GLOBAL)
}

/// Instruction budget per activation, generous enough for real work but low
/// enough that a runaway loop fails in well under a second instead of pinning a
/// core and making the IDE look hung.
const INSTRUCTION_BUDGET: u32 = 20_000_000;

/// Per-extension heap cap. Extensions are small scripts; 64 MiB is far more
/// than the scaffold ever needs and still bounds a runaway table.
const MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;

/// Global names copied from the real environment into the sandbox.
///
/// An allowlist rather than a denylist: anything mlua adds to a future Lua
/// version is excluded by default instead of silently becoming reachable.
const ALLOWED_GLOBALS: &[&str] = &[
    "assert",
    "error",
    "getmetatable",
    "ipairs",
    "next",
    "pairs",
    "pcall",
    "print",
    "rawequal",
    "rawget",
    "rawlen",
    "rawset",
    "select",
    "setmetatable",
    "tonumber",
    "tostring",
    "type",
    "warn",
    "xpcall",
];

/// Pure, side-effect-free libraries copied wholesale.
const ALLOWED_LIBRARIES: &[&str] = &["coroutine", "math", "table", "utf8"];

/// `os` members that cannot touch the machine.
const ALLOWED_OS: &[&str] = &["clock", "date", "difftime", "time"];

/// Members removed from copied-in libraries.
const STRIPPED_STRING_MEMBERS: &[&str] = &["dump"];

/// Everything an extension's `agamiz.*` functions need from the host.
///
/// Deliberately holds only `Arc`s and plain data: every closure mlua creates
/// must be `Send + 'static` (the `send` feature is enabled), and none of these
/// fields can reach a `Lua`, which would re-introduce the self-reference
/// problem described on [`HANDLERS_KEY`].
#[derive(Clone)]
pub struct ExtCtx {
    /// Extension id; namespaces every contributed id and every event payload.
    pub id: String,
    /// Absolute extension folder. The boundary for `require` and `fs` access.
    pub root: PathBuf,
    /// Grants copied from the manifest. Checked on every guarded call.
    pub permissions: Arc<BTreeSet<String>>,
    /// Emit channel to the webview. Abstracted so tests can drive the host
    /// without a Tauri application (see [`crate::ext::EventSink`]).
    pub sink: Arc<dyn crate::ext::EventSink>,
    /// Contribution registry shared with the Extensions UI.
    pub registry: Arc<std::sync::Mutex<crate::ext::Registry>>,
    /// Cached editor/workspace state pushed in from the frontend.
    pub snapshot: Arc<std::sync::RwLock<crate::ext::WorkspaceSnapshot>>,
}

impl ExtCtx {
    /// Error raised when Lua calls an API its manifest does not grant.
    ///
    /// Deliberately a Lua `error` rather than a silent no-op: an extension
    /// author should see "permission ui:statusbar not granted" in the output
    /// channel, not wonder why their status bar item never appears.
    pub fn require(&self, permission: &str, api: &str) -> Result<(), mlua::Error> {
        if self.permissions.contains(permission) {
            return Ok(());
        }
        Err(mlua::Error::external(format!(
            "{}: extension {:?} did not request the {permission:?} permission \
             (add it to \"permissions\" in extension.json)",
            api, self.id
        )))
    }
}

/// Build the sandbox environment and install the `agamiz` API into it.
///
/// Returns the environment table; the caller must keep using it as the
/// environment for *every* chunk the extension loads (entry point, modules
/// pulled in by `require`) so a module cannot escape by being compiled with
/// the real globals.
pub fn build_env<'lua>(lua: &'lua Lua, ctx: ExtCtx) -> Result<Table<'lua>, String> {
    let globals = lua.globals();
    let env = lua.create_table().map_err(|e| e.to_string())?;

    for name in ALLOWED_GLOBALS {
        let value: Value = globals
            .get(*name)
            .map_err(|e| format!("reading global {name}: {e}"))?;
        env.set(*name, value).map_err(|e| e.to_string())?;
    }

    for name in ALLOWED_LIBRARIES {
        let Ok(Value::Table(lib)) = globals.get::<_, Value>(*name) else {
            continue;
        };
        env.set(*name, lib).map_err(|e| e.to_string())?;
    }

    // `string` needs a filtered copy: `string.dump` serialises a function to
    // bytecode, which is both an exfiltration primitive and a way to smuggle
    // code past source-level review.
    if let Ok(Value::Table(string_lib)) = globals.get::<_, Value>("string") {
        let filtered = lua.create_table().map_err(|e| e.to_string())?;
        for pair in string_lib.clone().pairs::<Value, Value>() {
            let (key, value) = pair.map_err(|e| e.to_string())?;
            let keep = match &key {
                Value::String(name) => {
                    !STRIPPED_STRING_MEMBERS.contains(&name.to_string_lossy().as_ref())
                }
                // Metatable and array part are structural, not callable.
                _ => true,
            };
            if keep {
                filtered.set(key, value).map_err(|e| e.to_string())?;
            }
        }
        env.set("string", filtered).map_err(|e| e.to_string())?;
    }

    // Reduced `os`: clock and calendar only. No `execute`, `getenv`,
    // `remove`, `rename`, `exit`, `tmpname` or `setlocale`.
    if let Ok(Value::Table(os_lib)) = globals.get::<_, Value>("os") {
        let filtered = lua.create_table().map_err(|e| e.to_string())?;
        for name in ALLOWED_OS {
            let value: Value = os_lib.get(*name).map_err(|e| e.to_string())?;
            filtered.set(*name, value).map_err(|e| e.to_string())?;
        }
        env.set("os", filtered).map_err(|e| e.to_string())?;
    }

    // `_G` must be the sandbox, not the real global table, so that
    // `_G.print = ...` cannot rewrite what other chunks see.
    env.set("_G", env.clone()).map_err(|e| e.to_string())?;

    // Handler table: the Rust-visible home of every registered callback.
    let handlers = lua.create_table().map_err(|e| e.to_string())?;
    for bucket in ["commands", "events", "workspace", "panels"] {
        let t = lua.create_table().map_err(|e| e.to_string())?;
        handlers.set(bucket, t).map_err(|e| e.to_string())?;
    }
    let loaded = lua.create_table().map_err(|e| e.to_string())?;
    handlers.set("loaded", loaded).map_err(|e| e.to_string())?;
    handlers
        .set("env", env.clone())
        .map_err(|e| e.to_string())?;
    lua.globals()
        .set(HANDLERS_GLOBAL, handlers)
        .map_err(|e| e.to_string())?;

    install_require(lua, &env, ctx.clone())?;

    // Replace `print` so extension output reaches the IDE's output channel
    // (and the extension log) instead of the app's stdout, which a GUI build
    // on Windows does not show.
    let print_ctx = ctx.clone();
    let print = lua
        .create_function(move |lua, args: mlua::Variadic<Value>| {
            let mut parts = Vec::new();
            for value in args.iter() {
                parts.push(crate::ext::api::lua_to_string(lua, value.clone()));
            }
            print_ctx.log(&parts.join("\t"));
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    env.set("print", print).map_err(|e| e.to_string())?;

    crate::ext::api::install(lua, &env, ctx)?;

    harden(lua)?;
    Ok(env)
}

/// Install the resource limits described in the module docs.
fn harden(lua: &Lua) -> Result<(), String> {
    let budget = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let limit = INSTRUCTION_BUDGET;

    // `set_hook` is infallible; the budget lives in the callback's counter.
    lua.set_hook(
        mlua::HookTriggers::new().every_nth_instruction(100_000),
        move |_lua, _debug| {
            let used = budget.fetch_add(100_000, std::sync::atomic::Ordering::Relaxed);
            if used >= limit {
                // Returning Err aborts the running chunk; the value becomes a
                // catchable Lua error, which the host wraps so a runaway
                // extension cannot wedge the UI thread.
                return Err(mlua::Error::external(format!(
                    "extension exceeded its {limit}-instruction budget \
                     (infinite loop, or unexpectedly heavy work)"
                )));
            }
            Ok(())
        },
    );

    let _ = lua.set_memory_limit(MEMORY_LIMIT_BYTES);
    Ok(())
}

/// Install the sandboxed `require`.
///
/// The stock `require` resolves through `package.path` and will happily read a
/// file outside the extension folder. This one maps a module name to a
/// `.lua` path under the extension root, rejects anything that could escape,
/// caches results, and compiles the module in the *sandbox* environment.
fn install_require<'lua>(lua: &'lua Lua, env: &Table<'lua>, ctx: ExtCtx) -> Result<(), String> {
    let require = lua
        .create_function(move |lua, module: String| {
            // Keep both the path check and the chunk name short: the resolved
            // absolute path would be truncated in error messages, hiding which
            // module failed.
            let relative = module_relative_path(&module).map_err(mlua::Error::external)?;
            let path = module_path(&ctx.root, &module)?;
            let handlers = handlers(lua)?;

            // `package.loaded`-style memoisation, keyed by the resolved path.
            if let Some(loaded) = handlers.get::<_, Option<Table>>("loaded")? {
                if let Some(cached) = loaded.get::<_, Option<Value>>(relative.as_str())? {
                    if !matches!(cached, Value::Nil) {
                        return Ok(cached);
                    }
                }
            }

            let source = std::fs::read_to_string(&path).map_err(mlua::Error::external)?;
            let sandbox: Table = handlers.get("env")?;

            // The chunk is compiled in the sandbox env, not the real globals,
            // so a required module gets the same restricted view.
            let function: Function = lua
                .load(&source)
                .set_name(relative.clone())
                .set_environment(sandbox)
                .into_function()
                .map_err(mlua::Error::external)?;

            // A module that returns nothing is cached as `true`, matching Lua.
            // The error is propagated rather than folded into that default:
            // `unwrap_or` would swallow a syntax error or a failed nested
            // require, leaving the caller to index a bare `true` and report
            // something like "attempt to index a boolean value" with no mention
            // of the module that actually broke.
            let exported: Value = function.call(())?;
            let value = if matches!(exported, Value::Nil) {
                Value::Boolean(true)
            } else {
                exported
            };

            if let Some(loaded) = handlers.get::<_, Option<Table>>("loaded")? {
                let _ = loaded.set(relative, value.clone());
            }
            Ok(value)
        })
        .map_err(|e| e.to_string())?;

    env.set("require", require).map_err(|e| e.to_string())?;
    Ok(())
}

/// Map a `require` argument to an absolute path inside the extension root.
///
/// Accepts both dotted (`src.utils`) and slashed (`src/utils`) spellings. The
/// lexically-decidable half lives in [`module_relative_path`] so it can be
/// unit-tested without a real directory; this wrapper adds the symlink-aware
/// containment check that needs the filesystem.
fn module_path(root: &std::path::Path, module: &str) -> Result<PathBuf, mlua::Error> {
    let relative = module_relative_path(module).map_err(mlua::Error::external)?;
    let candidate = root.join(&relative);

    // Re-check after joining: `root` itself is trusted, but a symlinked
    // subdirectory could still point outside it.
    let root_real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    match candidate.canonicalize() {
        Ok(real) if real.starts_with(&root_real) => Ok(candidate),
        Ok(_) => Err(mlua::Error::external(format!(
            "require: module {module:?} resolves outside the extension folder"
        ))),
        // Not on disk: report the canonicalisation failure, which is the
        // actionable "no such module" the author needs.
        Err(e) => Err(mlua::Error::external(format!(
            "require: cannot load module {module:?}: {e}"
        ))),
    }
}

/// Purely lexical: a module name to a `.lua` path relative to the extension
/// root. Rejects everything that could escape before any I/O happens.
///
/// The order of operations matters and is easy to get wrong. An earlier
/// version rewrote `.` to `/` first, which (a) turned `a..b` into `a//b` and
/// silently defeated the traversal check, and (b) turned `utils.lua` into
/// `utils/lua.lua`. So: strip the extension, then split on both separators and
/// validate *every* segment against a strict allowlist.
fn module_relative_path(module: &str) -> Result<String, String> {
    if module.is_empty() {
        return Err("require: empty module name".to_string());
    }
    if module.contains('\\') {
        return Err(format!(
            "require: module {module:?} must use '/' separators"
        ));
    }
    if module.starts_with('/') {
        return Err(format!(
            "require: module {module:?} must be relative to the extension folder"
        ));
    }
    // Windows drive/UNC prefix, rejected before any path handling.
    let bytes = module.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(format!(
            "require: module {module:?} must be relative to the extension folder"
        ));
    }

    // Strip the extension before touching separators.
    let stem = module.strip_suffix(".lua").unwrap_or(module);

    // Split on both separators, then allowlist each segment. This is what
    // catches `..` (splits to empty segments) and `a..b`, and it also rejects
    // spaces and other characters that have no business in a module name.
    let mut segments = Vec::new();
    for segment in stem.split(['.', '/']) {
        if segment.is_empty() {
            return Err(format!(
                "require: module {module:?} must not traverse outside the extension folder"
            ));
        }
        if !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(format!(
                "require: module {module:?} has an invalid path segment {segment:?} \
                 (use letters, digits, '-' or '_')"
            ));
        }
        segments.push(segment);
    }

    if segments.is_empty() {
        return Err("require: empty module name".to_string());
    }
    Ok(format!("{}.lua", segments.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_path_accepts_dotted_and_slashed() {
        assert_eq!(module_relative_path("src.utils").unwrap(), "src/utils.lua");
        assert_eq!(module_relative_path("src/utils").unwrap(), "src/utils.lua");
        assert_eq!(
            module_relative_path("src/utils.lua").unwrap(),
            "src/utils.lua"
        );
        assert_eq!(module_relative_path("main").unwrap(), "main.lua");
    }

    #[test]
    fn module_path_blocks_escape() {
        for bad in [
            "..",
            "../secrets",
            "a..b",
            "a/../../b",
            "",
            "a\\b",
            "/abs",
            "C:evil",
            "a b",
            "....//....//etc",
        ] {
            assert!(
                module_relative_path(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn module_path_rejects_symlink_escape() {
        // A real directory is needed: the escape check is symlink-aware, so it
        // cannot be exercised against a synthetic path.
        let base = std::env::temp_dir().join(format!("agamiz-sandbox-{}", std::process::id()));
        let ext = base.join("ext");
        let outside = base.join("outside");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.lua"), "return 'leaked'").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, ext.join("link")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, ext.join("link")).unwrap();

        // A legitimate module resolves.
        std::fs::write(ext.join("ok.lua"), "return 1").unwrap();
        assert!(module_path(&ext, "ok").is_ok());

        // One that escapes does not, even though it is inside `ext` lexically.
        let escaped = module_path(&ext, "link.secret");
        assert!(escaped.is_err(), "symlink escape must be rejected");

        let _ = std::fs::remove_dir_all(&base);
    }
}
