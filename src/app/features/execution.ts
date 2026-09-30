/**
 * Executer Service — the single owner of "what is currently running".
 *
 * The header controls, the status-bar badge, the editor gutter and the Run &
 * Debug panel all read from this one store, so a single click on Run updates
 * every surface at once. Responsibilities:
 *
 *   - resolve the active file to a [`TargetDescriptor`] via the backend router,
 *   - run it (routed, or through the native Rak bridge, or a `tasks.json`
 *     command) and stream output/exit codes,
 *   - launch a debug session on either transport (DAP, or CDP for Node),
 *   - own breakpoint state and push it into whichever session is active,
 *   - forward stdin so a Python/Node REPL is usable from the output panel.
 */

import { debugController } from './debug';
import { DapDebugSession, DapScope, ScopeVariables, DebugAdapterId } from './dap';
import {
  InterpreterInfo,
  WorkspaceSettings,
  argsFor,
  resolveInterpreter,
  taskFor,
  toolOverrides,
} from './interpreter';

/** Mirrors `TargetDescriptor` in `src-tauri/src/executor.rs`. */
export interface TargetDescriptor {
  language: string;
  kind: 'script' | 'native' | 'shell' | 'rak' | 'command' | 'unsupported';
  runnable: boolean;
  debuggable: boolean;
  adapter: string;
  tool: string;
  preview: string;
  note: string;
  /** The plan compiles before running (C/C++/Java/single-file Rust). */
  buildstep: boolean;
}

export type ExecutionStatus =
  | 'idle'
  | 'starting'
  | 'building'
  | 'running'
  | 'debugging'
  | 'paused';

export interface OutputLine {
  stream: 'stdout' | 'stderr' | 'info' | 'error';
  text: string;
  /** Which plan step produced this line. */
  role?: 'build' | 'run' | 'debug';
}

/** A user-set breakpoint. Lines are 1-based to match both DAP and the gutter. */
export interface Breakpoint {
  file: string;
  line: number;
  enabled: boolean;
  /** Adapters confirm the location landed on real code; until then it is pending. */
  verified: boolean;
}

export interface ExecutionState {
  status: ExecutionStatus;
  descriptor: TargetDescriptor | null;
  interpreter: InterpreterInfo | null;
  breakpoints: Breakpoint[];
  /** Top-of-stack location while paused, for editor highlighting. */
  current: { file: string; line: number } | null;
  stoppedReason: string;
  frames: import('./dap').DapStackFrame[];
  scopes: DapScope[];
  variables: ScopeVariables;
  /** Exit code of the last finished run. */
  exitCode: number | null;
}

const INITIAL: ExecutionState = {
  status: 'idle',
  descriptor: null,
  interpreter: null,
  breakpoints: [],
  current: null,
  stoppedReason: '',
  frames: [],
  scopes: [],
  variables: {},
  exitCode: null,
};

type Listener = (state: ExecutionState) => void;

/**
 * Burst-dedupe window for the native Rak output channel.
 *
 * Module-level rather than per-instance because the listeners bind once, and
 * Rak frequently emits the same line on both stdout and stderr.
 */
const rakOutputSeen = new Map<string, number>();

/** Reactive store for execution state. Mirrors the diagnostics store pattern. */
class ExecutionStore {
  private state: ExecutionState = { ...INITIAL };
  private listeners = new Set<Listener>();

  get(): ExecutionState {
    return this.state;
  }

