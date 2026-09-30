//! The `agamiz` global — the only door an extension has into the IDE.
//!
//! Two rules shape every function here:
//!
//! 1. **Permission is checked at call time.** A granted permission is a
//!    precondition for the operation, not a hint. Failing loudly beats
//!    silently doing nothing, because "my status bar item never appeared" is a
//!    much harder bug to diagnose than "permission ui:statusbar not granted".
//! 2. **Nothing blocks on the webview.** The editor APIs read a mirror the
//!    frontend keeps up to date ([`crate::ext::WorkspaceSnapshot`]) and the
//!    mutating ones *emit* an event and return. A command handler therefore
//!    never holds a VM lock across an IPC round-trip, which is what keeps the
//!    lock order in [`crate::ext`] deadlock-free.

use std::path::{Path, PathBuf};

use mlua::{Lua, Table, Value};

use crate::ext::sandbox::ExtCtx;
use crate::ext::{CommandRecord, PanelRecord, ProjectTemplateFile, ProjectTemplateRecord, StatusRecord};
use crate::ext::events;

/// Install `agamiz` into the sandbox environment.
pub fn install(lua: &Lua, env: &Table, ctx: ExtCtx) -> Result<(), String> {
    let api = lua.create_table().map_err(|e| e.to_string())?;

    install_meta(lua, &api, &ctx)?;
    install_logging(lua, &api, &ctx)?;
    install_commands(lua, &api, &ctx)?;
    install_editor(lua, &api, &ctx)?;
    install_window(lua, &api, &ctx)?;
    install_status_bar(lua, &api, &ctx)?;
    install_projects(lua, &api, &ctx)?;
    install_workspace(lua, &api, &ctx)?;
    install_ui(lua, &api, &ctx)?;
    install_events(lua, &api)?;
    install_fs(lua, &api, &ctx)?;
    install_process(lua, &api, &ctx)?;
    install_http(lua, &api, &ctx)?;

    env.set("agamiz", api).map_err(|e| e.to_string())?;
    Ok(())
}

/// `agamiz.extension` — read-only facts about the running extension.
fn install_meta(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let ext = lua.create_table().map_err(|e| e.to_string())?;
    ext.set("id", ctx.id.as_str()).map_err(|e| e.to_string())?;
    ext.set("root", ctx.root.to_string_lossy().as_ref())
        .map_err(|e| e.to_string())?;

    let permissions = lua.create_table().map_err(|e| e.to_string())?;
    for permission in ctx.permissions.iter() {
        permissions
            .set(permission.as_str(), true)
            .map_err(|e| e.to_string())?;
    }
    ext.set("permissions", permissions)
        .map_err(|e| e.to_string())?;

    // `agamiz.has_permission("fs:write")` avoids a pcall around every call for
    // extensions that want to degrade gracefully instead of erroring.
    let has = ctx.clone();
    let has_fn = lua
        .create_function(move |_, permission: String| Ok(has.permissions.contains(&permission)))
        .map_err(|e| e.to_string())?;
    ext.set("has_permission", has_fn)
        .map_err(|e| e.to_string())?;

    api.set("extension", ext).map_err(|e| e.to_string())?;
    Ok(())
}

