//! End-to-end tests for the extension host.
//!
//! These drive the real lifecycle — build a VM, run `extension.lua`, call
//! `activate`, invoke a registered command, deactivate — against a recording
//! event sink instead of a Tauri webview. That is what makes the assertions
//! below meaningful: if `agamiz.commands.register` or the sandbox broke, these
//! would fail, where a compile check would not.
//!
//! Each test writes a throwaway extension into a per-test temp directory so
//! they neither depend on nor disturb the developer's real extensions folder.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::sandbox::HANDLERS_GLOBAL;
use super::{host, manifest, ExtensionHost, EventSink};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/// Captures everything the host emits so tests can assert on it.
#[derive(Debug, Default)]
struct Recorder {
    events: Mutex<Vec<(String, serde_json::Value)>>,
}

impl Recorder {
    fn on(&self, channel: &str) -> Vec<serde_json::Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == channel)
            .map(|(_, payload)| payload.clone())
            .collect()
    }

    fn any(&self, channel: &str) -> bool {
        !self.on(channel).is_empty()
    }
}

impl EventSink for Recorder {
    fn emit(&self, channel: &str, payload: serde_json::Value) {
        self.events
            .lock()
            .unwrap()
            .push((channel.to_string(), payload));
    }
}

/// A temp directory removed when the test ends.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        // Unique per test *and* per process so `cargo test` threads cannot
        // collide, and so a stale directory from a crashed run is never reused.
        let path = std::env::temp_dir().join(format!(
            "agamiz-ext-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Write an extension folder and return its path.
fn write_extension(root: &Path, name: &str, manifest_json: &str, lua: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(dir.join("src")).expect("create extension dir");
    std::fs::write(dir.join("extension.json"), manifest_json).expect("write manifest");
    std::fs::write(dir.join("extension.lua"), lua).expect("write entry point");
    dir
}

/// A host wired to a fresh recorder, rooted at `root`.
fn host_at(root: &Path) -> (ExtensionHost, Arc<Recorder>) {
    let host = ExtensionHost::new(root.to_path_buf());
    let recorder = Arc::new(Recorder::default());
    host.set_sink(Arc::clone(&recorder) as Arc<dyn EventSink>);
    (host, recorder)
}

/// The manifest used by most tests: grants the three UI permissions.
fn manifest_json(name: &str, main: &str) -> String {
    format!(
        r#"{{
          "name": "{name}",
          "displayName": "{name} test",
          "version": "1.0.0",
          "main": "{main}",
          "activationEvents": ["*"],
          "permissions": ["ui:notification", "ui:statusbar", "ui:sidebar", "workspace:read"]
        }}"#
    )
}

fn activate(host: &ExtensionHost, dir: &Path) -> Result<(), String> {
    let manifest = manifest::load_manifest(dir)?;
    host::activate(host, &manifest.name, dir, &manifest)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
/// Manifest for a template-contributing extension. `fs:write` is not optional
/// here: `agamiz.projects.register` refuses without it, which is the point of
/// the last case below.
fn project_manifest_json(name: &str) -> String {
    format!(
        r#"{{
          "name": "{name}",
          "version": "1.0.0",
          "main": "extension.lua",
          "activationEvents": ["*"],
          "permissions": ["fs:write", "ui:notification"]
        }}"#
    )
}

/// Activate a one-template extension and return the templates it registered.
fn try_register(lua: &str) -> Result<Vec<super::ProjectTemplateRecord>, String> {
    let temp = TempDir::new("proj");
    let dir = write_extension(
        temp.path(),
        "proj-test",
        &project_manifest_json("proj-test"),
        lua,
    );
    let (host, _recorder) = host_at(temp.path());
    let loaded = manifest::load_manifest(&dir)?;
    host::activate(&host, "proj-test", &dir, &loaded)?;
    let registry = host.registry.lock().unwrap();
    Ok(registry.snapshot().project_templates)
}

/// Registration body, wrapped in the boilerplate every case needs.
fn template_lua(opts: &str) -> String {
    format!(
        concat!(
            "function activate(ctx)\n",
            "    agamiz.commands.register(\"proj-test.gen\", {{ title = \"Generate\" }}, function() end)\n",
            "    agamiz.projects.register(\"t\", {{\n",
            "{opts}\n",
            "    }})\n",
            "end\n",
        ),
        opts = opts
    )
}

