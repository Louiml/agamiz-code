-- Hello Agamiz — a complete, minimal extension.
--
-- Demonstrates the whole contribution surface:
--   * agamiz.commands.register        -> a Command Palette entry
--   * agamiz.statusbar.set_item       -> a live status bar badge
--   * agamiz.ui.register_sidebar_panel-> a left-sidebar panel
--   * agamiz.workspace.on_did_save_file -> a workspace event
--
-- Every call above is checked against the "permissions" array in
-- extension.json. Asking for something you did not declare fails with an
-- explanatory error rather than silently doing nothing.

local utils = require("src.utils")

-- Extension Activation Entry Point
function activate(context)
    agamiz.log("activating, root = " .. context.root)

    -- 1. A command palette entry. The bare two-argument form is the shortest
    --    way to contribute one; the options table adds a title and a shortcut.
    agamiz.commands.register("hello-agamiz.greet", {
        title = "Hello Agamiz: Greet",
        shortcut = "Ctrl+Shift+G",
    }, function()
        agamiz.window.show_message("info", utils.greeting("Agamiz Code"))
    end)

    -- 2. A second command that reads the editor, computes something, and
    --    updates the status bar — the extension equivalent of a linter badge.
    agamiz.commands.register("hello-agamiz.analyse", {
        title = "Hello Agamiz: Analyse Active Buffer",
    }, function()
        local text = agamiz.editor.get_active_text()
        local stats = utils.count_words(text)

        agamiz.statusbar.set_item(
            "summary",
            string.format("%d words / %d lines", stats.words, stats.lines),
            { alignment = "right", priority = 10 }
        )

        agamiz.window.show_message("info", string.format(
            "Analysed %d words across %d lines.", stats.words, stats.lines))
    end)

    -- 3. Insert text at a known position in the active buffer.
    agamiz.commands.register("hello-agamiz.insertBanner", {
        title = "Hello Agamiz: Insert Banner",
    }, function()
        agamiz.editor.insert_text_at(1, 0, "-- added by Hello Agamiz\n")
        agamiz.window.show_message("info", "Inserted a banner at line 1.")
    end)

    -- 4. A sidebar panel. The body is plain text on purpose: the host never
    --    evaluates extension-supplied markup.
    agamiz.ui.register_sidebar_panel("hello-agamiz.info", "Hello Agamiz", {
        icon = "sparkles",
        body = "Run 'Hello Agamiz: Greet' or 'Analyse Active Buffer' from the palette.",
    })

    -- 5. An initial status bar item, cleared on deactivate.
    agamiz.statusbar.set_item("state", "hello-agamiz ready", { alignment = "left" })

    -- 6. A workspace event. `on_did_save_file` returns a disposable, which the
    --    context collects so `deactivate` need not track it by hand.
    context.subscriptions[#context.subscriptions + 1] =
        agamiz.workspace.on_did_save_file(function(path)
            agamiz.log("file saved: " .. path)
        end)
end

-- Extension Deactivation Cleanup
function deactivate()
    -- The VM is discarded wholesale, so registered commands, listeners, the
    -- sidebar panel and the status bar items are all released automatically.
    -- This hook only exists for work that lives *outside* the VM: a spawned
    -- process, a temp file, a background thread.
    agamiz.log("hello-agamiz deactivated")
end