fn install_logging(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    for (name, level) in [("log", "info"), ("log_warn", "warning"), ("log_error", "error")] {
        let c = ctx.clone();
        let log_fn = lua
            .create_function(move |lua, args: mlua::Variadic<Value>| {
                let mut parts = Vec::new();
                for value in args.iter() {
                    parts.push(lua_to_string(lua, value.clone()));
                }
                c.log_at(level, &parts.join("\t"));
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        api.set(name, log_fn).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `agamiz.commands.register(id[, opts], callback)`.
///
/// The callback itself is stored in the VM's handler table (never in Rust), so
/// the only lasting Rust-side trace is the [`CommandRecord`] the palette
/// renders.
fn install_commands(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let commands = lua.create_table().map_err(|e| e.to_string())?;

    let register_ctx = ctx.clone();
    let register = lua
        .create_function(move |lua, args: mlua::Variadic<Value>| {
            let (id, opts, callback) = parse_register_args(lua, args)
                .map_err(mlua::Error::external)?;

            let handlers = crate::ext::sandbox::handlers(lua)?;
            let table: Table = handlers.get("commands")?;
            if let Some(previous) = table.get::<_, Option<String>>(id.clone())? {
                return Err(mlua::Error::external(format!(
                    "agamiz.commands.register: command id {id:?} is already \
                     registered (by {previous:?}); pick a unique id"
                )));
            }
            table.set(id.clone(), callback)?;

            let title = opts
                .get::<_, Option<String>>("title")?
                .unwrap_or_else(|| humanize_command_id(&id));
            let shortcut = opts.get::<_, Option<String>>("shortcut")?;

            {
                let mut registry = register_ctx
                    .registry
                    .lock()
                    .map_err(|_| mlua::Error::external("registry lock poisoned"))?;
                registry.commands.insert(
                    id.clone(),
                    CommandRecord {
                        id: id.clone(),
                        extension_id: register_ctx.id.clone(),
                        title,
                        shortcut,
                    },
                );
                registry.own_command(&register_ctx.id, id.clone());
            }
            register_ctx.publish_registry();
            Ok(())
        })
        .map_err(|e| e.to_string())?;

    commands
        .set("register", register)
        .map_err(|e| e.to_string())?;
    api.set("commands", commands)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Accept `register(id, callback)` and `register(id, {title=, shortcut=}, callback)`.
///
/// The two-argument form is what the documented API shows, so it is the
/// canonical shape; the options table is an addition, not a replacement.
fn parse_register_args<'lua>(
    lua: &'lua Lua,
    args: mlua::Variadic<Value<'lua>>,
) -> Result<(String, Table<'lua>, mlua::Function<'lua>), mlua::Error> {
    let mut iter = args.into_iter();
    let id: String = match iter.next() {
        Some(Value::String(s)) => s.to_string_lossy().to_string(),
        _ => {
            return Err(mlua::Error::external(
                "agamiz.commands.register: first argument must be the command id string",
            ))
        }
    };

    let second = iter.next();
    let (opts, callback) = match second {
        Some(Value::Table(t)) => {
            let callback = match iter.next() {
                Some(Value::Function(f)) => f,
                _ => {
                    return Err(mlua::Error::external(
                        "agamiz.commands.register: expected a callback function",
                    ))
                }
            };
            (t, callback)
        }
        Some(Value::Function(f)) => {
            let t = lua.create_table()?;
            (t, f)
        }
        _ => {
            return Err(mlua::Error::external(
                "agamiz.commands.register: expected a callback function",
            ))
        }
    };

    if id.trim().is_empty() {
        return Err(mlua::Error::external(
            "agamiz.commands.register: command id must not be empty",
        ));
    }
    Ok((id, opts, callback))
}

/// `my.extension.doThing` → `Do Thing`, for a readable default palette label.
fn humanize_command_id(id: &str) -> String {
    let tail = id.rsplit('.').next().unwrap_or(id);
    let mut out = String::new();
    for (i, ch) in tail.chars().enumerate() {
        if i == 0 {
            out.extend(ch.to_uppercase());
        } else if ch.is_uppercase() && !tail[..i].ends_with(|p: char| p.is_uppercase()) {
            out.push(' ');
            out.push(ch);
        } else {
            out.push(ch);
        }
    }
    out
}

fn install_editor(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let editor = lua.create_table().map_err(|e| e.to_string())?;

    macro_rules! reader {
        ($name:literal, $accessor:ident) => {{
            let c = ctx.clone();
            let f = lua
                .create_function(move |_, ()| {
                    let snapshot = c
                        .snapshot
                        .read()
                        .map_err(|_| mlua::Error::external("workspace snapshot lock poisoned"))?;
                    Ok(snapshot.$accessor.clone())
                })
                .map_err(|e| e.to_string())?;
            editor.set($name, f).map_err(|e| e.to_string())?;
        }};
    }

    reader!("get_active_text", active_text);
    reader!("get_active_path", active_path);
    reader!("get_language_id", language_id);

    // Structured values (cursor, selection) are built explicitly rather than
    // through the macro, because mlua needs a real Lua table for them.
    let cursor_ctx = ctx.clone();
    let get_cursor = lua
        .create_function(move |lua, ()| {
            let snapshot = cursor_ctx
                .snapshot
                .read()
                .map_err(|_| mlua::Error::external("workspace snapshot lock poisoned"))?;
            Ok(Value::Table(position_table(lua, snapshot.cursor)?))
        })
        .map_err(|e| e.to_string())?;
    editor
        .set("get_cursor", get_cursor)
        .map_err(|e| e.to_string())?;

    let selection_ctx = ctx.clone();
    let get_selection = lua
        .create_function(move |lua, ()| {
            let snapshot = selection_ctx
                .snapshot
                .read()
                .map_err(|_| mlua::Error::external("workspace snapshot lock poisoned"))?;
            let Some(range) = snapshot.selection else {
                return Ok(Value::Nil);
            };
            let table = lua.create_table()?;
            table.set("start", position_table(lua, range.start)?)?;
            table.set("end", position_table(lua, range.end)?)?;
            Ok(Value::Table(table))
        })
        .map_err(|e| e.to_string())?;
    editor
        .set("get_selection", get_selection)
        .map_err(|e| e.to_string())?;

    // `insert_text({line=, character=}, text)`
    let insert_ctx = ctx.clone();
    let insert = lua
        .create_function(move |_, (pos, text): (Table, String)| {
            let line: u32 = pos.get("line").unwrap_or(0);
            let character: u32 = pos.get("character").unwrap_or(0);
            insert_ctx.editor_request("insert", line, character, &text);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    editor
        .set("insert_text", insert)
        .map_err(|e| e.to_string())?;

    // `insert_text_at(line, character, text)` — no table allocation at the
    // call site, which is what most extensions actually want.
    let insert_at_ctx = ctx.clone();
    let insert_at = lua
        .create_function(move |_, (line, character, text): (u32, u32, String)| {
            insert_at_ctx.editor_request("insert", line, character, &text);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    editor
        .set("insert_text_at", insert_at)
        .map_err(|e| e.to_string())?;

    let set_text_ctx = ctx.clone();
    let set_text = lua
        .create_function(move |_, text: String| {
            set_text_ctx.editor_request("setText", 0, 0, &text);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    editor
        .set("set_text", set_text)
        .map_err(|e| e.to_string())?;

    let replace_ctx = ctx.clone();
    let replace = lua
        .create_function(move |_, text: String| {
            replace_ctx.editor_request("replaceSelection", 0, 0, &text);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    editor
        .set("replace_selection", replace)
        .map_err(|e| e.to_string())?;

    // `open_buffer(name, text)` — a *new* untitled buffer, not a mutation of
    // the active one. The other four entry points can only rewrite whatever is
    // already open, which left no way for an extension to show the user
    // something: a starter script, a snippet, a generated file. This is what
    // makes "Examples" expressible as a contributed command.
    let open_buffer_ctx = ctx.clone();
    let open_buffer = lua
        .create_function(move |_, (name, text): (String, String)| {
            let name = if name.trim().is_empty() {
                "untitled".to_string()
            } else {
                name
            };
            open_buffer_ctx.editor_request_named("openBuffer", &text, &name);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    editor
        .set("open_buffer", open_buffer)
        .map_err(|e| e.to_string())?;

    api.set("editor", editor).map_err(|e| e.to_string())?;
    Ok(())
}

fn install_window(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let window = lua.create_table().map_err(|e| e.to_string())?;

    // `show_message(type, msg)` per the spec, plus a `show_error(msg)` shortcut.
    let show_ctx = ctx.clone();
    let show = lua
        .create_function(move |_, (level, message): (String, String)| {
            show_ctx
                .require("ui:notification", "agamiz.window.show_message")?;
            show_ctx.notice(&normalize_level(&level), &message);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    window
        .set("show_message", show)
        .map_err(|e| e.to_string())?;

    let error_ctx = ctx.clone();
    let show_error = lua
        .create_function(move |_, message: String| {
            error_ctx
                .require("ui:notification", "agamiz.window.show_error")?;
            error_ctx.notice("error", &message);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    window
        .set("show_error", show_error)
        .map_err(|e| e.to_string())?;

    api.set("window", window).map_err(|e| e.to_string())?;
    Ok(())
}

fn install_status_bar(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let statusbar = lua.create_table().map_err(|e| e.to_string())?;

    // `set_item(id, text, icon?)` with optional `{alignment=, priority=}`.
    let set_ctx = ctx.clone();
    let set_item = lua
        .create_function(move |_, args: mlua::Variadic<Value>| {
            set_ctx.require("ui:statusbar", "agamiz.statusbar.set_item")?;
            let mut iter = args.into_iter();
            let id = match iter.next() {
                Some(Value::String(s)) => s.to_string_lossy().to_string(),
                _ => {
                    return Err(mlua::Error::external(
                        "agamiz.statusbar.set_item: first argument must be the item id",
                    ))
                }
            };
            let text = match iter.next() {
                Some(Value::String(s)) => s.to_string_lossy().to_string(),
                _ => {
                    return Err(mlua::Error::external(
                        "agamiz.statusbar.set_item: second argument must be the text",
                    ))
                }
            };

            let mut icon = None;
            let mut alignment = "right".to_string();
            let mut priority = 0i64;
            match iter.next() {
                Some(Value::Table(opts)) => {
                    icon = opts.get::<_, Option<String>>("icon")?;
                    if let Some(a) = opts.get::<_, Option<String>>("alignment")? {
                        if a != "left" && a != "right" {
                            return Err(mlua::Error::external(format!(
                                "agamiz.statusbar.set_item: alignment must be \
                                 \"left\" or \"right\", got {a:?}"
                            )));
                        }
                        alignment = a;
                    }
                    if let Some(p) = opts.get::<_, Option<i64>>("priority")? {
                        priority = p;
                    }
                }
                Some(Value::String(s)) => icon = Some(s.to_string_lossy().to_string()),
                _ => {}
            }

            let key = format!("{}:{}", set_ctx.id, id);
            {
                let mut registry = set_ctx
                    .registry
                    .lock()
                    .map_err(|_| mlua::Error::external("registry lock poisoned"))?;
                registry.own_status(&set_ctx.id, key.clone());
                registry.status.insert(
                    key,
                    StatusRecord {
                        key: format!("{}:{}", set_ctx.id, id),
                        extension_id: set_ctx.id.clone(),
                        text,
                        icon,
                        alignment,
                        priority,
                    },
                );
            }
            set_ctx.publish_registry();
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    statusbar
        .set("set_item", set_item)
        .map_err(|e| e.to_string())?;

    let remove_ctx = ctx.clone();
    let remove_item = lua
        .create_function(move |_, id: String| {
            remove_ctx
                .require("ui:statusbar", "agamiz.statusbar.remove_item")?;
            let key = format!("{}:{id}", remove_ctx.id);
            if let Ok(mut registry) = remove_ctx.registry.lock() {
                registry.status.remove(&key);
                if let Some(owned) = registry.by_extension.get_mut(&remove_ctx.id) {
                    owned.status.retain(|k| k != &key);
                }
                drop(registry);
                remove_ctx.publish_registry();
            }
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    statusbar
        .set("remove_item", remove_item)
        .map_err(|e| e.to_string())?;

    api.set("statusbar", statusbar)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ceiling on a single template's file count.
///
/// A template is rendered as a preview tree and then written in one shot, so an
/// extension could otherwise hand over a hundred thousand entries and stall the
/// wizard on a list it is not entitled to fill. Real templates (including the
/// largest bundled one) sit in the low tens.
const MAX_TEMPLATE_FILES: usize = 512;

/// `agamiz.projects.register(id, opts)` — contribute a "New Project" template.
///
/// Requires `fs:write`: contributing a template is a request for the IDE to
/// write that content to disk on the user's behalf, so it is gated on the same
/// permission as the extension writing the files itself. `createCommand` needs
/// no extra check here — that command is an ordinary `agamiz.commands.register`
/// entry, and the `process:exec` it will use is checked when it runs.
///
/// The id is namespaced to `"{extension_id}:{id}"` in the registry, the same
/// way status-bar items are, so two extensions can both offer a template called
/// `"default"` without either silently replacing the other.
fn install_projects(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let projects = lua.create_table().map_err(|e| e.to_string())?;

    let register_ctx = ctx.clone();
    // The `&Lua` is taken as a *parameter* rather than captured from
    // `install_projects`'s own binding: a closure holding a `&Lua` would not be
    // `Send`, and every `agamiz.*` closure has to be.
    let register = lua
        .create_function(move |lua, args: mlua::Variadic<Value>| {
            register_ctx.require("fs:write", "agamiz.projects.register")?;

            let mut iter = args.into_iter();
            let id = match iter.next() {
                Some(Value::String(s)) => s.to_string_lossy().to_string(),
                _ => {
                    return Err(mlua::Error::external(
                        "agamiz.projects.register: first argument must be the template id string",
                    ))
                }
            };
            if id.trim().is_empty() {
                return Err(mlua::Error::external(
                    "agamiz.projects.register: template id must not be empty",
                ));
            }

            let opts = match iter.next() {
                Some(Value::Table(t)) => t,
                _ => {
                    return Err(mlua::Error::external(
                        "agamiz.projects.register: second argument must be an options table",
                    ))
                }
            };

            let name = opts
                .get::<_, Option<String>>("name")?
                .unwrap_or_else(|| humanize_command_id(&id));
            let description = opts.get::<_, Option<String>>("description")?.unwrap_or_default();
            let icon = opts.get::<_, Option<String>>("icon")?;
            let create_command = opts.get::<_, Option<String>>("createCommand")?;
            let install_command = opts.get::<_, Option<String>>("installCommand")?;
            let entry_file = opts.get::<_, Option<String>>("entryFile")?;

            let mut tags = Vec::new();
            if let Some(Value::Table(list)) = opts.get::<_, Option<Value>>("tags")? {
                for value in list.sequence_values::<Value>() {
                    tags.push(lua_to_string(lua, value.map_err(mlua::Error::external)?));
                }
            }

            // `files` is optional: a template may consist purely of a
            // `createCommand` that shells out to a real generator.
            let mut files = Vec::new();
            if let Some(Value::Table(list)) = opts.get::<_, Option<Value>>("files")? {
                for entry in list.sequence_values::<Value>() {
                    let file = match entry.map_err(mlua::Error::external)? {
                        Value::Table(t) => t,
                        _ => {
                            return Err(mlua::Error::external(
                                "agamiz.projects.register: every entry in `files` must be a \
                                 { path = ..., content = ... } table",
                            ))
                        }
                    };
                    let path = file.get::<_, String>("path")?;
                    let content = file.get::<_, Option<String>>("content")?.unwrap_or_default();
                    files.push(ProjectTemplateFile { path, content });
                }
            }

            if files.len() > MAX_TEMPLATE_FILES {
                return Err(mlua::Error::external(format!(
                    "agamiz.projects.register: template declares {} files, the limit is \
                     {MAX_TEMPLATE_FILES}",
                    files.len()
                )));
            }

            // `outputs` are the paths the generator is expected to produce, used
            // only to fill in the wizard's preview. Path-only, so there is
            // nothing here for the host to validate beyond the path shape.
            let mut declared_outputs = Vec::new();
            if let Some(Value::Table(list)) = opts.get::<_, Option<Value>>("outputs")? {
                for value in list.sequence_values::<Value>() {
                    let path = lua_to_string(lua, value.map_err(mlua::Error::external)?);
                    check_declared_output(&path)?;
                    declared_outputs.push(path);
                }
            }
            if declared_outputs.len() > MAX_TEMPLATE_FILES {
                return Err(mlua::Error::external(format!(
                    "agamiz.projects.register: template declares {} outputs, the limit is \
                     {MAX_TEMPLATE_FILES}",
                    declared_outputs.len()
                )));
            }

            // A template with neither files nor a generator would create an
            // empty folder and report success, which reads as a broken wizard
            // rather than a rejected manifest.
            if files.is_empty() && create_command.is_none() {
                return Err(mlua::Error::external(
                    "agamiz.projects.register: a template needs at least one entry in `files` \
                     or a `createCommand`",
                ));
            }

            // `outputs` are only meaningful with something to produce them.
            if !declared_outputs.is_empty() && create_command.is_none() {
                return Err(mlua::Error::external(
                    "agamiz.projects.register: `outputs` only makes sense alongside a \
                     `createCommand` — nothing else would create them",
                ));
            }

            // Reject an `entryFile` the template never declares, so a typo
            // surfaces as a loud activation error instead of a silently blank
            // editor after the project is created. A generator's output counts
            // as declared, since that file really will exist afterwards.
            if let Some(entry) = entry_file.as_deref() {
                let known = files.iter().any(|f| f.path == entry)
                    || declared_outputs.iter().any(|p| p == entry);
                if !known {
                    return Err(mlua::Error::external(format!(
                        "agamiz.projects.register: entryFile {entry:?} is neither a declared \
                         file nor a declared output"
                    )));
                }
            }

            let key = format!("{}:{}", register_ctx.id, id);
            {
                let mut registry = register_ctx
                    .registry
                    .lock()
                    .map_err(|_| mlua::Error::external("registry lock poisoned"))?;
                registry.own_project_template(&register_ctx.id, key.clone());
                registry.project_templates.insert(
                    key,
                    ProjectTemplateRecord {
                        id: id.clone(),
                        extension_id: register_ctx.id.clone(),
                        name,
                        description,
                        icon,
                        tags,
                        create_command,
                        install_command,
                        entry_file,
                        files,
                        declared_outputs,
                    },
                );
            }
            register_ctx.publish_registry();
            Ok(())
        })
        .map_err(|e| e.to_string())?;

    projects.set("register", register).map_err(|e| e.to_string())?;
    api.set("projects", projects)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reject an `outputs` entry that is not a plain relative path.
///
/// These are never written by the host, so this is not a filesystem-security
/// check — it is there so the wizard's preview cannot be fed something that
/// would render as a misleading tree (an absolute path would show up as a
/// top-level node that does not correspond to anything under the project root).
fn check_declared_output(path: &str) -> Result<(), mlua::Error> {
    let trimmed = path.trim();
    let bad = trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.as_bytes().get(1) == Some(&b':')
        || trimmed.split('/').any(|part| part == "..");
    if bad {
        return Err(mlua::Error::external(format!(
            "agamiz.projects.register: output path {path:?} must be a relative path inside the \
             project"
        )));
    }
    Ok(())
}

fn install_workspace(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let workspace = lua.create_table().map_err(|e| e.to_string())?;

    let root_ctx = ctx.clone();
    let root = lua
        .create_function(move |lua, ()| {
            root_ctx.require("workspace:read", "agamiz.workspace.get_root_path")?;
            let snapshot = root_ctx
                .snapshot
                .read()
                .map_err(|_| mlua::Error::external("workspace snapshot lock poisoned"))?;
            if snapshot.root.is_empty() {
                return Ok(Value::Nil);
            }
            Ok(Value::String(lua.create_string(&snapshot.root)?))
        })
        .map_err(|e| e.to_string())?;
    workspace
        .set("get_root_path", root)
        .map_err(|e| e.to_string())?;

    // `on_did_save_file(callback)` → `{ dispose() }`, matching the disposable
    // convention the JS extension context already uses.
    let save_ctx = ctx.clone();
    let on_save = lua
        .create_function(move |lua, callback: mlua::Function| {
            save_ctx
                .require("workspace:read", "agamiz.workspace.on_did_save_file")?;
            let handlers = crate::ext::sandbox::handlers(lua)?;
            let bucket: Table = handlers.get("workspace")?;
            bucket.set("on_did_save_file", callback)?;

            let disposable = lua.create_function(move |lua, ()| {
                if let Ok(handlers) = crate::ext::sandbox::handlers(lua) {
                    if let Ok(bucket) = handlers.get::<_, Table>("workspace") {
                        let _ = bucket.set("on_did_save_file", Value::Nil);
                    }
                }
                Ok(())
            })?;
            let table = lua.create_table()?;
            table.set("dispose", disposable)?;
            Ok(table)
        })
        .map_err(|e| e.to_string())?;
    workspace
        .set("on_did_save_file", on_save)
        .map_err(|e| e.to_string())?;

    api.set("workspace", workspace)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn install_ui(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let ui = lua.create_table().map_err(|e| e.to_string())?;

    // `register_sidebar_panel(id, title, view_config)`
    let panel_ctx = ctx.clone();
    let register = lua
        .create_function(move |_, args: mlua::Variadic<Value>| {
            panel_ctx
                .require("ui:sidebar", "agamiz.ui.register_sidebar_panel")?;
            let mut iter = args.into_iter();
            let id = match iter.next() {
                Some(Value::String(s)) => s.to_string_lossy().to_string(),
                _ => {
                    return Err(mlua::Error::external(
                        "agamiz.ui.register_sidebar_panel: first argument must be the panel id",
                    ))
                }
            };
            let title = match iter.next() {
                Some(Value::String(s)) => s.to_string_lossy().to_string(),
                _ => {
                    return Err(mlua::Error::external(
                        "agamiz.ui.register_sidebar_panel: second argument must be the title",
                    ))
                }
            };
            let config = match iter.next() {
                Some(Value::Table(cfg)) => Some(cfg),
                _ => None,
            };
            let icon = match config.as_ref() {
                Some(cfg) => cfg.get::<_, Option<String>>("icon")?,
                None => None,
            };
            let body = match config.as_ref() {
                Some(cfg) => cfg
                    .get::<_, Option<String>>("body")?
                    .unwrap_or_default(),
                None => String::new(),
            };

            {
                let mut registry = panel_ctx
                    .registry
                    .lock()
                    .map_err(|_| mlua::Error::external("registry lock poisoned"))?;
                registry.own_panel(&panel_ctx.id, id.clone());
                registry.panels.insert(
                    id.clone(),
                    PanelRecord {
                        id,
                        extension_id: panel_ctx.id.clone(),
                        title,
                        icon,
                        body,
                    },
                );
            }
            panel_ctx.publish_registry();
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    ui.set("register_sidebar_panel", register)
        .map_err(|e| e.to_string())?;

    api.set("ui", ui).map_err(|e| e.to_string())?;
    Ok(())
}

/// `agamiz.on(event, callback)` — the frontend → Lua direction.
fn install_events(lua: &Lua, api: &Table) -> Result<(), String> {
    let on = lua
        .create_function(move |lua, (event, callback): (String, mlua::Function)| {
            if event.trim().is_empty() {
                return Err(mlua::Error::external("agamiz.on: event name must not be empty"));
            }
            let handlers = crate::ext::sandbox::handlers(lua)?;
            let bucket: Table = handlers.get("events")?;
            bucket.set(event, callback)?;
            Ok(())
        })
        .map_err(|e| e.to_string())?;

    let off = lua
        .create_function(move |lua, event: String| {
            let handlers = crate::ext::sandbox::handlers(lua)?;
            let bucket: Table = handlers.get("events")?;
            bucket.set(event, Value::Nil)?;
            Ok(())
        })
        .map_err(|e| e.to_string())?;

    api.set("on", on).map_err(|e| e.to_string())?;
    api.set("off", off).map_err(|e| e.to_string())?;
    Ok(())
}

fn install_fs(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let fs = lua.create_table().map_err(|e| e.to_string())?;

    let read_ctx = ctx.clone();
    let read_file = lua
        .create_function(move |_, path: String| {
            read_ctx.require("fs:read", "agamiz.fs.read_file")?;
            let resolved = read_ctx
                .resolve_in_workspace(&path)
                .map_err(mlua::Error::external)?;
            std::fs::read_to_string(&resolved)
                .map_err(|e| mlua::Error::external(format!("agamiz.fs.read_file: {e}")))
        })
        .map_err(|e| e.to_string())?;
    fs.set("read_file", read_file).map_err(|e| e.to_string())?;

    let read_own_ctx = ctx.clone();
    let read_own = lua
        .create_function(move |_, path: String| {
            read_own_ctx
                .require("fs:read", "agamiz.fs.read_extension_file")?;
            let resolved = read_own_ctx
                .resolve_in_extension(&path)
                .map_err(mlua::Error::external)?;
            std::fs::read_to_string(&resolved)
                .map_err(|e| mlua::Error::external(format!("agamiz.fs.read_extension_file: {e}")))
        })
        .map_err(|e| e.to_string())?;
    fs.set("read_extension_file", read_own)
        .map_err(|e| e.to_string())?;

    let write_ctx = ctx.clone();
    let write_file = lua
        .create_function(move |_, (path, contents): (String, String)| {
            write_ctx.require("fs:write", "agamiz.fs.write_file")?;
            let resolved = write_ctx
                .resolve_in_workspace(&path)
                .map_err(mlua::Error::external)?;
            if let Some(parent) = resolved.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| mlua::Error::external(format!("agamiz.fs.write_file: {e}")))?;
            }
            std::fs::write(&resolved, contents)
                .map_err(|e| mlua::Error::external(format!("agamiz.fs.write_file: {e}")))
        })
        .map_err(|e| e.to_string())?;
    fs.set("write_file", write_file)
        .map_err(|e| e.to_string())?;

    let dir_ctx = ctx.clone();
    let read_dir = lua
        .create_function(move |lua, path: String| {
            dir_ctx.require("fs:read", "agamiz.fs.read_dir")?;
            let resolved = dir_ctx
                .resolve_in_workspace(&path)
                .map_err(mlua::Error::external)?;
            let entries = std::fs::read_dir(&resolved)
                .map_err(|e| mlua::Error::external(format!("agamiz.fs.read_dir: {e}")))?;

            let out = lua.create_table()?;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                out.set(name.as_str(), is_dir)?;
            }
            Ok(out)
        })
        .map_err(|e| e.to_string())?;
    fs.set("read_dir", read_dir).map_err(|e| e.to_string())?;

    api.set("fs", fs).map_err(|e| e.to_string())?;
    Ok(())
}

fn install_process(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let process = lua.create_table().map_err(|e| e.to_string())?;

    let exec_ctx = ctx.clone();
    let exec = lua
        .create_function(move |lua, args: mlua::Variadic<Value>| {
            exec_ctx.require("process:exec", "agamiz.process.exec")?;

            let mut iter = args.into_iter();
            let program = match iter.next() {
                Some(Value::String(s)) => s.to_string_lossy().to_string(),
                _ => {
                    return Err(mlua::Error::external(
                        "agamiz.process.exec: first argument must be the program name",
                    ))
                }
            };

            // `exec(program, {args...}, cwd?)` — the argument list is a table
            // rather than trailing varargs because a tuple containing
            // `Variadic` is not a valid `FromLuaMulti`, and a uniform
            // "leading table" shape is easier to document anyway.
            let mut argv: Vec<String> = Vec::new();
            let mut cwd: Option<String> = None;
            let mut rest = iter;
            if let Some(Value::Table(list)) = rest.next() {
                for pair in list.sequence_values::<Value>() {
                    let value = pair.map_err(mlua::Error::external)?;
                    argv.push(lua_to_string(lua, value));
                }
            }
            if let Some(Value::String(dir)) = rest.next() {
                let dir = dir.to_string_lossy().to_string();
                if !dir.is_empty() {
                    cwd = Some(dir);
                }
            }

            let mut command = std::process::Command::new(&program);
            command.args(&argv);
            command.stdin(std::process::Stdio::null());
            if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
                // Confine execution to the workspace like every other fs API.
                let dir = exec_ctx
                    .resolve_in_workspace(&dir)
                    .map_err(mlua::Error::external)?;
                command.current_dir(dir);
            }

            let output = command
                .output()
                .map_err(|e| mlua::Error::external(format!("agamiz.process.exec: {e}")))?;

            let table = lua.create_table()?;
            table.set("code", output.status.code().unwrap_or(-1))?;
            table.set("stdout", String::from_utf8_lossy(&output.stdout).to_string())?;
            table.set("stderr", String::from_utf8_lossy(&output.stderr).to_string())?;
            Ok(table)
            },
        )
        .map_err(|e| e.to_string())?;
    process.set("exec", exec).map_err(|e| e.to_string())?;

    api.set("process", process)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn install_http(lua: &Lua, api: &Table, ctx: &ExtCtx) -> Result<(), String> {
    let http = lua.create_table().map_err(|e| e.to_string())?;

    let get_ctx = ctx.clone();
    let get = lua
        .create_function(move |lua, (url, headers): (String, Option<Table>)| {
            get_ctx.require("network:http", "agamiz.http.get")?;
            let mut request = ureq::get(&url);
            if let Some(headers) = headers {
                for pair in headers.pairs::<String, String>() {
                    let (name, value) = pair.map_err(mlua::Error::external)?;
                    request = request.header(&name, &value);
                }
            }
            finish_http(lua, request.call())
        })
        .map_err(|e| e.to_string())?;
    http.set("get", get).map_err(|e| e.to_string())?;

    let post_ctx = ctx.clone();
    let post = lua
        .create_function(
            move |lua, (url, body, headers): (String, String, Option<Table>)| {
                post_ctx.require("network:http", "agamiz.http.post")?;
                let mut request = ureq::post(&url);
                if let Some(headers) = headers {
                    for pair in headers.pairs::<String, String>() {
                        let (name, value) = pair.map_err(mlua::Error::external)?;
                        request = request.header(&name, &value);
                    }
                }
                finish_http(lua, request.send(body.as_bytes()))
            },
        )
        .map_err(|e| e.to_string())?;
    http.set("post", post).map_err(|e| e.to_string())?;

    api.set("http", http).map_err(|e| e.to_string())?;
    Ok(())
}

/// Shape a `ureq` response into `{ status, body }`.
fn finish_http(lua: &Lua, result: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> mlua::Result<Table<'_>> {
    let table = lua.create_table()?;
    match result {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let body = response
                .body_mut()
                .read_to_string()
                .map_err(mlua::Error::external)?;
            table.set("status", status)?;
            table.set("body", body)?;
        }
        Err(ureq::Error::StatusCode(code)) => {
            // A 4xx/5xx is a normal answer, not a transport failure: report
            // the status so an extension can branch on it.
            table.set("status", code)?;
            table.set("body", "")?;
        }
        Err(e) => return Err(mlua::Error::external(format!("agamiz.http: {e}"))),
    }
    Ok(table)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `mlua`'s `AnyUserData` has no useful `Display`; this matches Lua's own
/// `tostring` conventions closely enough for log output.
pub fn lua_to_string(lua: &Lua, value: Value) -> String {
    match value {
        Value::Nil => "nil".to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Number(n) => {
            if n.fract() == 0.0 && n.is_finite() && n.abs() < 1e15 {
                format!("{}", n as i64)
            } else {
                n.to_string()
            }
        }
        Value::String(s) => s.to_string_lossy().to_string(),
        Value::Table(t) => {
            // `pairs` consumes the handle, so take the address first.
            let address = hash_of(&t);
            let len = t.raw_len();
            let mut parts = Vec::new();
            for i in 1..=len {
                if let Ok(v) = t.get::<usize, Value>(i) {
                    parts.push(lua_to_string(lua, v));
                }
            }
            if parts.is_empty() {
                for pair in t.pairs::<Value, Value>() {
                    if let Ok((k, v)) = pair {
                        parts.push(format!(
                            "[{}]={}",
                            lua_to_string(lua, k),
                            lua_to_string(lua, v)
                        ));
                        if parts.len() >= 8 {
                            parts.push("...".to_string());
                            break;
                        }
                    }
                }
            }
            format!("table: 0x{address:012x} {{{}}}", parts.join(", "))
        }
        Value::Function(_) => "function".to_string(),
        other => format!("{other:?}"),
    }
}

/// Stable-ish address for a table, purely so log lines can be correlated.
fn hash_of(table: &Table) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    table.to_pointer().hash(&mut hasher);
    hasher.finish()
}

fn position_table(lua: &Lua, position: crate::ext::TextPosition) -> mlua::Result<Table<'_>> {
    let table = lua.create_table()?;
    table.set("line", position.line)?;
    table.set("character", position.character)?;
    Ok(table)
}

fn normalize_level(level: &str) -> String {
    match level {
        "error" | "warning" | "warn" | "info" | "success" => level.to_string(),
        other => format!("info ({other})"),
    }
}

// ---------------------------------------------------------------------------
// `ExtCtx` behaviour used by the API above
// ---------------------------------------------------------------------------

impl ExtCtx {
    /// Emit a notification toast.
    pub fn notice(&self, level: &str, message: &str) {
        self.emit(events::NOTICE, serde_json::json!({
            "level": level,
            "message": message,
            "extensionId": self.id,
        }));
    }

    /// Write a line to the output channel and the extension log.
    pub fn log(&self, message: &str) {
        self.log_at("info", message);
    }

    pub fn log_at(&self, level: &str, message: &str) {
        log::info!("[ext:{}] {}", self.id, message);
        self.emit(events::LOG, serde_json::json!({
            "extensionId": self.id,
            "level": level,
            "text": message,
        }));
    }

    /// Ask the editor to perform a mutation. Fire-and-forget by design.
    ///
    /// `line` and `character` are ignored by actions that do not address a
    /// position; `text` doubles as the buffer contents for `openBuffer`.
    /// `name` carries the suggested filename, which only `openBuffer` reads.
    pub fn editor_request(&self, action: &str, line: u32, character: u32, text: &str) {
        self.emit(events::EDITOR, serde_json::json!({
            "extensionId": self.id,
            "action": action,
            "line": line,
            "character": character,
            "text": text,
        }));
    }

    /// Same as [`Self::editor_request`], plus a filename. Split out rather than
    /// always emitting an extra `name` field so the three positional mutations
    /// keep exactly the payload they always had.
    pub fn editor_request_named(&self, action: &str, text: &str, name: &str) {
        self.emit(events::EDITOR, serde_json::json!({
            "extensionId": self.id,
            "action": action,
            "line": 0,
            "character": 0,
            "text": text,
            "name": name,
        }));
    }

    /// Re-publish the contribution registry so the palette, status bar and
    /// sidebar all refresh after a registration.
    pub fn publish_registry(&self) {
        if let Ok(registry) = self.registry.lock() {
            // Serialise here so the sink deals only in `serde_json::Value`,
            // which keeps it free of any dependency on the registry types.
            if let Ok(payload) = serde_json::to_value(registry.snapshot()) {
                self.sink.emit(events::REGISTRY, payload);
            }
        }
    }

    fn emit(&self, channel: &str, payload: serde_json::Value) {
        self.sink.emit(channel, payload);
    }

    /// Resolve a workspace-relative path, refusing anything outside the root.
    pub fn resolve_in_workspace(&self, path: &str) -> Result<PathBuf, String> {
        let candidate = PathBuf::from(path);
        if candidate.is_absolute() {
            return self.confine(&candidate, "workspace");
        }
        let root = self.workspace_root()?;
        self.confine(&root.join(candidate), "workspace")
    }

    /// Resolve a path relative to the extension's own folder.
    pub fn resolve_in_extension(&self, path: &str) -> Result<PathBuf, String> {
        let candidate = PathBuf::from(path);
        let absolute = if candidate.is_absolute() {
            candidate
        } else {
            self.root.join(candidate)
        };
        self.confine(&absolute, "extension folder")
    }

    fn workspace_root(&self) -> Result<PathBuf, String> {
        let root = self
            .snapshot
            .read()
            .map_err(|_| "workspace snapshot lock poisoned".to_string())?
            .root
            .clone();
        if root.is_empty() {
            return Err("no workspace is open".to_string());
        }
        Ok(PathBuf::from(root))
    }

    /// Prove `candidate` lives under the workspace root (or the extension
    /// folder) after resolving symlinks.
    fn confine(&self, candidate: &Path, what: &str) -> Result<PathBuf, String> {
        let base = match what {
            "extension folder" => self.root.clone(),
            _ => self.workspace_root()?,
        };
        let base = base
            .canonicalize()
            .map_err(|e| format!("could not resolve the {what} root: {e}"))?;

        // A path that does not exist yet cannot be canonicalized, so resolve
        // the deepest existing ancestor and re-append the remainder.
        let mut existing = candidate;
        let mut trailing: Vec<std::ffi::OsString> = Vec::new();
        while !existing.exists() {
            let Some(name) = existing.file_name() else {
                break;
            };
            trailing.push(name.to_os_string());
            let Some(parent) = existing.parent() else {
                break;
            };
            existing = parent;
        }

        let mut resolved = existing
            .canonicalize()
            .map_err(|e| format!("could not resolve {}: {e}", existing.display()))?;
        for name in trailing.into_iter().rev() {
            resolved.push(name);
        }

        if !resolved.starts_with(&base) {
            return Err(format!(
                "path {:?} is outside the open {what}",
                candidate.display().to_string()
            ));
        }
        Ok(candidate.to_path_buf())
    }
}
