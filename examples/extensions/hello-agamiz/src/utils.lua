-- Helper module.
--
-- `require("src.utils")` resolves here. The host's `require` only reads .lua
-- files inside this extension's own folder, so a module name can never reach
-- the rest of the filesystem.

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

--- Greeting used by the `greet` command.
function utils.greeting(name)
    local hour = tonumber(os.date("%H")) or 12
    local part = "Hello"
    if hour < 12 then
        part = "Good morning"
    elseif hour < 18 then
        part = "Good afternoon"
    else
        part = "Good evening"
    end
    if name and name ~= "" then
        return string.format("%s, %s!", part, name)
    end
    return string.format("%s from Lua!", part)
end

return utils
