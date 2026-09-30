/**
 * Debug adapter. A thin Chrome DevTools Protocol (CDP) WebSocket client that
 * connects to a Node inspector (launched via `node_inspect`) or any debugger
 * exposing a CDP endpoint. Supports breakpoints, stepping, stack traces and a
 * basic REPL evaluate.
 */

export interface Breakpoint {
  id: string;
  line: number; // 0-based
  enabled: boolean;
}

export interface CallFrame {
  callFrameId: string;
  functionName: string;
  url: string;
  line: number; // 0-based
  column: number;
  scopeRefs: string[];
  locals: { name: string; value: string }[];
}

export interface DebugState {
  connected: boolean;
  running: boolean; // false => paused
  breakpoints: Breakpoint[];
  pauseReason: string;
  current: { url: string; line: number } | null;
  topFrame: CallFrame | null;
}

type PendingResolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class DebugController {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private scripts = new Map<string, { url: string; lineOffset: number }>();

  state: DebugState = {
    connected: false,
    running: false,
    breakpoints: [],
    pauseReason: '',
    current: null,
    topFrame: null,
  };

  onState: (s: DebugState) => void = () => {};
  onConsole: (text: string) => void = () => {};
  onStopped: (frames: CallFrame[]) => void = () => {};

  /** Connect to an already-running CDP endpoint (e.g. a node inspector). */
  connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => {
        this.state.connected = true;
        this.state.running = true;
        this.emit();
        this.sendRaw('Debugger.enable', {});
        this.sendRaw('Runtime.enable', {});
        resolve();
      };
      ws.onerror = () => reject(new Error('Failed to connect to debugger.'));
      ws.onmessage = (e) => this.onMessage(e.data as string);
      ws.onclose = () => {
        this.state.connected = false;
        this.state.running = false;
        this.emit();
      };
    });
  }

  private emit() {
    this.onState({ ...this.state, breakpoints: [...this.state.breakpoints] });
  }

  private sendRaw(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws?.send(msg);
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
      else p.resolve(msg.result);
      return;
    }
    const method: string | undefined = msg.method;
    const params = msg.params ?? {};
    switch (method) {
      case 'Debugger.scriptParsed': {
        this.scripts.set(params.scriptId, {
          url: params.url ?? '',
          lineOffset: params.startLine ?? 0,
        });
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const args: any[] = params.args ?? [];
        const text = args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.onConsole(text);
        break;
      }
      case 'Debugger.paused': {
        this.handlePaused(params);
        break;
      }
      case 'Debugger.resumed': {
        this.state.running = true;
        this.state.pauseReason = '';
        this.state.current = null;
        this.emit();
        break;
      }
    }
  }

  private handlePaused(params: any) {
    this.state.running = false;
    this.state.pauseReason = params.reason ?? 'other';
    const frames: CallFrame[] = [];
    for (const f of params.callFrames ?? []) {
      frames.push({
        callFrameId: f.callFrameId,
        functionName: f.functionName ?? '(anonymous)',
        url: f.url ?? this.scripts.get(f.location?.scriptId)?.url ?? '',
        line: (f.location?.lineNumber ?? 0) + (this.scripts.get(f.location?.scriptId)?.lineOffset ?? 0),
        column: f.location?.columnNumber ?? 0,
        scopeRefs: (f.scopeChain ?? []).map((s: any) => s.type),
        locals: [],
      });
    }
    this.state.current = frames[0]
      ? { url: frames[0].url, line: frames[0].line }
      : null;
    this.state.topFrame = frames[0] ?? null;
    this.emit();
    this.onStopped(frames);
  }

  /** Set (or update) a breakpoint on a URL+line; the inspector resolves the script. */
  async setBreakpoint(url: string, line0: number): Promise<boolean> {
    const result: any = await this.sendRaw('Debugger.setBreakpointByUrl', {
      lineNumber: line0,
      url,
    });
    const loc = result?.locations?.[0];
    if (loc) {
      this.state.breakpoints.push({ id: loc.breakpointId, line: loc.lineNumber, enabled: true });
      const seen = new Map<number, number>();
      this.state.breakpoints = this.state.breakpoints.filter((b) => {
        const k = b.line;
        if (seen.has(k)) return false;
        seen.set(k, 1);
        return true;
      });
      this.emit();
      return true;
    }
    return false;
  }

  async removeBreakpoint(id: string) {
    this.state.breakpoints = this.state.breakpoints.filter((b) => b.id !== id);
    this.emit();
    await this.sendRaw('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
  }

  async resume() {
    await this.sendRaw('Debugger.resume', {});
  }

  async stepOver() {
    await this.sendRaw('Debugger.stepOver', {});
  }

  async stepInto() {
    await this.sendRaw('Debugger.stepInto', {});
  }

  async stepOut() {
    await this.sendRaw('Debugger.stepOut', {});
  }

  async pause() {
    await this.sendRaw('Debugger.pause', {});
  }

  /** Evaluate an expression in a call frame's scope and return a string. */
  async evaluate(expression: string, callFrameId?: string): Promise<string> {
    const result: any = await this.sendRaw('Runtime.evaluate', {
      expression,
      ...(callFrameId ? { callFrameId } : {}),
      returnByValue: true,
    });
    const r = result?.result;
    if (r?.exceptionDetails) return `Error: ${r.exceptionDetails.text ?? ''}`;
    if (r?.value !== undefined) return String(r.value);
    if (r?.description) return r.description;
    return JSON.stringify(r ?? '');
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

export const debugController = new DebugController();