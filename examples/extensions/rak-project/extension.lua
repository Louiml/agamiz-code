-- Rak Project Templates — a "New Project" template backed by a real generator.
--
-- The built-in templates (React, Next, Astro, Rust + Tauri) are pure file
-- dumps, because a wizard can only preview a file tree and ask about
-- collisions if the tree is known up front. A language whose scaffolding is a
-- real CLI has nothing to dump, so this extension uses the other half of the
-- API: `createCommand`.
--
-- How the three halves fit together:
--
--   files          static, written by the IDE before the workspace switch.
--                  Here: a launch config and a README.
--   outputs        paths `createCommand` is *expected* to produce, so the wizard
--                  can show them. The IDE never writes these — it has no way to
--                  know what a generator will emit, so the template declares it.
--                  Here: the three .rak files `rakc package init` creates.
--   createCommand  an ordinary command, invoked with (root, name) *after* the
--                  files exist and *after* the shell is pointed at the new
--                  project. Here: `rakc package init`.
--
-- The ordering is guaranteed by the host, not by luck. A generator that wants
-- to exec inside the new project cannot do so before the workspace switch,
-- because `agamiz.process.exec` is confined to the open workspace root.

-- Files the IDE writes for us. Kept deliberately thin: everything that needs
-- the real toolchain comes from the generator instead, because guessing at
-- `rakc package init`'s output layout would produce a template that silently
-- drifts out of date with the tool.
local SCAFFOLD_FILES = {
  {
    path = ".vscode/launch.json",
    content = [[{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run main.rak",
      "type": "rak",
      "request": "launch",
      "args": ["main.rak"],
      "schematic": "debug-run"
    }
  ]
}
]],
  },
  {
    path = "README.md",
    content = [[# ${PROJECT_NAME}

A Rak package, scaffolded with `rakc package init`.

The manifest and sources came from the toolchain, not from this template — run
the command again at any time to add more:

```bash
rakc package init
```
]],
  },
}

-- What `rakc package init` writes into the project root.
--
-- These are *declared*, not written by the IDE: the generator creates them. But
-- without this the New Project wizard would preview as a folder holding only a
-- README and a launch config — hiding the three files the user is actually
-- creating the project for, which is the whole reason to pick this tile.
--
-- The list is documentation, not a guarantee. If `rakc` changes its output the
-- preview goes stale rather than breaking anything, and the "generated" badge on
-- each row makes clear these belong to the generator.
local GENERATED_OUTPUTS = {
  "package.rak",   -- the package manifest
  "lib.rak",       -- the standard library prelude
  "main.rak",      -- the entry point
}

--- Run the real Rak scaffolder inside `root`.
--
-- Shared by the New Project template and the "scaffold the current workspace"
-- command, so both go through exactly one code path.
local function scaffold_package(root, label)
  agamiz.log(string.format("scaffolding %s in %s", label, root))

  -- `rakc package init` may prompt on stdin. The sandbox closes stdin (see the
  -- comment on `process.exec` in api.rs), so a prompt fails fast instead of
  -- hanging the IDE — which is the behaviour we want, and the reason the
  -- failure path below points the user at their own terminal.
  local result = agamiz.process.exec("rakc", { "package", "init" }, root)

  if result.code ~= 0 then
    local detail = result.stderr
    if detail == "" then detail = result.stdout end
    error(string.format(
        "rakc package init failed (exit %d)%s. Run it from the terminal to see the full output.",
        result.code,
        detail ~= "" and (": " .. detail) or ""))
  end

  agamiz.log("rakc package init succeeded: " .. result.stdout)
  return result.stdout
end

-- Extension Activation Entry Point
function activate(context)
  agamiz.log("activating, root = " .. context.root)

  -- 1. The generator, exposed as an ordinary command.
  --
  --    This is what `createCommand` below points at, and it is also callable by
  --    hand from the Command Palette — registering it as a command rather than
  --    hiding it in a closure means the whole contribution surface of the
  --    extension stays inspectable.
  --
  --    `fs:write` and `process:exec` are both required, and both are declared in
  --    extension.json. The host checks them at call time rather than silently
  --    doing nothing, so a missing grant is a loud error.
  agamiz.commands.register("rak-project.createPackage", {
    title = "Rak: Scaffold Package Here",
  }, function(root, name)
    -- Called by the wizard with an explicit root; called by the palette with
    -- none, in which case the open workspace is the obvious target.
    local target = root
    if target == nil or target == "" then
      target = agamiz.workspace.get_root_path()
    end
    if target == nil or target == "" then
      error("no target folder: open a workspace, or use New Project (Ctrl+Shift+N)")
    end

    scaffold_package(target, name or "package")
    agamiz.window.show_message("success", string.format(
        "Scaffolded a Rak package in %s.", name or target))
  end)

  -- 2. The template itself. It appears in the New Project wizard alongside the
  --    built-ins, badged with this extension's id.
  --
  --    `entryFile` must name either a `files` path or an `outputs` path — the
  --    host validates that, so a typo fails at activation instead of opening a
  --    blank editor once the project already exists.
  agamiz.projects.register("package", {
    name = "Rak Package",
    description = "A Rak package, scaffolded by the real `rakc package init` generator.",
    icon = "package",
    tags = { "rak", "native" },
    entryFile = "main.rak",
    installCommand = nil,          -- the toolchain is already on the machine
    createCommand = "rak-project.createPackage",
    files = SCAFFOLD_FILES,
    outputs = GENERATED_OUTPUTS,
  })
end

-- Extension Deactivation Cleanup
function deactivate()
  -- The template is a registry entry and the command is a Lua closure, both
  -- owned by this VM. Discarding the VM releases them, so the tile simply
  -- disappears from the New Project wizard on reload.
  agamiz.log("rak-project deactivated")
end