  patch(next: Partial<ExecutionState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface RunRequest {
  file: string;
  cwd: string;
  settings: WorkspaceSettings;
  detected: InterpreterInfo[];
  /** Native Rak mode: `interp` | `vm` | `bench`. */
  rakMode?: 'interp' | 'vm' | 'bench';
  /** In-memory buffer for scratch tabs, which have no file on disk. */
  source?: string;
  /** Debug entry stops at the first line. */
  stopOnEntry?: boolean;
}

class ExecutionService {
  readonly store = new ExecutionStore();

  /** Output lines are pushed outward rather than stored here: page.tsx already
   *  owns the bottom-panel buffer and the Rak bridge emits on its own channel. */
  onOutput: (line: OutputLine) => void = () => {};
  /** Fired once a run or debug session ends, whatever the reason. */
  onFinished: (exitCode: number | null) => void = () => {};
  /** Fired when execution parks, so the editor can reveal the location. */
  onPaused: (location: { file: string; line: number } | null) => void = () => {};
  /** Human-readable progress messages (resolving toolchains, missing adapters). */
  onNotice: (text: string, kind: 'info' | 'error') => void = () => {};

  private session = 0;
  private activeSession: number | null = null;
  private dap: DapDebugSession | null = null;
  private listenersBound = false;
  private mode: 'run' | 'debug' | 'node-debug' | null = null;

  // -- description --------------------------------------------------------

  /** Ask the backend router what it would do with this file. */
  async describe(file: string, settings: WorkspaceSettings): Promise<TargetDescriptor | null> {
    if (!file) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<TargetDescriptor>('describe_target', {
        file,
        tools: toolOverrides(settings),
      });
    } catch (e) {
      // A routing failure is itself information: show it instead of a blank
      // status bar, but do not treat it as fatal.
      console.warn('[execution] describe_target failed:', e);
      return null;
    }
  }

  /** Resolve the interpreter for a language and record it on the store. */
  async syncInterpreter(
    language: string,
    detected: InterpreterInfo[],
    settings: WorkspaceSettings,
  ): Promise<InterpreterInfo | null> {
    const interpreter = resolveInterpreter(language, detected, settings);
    this.store.patch({ interpreter });
    return interpreter;
  }

  // -- run ----------------------------------------------------------------

  /** Run the active file using whichever transport fits it. */
  async run(request: RunRequest): Promise<void> {
    await this.stop();

    if (request.file.endsWith('.rak')) {
      await this.runRak(request);
      return;
    }

    const descriptor = await this.describe(request.file, request.settings);
    if (!descriptor) {
      this.onNotice(`Cannot run ${basename(request.file)}: no route available.`, 'error');
      return;
    }

    // A `tasks.json` entry always wins: it is the user's explicit escape hatch
    // for file types the router does not know.
    const task = taskFor(request.file, request.settings);
    const session = ++this.session;
    this.activeSession = session;
    this.mode = 'run';
    this.store.patch({
      status: 'starting',
      descriptor,
      exitCode: null,
      frames: [],
      scopes: [],
      variables: {},
      current: null,
    });

    const args = argsFor(descriptor.language, request.settings);
    const { invoke } = await import('@tauri-apps/api/core');

    try {
      const started = await invoke<TargetDescriptor>('run_target', {
        session,
        file: request.file,
        cwd: request.cwd,
        tools: toolOverrides(request.settings),
        args,
        program: task?.program ?? null,
        argv: task?.args ?? [],
      });
      this.store.patch({ descriptor: started, status: 'running' });
      this.onOutput({ stream: 'info', text: `> ${started.preview}`, role: 'run' });
    } catch (e) {
      this.store.patch({ status: 'idle', descriptor });
      const message = String(e);
      this.onOutput({ stream: 'error', text: message });
      this.onNotice(message.replace(/^Error:\s*/, ''), 'error');
    }
  }

  /**
   * Native Rak execution.
   *
   * Kept on the dedicated `run_rak` bridge because it is the only backend that
   * understands Rak's interpreter/VM/bench modes and its `rak-output` channel.
   */
  private async runRak(request: RunRequest): Promise<void> {
    const source = request.source ?? '';
    this.store.patch({
      status: 'running',
      exitCode: null,
      descriptor: {
        language: 'rak',
        kind: 'rak',
        runnable: true,
        debuggable: false,
        adapter: '',
        tool: '',
        preview: `rakc --mode ${request.rakMode ?? 'interp'}`,
        note: 'Native Rak runtime.',
        buildstep: false,
      },
    });
    this.onOutput({
      stream: 'info',
      text: `> rakc --mode ${request.rakMode ?? 'interp'}`,
      role: 'run',
    });

    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('run_rak', { mode: request.rakMode ?? 'interp', source });
    } catch (e) {
      const message = String(e);
      this.store.patch({ status: 'idle' });
      this.onOutput({ stream: 'error', text: message });
      this.onNotice(message, 'error');
    }
  }

  // -- debug --------------------------------------------------------------