#[test]
fn outputs_require_a_generator() {
    // `outputs` is a promise about what a `createCommand` will produce. Without
    // one, nothing would ever create them and the preview would be a lie.
    let err = try_register(&template_lua(
        "        name = \"T\", files = { { path = \"a.txt\", content = \"\" } },\n        outputs = { \"b.txt\" },",
    ))
    .expect_err("outputs without createCommand must be refused");
    assert!(err.contains("createCommand"), "unhelpful error: {err}");
}

#[test]
fn output_paths_must_stay_inside_the_project() {
    for bad in ["../escape.rak", "/etc/passwd", "C:/Windows/evil", "   "] {
        let opts = format!(
            concat!(
                "        name = \"T\", createCommand = \"proj-test.gen\",\n",
                "        files = {{ {{ path = \"a.txt\", content = \"\" }} }},\n",
                "        outputs = {{ \"{bad}\" }},"
            ),
            bad = bad
        );
        assert!(
            try_register(&template_lua(&opts)).is_err(),
            "{bad:?} should have been refused as an output path"
        );
    }
}

#[test]
fn entry_file_may_name_a_declared_output() {
    // This is the case that makes generator templates usable: the file that
    // opens on create is the generator's, not the IDE's.
    let templates = try_register(&template_lua(
        concat!(
            "        name = \"T\", createCommand = \"proj-test.gen\",\n",
            "        entryFile = \"main.rak\",\n",
            "        files = { { path = \"README.md\", content = \"\" } },\n",
            "        outputs = { \"main.rak\" },"
        ),
    ))
    .expect("a generator entryFile must be accepted");
    assert_eq!(templates[0].entry_file.as_deref(), Some("main.rak"));
    assert_eq!(templates[0].declared_outputs, vec!["main.rak".to_string()]);
}

#[test]
fn an_undeclared_entry_file_is_refused() {
    let err = try_register(&template_lua(concat!(
        "        name = \"T\",\n",
        "        entryFile = \"typo.rak\",\n",
        "        files = { { path = \"README.md\", content = \"\" } },"
    )))
    .expect_err("a typo in entryFile must be refused");
    assert!(err.contains("entryFile"), "unhelpful error: {err}");
}

#[test]
fn an_empty_template_is_refused() {
    // Neither files nor a generator: creates an empty folder and claims success.
    let err = try_register(&template_lua("        name = \"T\","))
        .expect_err("a template that does nothing must be refused");
    assert!(err.contains("at least one"), "unhelpful error: {err}");
}

#[test]
fn registering_a_template_requires_fs_write() {
    // Contributing a template asks the IDE to write that content to disk, so it
    // is gated like any other write. Dropped deliberately below.
    let without_fs_write = r#"{
          "name": "proj-test",
          "version": "1.0.0",
          "main": "extension.lua",
          "activationEvents": ["*"],
          "permissions": ["ui:notification"]
        }"#;
    let lua = template_lua("        name = \"T\", files = { { path = \"a.txt\", content = \"\" } },");

    let temp = TempDir::new("proj-noperm");
    let dir = write_extension(temp.path(), "proj-test", without_fs_write, &lua);
    let (host, _recorder) = host_at(temp.path());
    let loaded = manifest::load_manifest(&dir).unwrap();
    let err = host::activate(&host, "proj-test", &dir, &loaded)
        .expect_err("registering a template without fs:write must fail");
    assert!(err.contains("fs:write"), "unhelpful error: {err}");
}

