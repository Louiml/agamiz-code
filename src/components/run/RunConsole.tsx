import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useRunStore } from "../../store";
import { openProject } from "../../utils/project";

export function RunConsole() {
  const visible = useRunStore((s) => s.visible);
  const setVisible = useRunStore((s) => s.setVisible);
  const configs = useRunStore((s) => s.configs);
  const selectedConfig = useRunStore((s) => s.selectedConfig);
  const select = useRunStore((s) => s.select);
  const running = useRunStore((s) => s.running);
  const runId = useRunStore((s) => s.runId);
  const output = useRunStore((s) => s.output);
  const exitCode = useRunStore((s) => s.exitCode);
  const refresh = useRunStore((s) => s.refresh);
  const setRunning = useRunStore((s) => s.setRunning);
  const appendOutput = useRunStore((s) => s.appendOutput);
  const setExitCode = useRunStore((s) => s.setExitCode);
  const clear = useRunStore((s) => s.clear);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const unlisteners: UnlistenFn[] = [];
    void listen<[number, "stdout" | "stderr", string]>(
      "run:output",
      ({ payload }) => {
        appendOutput(payload[1], payload[2]);
      }
    ).then((fn) => {
      unlisteners.push(fn);
    });
    void listen<[number, number, string]>("run:exit", ({ payload }) => {
      setRunning(false, null);
      setExitCode(payload[1]);
    }).then((fn) => {
      unlisteners.push(fn);
    });
    return () => {
      unlisteners.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output]);

  const handleRun = (debug: boolean) => {
    if (!selectedConfig) return;
    clear();
    setExitCode(null);
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

  if (!visible) return null;

  return (
    <div className="flex flex-col shrink-0 border-t border-[var(--color-border-glass)] glass" style={{ height: 220 }}>
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 select-none border-b border-[var(--color-border-glass)]">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)]">
          Run Console
        </span>
        {configs.length === 0 ? (
          <button
            onClick={() => void openProject()}
            className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] underline decoration-dotted"
          >
            No run configurations — open a project
          </button>
        ) : (
          <select
            value={selectedConfig ?? ""}
            onChange={(e) => select(e.target.value)}
            className="ml-1 text-[11px] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] border border-[var(--color-border-glass)] rounded-md px-2 py-0.5 outline-none focus:border-[var(--color-border-focus)]"
          >
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex-1" />
        <button
          onClick={() => handleRun(false)}
          disabled={!selectedConfig || running}
          className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--color-accent-green)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40 transition-colors"
          title="Run"
        >
          {"\u25B6"}
        </button>
        <button
          onClick={() => handleRun(true)}
          disabled={!selectedConfig || running}
          className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--color-accent-red)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40 transition-colors"
          title="Debug"
        >
          <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a2 2 0 0 1 2 2v.35A4 4 0 0 1 12 7v1a4 4 0 0 1-1.2 2.85l.95.95a.5.5 0 0 1-.7.7l-1.1-1.1c-.6.25-1.25.4-1.95.4s-1.35-.15-1.95-.4l-1.1 1.1a.5.5 0 0 1-.7-.7l.95-.95A4 4 0 0 1 4 8V7a4 4 0 0 1 2-3.5A2 2 0 0 1 8 8zm0-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />
          </svg>
        </button>
        <button
          onClick={handleStop}
          disabled={!running}
          className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40 transition-colors"
          title="Stop"
        >
          {"\u25A0"}
        </button>
        <button
          onClick={clear}
          className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-glass-hover)] hover:text-[var(--color-text-secondary)] transition-colors"
          title="Clear output"
        >
          <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M4 2h8l-1 11H5L4 2zM6 12V6M9 12V6" />
          </svg>
        </button>
        <button
          onClick={() => setVisible(false)}
          className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-glass-hover)] hover:text-[var(--color-text-primary)] transition-colors"
          title="Close"
        >
          {"\u2715"}
        </button>
      </div>

      {running && (
        <div className="flex items-center gap-2 px-3 h-[22px] shrink-0 bg-[var(--color-bg-glass)] text-[11px] text-[var(--color-accent-green)]">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent-green)] opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-accent-green)]" />
          </span>
          Running…
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-apple p-2 font-mono text-[12px] leading-5">
        {output.length === 0 && (
          <span className="text-[var(--color-text-tertiary)]">
            {configs.length === 0
              ? "Open a project to see available run configurations."
              : `Ready to run "${configs.find((c) => c.id === selectedConfig)?.name ?? "..."}"`}
          </span>
        )}
        {output.map((line, i) => (
          <div
            key={i}
            className={
              line.stream === "stderr"
                ? "text-[var(--color-accent-red)]"
                : "text-[var(--color-text-primary)]"
            }
          >
            {line.text}
          </div>
        ))}
        {exitCode !== null && (
          <div
            className={
              exitCode === 0
                ? "text-[var(--color-accent-green)]"
                : "text-[var(--color-accent-red)]"
            }
          >
            {"\u2014"} Process exited with code {exitCode}
            {exitCode !== 0 ? " (failed)" : ""}
          </div>
        )}
      </div>
    </div>
  );
}