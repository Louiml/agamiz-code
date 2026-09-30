/* eslint-disable @typescript-eslint/no-explicit-any --
 * DAP payloads are untyped wire JSON whose shape varies per adapter (debugpy,
 * codelldb, delve all name scopes, variables and capabilities differently).
 * Modelling every adapter's body would add hundreds of lines of casts without
 * making any of it safer, so bodies are typed `any` and narrowed at the point
 * of use. The typed interfaces above cover everything the UI actually reads.
 */

/**
 * Debug Adapter Protocol client.
 *
 * Speaks DAP to whichever adapter the backend spawned (see
 * `src-tauri/src/dap.rs`). The adapter owns the debuggee; this class owns the
 * protocol: request/response correlation, breakpoint bookkeeping, stepping, and
 * variable inspection.
 *
 * Transport asymmetry worth knowing: the browser cannot write to the adapter's
 * stdin, so requests go out via the `dap_send` Tauri command and responses
 * arrive as `dap-message` events. Sequencing and correlation therefore live
 * entirely here.
 *
 * Node is *not* handled by this client — `node --inspect-brk` speaks the Chrome
 * DevTools Protocol, which the existing CDP controller in `debug.ts` covers.
 * `DebugAdapterId` selects which of the two the execution service drives.
 */

export type DebugAdapterId = 'debugpy' | 'codelldb' | 'gdb' | 'lldb' | 'dlv' | 'node-inspector';

export interface DapStackFrame {
  /** DAP `id`, needed to evaluate in that frame's scope. */
  id: number;
  name: string;
  /** 1-based line, matching what the editor gutter shows. */
  line: number;
  column: number;
  sourceName: string;
  sourcePath: string;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type: string;
  variablesReference: number;
}

export interface DapSourceBreakpoint {
  /** 1-based line. */
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface DapStoppedEvent {
  reason: string;
  text?: string;
  threadId: number;
}

export interface DapSessionState {
  connected: boolean;
  /** false while paused at a breakpoint or step. */
  running: boolean;
  stoppedReason: string;
  frames: DapStackFrame[];
  /** Where execution is currently parked, for editor highlighting. */
  current: { file: string; line: number } | null;
  breakpoints: { file: string; line: number; verified: boolean }[];
}

type Pending = { resolve: (value: any) => void; reject: (e: Error) => void };

/** Tracks every (scope name → variables) pair so the panel can render them. */
export type ScopeVariables = Record<string, DapVariable[]>;

export class DapDebugSession {
  private session: number;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private adapter: DebugAdapterId;
  private unlisten: (() => void) | null = null;
  private scopesByRef = new Map<number, string>();
  /** Thread id from the most recent `stopped` event. */
  private thread = 1;

  /** Raw adapter stdout/stderr, surfaced in the debug console. */
  onConsole: (text: string, isError?: boolean) => void = () => {};
  onState: (state: DapSessionState) => void = () => {};
  /** Fired whenever the scopes/variables pair needs refetching. */
  onVariables: (scopes: DapScope[], variables: ScopeVariables) => void = () => {};
  onTerminated: (code: number | null) => void = () => {};

  state: DapSessionState = {
    connected: false,
    running: false,
    stoppedReason: '',
    frames: [],
    current: null,
    breakpoints: [],
  };

  constructor(session: number, adapter: DebugAdapterId) {
    this.session = session;
    this.adapter = adapter;
  }

  // -- transport ----------------------------------------------------------

  /**
   * Send a DAP request.
   *
   * Public because the execution service re-sends `setBreakpoints` when the
   * user toggles a breakpoint on an already-attached session.
   */
  async send(command: string, args?: Record<string, unknown>): Promise<any> {
    const { invoke } = await import('@tauri-apps/api/core');
    const seq = this.seq++;
    const payload = JSON.stringify({
      seq,
      type: 'request',
      command,
      arguments: args ?? {},
    });

    const settled = new Promise<any>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
    });