#[test]
fn activate_runs_the_entry_point_and_registers_commands() {
    let temp = TempDir::new("activate");
    let dir = write_extension(
        temp.path(),
        "lifecycle",
        &manifest_json("lifecycle", "extension.lua"),
        r#"
        activated = true

        function activate(context)
            agamiz.commands.register("lifecycle.hello", { title = "Say Hello" }, function()
                agamiz.window.show_message("info", "hello")
            end)
            agamiz.statusbar.set_item("badge", "ready", { alignment = "left" })
            agamiz.ui.register_sidebar_panel("lifecycle.panel", "Lifecycle", { body = "hi" })
        end

        function deactivate()
            agamiz.log("bye")
        end
        "#,
    );
    let (host, recorder) = host_at(temp.path());

    activate(&host, &dir).expect("activation succeeds");
    assert!(host.is_active("lifecycle"));

    // The command landed in the registry the UI reads, and the registry was
    // pushed to the webview.
    let snapshot = host.registry.lock().unwrap().snapshot();
    assert_eq!(snapshot.commands.len(), 1);
    assert_eq!(snapshot.commands[0].id, "lifecycle.hello");
    assert_eq!(snapshot.commands[0].title, "Say Hello");
    assert_eq!(snapshot.commands[0].extension_id, "lifecycle");

    assert_eq!(snapshot.status.len(), 1);
    assert_eq!(snapshot.status[0].text, "ready");
    assert_eq!(snapshot.status[0].alignment, "left");
    assert_eq!(snapshot.status[0].key, "lifecycle:badge");

    assert_eq!(snapshot.panels.len(), 1);
    assert_eq!(snapshot.panels[0].title, "Lifecycle");

    assert!(recorder.any(super::events::REGISTRY));

    // Deactivating tears the VM down and revokes every contribution.
    host::deactivate(&host, "lifecycle").expect("deactivation succeeds");
    assert!(!host.is_active("lifecycle"));
    let after = host.registry.lock().unwrap().snapshot();
    assert!(after.commands.is_empty(), "commands must be revoked");
    assert!(after.status.is_empty(), "status items must be revoked");
    assert!(after.panels.is_empty(), "panels must be revoked");
}

#[test]
fn running_a_command_reaches_lua_and_emits_back_to_the_webview() {
    let temp = TempDir::new("command");
    let dir = write_extension(
        temp.path(),
        "cmd",
        &manifest_json("cmd", "extension.lua"),
        r#"
        function activate()
            agamiz.commands.register("cmd.stats", function()
                local text = agamiz.editor.get_active_text()
                local n = 0
                for _ in text:gmatch("%S+") do n = n + 1 end
                agamiz.window.show_message("info", "words: " .. n)
                agamiz.statusbar.set_item("words", tostring(n))
            end)
        end
        "#,
    );
    let (host, recorder) = host_at(temp.path());
    activate(&host, &dir).expect("activation succeeds");

    // The frontend pushes the open buffer in; `get_active_text` then answers
    // synchronously from the mirror.
    *host.snapshot.write().unwrap() = super::WorkspaceSnapshot {
        root: "/tmp/project".to_string(),
        active_path: "/tmp/project/main.py".to_string(),
        active_text: "one two three four".to_string(),
        cursor: super::TextPosition {
            line: 0,
            character: 0,
        },
        language_id: "python".to_string(),
        ..Default::default()
    };

    host::run_command(&host, "cmd.stats", Vec::new()).expect("command runs");

    let notices = recorder.on(super::events::NOTICE);
    assert_eq!(notices.len(), 1, "expected one notification");
    assert_eq!(notices[0]["message"], "words: 4");
    assert_eq!(notices[0]["extensionId"], "cmd");

    let status = host.registry.lock().unwrap().snapshot();
    assert_eq!(status.status[0].text, "4");
}

#[test]
fn editor_mutation_requests_are_emitted_for_the_frontend_to_apply() {
    let temp = TempDir::new("editor");
    let dir = write_extension(
        temp.path(),
        "ed",
        &manifest_json("ed", "extension.lua"),
        r#"
        function activate()
            agamiz.editor.insert_text_at(3, 2, "injected")
        end
        "#,
    );
    let (host, recorder) = host_at(temp.path());
    activate(&host, &dir).expect("activation succeeds");

    let requests = recorder.on(super::events::EDITOR);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["action"], "insert");
    assert_eq!(requests[0]["line"], 3);
    assert_eq!(requests[0]["character"], 2);
    assert_eq!(requests[0]["text"], "injected");
}

#[test]
fn require_loads_a_module_from_inside_the_extension_only() {
    let temp = TempDir::new("require");
    let dir = write_extension(
        temp.path(),
        "req",
        &manifest_json("req", "extension.lua"),
        r#"
        local utils = require("src.utils")
        function activate()
            agamiz.statusbar.set_item("answer", utils.answer())
        end
        "#,
    );
    std::fs::write(
        dir.join("src").join("utils.lua"),
        "return { answer = function() return '42' end }",
    )
    .unwrap();

    let (host, _recorder) = host_at(temp.path());
    activate(&host, &dir).expect("activation succeeds");
    let snapshot = host.registry.lock().unwrap().snapshot();
    assert_eq!(snapshot.status[0].text, "42");
}

