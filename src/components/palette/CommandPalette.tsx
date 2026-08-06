import { useEffect, useMemo, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePaletteStore, useIndexStore } from "../../store";
import { openProject } from "../../utils/project";
import type { Symbol as GraphSymbol } from "../../types";

interface Command {
  id: string;
  label: string;
  detail: string;
  icon: string;
  action: () => void;
}

export function CommandPalette() {
  const isOpen = usePaletteStore((s) => s.isOpen);
  const query = usePaletteStore((s) => s.query);
  const setQuery = usePaletteStore((s) => s.setQuery);
  const close = usePaletteStore((s) => s.close);
  const symbols = useIndexStore((s) => s.symbols);

  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<number>(0);

  const staticCommands: Command[] = useMemo(
    () => [
      {
        id: "cmd:open-project",
        label: "Open Project",
        detail: "Open a workspace folder",
        icon: "\uD83D\uDCC2",
        action: () => {
          openProject();
        },
      },
      {
        id: "cmd:toggle-inspector",
        label: "Toggle Inspector",
        detail: "Show/hide the right panel",
        icon: "\uD83D\uDD0D",
        action: () => close(),
      },
      {
        id: "cmd:toggle-sidebar",
        label: "Toggle Sidebar",
        detail: "Show/hide file explorer",
        icon: "\uD83D\uDCC1",
        action: () => close(),
      },
      {
        id: "cmd:focus-editor",
        label: "Focus Editor",
        detail: "Move cursor to editor",
        icon: "\u2328\uFE0F",
        action: () => close(),
      },
    ],
    [close],
  );

  const results = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return [...staticCommands];
    const cmds = staticCommands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.detail.toLowerCase().includes(q),
    );
    const syms: Command[] = symbols
      .filter((s) => s.name.toLowerCase().includes(q))
      .map((s) => ({
        id: `sym:${s.id}`,
        label: s.name,
        detail: `${s.kind} \u00B7 ${s.location.file}`,
        icon: "S",
        action: () => close(),
      }));
    return [...cmds, ...syms];
  }, [query, symbols, staticCommands, close]);

  useEffect(() => {
    selectedRef.current = 0;
  }, [query]);

  useEffect(() => {
    if (isOpen) {
      async function fetch() {
        try {
          const syms = await invoke<GraphSymbol[]>("query_symbols", {
            query: query || "",
          });
          useIndexStore.getState().setSymbols(syms);
        } catch {}
      }
      fetch();
    }
  }, [isOpen, query]);

  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedRef.current = Math.min(selectedRef.current + 1, results.length - 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedRef.current = Math.max(selectedRef.current - 1, 0);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = results[selectedRef.current];
        if (item) item.action();
        close();
      }
    },
    [close, results],
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm animate-fade-in"
        onClick={close}
      />

      {/* Palette */}
      <div className="glass-modal w-[560px] max-h-[400px] overflow-hidden animate-scale-in flex flex-col z-10">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border-glass)]">
          <svg
            className="size-4 text-[var(--color-text-tertiary)] shrink-0"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <path d="M10 10l4.5 4.5" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search commands, symbols, files..."
            className="flex-1 bg-transparent text-[14px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] font-sans"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="overflow-y-auto scrollbar-apple max-h-[300px] py-1">
          {results.length === 0 && query && (
            <div className="px-4 py-6 text-center text-[13px] text-[var(--color-text-tertiary)]">
              No results for "{query}"
            </div>
          )}
          {results.map((item, idx) => (
            <button
              key={item.id}
              onClick={() => {
                item.action();
                close();
              }}
              onMouseEnter={() => {
                selectedRef.current = idx;
              }}
              className={`flex items-center gap-3 w-full text-left px-4 py-2 text-[13px] transition-colors ${
                idx === selectedRef.current
                  ? "bg-[var(--color-bg-glass-hover)]"
                  : ""
              }`}
            >
              <span className="w-5 h-5 flex items-center justify-center text-[11px] rounded bg-[var(--color-bg-glass-strong)] text-[var(--color-text-secondary)]">
                {item.icon ?? ">"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[var(--color-text-primary)] truncate">
                  {item.label}
                </div>
                <div className="text-[11px] text-[var(--color-text-tertiary)] truncate">
                  {item.detail}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4 px-4 py-1.5 border-t border-[var(--color-border-glass)] text-[10px] text-[var(--color-text-tertiary)]">
          <span>\u2191\u2193 Navigate</span>
          <span>\u21B5 Open</span>
          <span>Esc Dismiss</span>
        </div>
      </div>
    </div>
  );
}