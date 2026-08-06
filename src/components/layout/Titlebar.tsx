import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  useDebugStore,
  useProjectStore,
  useRunStore,
} from "../../store";
import { openProject } from "../../utils/project";
import { startDebugSession } from "../../utils/dap";

function RunIcon({ color }: { color: string }) {
  return (
    <svg className="size-3" viewBox="0 0 12 12" fill="currentColor" style={{ color }}>
      <path d="M2.5 1.8v8.4a.6.6 0 0 0 .92.5l6.7-4.2a.6.6 0 0 0 0-1L3.42 1.3a.6.6 0 0 0-.92.5z" />
    </svg>
  );
}

function resolveAdapter(kind: string): string {
  switch (kind) {
    case "cargo":
      return "codelldb";
    case "npm-script":
    case "node":
    default:
      return "node";
  }
}

export function Titlebar() {
  const root = useProjectStore((s) => s.root);
  const handleClose = () => getCurrentWindow().close();
  const projectName = root
    ? root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "Project"
    : "No Project";

  const configs = useRunStore((s) => s.configs);
  const selectedConfig = useRunStore((s) => s.selectedConfig);
  const select = useRunStore((s) => s.select);
  const running = useRunStore((s) => s.running);
  const runId = useRunStore((s) => s.runId);
  const setVisible = useRunStore((s) => s.setVisible);
  const setRunning = useRunStore((s) => s.setRunning);
  const clear = useRunStore((s) => s.clear);
  const setExitCode = useRunStore((s) => s.setExitCode);
  const appendOutput = useRunStore((s) => s.appendOutput);

  const handleRun = (debug: boolean) => {
    if (!selectedConfig) return;
    clear();
    setExitCode(null);
    setVisible(true);
    void invoke("run_project", { configId: selectedConfig, debug })
      .then((id) => setRunning(true, id as number))
      .catch((e) => appendOutput("stderr", String(e)));
  };

  const handleStop = () => {
    if (runId != null) {
      void invoke("stop_run", { id: runId }).then(() => {
        setRunning(false, null);
      });
    }
  };

  const handleDebug = () => {
    // If a debug session is active, stop it.
    const debugState = useDebugStore.getState();
    if (debugState.sessionId != null) {
      void invoke("dap_stop", { sessionId: debugState.sessionId }).then(() =>
        debugState.reset(),
      );
      return;
    }
    if (!selectedConfig || !root) return;
    const config = configs.find((c) => c.id === selectedConfig);
    if (!config) return;
    const bpState = useDebugStore.getState();
    const program = config.command;
    // Derive a DAP adapter: use node if vscode-js-debug/other isn't set.
    const adapter = resolveAdapter(config.kind);
    void startDebugSession(
      {
        name: config.name,
        adapter,
        args: [],
        mode: "launch",
        program,
        cwd: root,
      },
      bpState.breakpointFile
        ? [{ path: bpState.breakpointFile, lines: bpState.breakpoints }]
        : [],
      root,
    )
      .then((sessionId) => {
        useDebugStore.getState().setSession(sessionId, true);
        useDebugStore.getState().setVisible(true);
        setVisible(true);
        appendOutput("stdout", `Debug session started (#${sessionId})`);
      })
      .catch((e) => appendOutput("stderr", `[debugger] ${String(e)}`));
  };

  return (
    <header
      data-tauri-drag-region
      className="flex items-center justify-between h-[var(--spacing-titlebar)] shrink-0 glass-strong border-b border-[var(--color-border-glass)] select-none"
    >
      <div className="flex items-center gap-2 px-3">
        <button
          onClick={() => void openProject()}
          className="flex items-center gap-1.5 glass-strong glass-hover px-2 py-1 rounded-md text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors"
          title="Open Project"
        >
          <svg
            className="size-3.5"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          >
            <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V4.5z" />
          </svg>
        </button>
        <span className="text-[11px] font-semibold tracking-wide text-[var(--color-text-secondary)]">
          Agamiz Code
        </span>
        {projectName && (
          <>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">—</span>
            <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono truncate max-w-[200px]">
              {projectName}
            </span>
          </>
        )}
      </div>

      <div className="flex-1" data-tauri-drag-region />

      <div
        className="flex items-center gap-1 px-2 glass-pill mx-2 h-[30px]"
        data-tauri-drag-region
      >
        <select
          value={selectedConfig ?? ""}
          onChange={(e) => select(e.target.value)}
          disabled={!root || configs.length === 0 || running}
          title={configs[0] ? `Run: ${configs[0].command}` : "No run configurations"}
          className="bg-transparent text-[11px] text-[var(--color-text-secondary)] border-none outline-none appearance-none px-1 cursor-pointer disabled:cursor-default disabled:opacity-50 hover:text-[var(--color-text-primary)] transition-colors font-mono max-w-[160px]"
        >
          {configs.length === 0 ? (
            <option value="">{root ? "No configs" : "Open a project"}</option>
          ) : (
            configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))
          )}
        </select>

        <span className="w-px h-3.5 bg-[var(--color-border-glass)]" />

        <button
          onClick={() => handleRun(false)}
          disabled={!selectedConfig || running}
          title="Run"
          className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--color-accent-green)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40 transition-colors"
        >
          <RunIcon color="var(--color-accent-green)" />
        </button>
        <button
          onClick={handleDebug}
          disabled={!selectedConfig || (running && useDebugStore.getState().sessionId == null)}
          title="Debug"
          className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--color-accent-red)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40 transition-colors"
        >
          <svg className="size-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a2 2 0 0 1 2 2v.35A4 4 0 0 1 12 7v1a4 4 0 0 1-1.2 2.85l.95.95a.5.5 0 0 1-.7.7l-1.1-1.1c-.6.25-1.25.4-1.95.4s-1.35-.15-1.95-.4l-1.1 1.1a.5.5 0 0 1-.7-.7l.95-.95A4 4 0 0 1 4 8V7a4 4 0 0 1 2-3.5A2 2 0 0 1 8 1zm0-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />
          </svg>
        </button>
        <button
          onClick={handleStop}
          disabled={!running}
          title="Stop"
          className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40 transition-colors"
        >
          <svg className="size-2.5" viewBox="0 0 10 10" fill="currentColor">
            <rect x="1" y="1" width="8" height="8" rx="1" />
          </svg>
        </button>
      </div>

      <div className="flex items-center h-full">
        <button
          onClick={() => getCurrentWindow().minimize()}
          className="flex items-center justify-center w-10 h-full hover:bg-[var(--color-bg-glass-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M1 6h10" />
          </svg>
        </button>
        <button
          onClick={() => getCurrentWindow().toggleMaximize()}
          className="flex items-center justify-center w-10 h-full hover:bg-[var(--color-bg-glass-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <svg className="size-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="10" height="10" />
          </svg>
        </button>
        <button
          onClick={handleClose}
          className="flex items-center justify-center w-11 h-full hover:bg-[#ff453a] group cursor-pointer transition-colors duration-150"
        >
          <svg
            className="size-3 opacity-60 group-hover:opacity-100 group-hover:text-white transition-opacity"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
    </header>
  );
}