#[test]
fn required_module_must_exist_inside_the_extension() {
    let temp = TempDir::new("require-escape");
    let dir = write_extension(
        temp.path(),
        "esc",
        &manifest_json("esc", "extension.lua"),
        r#"
        require("../../../../etc/passwd")
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    let err = activate(&host, &dir).expect_err("traversal must be refused");
    assert!(
        err.contains("traverse") || err.contains("cannot load"),
        "unexpected error: {err}"
    );
    assert!(!host.is_active("esc"), "a failed load must not leave a VM");
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

#[test]
fn dangerous_globals_are_not_reachable() {
    let temp = TempDir::new("sandbox");
    let dir = write_extension(
        temp.path(),
        "sandboxed",
        &manifest_json("sandboxed", "extension.lua"),
        r#"
        function activate()
            local report = {}
            for _, name in ipairs({
                "os", "io", "package", "debug", "require2", "dofile", "loadfile", "load", "loadstring"
            }) do
                if _G[name] ~= nil then report[#report + 1] = name end
            end
            -- `os` is present but reduced to clock/calendar.
            local osKeys = {}
            for k in pairs(os) do osKeys[#osKeys + 1] = k end
            table.sort(osKeys)
            agamiz.statusbar.set_item("globals", table.concat(report, ","))
            agamiz.statusbar.set_item("os", table.concat(osKeys, ","))
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    activate(&host, &dir).expect("activation succeeds");

    let snapshot = host.registry.lock().unwrap().snapshot();
    let globals = snapshot
        .status
        .iter()
        .find(|s| s.key == "sandboxed:globals")
        .map(|s| s.text.as_str())
        .unwrap_or_default();
    // `os` is allowed (reduced below); nothing else may be there.
    assert_eq!(globals, "os", "unexpected globals reachable: {globals:?}");

    let os_keys = snapshot
        .status
        .iter()
        .find(|s| s.key == "sandboxed:os")
        .map(|s| s.text.as_str())
        .unwrap_or_default();
    for forbidden in ["execute", "exit", "remove", "rename", "getenv", "tmpname", "setlocale"] {
        assert!(
            !os_keys.split(',').any(|k| k == forbidden),
            "os.{forbidden} must not be reachable (got {os_keys:?})"
        );
    }
}

#[test]
fn string_dump_is_removed() {
    let temp = TempDir::new("dump");
    let dir = write_extension(
        temp.path(),
        "nodump",
        &manifest_json("nodump", "extension.lua"),
        r#"
        function activate()
            agamiz.statusbar.set_item("dump", tostring(string.dump))
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    activate(&host, &dir).expect("activation succeeds");
    let snapshot = host.registry.lock().unwrap().snapshot();
    assert_eq!(
        snapshot.status[0].text, "nil",
        "string.dump must be removed from the sandbox"
    );
}

#[test]
fn the_real_globals_table_is_not_the_sandbox() {
    // `agamiz`'s own state lives in the VM's real globals so Rust can reach it.
    // That must not hand the extension a way to reach — or rewrite — the real
    // global table that other chunks and the host see.
    let temp = TempDir::new("realglobals");
    let dir = write_extension(
        temp.path(),
        "globals",
        &manifest_json("globals", "extension.lua"),
        r#"
        function activate()
            -- Writing a global must land in the extension's own environment.
            _G.pwned = "yes"
            agamiz.statusbar.set_item("visible", tostring(_G.pwned))
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    activate(&host, &dir).expect("activation succeeds");

    // Inside the sandbox the write is visible to that extension...
    let snapshot = host.registry.lock().unwrap().snapshot();
    assert_eq!(snapshot.status[0].text, "yes");

    // ...and absent from the VM's real globals, which only the host reads.
    let vm = host.vms.lock().unwrap().get("globals").cloned().unwrap();
    let lua = vm.lock().unwrap();
    assert_eq!(
        lua.globals().get::<_, Option<String>>("pwned").unwrap(),
        None,
        "an extension must not be able to write the real global table"
    );

    // The handler table really is in the real globals, where Rust expects it.
    let handlers: mlua::Table = lua.globals().get(HANDLERS_GLOBAL).unwrap();
    assert!(handlers.get::<_, mlua::Table>("commands").is_ok());
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

#[test]
fn ungranted_permission_fails_loudly_rather_than_silently() {
    let temp = TempDir::new("permission");
    // No `ui:statusbar` in the list.
    let manifest = r#"{
        "name": "noperm",
        "version": "1.0.0",
        "main": "extension.lua",
        "activationEvents": ["*"],
        "permissions": ["ui:notification"]
    }"#;
    let dir = write_extension(
        temp.path(),
        "noperm",
        manifest,
        r#"
        function activate()
            agamiz.statusbar.set_item("nope", "should not appear")
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    let err = activate(&host, &dir).expect_err("status bar use must be refused");

    assert!(err.contains("ui:statusbar"), "error should name the permission: {err}");
    assert!(err.contains("permission"), "error should be actionable: {err}");
    assert!(!host.is_active("noperm"));
}

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

#[test]
fn a_runtime_error_in_activate_does_not_leave_a_vm() {
    let temp = TempDir::new("error");
    let dir = write_extension(
        temp.path(),
        "boom",
        &manifest_json("boom", "extension.lua"),
        r#"
        function activate()
            error("intentional failure")
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    let err = activate(&host, &dir).expect_err("activation should fail");
    assert!(err.contains("intentional failure"), "unexpected error: {err}");
    assert!(!host.is_active("boom"));
}

#[test]
fn an_infinite_loop_is_stopped_by_the_instruction_budget() {
    let temp = TempDir::new("loop");
    let dir = write_extension(
        temp.path(),
        "loop",
        &manifest_json("loop", "extension.lua"),
        r#"
        function activate()
            while true do end
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    let err = activate(&host, &dir).expect_err("runaway loop must be stopped");
    assert!(
        err.contains("budget"),
        "error should name the instruction budget: {err}"
    );
    assert!(!host.is_active("loop"), "the VM must be discarded");
}

#[test]
fn a_syntax_error_is_reported_with_the_chunk_name() {
    let temp = TempDir::new("syntax");
    let dir = write_extension(
        temp.path(),
        "bad",
        &manifest_json("bad", "extension.lua"),
        "function activate( this is not lua",
    );
    let (host, _recorder) = host_at(temp.path());
    let err = activate(&host, &dir).expect_err("syntax error must surface");
    assert!(
        err.contains("extension.lua"),
        "error should name the chunk: {err}"
    );
}

#[test]
fn one_broken_extension_does_not_block_the_others() {
    let temp = TempDir::new("sweep");
    // The returned handles are unused: the assertions below check activation by
    // id, which is the behaviour under test. Matches the `_bad` binding.
    let _good = write_extension(
        temp.path(),
        "good",
        &manifest_json("good", "extension.lua"),
        r#"
        function activate()
            agamiz.statusbar.set_item("ok", "fine")
        end
        "#,
    );
    let _bad = write_extension(
        temp.path(),
        "bad",
        &manifest_json("bad", "extension.lua"),
        "function activate( nope",
    );

    let (host, _recorder) = host_at(temp.path());
    host::activate_startup(&host);

    assert!(host.is_active("good"), "the healthy extension must still load");
    assert!(!host.is_active("bad"));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn frontend_events_reach_lua_listeners() {
    let temp = TempDir::new("events");
    let dir = write_extension(
        temp.path(),
        "evt",
        &manifest_json("evt", "extension.lua"),
        r#"
        function activate()
            agamiz.on("cursorMoved", function(name, payload)
                agamiz.statusbar.set_item("last", tostring(name) .. ":" .. tostring(payload.line))
            end)
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    activate(&host, &dir).expect("activation succeeds");

    host::dispatch_event(
        &host,
        "evt",
        "cursorMoved",
        &serde_json::json!({ "line": 42 }),
    )
    .expect("dispatch succeeds");

    let snapshot = host.registry.lock().unwrap().snapshot();
    let item = snapshot
        .status
        .iter()
        .find(|s| s.key == "evt:last")
        .expect("listener ran");
    assert_eq!(item.text, "cursorMoved:42");
}

#[test]
fn dispatching_to_an_inactive_extension_is_a_no_op() {
    let temp = TempDir::new("events-inactive");
    let (host, _recorder) = host_at(temp.path());
    // No such extension, and no VM: must not panic or error.
    host::dispatch_event(&host, "ghost", "anything", &serde_json::json!({}))
        .expect("dispatching to an inactive extension is harmless");
}

#[test]
fn save_notification_reaches_workspace_listeners() {
    let temp = TempDir::new("save");
    let dir = write_extension(
        temp.path(),
        "saver",
        &manifest_json("saver", "extension.lua"),
        r#"
        function activate()
            agamiz.workspace.on_did_save_file(function(path)
                agamiz.statusbar.set_item("saved", path)
            end)
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    activate(&host, &dir).expect("activation succeeds");

    host::notify_save(&host, "/tmp/project/notes.md").expect("notify succeeds");
    let snapshot = host.registry.lock().unwrap().snapshot();
    assert_eq!(snapshot.status[0].text, "/tmp/project/notes.md");
}

// ---------------------------------------------------------------------------
// Discovery and reload
// ---------------------------------------------------------------------------

#[test]
fn discovery_finds_installed_and_dev_extensions() {
    let temp = TempDir::new("discover");
    write_extension(
        temp.path(),
        "installed",
        &manifest_json("installed", "extension.lua"),
        "function activate() end",
    );
    write_extension(
        &temp.path().join("dev"),
        "devext",
        &manifest_json("devext", "extension.lua"),
        "function activate() end",
    );
    // A non-extension directory must be ignored rather than reported.
    std::fs::create_dir_all(temp.path().join("not-an-extension")).unwrap();

    let (host, _recorder) = host_at(temp.path());
    let records = host::discover(&host);
    let ids: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"installed"));
    assert!(ids.contains(&"devext"));
    assert!(!ids.contains(&"not-an-extension"));

    let dev = records.iter().find(|r| r.id == "devext").unwrap();
    assert_eq!(dev.source, "dev");
    assert_eq!(dev.version, "1.0.0");
    assert!(dev.enabled, "extensions are enabled by default");
}

#[test]
fn reload_re_registers_everything() {
    let temp = TempDir::new("reload");
    let dir = write_extension(
        temp.path(),
        "reload",
        &manifest_json("reload", "extension.lua"),
        r#"
        local count = 0
        function activate()
            count = count + 1
            -- A fresh VM each time means globals do NOT survive a reload, so
            -- this always registers exactly one command.
            agamiz.commands.register("reload.one", function() end)
        end
        "#,
    );
    let (host, _recorder) = host_at(temp.path());
    activate(&host, &dir).expect("first activation");
    assert_eq!(host.registry.lock().unwrap().snapshot().commands.len(), 1);

    host::reload(&host, "reload").expect("reload succeeds");
    let snapshot = host.registry.lock().unwrap().snapshot();
    assert_eq!(
        snapshot.commands.len(),
        1,
        "a reload must not duplicate contributions"
    );
    assert!(host.is_active("reload"));
}

#[test]
fn a_manifest_that_fails_validation_still_gets_a_row() {
    let temp = TempDir::new("badmanifest");
    let dir = temp.path().join("broken");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("extension.json"),
        r#"{ "name": "Broken", "version": "not-semver" }"#,
    )
    .unwrap();
    std::fs::write(dir.join("extension.lua"), "function activate() end").unwrap();

    let (host, _recorder) = host_at(temp.path());
    let records = host::discover(&host);
    let row = records
        .iter()
        .find(|r| r.id == "broken")
        .expect("a broken manifest must still be listed so it can be removed");
    assert!(
        row.error.is_some(),
        "the row must carry the validation error"
    );
}

// ---------------------------------------------------------------------------
// Manifest gating for activation events
// ---------------------------------------------------------------------------

#[test]
fn activation_events_match_exactly() {
    let m = manifest_with_events("events", &["onLanguage:python", "onCommand:myext.run"]);
    assert!(host::matches_activation(&m, "onLanguage:python"));
    assert!(host::matches_activation(&m, "onCommand:myext.run"));
    assert!(!host::matches_activation(&m, "onLanguage:rust"));
    assert!(!host::matches_activation(&m, "onCommand:other.run"));
    assert!(!host::wants_startup(&m), "no startup event means lazy");
}

#[test]
fn star_activates_at_startup() {
    let m = manifest_with_events("star", &["*"]);
    assert!(host::wants_startup(&m));
    assert!(host::matches_activation(&m, "onStartup"));

    let never = manifest_with_events("never", &["never"]);
    assert!(!host::wants_startup(&never));
    assert!(!host::matches_activation(&never, "onStartup"));
}

/// The documented example must actually load, not just a synthetic fixture.
///
/// Skips (rather than fails) if the repo layout has moved, so this cannot turn
/// into a spurious failure in a packaged build.
#[test]
fn the_shipped_example_extension_loads_and_contributes() {
    let Some(repo) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent() else {
        return;
    };
    let example = repo.join("examples").join("extensions").join("hello-agamiz");
    if !example.join("extension.json").is_file() {
        eprintln!("skipping: {} not found", example.display());
        return;
    }

    let manifest = manifest::load_manifest(&example)
        .unwrap_or_else(|e| panic!("the example manifest must be valid: {e}"));
    assert_eq!(manifest.name, "hello-agamiz");
    assert!(host::wants_startup(&manifest), "example declares onStartup");

    let temp = TempDir::new("example");
    let (host, recorder) = host_at(temp.path());

    // Point the host at the real folder: `activate` only needs the path, so the
    // example can be exercised in place without installing it.
    activate(&host, &example).expect("the shipped example must activate");
    assert!(host.is_active("hello-agamiz"));

    let snapshot = host.registry.lock().unwrap().snapshot();
    assert!(
        snapshot.commands.len() >= 3,
        "example contributes 3 commands, got {}",
        snapshot.commands.len()
    );
    assert!(
        snapshot
            .commands
            .iter()
            .all(|c| c.extension_id == "hello-agamiz"),
        "commands must be attributed to the example"
    );
    assert!(!snapshot.panels.is_empty(), "example contributes a panel");
    assert!(
        !snapshot.status.is_empty(),
        "example sets an initial status item"
    );

    // Run the buffer-analysis command end to end.
    *host.snapshot.write().unwrap() = super::WorkspaceSnapshot {
        root: "/tmp/project".to_string(),
        active_text: "one two three".to_string(),
        ..Default::default()
    };
    host::run_command(&host, "hello-agamiz.analyse", Vec::new())
        .expect("the example's analyse command runs");

    let notices = recorder.on(super::events::NOTICE);
    assert!(
        notices
            .iter()
            .any(|n| n["message"].as_str() == Some("Analysed 3 words across 1 lines.")),
        "expected the analysis notification, got {notices:?}"
    );

    // The insert command must ask the frontend to edit the buffer.
    host::run_command(&host, "hello-agamiz.insertBanner", Vec::new())
        .expect("the example's insert command runs");
    let requests = recorder.on(super::events::EDITOR);
    assert_eq!(requests.len(), 1);
    assert!(requests[0]["text"].as_str().unwrap().contains("added by Hello Agamiz"));
}

/// The `rak-project` example must register a New Project template.
///
/// This is the only test that drives `agamiz.projects.register` end to end —
/// manifest validation, the Lua sandbox, the options-table parser and the
/// registry all have to agree, and a mismatch between the Lua-facing camelCase
/// names and the Rust record would otherwise only surface when a user opened
/// the wizard.
#[test]
fn the_rak_example_registers_a_project_template() {
    let Some(repo) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent() else {
        return;
    };
    let example = repo.join("examples").join("extensions").join("rak-project");
    if !example.join("extension.json").is_file() {
        eprintln!("skipping: {} not found", example.display());
        return;
    }

    let manifest = manifest::load_manifest(&example)
        .unwrap_or_else(|e| panic!("the example manifest must be valid: {e}"));
    assert_eq!(manifest.name, "rak-project");
    // The template needs `fs:write` to register and `process:exec` to run the
    // generator, so a manifest that dropped either would fail at activation
    // rather than at use — which is the behaviour we want, but it means the
    // example is only correct while these are declared.
    for required in ["fs:write", "process:exec"] {
        assert!(
            manifest.permissions.iter().any(|p| p == required),
            "the example must declare {required}"
        );
    }

    let temp = TempDir::new("example-rak");
    let (host, _recorder) = host_at(temp.path());
    activate(&host, &example).expect("the rak example must activate");

    let snapshot = host.registry.lock().unwrap().snapshot();
    assert_eq!(
        snapshot.project_templates.len(),
        1,
        "the example contributes exactly one template"
    );

    let template = &snapshot.project_templates[0];
    assert_eq!(template.extension_id, "rak-project");
    assert_eq!(template.name, "Rak Package");
    // The generator is named rather than inlined, so the wizard can offer the
    // template without the host having to hold a Lua handle.
    assert_eq!(
        template.create_command.as_deref(),
        Some("rak-project.createPackage")
    );
    // `entryFile` is validated against `files` ∪ `outputs` at registration, so
    // this pairing is guaranteed by the host — asserted here to catch a
    // regression in that check rather than in the example.
    assert_eq!(template.entry_file.as_deref(), Some("main.rak"));
    assert!(
        template.declared_outputs.iter().any(|p| p == "main.rak"),
        "entryFile may name a declared output, since the generator creates it"
    );
    // The whole point of `outputs`: a template whose real content comes from a
    // generator must still preview the files it is going to produce.
    for expected in ["package.rak", "lib.rak", "main.rak"] {
        assert!(
            template.declared_outputs.iter().any(|p| p == expected),
            "{expected} should be declared as a generator output, got {:?}",
            template.declared_outputs
        );
    }
    assert!(
        !template.files.iter().any(|f| f.path.ends_with(".rak")),
        "the .rak files are the generator's to write, not the IDE's"
    );
    assert!(
        template
            .create_command
            .as_deref()
            .is_some_and(|id| snapshot
                .commands
                .iter()
                .any(|c| c.id == id)),
        "createCommand must reference a command this extension registered"
    );

    // Deactivating must revoke the template too, or a disabled extension would
    // keep offering itself in the wizard.
    host::deactivate(&host, "rak-project").expect("deactivate");
    assert!(
        host.registry
            .lock()
            .unwrap()
            .snapshot()
            .project_templates
            .is_empty(),
        "deactivation must remove contributed templates"
    );
}

/// Build a manifest in memory. `ExtensionManifest`'s fields are public, so no
/// test-only constructor is needed in the production module.
fn manifest_with_events(name: &str, events: &[&str]) -> manifest::ExtensionManifest {
    manifest::ExtensionManifest {
        name: name.to_string(),
        display_name: None,
        version: "1.0.0".to_string(),
        description: None,
        author: None,
        repository: None,
        main: "extension.lua".to_string(),
        files: Vec::new(),
        activation_events: events.iter().map(|e| e.to_string()).collect(),
        permissions: Vec::new(),
    }
}

/// The `rak-examples` extension must load and contribute one command per
/// example, and running one must deliver the real source text to the editor.
///
/// This is the only test that exercises `open_buffer` end to end, and it is
/// also the check that the generated Lua modules round-trip: a long-bracket
/// string that closed early, or a body with quotes and backslashes in it, would
/// show up as a missing command or a mangled payload.
#[test]
fn the_rak_examples_extension_contributes_every_example() {
    let Some(repo) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent() else {
        return;
    };
    let dir = repo.join("examples").join("extensions").join("rak-examples");
    if !dir.join("extension.json").is_file() {
        eprintln!("skipping: {} not found", dir.display());
        return;
    }

    let m = manifest::load_manifest(&dir).expect("the example manifest must be valid");
    let temp = TempDir::new("example-rak-ex");
    let (host, recorder) = host_at(temp.path());
    host::activate(&host, "rak-examples", &dir, &m).expect("the example must activate");

    let commands: Vec<String> = {
        let registry = host.registry.lock().unwrap();
        let snap = registry.snapshot();
        assert!(
            snap.commands.len() >= 20,
            "expected one command per example, got {}",
            snap.commands.len()
        );
        assert!(
            snap.commands.iter().all(|c| c.extension_id == "rak-examples"),
            "commands must be attributed to the example"
        );
        snap.commands.iter().map(|c| c.id.clone()).collect()
    };
    assert!(
        commands.iter().all(|id| id.starts_with("rak-examples.open.")),
        "every command should be an example opener, got {commands:?}"
    );
    assert!(
        commands.iter().any(|id| id == "rak-examples.open.hello.rak"),
        "the hello example should be contributed"
    );

    // Run one and check the editor request that comes back out.
    host::run_command(&host, "rak-examples.open.hello.rak", Vec::new())
        .expect("the example command runs");
    let requests = recorder.on(super::events::EDITOR);
    assert_eq!(requests.len(), 1, "expected one editor request");
    assert_eq!(requests[0]["action"].as_str(), Some("openBuffer"));
    assert_eq!(requests[0]["name"].as_str(), Some("hello.rak"));
    assert_eq!(
        requests[0]["text"].as_str(),
        Some("dump \"Hello, World\"\n"),
        "the generated Lua must preserve the example source exactly"
    );
}

/// The examples must be reachable only through the extension, so nothing can
/// quietly reintroduce a bundled copy or the toolbar menu.
#[test]
fn the_bundled_rak_examples_are_gone() {
    let Some(repo) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent() else {
        return;
    };
    assert!(
        !repo.join("src")
            .join("extensions")
            .join("rak")
            .join("examples.ts")
            .exists(),
        "the Rak examples moved into the rak-examples extension"
    );
    assert!(
        !repo
            .join("src")
            .join("app")
            .join("components")
            .join("ExamplesMenu.tsx")
            .exists(),
        "the toolbar Examples menu was replaced by extension contributions"
    );
}
