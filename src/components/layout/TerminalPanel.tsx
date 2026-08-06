import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTerminalStore, useThemeStore } from "../../store";
import type { ThemeVariant } from "../../types";
import "@xterm/xterm/css/xterm.css";

const XTERM_THEMES: Record<ThemeVariant, Record<string, string>> = {
  dark: {
    background: "#0d0d0d",
    foreground: "#f5f5f7",
    cursor: "#64d2ff",
    selectionBackground: "rgba(0,122,255,0.4)",
    black: "#1a1a1a",
    red: "#ff453a",
    green: "#30d158",
    yellow: "#ff9f0a",
    blue: "#0a84ff",
    magenta: "#bf5af2",
    cyan: "#64d2ff",
    white: "#f5f5f7",
    brightBlack: "#48484a",
    brightRed: "#ff6961",
    brightGreen: "#57e389",
    brightYellow: "#ffb340",
    brightBlue: "#74d0ff",
    brightMagenta: "#daafff",
    brightCyan: "#a5d8ff",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#f2f2f7",
    foreground: "#1d1d1f",
    cursor: "#0a84ff",
    selectionBackground: "rgba(0,122,255,0.3)",
    black: "#1d1d1f",
    red: "#d70015",
    green: "#30a158",
    yellow: "#e08a00",
    blue: "#0a84ff",
    magenta: "#8e48b8",
    cyan: "#0a84ff",
    white: "#ffffff",
    brightBlack: "#8a8a93",
    brightRed: "#ff453a",
    brightGreen: "#30d158",
    brightYellow: "#ff9f0a",
    brightBlue: "#0a84ff",
    brightMagenta: "#bf5af2",
    brightCyan: "#74d0ff",
    brightWhite: "#ffffff",
  },
  purple: {
    background: "#141019",
    foreground: "#f3eaff",
    cursor: "#c77dff",
    selectionBackground: "rgba(191,90,242,0.4)",
    black: "#211a2b",
    red: "#ff6961",
    green: "#5be49b",
    yellow: "#ffb340",
    blue: "#7b5af2",
    magenta: "#bf5af2",
    cyan: "#c77dff",
    white: "#f3eaff",
    brightBlack: "#8d76ab",
    brightRed: "#ff6961",
    brightGreen: "#5be49b",
    brightYellow: "#ffb340",
    brightBlue: "#a58bff",
    brightMagenta: "#daafff",
    brightCyan: "#c77dff",
    brightWhite: "#ffffff",
  },
  green: {
    background: "#0e1510",
    foreground: "#eafaf0",
    cursor: "#5be49b",
    selectionBackground: "rgba(48,209,88,0.35)",
    black: "#18221b",
    red: "#ff453a",
    green: "#30d158",
    yellow: "#ffd60a",
    blue: "#30d158",
    magenta: "#9be46b",
    cyan: "#5be49b",
    white: "#eafaf0",
    brightBlack: "#6f9079",
    brightRed: "#ff6961",
    brightGreen: "#57e389",
    brightYellow: "#ffd60a",
    brightBlue: "#5be49b",
    brightMagenta: "#9be46b",
    brightCyan: "#5be49b",
    brightWhite: "#ffffff",
  },
  ocean: {
    background: "#0a1424",
    foreground: "#e6f2ff",
    cursor: "#74d0ff",
    selectionBackground: "rgba(10,132,255,0.4)",
    black: "#101f3a",
    red: "#ff453a",
    green: "#5be49b",
    yellow: "#ffb340",
    blue: "#0a84ff",
    magenta: "#a58bff",
    cyan: "#74d0ff",
    white: "#e6f2ff",
    brightBlack: "#6d8fb5",
    brightRed: "#ff6961",
    brightGreen: "#5be49b",
    brightYellow: "#ffb340",
    brightBlue: "#74d0ff",
    brightMagenta: "#a58bff",
    brightCyan: "#a5d8ff",
    brightWhite: "#ffffff",
  },
  sunset: {
    background: "#1f1212",
    foreground: "#fff0e8",
    cursor: "#ffb340",
    selectionBackground: "rgba(255,159,10,0.4)",
    black: "#2e1a17",
    red: "#ff6961",
    green: "#8cdd6a",
    yellow: "#ff9f0a",
    blue: "#ff9f0a",
    magenta: "#d0a5ff",
    cyan: "#ffb340",
    white: "#fff0e8",
    brightBlack: "#a07d70",
    brightRed: "#ff6961",
    brightGreen: "#8cdd6a",
    brightYellow: "#ffb340",
    brightBlue: "#ffb340",
    brightMagenta: "#d0a5ff",
    brightCyan: "#ffb340",
    brightWhite: "#ffffff",
  },
  graphite: {
    background: "#17181c",
    foreground: "#eef0f3",
    cursor: "#9aa4b0",
    selectionBackground: "rgba(142,152,165,0.35)",
    black: "#23252b",
    red: "#ff6b61",
    green: "#9be46b",
    yellow: "#e6b74c",
    blue: "#8e98a5",
    magenta: "#a58bff",
    cyan: "#a6b0bc",
    white: "#eef0f3",
    brightBlack: "#7c838e",
    brightRed: "#ff6b61",
    brightGreen: "#9be46b",
    brightYellow: "#e6b74c",
    brightBlue: "#a6b0bc",
    brightMagenta: "#a58bff",
    brightCyan: "#a6b0bc",
    brightWhite: "#ffffff",
  },
};