  /** Debug the active file, choosing DAP or CDP from the router's verdict. */
  async debug(request: RunRequest): Promise<void> {
    await this.stop();

    if (request.file.endsWith('.rak')) {
      this.onNotice('Debugging is not available for the native Rak runtime yet.', 'info');
      return;
    }

    const descriptor = await this.describe(request.file, request.settings);
    if (!descriptor?.debuggable) {
      this.onNotice(
        descriptor?.note
          ? `${basename(request.file)} cannot be debugged. ${descriptor.note}`
          : `No debug adapter for ${basename(request.file)}.`,
        'error',
      );
      return;
    }

    const session = ++this.session;
    this.activeSession = session;
    this.store.patch({
      status: 'debugging',
      descriptor,
      exitCode: null,
      current: null,
      stoppedReason: '',
    });

    if (descriptor.adapter === 'node-inspector') {
      await this.debugWithCdp(request, session, descriptor);
      return;
    }

    await this.debugWithDap(request, session, descriptor);
  }

  /** DAP transport (Python/debugpy, and any future standalone adapter). */
  private async debugWithDap(
    request: RunRequest,
    session: number,
    descriptor: TargetDescriptor,
  ): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    const adapter = descriptor.adapter as DebugAdapterId;

    // Confirm an adapter is actually installed before spawning, so a missing
    // debugpy is a clear message rather than an opaque handshake failure.
    let chosen = adapter;
    try {
      const auto = await invoke<string | null>('select_debug_adapter', {
        language: descriptor.language,
        preferred: request.settings.debugAdapter?.[descriptor.language] ?? '',
        tools: toolOverrides(request.settings),
      });
      if (auto) chosen = auto as DebugAdapterId;
    } catch {
      /* fall back to the router's choice */
    }

    const breakpoints = this.breakpointGroups(request.file);

