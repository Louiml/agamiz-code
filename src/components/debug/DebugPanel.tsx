import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDebugStore, useEditorStore } from "../../store";
import type { DapScope, DapStackFrame, DapVariable } from "../../types";
import { dap, initDebugEvents, type DapOutputEvent } from "../../utils/dap";

type Tab = "stack" | "variables" | "breakpoints";

const activeThreadId = () => useDebugStore.getState().threads[0]?.id ?? null;

async function loadStack(sessionId: number, threadId: number) {
  try {
    const frames = await dap.stackTrace(sessionId, threadId);
    useDebugStore.getState().setStack(frames);
    const first = frames[0];
    if (first) {
      const scopes = await dap.scopes(sessionId, first.id);
      useDebugStore
        .getState()
        .setScopes(
          scopes.map((s: DapScope) => ({
            name: s.name,
            variablesReference: s.variablesReference,
            expensive: !!s.expensive,
          })),
        );
      const vars: DapVariable[] = [];
      for (const scope of scopes) {
        if (scope.variablesReference <= 0) continue;
        const v = await dap.variables(sessionId, scope.variablesReference);
        vars.push(...v);
      }
      useDebugStore.getState().setVariables(vars);
    }
  } catch (e) {
    console.warn("[dap] stack load", e);
  }
}

async function loadVariables(sessionId: number, variablesReference: number) {
  try {
    const vars = await dap.variables(sessionId, variablesReference);
    useDebugStore.getState().setVariables(vars);
  } catch (e) {
    console.warn("[dap] variables", e);
  }
}