export function TerminalPanel() {
  const visible = useTerminalStore((s) => s.visible);
  const height = useTerminalStore((s) => s.height);
  const setHeight = useTerminalStore((s) => s.setHeight);
  const setVisible = useTerminalStore((s) => s.setVisible);
  const themeVariant = useThemeStore((s) => s.variant);

  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const termIdRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!visible) return;
    mountedRef.current = true;
    setReady(false);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "var(--font-mono)",
      theme: XTERM_THEMES[themeVariant] ?? XTERM_THEMES.dark,
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitAddonRef.current = fit;

    const container = document.getElementById("terminal-container");
    if (container) {
      term.open(container);
      // wait a tick for layout
      requestAnimationFrame(() => fit.fit());
    }

    let resizeHandler: (() => void) | null = null;

    async function setup() {
      try {
        const id = await invoke<number>("terminal_spawn");
        termIdRef.current = id;

        term.onData((data) => {
          invoke("terminal_write", { id, data });
        });

        resizeHandler = () => {
          fit.fit();
          const dims = fit.proposeDimensions();
          if (dims) {
            invoke("terminal_resize", { id, cols: dims.cols, rows: dims.rows });
          }
        };
        const ro = new ResizeObserver(resizeHandler);
        if (container) ro.observe(container);

        term.onResize(({ cols, rows }) => {
          invoke("terminal_resize", { id, cols, rows });
        });

        await listen<[number, string]>("terminal:output", ({ payload }) => {
          if (payload[0] !== id) return;
          term.write(payload[1]);
        });

        setReady(true);
      } catch (e) {
        console.warn("terminal spawn failed", e);
        term.write("\r\nTerminal unavailable.");
      }
    }

    setup();

    return () => {
      mountedRef.current = false;
      if (resizeHandler) resizeHandler = null;
      if (termIdRef.current != null) {
        invoke("terminal_close", { id: termIdRef.current }).catch(() => {});
        termIdRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (visible && termRef.current) {
      termRef.current.options.theme = XTERM_THEMES[themeVariant] ?? XTERM_THEMES.dark;
    }
  }, [themeVariant, visible]);

  if (!visible) return null;

  return (
    <div
      className="flex flex-col shrink-0 border-t border-[var(--color-border-glass)] glass"
      style={{ height }}
    >
      <div className="flex items-center px-3 h-[30px] shrink-0 select-none">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)]">
          Terminal
        </span>
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--color-text-tertiary)] flex items-center gap-1.5 mr-2">
          <span>
            {ready ? (
              <span className="w-1.5 h-1.5 rounded-full inline-block bg-[var(--color-accent-green)]" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full inline-block bg-[var(--color-accent-orange)]" />
            )}
          </span>
          {ready ? "connected" : "connecting"}
        </span>
        <button
          onClick={() => setVisible(false)}
          className="w-6 h-6 flex items-center justify-center rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-glass-hover)] transition-colors"
        >
          {"\u2715"}
        </button>
      </div>

      <div className="flex-1 min-h-0 pl-1 pb-1 pr-2">
        <div id="terminal-container" className="w-full h-full" />
      </div>

      <div
        className="cursor-row-resize h-[5px] shrink-0 flex items-center justify-center hover:bg-[var(--color-bg-glass-hover)] transition-colors -mt-[2px]"
        onMouseDown={(e) => {
          e.preventDefault();
          const startY = e.clientY;
          const startHeight = height;
          const onMove = (ev: MouseEvent) => {
            const newHeight = startHeight + (startY - ev.clientY);
            setHeight(Math.max(120, Math.min(600, newHeight)));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />
    </div>
  );
}