    await invoke('dap_send', { session: this.session, json: payload });
    return settled;
  }

  /** Subscribe to adapter messages. Call before `initialize`. */
  async attach(): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    this.unlisten = await listen<{ session: number; text: string }>('dap-message', (event) => {
      if (event.payload.session !== this.session) return;
      this.handleMessage(event.payload.text);
    });
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'response') {
      const pending = this.pending.get(msg.request_seq);
      if (!pending) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) pending.resolve(msg.body ?? {});
      else pending.reject(new Error(msg.message ?? `${msg.command} failed`));
      return;
    }

    if (msg.type === 'event') this.handleEvent(msg.event, msg.body ?? {});
  }

  // -- events -------------------------------------------------------------

  private handleEvent(event: string, body: any) {
    switch (event) {
      case 'output': {
        const text: string = body.output ?? '';
        if (text.trim()) this.onConsole(text, body.category === 'stderr');
        break;
      }
      case 'initialized':
        // The adapter is ready for breakpoints; the caller drives the sequence.
        break;
      case 'stopped':
        void this.onStopped(body as DapStoppedEvent);
        break;
      case 'continued':
        this.state.running = true;
        this.state.stoppedReason = '';
        this.state.frames = [];
        this.state.current = null;
        this.emit();
        break;
      case 'terminated':
        this.state.running = false;
        this.state.connected = false;
        this.emit();
        this.onTerminated(null);
        break;
      case 'exited':
        this.onTerminated(typeof body.exitCode === 'number' ? body.exitCode : null);
        break;
      case 'breakpoint':
        this.onBreakpointEvent(body);
        break;
    }
  }

  private onBreakpointEvent(body: any) {
    const changed: any[] = body.breakpoint ?? [];
    for (const bp of changed) {
      const index = this.state.breakpoints.findIndex(
        (b) => b.file === bp.source?.path && b.line === bp.line,
      );
      if (index < 0) continue;
      this.state.breakpoints[index] = {
        ...this.state.breakpoints[index],
        verified: !!bp.verified,
      };
    }
    this.emit();
  }

  private async onStopped(event: DapStoppedEvent) {
    this.state.running = false;
    this.state.stoppedReason = event.text ?? event.reason;
    // Remember which thread stopped so Continue/Step apply to it.
    this.thread = event.threadId || 1;
    this.emit();

    try {
      const response = await this.send('stackTrace', { threadId: event.threadId });
      this.state.frames = (response.stackFrames ?? []).map((f: any) => ({
        id: f.id,
        name: f.name || '(anonymous)',
        line: (f.line ?? 1) + 1, // DAP is 0-based for lines on the wire
        column: (f.column ?? 1) + 1,
        sourceName: f.source?.name ?? '',
        sourcePath: f.source?.path ?? '',
      }));
      this.state.current = this.state.frames[0]
        ? { file: this.state.frames[0].sourcePath, line: this.state.frames[0].line }
        : null;
    } catch (e) {
      this.onConsole(`Could not read the call stack: ${(e as Error).message}`, true);
    }

    this.emit();
    await this.refreshVariables(this.state.frames[0]?.id);
  }

  private emit() {
    this.onState({ ...this.state, breakpoints: [...this.state.breakpoints] });
  }

  // -- lifecycle ----------------------------------------------------------

  /**
   * Perform the DAP handshake, install breakpoints, and launch the program.
   *
   * `breakpoints` is keyed by file because DAP is explicitly multi-file: a
   * single-file run still needs the whole map sent to `setBreakpoints` per
   * source, otherwise the adapter cannot resolve the user's file URL.
   */
  async start(options: {
    program: string;
    cwd: string;
    args: string[];
    breakpoints: { file: string; lines: number[] }[];
    stopOnEntry: boolean;
  }): Promise<void> {
    await this.attach();

    await this.send('initialize', {
      // Adapters key their capabilities off `adapterID`; `node-inspector` is
      // handled by the CDP path and never reaches here.
      adapterID: this.adapter,
      clientID: 'agamiz-code',
      clientName: 'Agamiz Code',
      locale: 'en-US',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
    });

    for (const group of options.breakpoints) {
      if (!group.file || group.lines.length === 0) continue;
      const response = await this.send('setBreakpoints', {
        source: { path: group.file },
        breakpoints: group.lines.map((line) => ({ line })),
        sourceModified: false,
      });
      const verified: boolean[] = (response.breakpoints ?? []).map((b: any) => !!b.verified);
      group.lines.forEach((line, i) => {
        this.state.breakpoints.push({ file: group.file, line, verified: verified[i] ?? false });
      });
    }

    await this.send('configurationDone', {});

    await this.send('launch', {
      program: options.program,
      cwd: options.cwd,
      args: options.args,
      // Adapters that support `stopOnEntry` honour it; the rest ignore it.
      stopOnEntry: options.stopOnEntry,
      __sessionId: this.session,
    });

    this.state.connected = true;
    this.state.running = !options.stopOnEntry;
    this.emit();

    if (options.stopOnEntry) {
      // No `stopped` event will arrive for adapters that honour stopOnEntry in
      // the launch request itself, so park the UI explicitly.
      this.state.running = false;
      this.state.stoppedReason = 'entry';
      this.emit();
    }
  }

  // -- execution control --------------------------------------------------

  /**
   * Thread the next control request applies to.
   *
   * DAP threads execution commands per thread; the runtimes the IDE launches
   * today are single-threaded, so this is the id reported by the last `stopped`
   * event, defaulting to 1.
   */
  private threadId(): number {
    return this.thread;
  }

  resume(): Promise<any> {
    return this.send('continue', { threadId: this.threadId() });
  }

  stepOver(): Promise<any> {
    return this.send('next', { threadId: this.threadId() });
  }

  stepInto(): Promise<any> {
    return this.send('stepIn', { threadId: this.threadId() });
  }

  stepOut(): Promise<any> {
    return this.send('stepOut', { threadId: this.threadId() });
  }

  pause(): Promise<any> {
    return this.send('pause', { threadId: this.threadId() });
  }

  // -- inspection ---------------------------------------------------------

  /** Fetch scopes for a frame and resolve one level of variables for each. */
  async refreshVariables(frameId?: number): Promise<void> {
    if (frameId === undefined) return;
    try {
      const response = await this.send('scopes', { frameId });
      const scopes: DapScope[] = (response.scopes ?? []).map((s: any) => ({
        name: s.name,
        variablesReference: s.variablesReference,
        expensive: !!s.expensive,
      }));

      this.scopesByRef.clear();
      for (const scope of scopes) this.scopesByRef.set(scope.variablesReference, scope.name);

      const collected: ScopeVariables = {};
      for (const scope of scopes) {
        if (scope.expensive) continue;
        const vars = await this.send('variables', {
          variablesReference: scope.variablesReference,
        });
        collected[scope.name] = (vars.variables ?? []).map((v: any) => ({
          name: v.name,
          value: v.value,
          type: v.type ?? '',
          variablesReference: v.variablesReference ?? 0,
        }));
      }
      this.onVariables(scopes, collected);
    } catch (e) {
      this.onConsole(`Could not read variables: ${(e as Error).message}`, true);
    }
  }

  /** Expand a lazy object/array variable (the `…` entries in the tree). */
  async expandVariable(reference: number): Promise<DapVariable[]> {
    const response = await this.send('variables', { variablesReference: reference });
    return (response.variables ?? []).map((v: any) => ({
      name: v.name,
      value: v.value,
      type: v.type ?? '',
      variablesReference: v.variablesReference ?? 0,
    }));
  }

  /** Evaluate an expression in the debug console's scope. */
  async evaluate(expression: string, frameId?: number): Promise<string> {
    const response = await this.send('evaluate', {
      expression,
      context: 'repl',
      ...(frameId !== undefined ? { frameId } : {}),
    });
    if (response.exceptionDetails) {
      return `Error: ${response.result?.description ?? response.exceptionDetails.text ?? 'failed'}`;
    }
    return response.result?.description ?? response.result?.value ?? '';
  }

  /** Selected stack frame, or the top frame when nothing is picked. */
  selectedFrame(): DapStackFrame | undefined {
    return this.state.frames[0];
  }

  async dispose(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    this.unlisten?.();
    this.unlisten = null;
    // Reject anything still in flight so callers never hang on a dead adapter.
    for (const [, pending] of this.pending) pending.reject(new Error('Debug session ended'));
    this.pending.clear();
    await invoke('dap_stop', { session: this.session }).catch(() => {});
  }
}
