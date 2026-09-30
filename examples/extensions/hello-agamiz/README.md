# Hello Agamiz

A complete, minimal Agamiz Code extension. It contributes a Command Palette
entry, a live status bar badge, a sidebar panel, and a workspace save listener.

## Install

Copy this folder into the extensions directory, then use the Extensions panel
(the puzzle icon in the activity bar) to enable it:

```
~/.agamizcode/extensions/hello-agamiz          # installed
~/.agamizcode/extensions/dev/hello-agamiz      # hot-reloads on save
```

Or scaffold an equivalent extension yourself:

```bash
agamizcode extension init my-extension
```

## What it demonstrates

| Line in `extension.lua` | API |
| --- | --- |
| 1 | `require("src.utils")` — sandboxed module loading |
| 2 | `activate(context)` — the lifecycle hook |
| 3 | `agamiz.commands.register` — Command Palette entries |
| 4 | `agamiz.editor.get_active_text` + `agamiz.statusbar.set_item` |
| 5 | `agamiz.editor.insert_text_at` |
| 6 | `agamiz.ui.register_sidebar_panel` |
| 7 | `agamiz.workspace.on_did_save_file` + `context.subscriptions` |
| 8 | `deactivate()` — cleanup hook |

## Permissions it requests

`ui:notification`, `ui:statusbar`, `ui:sidebar`, `workspace:read` — the minimum
needed for the above. Add a capability by extending the `permissions` array in
`extension.json`; unknown permission names are rejected at load time, and a
call you did not request fails with an explanatory error.

## What it cannot do

`os.execute`, `io`, `package`, the real `require`, `load`, `loadfile` and
`dofile` are all unreachable from inside the sandbox, and the VM runs with an
instruction budget and a heap cap. Filesystem and process APIs are available
only through `agamiz.fs` / `agamiz.process`, which require permissions and are
confined to the open workspace.
