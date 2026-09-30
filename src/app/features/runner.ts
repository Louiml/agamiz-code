/**
 * Process execution services. Thin, typed wrappers around the backend command
 * tunnel (`src-tauri/src/lib.rs`):
 *   - `execResult`       runs a non-interactive command and returns its output.
 *   - `spawnProcess`     starts a long-running process that streams stdout/stderr
 *                        events (`proc-output`) and accepts stdin writes.
 *   - `stopAllProcesses` kills every tracked process.
 *   - `startNodeInspect` boots a Node process under the inspector and returns
 *                        its CDP WebSocket URL for the debugger.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SpawnHandle {
  pid: number;
  /** unsubscribe the output listener */
  dispose: () => void;
  write: (data: string) => Promise<void>;
  stop: () => Promise<void>;
}

export interface ProcessOutput {
  processId: number;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface InspectResult {
  pid: number;
  /** ws:// CDP inspector URL */
  wsUrl: string;
  started: boolean;
}

export async function execResult(cmd: string, args: string[], cwd?: string): Promise<ExecResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  // The backend `exec_result` receives the full argv (args[0] = program).
  const result = (await invoke('exec_result', { args: [cmd, ...args], cwd: cwd ?? '' })) as ExecResult;
  return result;
}

/** Monotonic id for correlating spawned-process output events. */
let procSeq = 1;
const nextProcId = () => procSeq++;

export async function spawnProcess(
  program: string,
  args: string[],
  cwd: string,
  onOutput: (line: ProcessOutput) => void,
): Promise<SpawnHandle> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  // The backend `spawn_program` is id-keyed so output events can be
  // correlated; it returns the same id back as the "pid".
  const id = nextProcId();
  const pid = (await invoke('spawn_program', { id, program, args, cwd })) as number;
  const un = await listen<{ id: number; stream: string; text: string }>('proc-output', (e) => {
    if (e.payload.id !== pid) return;
    onOutput({
      processId: pid,
      stream: e.payload.stream === 'stderr' ? 'stderr' : 'stdout',
      data: e.payload.text,
    });
  });
  const write = async (data: string): Promise<void> => {
    await invoke('proc_write', { id: pid, input: data });
  };
  // The backend `proc_stop` kills every tracked process (it takes no args);
  // keep the id only for output correlation.
  const stop = () => invoke('proc_stop').then(() => un());
  return { pid, write, stop, dispose: un };
}

export async function stopAllProcesses(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('proc_stop').catch(() => {});
}

/**
 * Start a Node program under `--inspect-brk` and grab its CDP WebSocket URL.
 * The backend listens for the `ws://` URL on stderr and returns it once the
 * inspector is up. (Extra program args are accepted for API compatibility but
 * the backend launches `node --inspect-brk=<port> <script>` directly.)
 */
export async function startNodeInspect(
  file: string,
  args: string[],
  cwd: string,
  breakOnStart = true,
): Promise<InspectResult> {
  void args;
  const { invoke } = await import('@tauri-apps/api/core');
  const id = nextProcId();
  // Spread debugger ports over a small range to avoid collisions between
  // concurrent instances/windows.
  const port = 9229 + (Date.now() % 400);
  const wsUrl = (await invoke('node_inspect', { id, script: file, cwd, port })) as string;
  return { pid: id, wsUrl, started: breakOnStart };
}

/** URL decoding helper for inspector ports split from the ws URL. */
export interface NodeInspectorInfo {
  wsUrl: string;
  host: string;
  port: number;
}

export function parseInspectorWs(wsUrl: string): NodeInspectorInfo | null {
  const m = wsUrl.match(/^ws:\/\/([^:]+):(\d+)\//);
  if (!m) return null;
  return { wsUrl, host: m[1], port: Number(m[2]) };
}