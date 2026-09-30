# Rak Examples

Starter scripts for Rak, contributed as **Command Palette** entries.

## Install

Copy this folder into the extensions directory, then enable it from the
Extensions panel:

```
~/.agamizcode/extensions/rak-examples          # installed
~/.agamizcode/extensions/dev/rak-examples      # hot-reloads on save
```

Then press `Ctrl+Shift+P` and type `Rak: Example` — every script is listed
individually, so filtering by name works the way you would expect
(`Rak: Example — pipeline`, `Rak: Example — regex`, ...).

## Why this is an extension

These used to be a hard-coded `Examples` dropdown in the editor toolbar. That
made Rak-specific content permanent IDE chrome: always visible whether or not
the user cared about Rak, impossible to extend, and impossible to remove. As a
contribution, the entire feature disappears when the extension is not installed.

## What it demonstrates

| API | Purpose |
| --- | --- |
| `require("src.examples")` | one module per example, loaded inside the sandbox |
| `agamiz.commands.register` | one palette entry per example |
| `agamiz.editor.open_buffer` | open the script in a **new** untitled tab |
| `agamiz.window.show_message` | confirm which file was opened |

## `open_buffer` is the load-bearing part

The other `agamiz.editor.*` entry points — `insert_text`, `set_text`,
`replace_selection` — can only rewrite the buffer that is **already open**. An
extension therefore had no way to show the user anything new, which is why
"Examples" had to be hard-coded into the IDE.

`open_buffer(name, text)` asks the frontend for a new untitled tab. The buffer
has no path on disk, so `Ctrl+S` prompts for a location rather than silently
overwriting anything, and it stays out of the persisted session.

## About `src/examples/`

One file per example, each returning
`{ name = ..., filename = ..., source = ... }`. Every `source` is a **Lua
long-bracket string**, which performs no escape processing at all — so a Rak
regex like `/\d+/g`, or a Windows path, is stored byte-for-byte instead of
needing every backslash doubled.

`src/examples.lua` is the index that requires them all. Module paths are
resolved **relative to the extension root**, not to the requiring file, so the
index uses `require("src/examples/hello")` rather than `require("examples/hello")`.

These files were generated from the old bundled TypeScript table so the sources
would survive the move unchanged. Edit them directly from now on.

## Permissions it requests

`ui:notification` only. The extension reads nothing, writes nothing and runs
nothing — `require` is confined to its own folder, and `open_buffer` only asks
the editor for a new tab.