export function DebugPanel() {
  const visible = useDebugStore((s) => s.visible);
  const setVisible = useDebugStore((s) => s.setVisible);
  const sessionId = useDebugStore((s) => s.sessionId);
  const running = useDebugStore((s) => s.running);
  const stackFrames = useDebugStore((s) => s.stackFrames);
  const scopes = useDebugStore((s) => s.scopes);
  const variables = useDebugStore((s) => s.variables);
  const breakpointFile = useDebugStore((s) => s.breakpointFile);
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const stoppedReason = useDebugStore((s) => s.stoppedReason);

  const [tab, setTab] = useState<Tab>("stack");
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;
    void initDebugEvents({
      onStopped: (id, body) => {
        useDebugStore.getState().setSession(id, false);
        useDebugStore.getState().setStoppedReason(body.reason);
        useDebugStore.getState().setVisible(true);
        if (body.threadId != null) {
          void loadStack(id, body.threadId);
        }
      },
      onContinued: (id) => {
        useDebugStore.getState().setSession(id, true);
        useDebugStore.getState().setStoppedReason(null);
      },
      onOutput: (id, body: DapOutputEvent) => {
        void id;
        const text = body.output;
        if (text) setOutput((o) => [...o, text]);
      },
      onExited: () => {
        useDebugStore.getState().reset();
        useDebugStore.getState().setSession(null, false);
      },
      onBreakpoint: () => {},
      onThread: () => {
        if (sessionId) void dap.threads(sessionId).then((t) => useDebugStore.getState().setThreads(t));
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Refresh threads when stopped.
  useEffect(() => {
    if (!sessionId || running) return;
    void dap
      .threads(sessionId)
      .then((t) => useDebugStore.getState().setThreads(t))
      .catch(() => {});
  }, [sessionId, running]);

  const stepAction = (action: "next" | "stepIn" | "stepOut" | "continueRun" | "pause") => {
    if (sessionId == null) return;
    const tid = activeThreadId();
    if (tid == null) return;
    void dap[action](sessionId, tid).catch((e) => console.warn("[dap]", action, e));
  };

  const openFrameSource = useCallback((frame: DapStackFrame) => {
    const path = frame.source?.path;
    if (!path) return;
    void invoke<string>("read_file_content", { path }).then((_content) => {
      const tabs = useEditorStore.getState().tabs;
      const existing = tabs.find((t) => t.path.replace(/\\/g, "/") === path.replace(/\\/g, "/"));
      if (existing) {
        useEditorStore.getState().setActiveTab(existing.id);
      }
    }).catch(() => {});
  }, []);

  if (!visible) return null;

  const runControls = (
    <div className="flex items-center gap-1 px-3 h-[30px] shrink-0 border-b border-[var(--color-border-glass)]">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)]">
        Debug
      </span>
      <div className="flex-1" />
      <button
        onClick={() => stepAction("continueRun")}
        disabled={!sessionId || running}
        className="w-6 h-6 rounded flex items-center justify-center text-[var(--color-accent-green)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40"
        title="Continue"
      >
        {"\u25B6"}
      </button>
      <button
        onClick={() => stepAction("pause")}
        disabled={!sessionId || !running}
        className="w-6 h-6 rounded flex items-center justify-center text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40"
        title="Pause"
      >
        {"\u2759\u2759"}
      </button>
      <button
        onClick={() => stepAction("next")}
        disabled={!sessionId || running}
        className="w-6 h-6 rounded flex items-center justify-center text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40"
        title="Step Over"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M5 11.5 1.5 8 5 4.5v7zM8 11.5 4.5 8 8 4.5v7zM9.5 6.5l5 0-1.5 1.5h3.5v3l-5 0z" transform="translate(-1 0)" />
        </svg>
      </button>
      <button
        onClick={() => stepAction("stepIn")}
        disabled={!sessionId || running}
        className="w-6 h-6 rounded flex items-center justify-center text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40"
        title="Step Into"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.5 3v5.5l-3-3-1 1 4.5 4.5L12.5 6.5l-1-1-3 3V3h-1z" />
        </svg>
      </button>
      <button
        onClick={() => stepAction("stepOut")}
        disabled={!sessionId || running}
        className="w-6 h-6 rounded flex items-center justify-center text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-bg-glass-hover)] disabled:opacity-40"
        title="Step Out"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8.5 13V7.5l3 3 1-1L8 5l-4.5 4.5 1 1 3-3V13h1z" />
        </svg>
      </button>
      <button
        onClick={() => sessionId != null && void dap.stop(sessionId)}
        disabled={!sessionId}
        className="w-6 h-6 rounded flex items-center justify-center text-[var(--color-text-tertiary)] enabled:hover:bg-[var(--color-bg-glass-hover)] enabled:hover:text-[var(--color-accent-red)] disabled:opacity-40"
        title="Stop Debugging"
      >
        {"\u25A0"}
      </button>
      <button
        onClick={() => setVisible(false)}
        className="w-6 h-6 rounded flex items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-glass-hover)] hover:text-[var(--color-text-primary)]"
        title="Close"
      >
        {"\u2715"}
      </button>
    </div>
  );

  const tabBar = (
    <div className="flex items-center px-2 h-[26px] shrink-0 border-b border-[var(--color-border-glass)] gap-0.5">
      {(["stack", "variables", "breakpoints"] as Tab[]).map((t) => (
        <button
          key={t}
          onClick={() => setTab(t)}
          className={`px-2.5 py-0.5 rounded text-[11px] capitalize transition-colors ${
            tab === t
              ? "bg-[var(--color-bg-glass-strong)] text-[var(--color-text-primary)]"
              : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );

  const stackTab = (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-apple">
      {stackFrames.length === 0 ? (
        <div className="p-3 text-[11px] text-[var(--color-text-tertiary)]">
          {running ? "Running…" : "No stack frames. Set a breakpoint and debug."}
        </div>
      ) : (
        stackFrames.map((frame, i) => (
          <button
            key={frame.id}
            onClick={() => openFrameSource(frame)}
            className="w-full flex items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-[var(--color-bg-glass)] transition-colors"
          >
            <span className="w-5 shrink-0 text-[10px] text-[var(--color-text-tertiary)] font-mono">
              {i}
            </span>
            <span className="flex-1 min-w-0 truncate font-mono text-[var(--color-text-primary)]">
              {frame.name}
            </span>
            <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)] font-mono">
              {frame.source?.name ?? ""}:{frame.line}
            </span>
          </button>
        ))
      )}
    </div>
  );

  const renderVariable = (v: DapVariable, depth: number) => (
    <div key={`${v.name}-${depth}`} className="flex items-center gap-2 px-3 py-0.5 text-[12px]">
      <span className="text-[var(--color-accent-teal)] font-mono">{v.name}</span>
      <span className="text-[var(--color-text-tertiary)]">:</span>
      <span className="flex-1 min-w-0 truncate text-[var(--color-text-primary)] font-mono">
        {v.value}
      </span>
      {v.type && (
        <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
          {v.type}
        </span>
      )}
      {v.variablesReference && v.variablesReference > 0 && sessionId != null && (
        <button
          onClick={() => void loadVariables(sessionId, v.variablesReference!)}
          className="shrink-0 text-[10px] text-[var(--color-accent-blue)] hover:underline"
        >
          expand
        </button>
      )}
    </div>
  );

  const variablesTab = (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-apple">
      {scopes.length === 0 && variables.length === 0 && (
        <div className="p-3 text-[11px] text-[var(--color-text-tertiary)]">
          No variables. Pause execution to inspect the runtime state.
        </div>
      )}
      {scopes.map((s) => (
        <div key={s.name} className="mt-1">
          <div className="px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
            {s.name}
          </div>
          {s.variablesReference > 0 && sessionId != null && (
            <VariableScope sessionId={sessionId} variablesReference={s.variablesReference} />
          )}
        </div>
      ))}
      {scopes.length === 0 &&
        variables.map((v, i) => <div key={i}>{renderVariable(v, 0)}</div>)}
    </div>
  );

  const breakpointsTab = (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-apple">
      {breakpoints.length === 0 ? (
        <div className="p-3 text-[11px] text-[var(--color-text-tertiary)]">
          No breakpoints. Click the gutter in the editor to add one.
        </div>
      ) : (
        <div className="p-3 space-y-1">
          <div className="text-[11px] font-medium text-[var(--color-text-secondary)]">
            {breakpointFile?.split(/[\\/]/).pop()}
          </div>
          {breakpoints.map((line) => (
            <div
              key={line}
              className="flex items-center gap-2 text-[12px] font-mono text-[var(--color-text-primary)]"
            >
              <span className="w-2 h-2 rounded-full bg-[var(--color-accent-red)]" />
              Line {line}
            </div>
          ))}
          <button
            onClick={() => useDebugStore.getState().setBreakpoints(breakpointFile ?? "", [])}
            className="mt-2 text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent-red)]"
          >
            Remove all
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col shrink-0 border-t border-[var(--color-border-glass)] glass" style={{ height: 260 }}>
      {runControls}
      <div className="flex items-center gap-2 px-3 h-[24px] shrink-0 bg-[var(--color-bg-glass)] text-[11px]">
        {running ? (
          <span className="flex items-center gap-1.5 text-[var(--color-accent-green)]">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent-green)] opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-accent-green)]" />
            </span>
            Running
          </span>
        ) : stoppedReason ? (
          <span className="text-[var(--color-accent-orange)]">
            Paused — {stoppedReason}
          </span>
        ) : sessionId ? (
          <span className="text-[var(--color-text-secondary)]">
            Session #{sessionId}
          </span>
        ) : (
          <span className="text-[var(--color-text-tertiary)]">
            Not debugging — click Debug in the toolbar
          </span>
        )}
      </div>
      {tabBar}
      {tab === "stack" && stackTab}
      {tab === "variables" && variablesTab}
      {tab === "breakpoints" && breakpointsTab}
      {output.length > 0 && (
        <div className="h-[92px] shrink-0 overflow-y-auto border-t border-[var(--color-border-glass)] px-3 py-1 font-mono text-[11px] text-[var(--color-text-secondary)] scrollbar-apple">
          {output.map((line, i) => (
            <div key={i} className="truncate whitespace-pre">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VariableScope({
  sessionId,
  variablesReference,
}: {
  sessionId: number;
  variablesReference: number;
}) {
  const [vars, setVars] = useState<DapVariable[]>([]);
  useEffect(() => {
    let cancelled = false;
    void dap
      .variables(sessionId, variablesReference)
      .then((v) => {
        if (!cancelled) setVars(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, variablesReference]);

  if (vars.length === 0) return null;
  return (
    <div>
      {vars.map((v) => (
        <div
          key={v.name}
          className="flex items-center gap-2 px-3 py-0.5 text-[12px]"
        >
          <span className="text-[var(--color-accent-teal)] font-mono">{v.name}</span>
          <span className="text-[var(--color-text-tertiary)]">:</span>
          <span className="flex-1 min-w-0 truncate text-[var(--color-text-primary)] font-mono">
            {v.value}
          </span>
          {v.type && (
            <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
              {v.type}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}