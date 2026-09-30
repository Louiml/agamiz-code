# Rak Project Templates

An Agamiz Code extension that adds a **Rak Package** tile to the New Project
wizard, scaffolded by the real `rakc package init` toolchain.

## Install

Copy this folder into the extensions directory, then enable it from the
Extensions panel (the puzzle icon in the activity bar):

```
~/.agamizcode/extensions/rak-project          # installed
~/.agamizcode/extensions/dev/rak-project      # hot-reloads on save
```

## What it demonstrates

| Line in `extension.lua` | API |
| --- | --- |
| 1 | `agamiz.commands.register` — the generator, as a real command |
| 2 | `agamiz.process.exec` — running `rakc package init` |
| 3 | `agamiz.projects.register` — contributing the New Project template |
| 4 | `agamiz.workspace.get_root_path` — targeting the open workspace |
| 5 | `deactivate()` — cleanup hook |

## The three halves of a project template

A template is **static data plus a declared generator**, never a callback:

- **`files`** — a list of `{ path, content }` written by the IDE. These must be
  known up front, because the wizard renders a file-tree preview and asks about
  collisions *before* the user commits to anything.
- **`createCommand`** — the id of an ordinary command, invoked with
  `(root, name)` *after* the files are written and *after* the IDE has switched
  its workspace to the new folder.
- **`outputs`** — paths the generator is expected to create, so the preview can
  show them. The IDE never writes these; it has no way to know what a generator
  will emit, so the template declares it and the wizard badges those rows
  **generated**.

That ordering is a guarantee, not a coincidence. A generator that needs to
`exec` inside the new project cannot run before the switch, because
`agamiz.process.exec` is confined to the open workspace root. Once the
workspace is the new project, the root *is* the new project.

### Why `outputs` exists

Without it, this template would preview as a folder holding only a `README.md`
and a launch config — hiding the three `.rak` files the user is creating the
project *for*, which is the entire reason to pick this tile. A generator
template that under-reports its own output is worse than no template at all,
because the user has no way to tell what they are about to get.

The trade-off is that `outputs` is documentation, not a contract. If `rakc`
changes its output, the preview goes stale rather than breaking anything. That
is the right way round: a stale preview is a cosmetic problem, whereas trying to
*derive* the output would mean running the generator before the user has agreed
to a destination.

## Writing one

```lua
agamiz.projects.register("package", {
  name = "Rak Package",                -- shown on the tile
  description = "A Rak package.",      -- one line under the name
  icon = "package",                    -- must be a known icon name
  tags = { "rak", "native" },
  entryFile = "main.rak",              -- must be in `files` OR `outputs`
  installCommand = nil,                -- run in the terminal after creation
  createCommand = "rak-project.createPackage",
  files = {
    { path = "README.md", content = "# ${PROJECT_NAME}\n" },
  },
  outputs = { "package.rak", "lib.rak", "main.rak" },
})
```

### Rules the host enforces at registration time

- **`fs:write` is required.** Contributing a template asks the IDE to write that
  content to disk on the user's behalf, so it is gated like any other write.
- **`entryFile` must name a `files` path or an `outputs` path.** Otherwise the
  wizard would open a blank editor after creating a real project — a load-time
  error is far easier to diagnose. A generator's output counts, because that
  file really will exist afterwards.
- **`outputs` requires a `createCommand`.** Nothing else would create them, so
  the preview would be a lie.
- **A template needs at least one `files` entry or a `createCommand`.** Neither
  would create an empty folder and report success.
- **Paths are relative and slash-separated**, and are resolved against the
  project root. Anything absolute, or that escapes the root with `..`, is
  rejected by the host before a single byte is written. This is what stops a
  template from being a path-traversal primitive. `outputs` is checked by the
  same rule, even though the host never writes it.
- **At most 512 files** per template, and 512 outputs.
- **Ids are namespaced** to `"{extension_id}:{id}"`, so two extensions can both
  offer a template called `"default"` without either silently replacing the
  other.

### `${PROJECT_NAME}`

Substituted throughout every file body and path just before writing, so a
template can name the project it is creating without knowing the name at
registration time.

## Permissions it requests

| Permission | Why |
| --- | --- |
| `fs:write` | required by `agamiz.projects.register` |
| `process:exec` | to run `rakc package init` |
| `ui:notification` | `agamiz.window.show_message` on success |
| `workspace:read` | `get_root_path` when run from the palette without an explicit target |

Unknown permission names are rejected at load time, and a call you did not
request fails with an explanatory error rather than silently doing nothing.

## Requirements

`rakc` must be on the `PATH`. If it is missing, `process.exec` fails and the
wizard reports the failure — the files the template declared are still written,
so the project is not left in a broken state.
