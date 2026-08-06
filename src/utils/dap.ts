import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DapBreakpoint,
  DapScope,
  DapStackFrame,
  DapThread,
  DapVariable,
  DebugConfig,
} from "../types";

export interface DebugSession {
  id: number;
}

export interface DapStoppedEvent {
  reason: string;
  threadId?: number;
  allThreadsStopped?: boolean;
  text?: string;
  hitBreakpointIds?: number[];
}

export interface DapOutputEvent {
  category?: string;
  output: string;
  line?: number;
  column?: number;
  source?: { name?: string; path?: string };
}

let stoppedListener: UnlistenFn | undefined;
let outputListener: UnlistenFn | undefined;
let exitedListener: UnlistenFn | undefined;

export async function initDebugEvents(callbacks: {
  onStopped: (sessionId: number, body: DapStoppedEvent) => void;
  onContinued: (sessionId: number, threadId: number) => void;
  onOutput: (sessionId: number, body: DapOutputEvent) => void;
  onExited: (sessionId: number, code: number | null) => void;
  onBreakpoint: (sessionId: number, body: { reason: string; breakpoint: DapBreakpoint }) => void;
  onThread: (sessionId: number, body: { reason: string; threadId: number }) => void;
}): Promise<UnlistenFn[]> {
  const unlisteners: UnlistenFn[] = [];

  if (!stoppedListener) {
    stoppedListener = await listen<[number, DapStoppedEvent]>("dap:event:stopped", (e) => {
      const [id, body] = e.payload;
      callbacks.onStopped(id, body);
    });
    unlisteners.push(stoppedListener);
  }
  if (!continuedListener) {
    continuedListener = await listen<[number, { threadId: number }]>("dap:event:continued", (e) => {
      const [id, body] = e.payload;
      callbacks.onContinued(id, body.threadId);
    });
    unlisteners.push(continuedListener);
  }
  if (!outputListener) {
    outputListener = await listen<[number, DapOutputEvent]>("dap:event:output", (e) => {
      const [id, body] = e.payload;
      callbacks.onOutput(id, body);
    });
    unlisteners.push(outputListener);
  }
  if (!exitedListener) {
    exitedListener = await listen<[number, number | null]>("dap:exit", (e) => {
      const [id, code] = e.payload;
      callbacks.onExited(id, code);
    });
    unlisteners.push(exitedListener);
  }
  if (!breakpointListener) {
    breakpointListener = await listen<[number, { reason: string; breakpoint: DapBreakpoint }]>(
      "dap:event:breakpoint",
      (e) => {
        const [id, body] = e.payload;
        callbacks.onBreakpoint(id, body);
      },
    );
    unlisteners.push(breakpointListener);
  }
  if (!threadListener) {
    threadListener = await listen<[number, { reason: string; threadId: number }]>(
      "dap:event:thread",
      (e) => {
        const [id, body] = e.payload;
        callbacks.onThread(id, body);
      },
    );
    unlisteners.push(threadListener);
  }
  return unlisteners;
}

let continuedListener: UnlistenFn | undefined;
let breakpointListener: UnlistenFn | undefined;
let threadListener: UnlistenFn | undefined;

export const dap = {
  start: (config: DebugConfig) => invoke<number>("dap_start", { config }),
  stop: (sessionId: number) => invoke<void>("dap_stop", { sessionId }),
  initialize: (sessionId: number, adapterId: string) =>
    invoke<unknown>("dap_initialize", { sessionId, adapterId }),
  launch: (sessionId: number, args: Record<string, unknown>, configurationDone: boolean) =>
    invoke<void>("dap_launch", { sessionId, args, configurationDone }),
  attach: (sessionId: number, args: Record<string, unknown>, configurationDone: boolean) =>
    invoke<void>("dap_attach", { sessionId, args, configurationDone }),
  setBreakpoints: (sessionId: number, sourcePath: string, lines: number[]) =>
    invoke<DapBreakpoint[]>("dap_set_breakpoints", {
      sessionId,
      sourcePath,
      lines,
    }),
  threads: (sessionId: number) => invoke<DapThread[]>("dap_threads", { sessionId }),
  stackTrace: (sessionId: number, threadId: number) =>
    invoke<DapStackFrame[]>("dap_stack_trace", { sessionId, threadId }),
  scopes: (sessionId: number, frameId: number) =>
    invoke<DapScope[]>("dap_scopes", { sessionId, frameId }),
  variables: (sessionId: number, variablesReference: number) =>
    invoke<DapVariable[]>("dap_variables", { sessionId, variablesReference }),
  continueRun: (sessionId: number, threadId: number) =>
    invoke<void>("dap_continue", { sessionId, threadId }),
  next: (sessionId: number, threadId: number) => invoke<void>("dap_next", { sessionId, threadId }),
  stepIn: (sessionId: number, threadId: number) =>
    invoke<void>("dap_step_in", { sessionId, threadId }),
  stepOut: (sessionId: number, threadId: number) =>
    invoke<void>("dap_step_out", { sessionId, threadId }),
  pause: (sessionId: number, threadId: number) =>
    invoke<void>("dap_pause", { sessionId, threadId }),
};

/**
 * Start a debug session, initialize the adapter, push the current breakpoints,
 * and launch the program in one flow. Returns the new session id.
 */
export async function startDebugSession(
  config: DebugConfig,
  breakpoints: { path: string; lines: number[] }[],
  rootPath: string,
): Promise<number> {
  const sessionId = await dap.start({
    ...config,
    cwd: config.cwd ?? rootPath,
  });
  const adapterId = config.adapter.split(/[\s]/)[0] ?? "node";
  await dap.initialize(sessionId, adapterId);
  for (const bp of breakpoints) {
    if (bp.lines.length === 0) continue;
    await dap.setBreakpoints(sessionId, bp.path, bp.lines);
  }
  const args: Record<string, unknown> = { program: config.program };
  if (config.env) args.env = config.env;
  if (config.mode !== "attach") {
    await dap.launch(sessionId, args, true);
  } else {
    await dap.attach(sessionId, args, true);
  }
  await dap.threads(sessionId).catch(() => []);
  return sessionId;
}