    try {
      await invoke<string>('dap_start', {
        session,
        adapter: chosen,
        tools: toolOverrides(request.settings),
        port: 5678,
      });
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/, '');
      this.store.patch({ status: 'idle' });
      this.onNotice(`Could not start the ${chosen} adapter: ${message}`, 'error');
      this.onOutput({ stream: 'error', text: message });
      return;
    }

    const dap = new DapDebugSession(session, chosen);
    dap.onConsole = (text, isError) =>
      this.onOutput({ stream: isError ? 'stderr' : 'stdout', text, role: 'debug' });
    dap.onState = (state) => {
      this.store.patch({
        frames: state.frames,
        current: state.current,
        stoppedReason: state.stoppedReason,
        status: state.running ? 'debugging' : 'paused',
      });
      this.onPaused(state.current);
    };
    dap.onVariables = (scopes, variables) => this.store.patch({ scopes, variables });
    dap.onTerminated = (code) => this.finish(code);
    this.dap = dap;

    try {
      await dap.start({
        program: request.file,
        cwd: request.cwd,
        args: argsFor(descriptor.language, request.settings),
        breakpoints,
        stopOnEntry: request.stopOnEntry ?? false,
      });
    } catch (e) {
      const message = (e as Error).message;
      this.store.patch({ status: 'idle' });
      this.onNotice(`Debug session failed: ${message}`, 'error');
      this.onOutput({ stream: 'error', text: `debug session failed: ${message}` });
      await dap.dispose();
      this.dap = null;
    }
  }

  /**
   * CDP transport for Node.
   *
   * `node --inspect-brk` has no DAP bridge in core Node, and the existing CDP
   * controller already implements breakpoints, stepping and scopes, so reusing
   * it avoids a second, worse Node debugger.
   */
  private async debugWithCdp(
    request: RunRequest,
    session: number,
    descriptor: TargetDescriptor,
  ): Promise<void> {
    const { startNodeInspect } = await import('./runner');
    const breakpoints = this.breakpointGroups(request.file);
    const first = breakpoints[0]?.lines[0];

    debugController.onState = (state) => {
      this.store.patch({
        frames: state.topFrame
          ? [
              {
                id: Number(state.topFrame.callFrameId) || 1,
                name: state.topFrame.functionName,
                line: state.topFrame.line + 1,
                column: state.topFrame.column,
                sourceName: basename(state.topFrame.url),
                sourcePath: state.topFrame.url.replace(/^file:\/\//, ''),
              },
            ]
          : [],
        status: state.running ? 'debugging' : 'paused',
        stoppedReason: state.pauseReason,
      });
    };
    debugController.onStopped = () => {
      const frame = debugController.state.topFrame;
      const location = frame ? { file: frame.url.replace(/^file:\/\//, ''), line: frame.line + 1 } : null;
      this.store.patch({ current: location, status: 'paused' });
      this.onPaused(location);
    };
    debugController.onConsole = (text) => this.onOutput({ stream: 'stdout', text, role: 'debug' });

    try {
      const info = await startNodeInspect(
        request.file,
        argsFor(descriptor.language, request.settings),
        request.cwd,
        true,
      );
      void session;
      await debugController.connect(info.wsUrl);
      this.mode = 'node-debug';

      const url = `file://${request.file.replace(/\\/g, '/')}`;
      for (const line of breakpoints.flatMap((g) => g.lines)) {
        await debugController.setBreakpoint(url, line - 1).catch(() => {});
      }
      if (!first || !request.stopOnEntry) {
        await debugController.resume();
      }
      this.onOutput({ stream: 'info', text: `Inspector: ${info.wsUrl}`, role: 'debug' });
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/, '');
      this.store.patch({ status: 'idle' });
      this.onNotice(`Node debug failed: ${message}`, 'error');
      this.onOutput({ stream: 'error', text: message });
    }
  }

  // -- breakpoints --------------------------------------------------------

  /** Group breakpoints for the active file, as DAP's `setBreakpoints` wants. */
  private breakpointGroups(file: string): { file: string; lines: number[] }[] {
    const mine = this.store
      .get()
      .breakpoints.filter((b) => b.file === file && b.enabled)
      .map((b) => b.line)
      .sort((a, b) => a - b);
    return mine.length ? [{ file, lines: mine }] : [];
  }

  /** Add/remove/toggle a breakpoint and push it into the live session. */
  async toggleBreakpoint(file: string, line: number): Promise<void> {
    if (!file) return;
    const existing = this.store.get().breakpoints.find((b) => b.file === file && b.line === line);
    const next = existing
      ? this.store.get().breakpoints.filter((b) => !(b.file === file && b.line === line))
      : [...this.store.get().breakpoints, { file, line, enabled: true, verified: false }];
    this.store.patch({ breakpoints: next });

    // Mid-session changes are rare but should not require a restart.
    if (this.dap) {
      await this.dap.send('setBreakpoints', {
        source: { path: file },
        breakpoints: next
          .filter((b) => b.file === file)
          .map((b) => ({ line: b.line })),
      }).catch(() => {});
    }
  }

  async clearBreakpoints(file?: string): Promise<void> {
    this.store.patch({
      breakpoints: file
        ? this.store.get().breakpoints.filter((b) => b.file !== file)
        : [],
    });
  }

  /** Lines of the active file that carry a breakpoint, for the gutter. */
  breakpointLines(file: string): Set<number> {
    return new Set(
      this.store.get().breakpoints.filter((b) => b.file === file).map((b) => b.line),
    );
  }

  // -- control ------------------------------------------------------------

  /** Forward a line of input to the running process (REPL support). */
  async write(text: string): Promise<void> {
    if (this.mode === 'node-debug') {
      await debugController.evaluate(text).then((r) => this.onOutput({ stream: 'stdout', text: String(r), role: 'debug' }));
      return;
    }
    if (this.activeSession === null) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('run_write', { session: this.activeSession, input: text }).catch((e) => {
      this.onOutput({ stream: 'error', text: String(e) });
    });
  }

  /** Terminate whatever is running. Safe to call when nothing is. */
  async stop(): Promise<void> {
    const session = this.activeSession;
    const wasActive = session !== null;

    if (this.dap) {
      await this.dap.dispose().catch(() => {});
      this.dap = null;
    }
    if (this.mode === 'node-debug') {
      debugController.close();
    }
    if (session !== null) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('run_stop', { session }).catch(() => {});
    }
    if (wasActive && this.store.get().status !== 'idle') {
      this.onOutput({ stream: 'info', text: '> Stopped', role: 'run' });
    }

    this.activeSession = null;
    this.mode = null;
    this.store.patch({
      status: 'idle',
      frames: [],
      scopes: [],
      variables: {},
      current: null,
      stoppedReason: '',
    });
  }

  // -- stepping -----------------------------------------------------------

  async stepOver() {
    if (this.dap) return this.dap.stepOver();
    return debugController.stepOver();
  }

  async stepInto() {
    if (this.dap) return this.dap.stepInto();
    return debugController.stepInto();
  }

  async stepOut() {
    if (this.dap) return this.dap.stepOut();
    return debugController.stepOut();
  }

  async resume() {
    if (this.dap) return this.dap.resume();
    return debugController.resume();
  }

  async pause() {
    if (this.dap) return this.dap.pause();
    return debugController.pause();
  }

  /** Evaluate an expression in the debug console. */
  async evaluate(expression: string): Promise<string> {
    if (this.dap) {
      return this.dap.evaluate(expression, this.dap.selectedFrame()?.id);
    }
    return String(await debugController.evaluate(expression, debugController.state.topFrame?.callFrameId));
  }

  // -- plumbing -----------------------------------------------------------

  /** Wire the backend event streams exactly once. */
  ensureListeners(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;
    void this.bindListeners();
  }

  private async bindListeners(): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');

    await listen<{ session: number; step: number; role: string; stream: string; text: string }>(
      'run-output',
      (event) => {
        const { session, stream, text, role } = event.payload;
        if (session !== this.activeSession) return;
        this.onOutput({
          stream: stream === 'stderr' ? 'stderr' : 'stdout',
          text,
          role: role === 'build' ? 'build' : 'run',
        });
      },
    );

    // Step boundaries come from the backend rather than being inferred from
    // output text; that is what makes "Building…" vs "Running…" accurate.
    await listen<{ session: number; step: number; role: string; label: string }>(
      'run-step',
      (event) => {
        if (event.payload.session !== this.activeSession) return;
        const { role, label } = event.payload;
        this.store.patch({ status: role === 'build' ? 'building' : 'running' });
        this.onOutput({
          stream: 'info',
          text: `> ${label}`,
          role: role === 'build' ? 'build' : 'run',
        });
      },
    );

    await listen<{ session: number; code: number; ok: boolean; error: string | null }>('run-done', (event) => {
      if (event.payload.session !== this.activeSession) return;
      this.finish(event.payload.code, event.payload.error ?? undefined);
    });

    // Native Rak channel — bridged into the same store so the header controls
    // and the panel do not need to know Rak is special. Rak re-emits identical
    // lines in bursts (one value dumped to both stdout and stderr), so the same
    // short dedupe window the old page-level listener used is applied here.
    await listen<{ stream: string; text: string }>('rak-output', (event) => {
      if (this.store.get().descriptor?.kind !== 'rak') return;
      const key = `${event.payload.stream}:${event.payload.text}`;
      const now = Date.now();
      const seen = rakOutputSeen.get(key) ?? 0;
      if (now - seen < 100) return;
      rakOutputSeen.set(key, now);
      this.onOutput({
        stream: event.payload.stream === 'stderr' ? 'stderr' : 'stdout',
        text: event.payload.text,
        role: 'run',
      });
    });

    await listen('rak-done', () => {
      if (this.store.get().descriptor?.kind !== 'rak') return;
      this.finish(0);
    });
  }

  private finish(code: number | null, error?: string): void {
    if (error) this.onOutput({ stream: 'error', text: error });
    if (code !== null) {
      this.onOutput({
        stream: code === 0 ? 'info' : 'error',
        text: code === 0 ? '> Process finished' : `> Process exited with code ${code}`,
      });
    }
    this.activeSession = null;
    this.mode = null;
    this.store.patch({
      status: 'idle',
      exitCode: code,
      frames: [],
      scopes: [],
      variables: {},
      current: null,
    });
    this.onFinished(code);
  }
}

function basename(path: string): string {
  const clean = path.replace(/^file:\/\//, '');
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

/** Shared singleton; mirrors how `diagnosticStore` is wired in the app. */
export const executionService = new ExecutionService();
