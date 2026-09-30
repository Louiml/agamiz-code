/**
 * In-IDE AI agent runtime.
 *
 * Turns the chat transport (`ai.ts`) into an autonomous agent loop that can
 * read and edit the workspace: read/list/search files, write / create /
 * rename / delete files, run shell commands, sample long-running programs,
 * inspect git state and IDE diagnostics, and open files in the editor.
 *
 * Protocol: the model replies with one or more fenced tool blocks per step.
 * Both shapes are accepted (the fence tag is either `tool` or the tool name):
 *   ```tool { "tool": "write_file", "args": { "path": "src/a.ts" } }```
 *   ```write_file { "path": "src/a.ts", "content": "..." }```
 * Blocks are brace-scanned (string-aware) so JSON containing backticks or
 * newlines is extracted safely. They execute in order (with approval gating
 * for mutating tools, plus an interactive `ask_user` tool that pauses for
 * the user's answer), and every result is fed back for the next round until
 * the model replies without a tool block, the step budget is exhausted, or
 * the run is stopped by the user.
 */

import type { AiProviderConfig, ChatMessage, TokenUsage } from './ai';
import { requestText } from './ai';
import { execResult, spawnProcess, stopAllProcesses } from './runner';
import { diagnosticStore } from './diag';

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Line-level change summary attached to file-writing tool results. */
export interface ToolDiff {
  /** (Sample of the) new lines added by the change. */
  added: string[];
  /** (Sample of the) old lines removed by the change. */
  removed: string[];
  /** Full counts, even when the samples above are truncated. */
  addedCount: number;
  removedCount: number;
}

export type AgentEvent =
  | { type: 'assistant-text'; text: string }
  | { type: 'tool-start'; id: string; call: ToolCall }
  | { type: 'tool-end'; id: string; call: ToolCall; ok: boolean; denied?: boolean; output: string; label?: string; diff?: ToolDiff }
  | { type: 'step'; step: number; maxSteps: number };

export interface AgentContext {
  cwd: string;
  activeFile?: string | null;
  activeFileContent?: string;
}

/** Agent operating mode: 'plan' = read-only investigation & planning; 'build' = full execution. */
export type AgentMode = 'build' | 'plan';

export interface AgentHooks {
  onEvent: (e: AgentEvent) => void;
  /** Resolve with true to allow, false to deny. `id` matches the ToolCall id. */
  requestApproval: (call: ToolCall, id: string) => Promise<boolean>;
  /** Called after the agent modified a file on disk (write/create/delete/rename). */
  onFileChanged?: (path: string) => void;
  /** Called when the agent asks to open a file in an editor tab. */
  onOpenFile?: (path: string) => void;
  /**
   * Resolve with the user's answer to an `ask_user` question (`id` matches
   * the ToolCall id). Without this hook the ask_user tool reports an error.
   */
  requestUserInput?: (call: ToolCall, id: string) => Promise<string>;
  /** Called after every model request with the provider-reported token usage. */
  onUsage?: (usage: TokenUsage) => void;
}

export interface AgentOptions {
  maxSteps?: number;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  /** 'plan' blocks mutating tools (read-only investigation); default 'build'. */
  mode?: AgentMode;
}

export interface AgentRunResult {
  text: string;
  steps: number;
  messages: ChatMessage[];
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface DiagEntry {
  line: number;
  severity: string;
  message: string;
  source: string;
}

/** Tools that mutate the workspace or execute programs — require approval.
 *  (ask_user is deliberately NOT here: it only pauses for user input.) */
const WRITE_TOOLS = new Set([
  'write_file', 'create_file', 'create_dir', 'rename_file', 'delete_file',
  'run_command', 'run_program', 'stop_processes',
]);

/** Fence tags the parser accepts for tool blocks: `tool` plus every tool name. */
const TOOL_NAMES = new Set([
  'tool', 'ask_user', 'list_dir', 'read_file', 'search_workspace', 'git_status',
  'read_diagnostics', 'open_file', 'write_file', 'create_file', 'create_dir',
  'rename_file', 'delete_file', 'run_command', 'run_program', 'stop_processes',
]);

const MAX_MODEL_OUTPUT = 8000; // chars fed back to the model per tool result
const MAX_UI_OUTPUT = 4000; // chars shown in the tool card
const MAX_FILE_CHARS = 12000; // chars per read_file result
const SEARCH_MAX_FILES = 400;
const SEARCH_MAX_MATCHES = 40;
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|pdf|zip|exe|dll|bin|lock)$/i;

let callSeq = 1;
const nextCallId = () => `t${callSeq++}`;

const truncate = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}\n…(truncated, ${s.length} chars total)` : s;

/**
 * Resolve a (possibly workspace-relative) path against the workspace root.
 *
 * Throws [`PathEscapeError`] when the result lands outside the root. The old
 * implementation passed absolute paths through untouched and joined relative
 * ones with a bare `replace(/^[\\/]+/, '')`, so `../../../.ssh/authorized_keys`
 * reached the attacker's target instead of being refused, and `delete_file` on
 * an absolute path was worse still.
 *
 * Throwing is deliberate: `runAgent` turns a throw into an `error:` tool result
 * that is fed back to the model, so it learns the path was refused and can
 * adapt. Returning a clamped path instead would look like a silent success.
 *
 * The backend enforces the same rule with `confine()`, which canonicalizes —
 * so a symlink inside the workspace cannot be used to escape either. This layer
 * exists to reject the obvious cases before an IPC round-trip and to give a
 * readable reason in the tool card.
 */
import { PathEscapeError, resolveWithin } from './paths';

export { PathEscapeError };

export function resolvePath(cwd: string, p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  return resolveWithin(cwd, p);
}

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

// ---------------------------------------------------------------------------
// Tool-call parsing
// ---------------------------------------------------------------------------

/**
 * Extract tool-call fenced blocks. Two shapes are accepted, and a reply may
 * contain several blocks that are executed in order:
 *   ```tool { "tool": "read_file", "args": { ... } } ```   (generic form)
 *   ```read_file { "path": "src/lib.ts" } ```              (per-tool form)
 * The JSON body is found with a string-aware brace scanner so content that
 * embeds backticks or newlines is extracted safely. Unrelated markdown code
 * fences (```js, ```rust, ...) are skipped, never parsed as tools — except
 * that tool blocks nested inside a wrapper fence (weak models sometimes wrap
 * the whole reply in ```markdown) are still recovered, and tool fences with
 * missing or broken JSON surface as malformed calls so the model is corrected
 * instead of the run silently ending on a fabricated summary.
 */
export function parseToolBlocks(text: string): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const cleaned: string[] = [];
  let cursor = 0;

  for (;;) {
    const open = text.indexOf('```', cursor);
    if (open < 0) break;

    // Read the info string on the fence-open line.
    let lineEnd = text.indexOf('\n', open);
    if (lineEnd < 0) lineEnd = text.length;
    const info = text.slice(open + 3, lineEnd).trim().toLowerCase();
    // Models emit single-line fences like ```create_file { ... }``` — the
    // trailing fence marks belong to the body, not the tag.
    const base = info.replace(/`+$/, '').split(/[\s:{}]+/)[0];

    if (!TOOL_NAMES.has(base)) {
      // A plain markdown fence (```js, ```rust, ...). If the next fence line
      // opens a tool block, this fence is a wrapper around it — step over
      // just the wrapper's opening line and keep scanning the interior.
      const close = text.indexOf('```', lineEnd + 1);
      if (close >= 0) {
        const closeLineEnd = text.indexOf('\n', close);
        const innerTag = text
          .slice(close + 3, closeLineEnd < 0 ? text.length : closeLineEnd)
          .trim()
          .toLowerCase()
          .replace(/`+$/, '')
          .split(/[\s:{}]+/)[0];
        if (TOOL_NAMES.has(innerTag)) {
          cleaned.push(text.slice(cursor, open)); // prose before the wrapper
          cursor = lineEnd + 1; // drop the wrapper's opener line
          continue;
        }
      } else if (TOOL_FENCE_TAG.test(text.slice(lineEnd + 1))) {
        // Unclosed wrapper with a tool block somewhere after it.
        cleaned.push(text.slice(cursor, open));
        cursor = lineEnd + 1;
        continue;
      }
      if (close < 0 && !base) {
        // Dangling bare fence marker (often a wrapper's last fence line) —
        // drop it and let the remaining text flow as prose.
        cleaned.push(text.slice(cursor, open));
        cursor = lineEnd + 1;
        continue;
      }
      // No tool block inside — keep the fence as prose and skip past it so
      // braces inside examples never confuse the scanner.
      const stop = close < 0 ? text.length : close + 3;
      cleaned.push(text.slice(cursor, stop));
      cursor = stop;
      continue;
    }

    cleaned.push(text.slice(cursor, open));

    // Body of this block: everything up to its closing fence (or EOF when the
    // model forgot to close the fence).
    const fenceClose = text.indexOf('```', open + 3);
    const bodyEnd = fenceClose < 0 ? text.length : fenceClose;
    const objStart = text.indexOf('{', open + 3);
    if (objStart < 0 || objStart >= bodyEnd) {
      // Tool fence with no JSON object inside (e.g. "```create_file```") —
      // surface it as a malformed call so the model gets corrective feedback
      // instead of the block being silently ignored.
      const raw = text.slice(lineEnd + 1, bodyEnd).trim() || base;
      calls.push({ id: nextCallId(), tool: 'invalid', args: { _raw: raw } });
      cursor = fenceClose < 0 ? text.length : fenceClose + 3;
      continue;
    }

    // Scan the first balanced JSON object (string/escape aware). The scan is
    // deliberately NOT bounded by the closing fence: JSON content may embed
    // ``` sequences (code samples), and the string-aware scanner skips them.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = objStart; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j + 1; break; }
      }
    }
    if (end < 0) {
      // Unbalanced / truncated JSON — treat as a malformed call.
      calls.push({
        id: nextCallId(),
        tool: 'invalid',
        args: { _raw: text.slice(objStart, bodyEnd).trim() || base },
      });
      cursor = fenceClose < 0 ? text.length : fenceClose + 3;
      continue;
    }

    const json = text.slice(objStart, end);
    let after = end;
    if (text.slice(after, after + 3) === '```') after += 3;
    // Swallow one trailing newline so consecutive blocks stay tight.
    if (text[after] === '\r') after++;
    if (text[after] === '\n') after++;
    cursor = after;

    calls.push(normalizeCallSpec(json, base));
  }
  cleaned.push(text.slice(cursor));
  return { text: cleaned.join('').replace(/\n{3,}/g, '\n\n').trim(), calls };
}

function normalizeCallSpec(json: string, fenceTool?: string): ToolCall {
  const id = nextCallId();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { id, tool: 'invalid', args: { _raw: json } };
  }
  if (parsed && typeof parsed.tool === 'string') {
    return { id, tool: parsed.tool, args: (parsed.args ?? {}) as Record<string, unknown> };
  }
  // Per-tool fence (```create_file { "path": ... }```): the object IS the args.
  if (fenceTool && fenceTool !== 'tool' && parsed) {
    return { id, tool: fenceTool, args: parsed };
  }
  // Legacy chat-mode specs: { cmd: [...] } / { file: "..." }
  if (Array.isArray(parsed?.cmd)) {
    return { id, tool: 'run_command', args: { args: parsed.cmd, cwd: parsed.cwd ?? '' } };
  }
  if (typeof parsed?.file === 'string') {
    return { id, tool: 'read_file', args: { path: parsed.file } };
  }
  return { id, tool: 'invalid', args: { _raw: json } };
}

/** A fence-open tag that starts a tool block (```tool, ```create_file, ...). */
const TOOL_FENCE_TAG = new RegExp(
  '```[ \\t]*(?:' + [...TOOL_NAMES].join('|') + ')\\b',
);

/** A complete, correct tool call the model is shown when it gets the format wrong. */
const TOOL_EXAMPLE =
  '```create_file { "path": "cpp/hello_world.cpp", "content": "#include <iostream>\\n\\nint main() {\\n    std::cout << \\"Hello, World!\\" << std::endl;\\n    return 0;\\n}\\n" }```';

const MALFORMED_HINT =
  'Your tool block could not be parsed. Emit each tool call as ONE fenced line, exactly like:\n' +
  TOOL_EXAMPLE +
  '\nThe JSON must stay on one line: escape newlines inside strings as \\n (never raw line breaks) and close the fence with ``` right after the }. ' +
  'The per-tool form also works: ```run_command { "args": ["dir"] }``` (tool name as the fence tag, the object is the args).';

const NO_BLOCK_HINT =
  'No valid tool block was found in your reply — tool names written as plain text are NOT executed, and a reply wrapped in a ```markdown fence is treated as text, not as tools.\n' +
  'Emit REAL tool blocks now, one per action, exactly like:\n' +
  TOOL_EXAMPLE +
  '\nIf the task is already complete, reply with the single word DONE.';

/** Tool names the model listed as bare text lines (a common weak-model failure). */
export function narratedToolNames(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    const t = line
      .trim()
      .replace(/^[`>*\-•\s]+/, '')
      .replace(/[`:,\s]+$/, '')
      .trim();
    if (TOOL_NAMES.has(t)) found.add(t);
  }
  return [...found];
}

/** Rich result of executing one tool: model text + UI presentation hints. */
interface ToolExecResult {
  output: string;
  /** Short human action line for the timeline, e.g. "Edited file src/a.ts (+12/-3)". */
  label?: string;
  /** Before/after line diff for file writes. */
  diff?: ToolDiff;
}

const DIFF_MAX_LINES = 1200; // per side; larger files skip diffing
const DIFF_STORE_MAX = 40; // diff lines kept per side for the tool card

/** Shorten an absolute workspace path to a cwd-relative display form. */
function relDisplay(cwd: string, p: string): string {
  if (!cwd) return p;
  return p.toLowerCase().startsWith(cwd.toLowerCase())
    ? p.slice(cwd.length).replace(/^[\\/]+/, '') || p
    : p;
}

/** "(+12/-3)" suffix for file-edit labels, omitted when nothing changed. */
function diffStat(diff: ToolDiff | undefined): string {
  if (!diff || (diff.addedCount === 0 && diff.removedCount === 0)) return '';
  return ` (+${diff.addedCount}/-${diff.removedCount})`;
}

/** Line-based LCS diff used for the +/- summary of file edits. */
function lineDiff(oldText: string, newText: string): ToolDiff | undefined {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) return undefined;

  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) removed.push(oldLines[i++]);
    else added.push(newLines[j++]);
  }
  while (i < n) removed.push(oldLines[i++]);
  while (j < m) added.push(newLines[j++]);
  return {
    added: added.slice(0, DIFF_STORE_MAX).map((l) => l.slice(0, 160)),
    removed: removed.slice(0, DIFF_STORE_MAX).map((l) => l.slice(0, 160)),
    addedCount: added.length,
    removedCount: removed.length,
  };
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeToolCall(
  call: ToolCall,
  ctx: AgentContext,
  hooks: AgentHooks,
): Promise<ToolExecResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  const cwd = ctx.cwd;
  const a = call.args;

  switch (call.tool) {
    case 'list_dir': {
      const target = resolvePath(cwd, a.path) || cwd || '.';
      const entries = await invoke<FileEntry[]>('list_dir', { path: target });
      const lines = entries.map((e) => `${e.is_dir ? '[dir]  ' : '[file] '}${e.name}`);
      return {
        output: `Directory ${target} (${entries.length} entries):\n${lines.join('\n') || '(empty)'}`,
        label: `Listed directory ${relDisplay(cwd, target)} (${entries.length} entries)`,
      };
    }
    case 'read_file': {
      const path = resolvePath(cwd, a.path);
      if (!path) return { output: 'error: missing "path"' };
      const content = await invoke<string>('read_file', { path });
      return {
        output: `Contents of ${path} (${content.length} chars):\n${truncate(content, MAX_FILE_CHARS)}`,
        label: `Read file ${relDisplay(cwd, path)}`,
      };
    }
    case 'search_workspace': {
      const output = await searchWorkspace(cwd, asString(a.query), asString(a.ext));
      const q = asString(a.query);
      return { output, label: `Searched workspace${q ? ` for "${q}"` : ''}` };
    }
    case 'git_status': {
      const r = await execResult('git', ['status', '--porcelain', '-b'], cwd || '.');
      return {
        output: `exit=${r.code}\n${(r.stdout + '\n' + r.stderr).trim() || '(clean)'}`,
        label: 'Checked git status',
      };
    }
    case 'read_diagnostics': {
      const path = resolvePath(cwd, a.path) || ctx.activeFile || '';
      const diags: DiagEntry[] = path ? diagnosticStore.get(path) : diagnosticStore.all();
      if (!diags.length) {
        return {
          output: path ? `No diagnostics for ${path}.` : 'No diagnostics.',
          label: 'Read IDE diagnostics',
        };
      }
      return {
        output: diags
          .map((d) => `${d.severity} L${d.line}: ${d.message} (${d.source})`)
          .join('\n'),
        label: `Read IDE diagnostics${path ? ` (${diags.length} entries)` : ''}`,
      };
    }
    case 'open_file': {
      const path = resolvePath(cwd, a.path);
      if (!path) return { output: 'error: missing "path"' };
      hooks.onOpenFile?.(path);
      return {
        output: `Opened ${path} in the editor.`,
        label: `Opened file ${relDisplay(cwd, path)}`,
      };
    }
    case 'write_file': {
      const path = resolvePath(cwd, a.path);
      if (!path) return { output: 'error: missing "path"' };
      const content = asString(a.content);
      let prev: string | null = null;
      try {
        prev = await invoke<string>('read_file', { path });
      } catch {
        prev = null; // file does not exist yet
      }
      const diff = prev === null ? undefined : lineDiff(prev, content);
      await invoke('save_file', { path, content });
      hooks.onFileChanged?.(path);
      return {
        output: `Wrote ${content.length} chars to ${path}.`,
        label: `${prev === null ? 'Created' : 'Edited'} file ${relDisplay(cwd, path)}${diffStat(diff)}`,
        diff,
      };
    }
    case 'create_file': {
      const path = resolvePath(cwd, a.path);
      if (!path) return { output: 'error: missing "path"' };
      const content = asString(a.content);
      let prev: string | null = null;
      try {
        prev = await invoke<string>('read_file', { path });
      } catch {
        prev = null; // file does not exist yet
      }
      const diff = prev === null ? undefined : lineDiff(prev, content);
      // Ensure parent directories exist so nested paths ("cpp/hello.cpp") work
      // without the model having to emit create_dir first.
      const sepAt = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
      if (sepAt > 0) {
        try {
          await invoke('create_dir', { path: path.slice(0, sepAt) });
        } catch {
          // parent may already exist; create_file below reports real errors
        }
      }
      await invoke('create_file', { path });
      if (content) await invoke('save_file', { path, content });
      hooks.onFileChanged?.(path);
      return {
        output: content
          ? `Created ${path} with ${content.length} chars.`
          : `Created empty file ${path}.`,
        label: `${prev === null ? 'Created' : 'Edited'} file ${relDisplay(cwd, path)}${
          content ? '' : ' (empty)'
        }${diffStat(diff)}`,
        diff,
      };
    }
  }
  return executeToolCallRest(call, ctx, hooks);
}

/** Second half of the tool switch (process/dir/agent-utility tools). */
async function executeToolCallRest(
  call: ToolCall,
  ctx: AgentContext,
  hooks: AgentHooks,
): Promise<ToolExecResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  const cwd = ctx.cwd;
  const a = call.args;

  switch (call.tool) {
    case 'create_dir': {
      const path = resolvePath(cwd, a.path);
      if (!path) return { output: 'error: missing "path"' };
      await invoke('create_dir', { path });
      return {
        output: `Created directory ${path}.`,
        label: `Created directory ${relDisplay(cwd, path)}`,
      };
    }
    case 'rename_file': {
      const from = resolvePath(cwd, a.from);
      const to = resolvePath(cwd, a.to);
      if (!from || !to) return { output: 'error: "from" and "to" paths required' };
      await invoke('rename_file', { old_path: from, new_path: to });
      hooks.onFileChanged?.(to);
      return {
        output: `Renamed ${from} to ${to}.`,
        label: `Renamed ${relDisplay(cwd, from)} -> ${relDisplay(cwd, to)}`,
      };
    }
    case 'delete_file': {
      const path = resolvePath(cwd, a.path);
      if (!path) return { output: 'error: missing "path"' };
      await invoke('delete_file', { path });
      hooks.onFileChanged?.(path);
      return {
        output: `Deleted ${path}.`,
        label: `Deleted file ${relDisplay(cwd, path)}`,
      };
    }
    case 'run_command': {
      const args = asStringArray(a.args);
      if (!args.length) {
        return { output: 'error: "args" must be a non-empty array, e.g. ["npm", "run", "build"]' };
      }
      const r = await execResult(args[0], args.slice(1), asString(a.cwd, cwd || '.'));
      const cmd = args.join(' ');
      return {
        output: `exit=${r.code}\n${truncate(`${r.stdout}\n${r.stderr}`.trim(), MAX_MODEL_OUTPUT)}`,
        label: `Ran command: ${cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd} (exit ${r.code})`,
      };
    }
    case 'run_program': {
      const program = asString(a.program);
      if (!program) return { output: 'error: missing "program"' };
      const lines: string[] = [];
      const handle = await spawnProcess(program, asStringArray(a.args), asString(a.cwd, cwd || '.'), (p) => {
        if (lines.length < 80) lines.push(`[${p.stream}] ${p.data}`);
      });
      // Sample the first 4 seconds of output, then stop the process so the
      // agent session never hangs on a long-running server.
      await new Promise((res) => setTimeout(res, 4000));
      await handle.stop().catch(() => {});
      return {
        output: `Program ${program} started (pid ${handle.pid}); output sample (4s):\n${
          truncate(lines.join('\n') || '(no output)', MAX_MODEL_OUTPUT)
        }\nUse stop_processes to kill spawned processes.`,
        label: `Started program ${program} (pid ${handle.pid})`,
      };
    }
    case 'stop_processes': {
      await stopAllProcesses();
      return { output: 'All spawned processes stopped.', label: 'Stopped spawned processes' };
    }
    default:
      return {
        output: `Unknown tool "${call.tool}". Use one of the tools listed in your instructions.`,
      };
  }
}

/** Substring search across workspace file names and contents. */
async function searchWorkspace(cwd: string, query: string, ext: string): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  if (!cwd) return 'error: no workspace folder open';
  if (!query) return 'error: missing "query"';
  const files = await invoke<FileEntry[]>('list_files_recursive', { path: cwd, ext: ext ?? '' });
  const q = query.toLowerCase();
  const matches: string[] = [];
  const relative = (p: string) =>
    cwd && p.toLowerCase().startsWith(cwd.toLowerCase()) ? p.slice(cwd.length).replace(/^[\\/]+/, '') : p;

  let searched = 0;
  for (const f of files) {
    if (matches.length >= SEARCH_MAX_MATCHES || searched >= SEARCH_MAX_FILES) break;
    if (SKIP_EXTENSIONS.test(f.path)) continue;
    let content = '';
    try {
      content = await invoke<string>('read_file', { path: f.path });
    } catch {
      continue; // unreadable (binary/locked) — skip
    }
    searched++;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        matches.push(`${relative(f.path) || f.name}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (matches.length >= SEARCH_MAX_MATCHES) break;
      }
    }
  }
  return `Searched ${searched} workspace files for "${query}"; ${matches.length} matches:\n${
    matches.join('\n') || '(no matches)'
  }`;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildAgentSystemPrompt(context: string, memory = '', mode: AgentMode = 'build'): string {
  const plan = mode === 'plan';
  const header = plan
    ? 'You are Agamiz Agent, an autonomous coding agent embedded in the Agamiz Code IDE — currently in PLAN MODE.\n' +
      'PLAN MODE: investigate and design only — never modify the workspace. The IDE blocks write/create/rename/delete/run tools in this mode, so do not emit them. Inspect the code with the read-only tools, then reply in Markdown with: (1) a brief analysis of the current state, (2) a numbered step-by-step implementation plan with exact file paths, changes and verification commands, and (3) one closing line telling the user to switch to Build mode to apply the plan.\n\n'
    : 'You are Agamiz Agent, an autonomous coding agent embedded in the Agamiz Code IDE.\n' +
      'You can inspect and modify the workspace: read and search files, write, create, rename or delete files, run shell commands, run programs, check git state, read IDE diagnostics, and open files in the editor.\n\n';
  const toolsDoc = plan
    ? 'READ-ONLY TOOLS (plan mode) — reply with a short Markdown analysis; when you need more information emit fenced tool blocks:\n' +
      '```read_file { "path": "src/app/page.tsx" }```\n' +
      'All blocks in one reply execute in order and you receive every result before continuing.\n\n' +
      'Available read-only tools:\n' +
      '- list_dir { "path": "sub/dir" } — list a directory (omit path for the workspace root)\n' +
      '- read_file { "path": "src/lib.ts" }\n' +
      '- search_workspace { "query": "TODO", "ext": ".ts" } — substring search of names and contents\n' +
      '- git_status {} — current branch and changed files\n' +
      '- read_diagnostics { "path": "src/lib.ts" } — IDE Problems entries (omit path for active file)\n' +
      '- open_file { "path": "src/lib.ts" } — open a file in an editor tab\n' +
      '- ask_user { "question": "Which approach do you prefer?", "options": ["A", "B"] } — pause and ask the user a question\n\n'
    : 'TOOLS — reply with a short plan in Markdown followed by one or more fenced tool blocks:\n' +
      '```tool { "tool": "read_file", "args": { "path": "src/app/page.tsx" } }```\n' +
      'or, equivalently, with the tool name as the fence tag (PREFERRED):\n' +
      '```read_file { "path": "src/app/page.tsx" }```\n' +
      'All blocks in one reply execute in order and you receive every result before continuing — batch the calls you are already sure about (e.g. create a directory, then the file, then build commands) into a single reply instead of waiting between them.\n' +
      'Multi-line file content goes in ONE JSON string with \\n escapes — never raw line breaks inside the JSON, e.g.:\n' +
      TOOL_EXAMPLE + '\n' +
      'create_file creates missing parent directories itself, so you usually do not need create_dir first.\n\n' +
      'Available tools:\n' +
      '- list_dir { "path": "sub/dir" } — list a directory (omit path for the workspace root)\n' +
      '- read_file { "path": "src/lib.ts" }\n' +
      '- search_workspace { "query": "TODO", "ext": ".ts" } — substring search of names and contents\n' +
      '- git_status {} — current branch and changed files\n' +
      '- read_diagnostics { "path": "src/lib.ts" } — IDE Problems entries (omit path for active file)\n' +
      '- open_file { "path": "src/lib.ts" } — open a file in an editor tab\n' +
      '- ask_user { "question": "Which option do you prefer?", "options": ["A", "B"] } — pause and ask the user a question; options are optional suggested answers shown as buttons\n' +
      '- write_file { "path": "src/lib.ts", "content": "FULL NEW FILE CONTENT" } — overwrite/create (asks user approval)\n' +
      '- create_file { "path": "new.ts", "content": "optional initial content" } — creates missing parent directories too (approval)\n' +
      '- create_dir { "path": "src/newdir" } (approval)\n' +
      '- rename_file { "from": "old.ts", "to": "new.ts" } (approval)\n' +
      '- delete_file { "path": "tmp.txt" } (approval)\n' +
      '- run_command { "args": ["npm", "run", "build"] } — run to completion; returns exit code, stdout, stderr (approval)\n' +
      '- run_program { "program": "node", "args": ["server.js"] } — start a long-running process and sample 4s of output (approval)\n' +
      '- stop_processes {} — kill spawned processes (approval)\n\n';
  const memoryDoc = memory
    ? 'PROJECT MEMORY — summaries of previous sessions in this workspace (most recent first). Recall earlier decisions and file locations from it; verify anything that may have changed with tools.\n' + memory + '\n\n'
    : '';
  return (
    header +
    toolsDoc +
    memoryDoc +
    'Rules:\n' +
    '1. Paths are workspace-relative unless the user gives an absolute one.\n' +
    (plan ? '' : '2. write_file REPLACES the whole file — always send the complete final content, never a diff or placeholder.\n') +
    '3. JSON strings must escape newlines as \\n; the IDE decodes them. One JSON object per block.\n' +
    '4. Never wrap your reply or a tool block inside another ```markdown fence, and never list tool names as plain text — fenced tool blocks are the only way actions are executed.\n' +
    (plan
      ? '5. Stay read-only: gather what you need, then present the final plan. Mutating tool blocks are blocked and only waste steps.\n'
      : '5. Work step by step: inspect, plan, edit, then VERIFY (run the relevant build/test command and/or read_diagnostics) and iterate until clean.\n') +
    '6. Make focused changes; do not reformat unrelated code.\n' +
    '7. If a tool is denied or fails, adapt — never repeat the same failing call.\n' +
    (plan
      ? '8. End with the complete numbered plan as Markdown (or the finished analysis when no plan is needed) and NO mutating tool block.\n'
      : '8. When the task is complete, reply with a concise Markdown summary of what changed and how to verify it, with NO tool block.\n') +
    '9. If you lack information or need a decision (library choice, confirm a destructive action, unclear requirements), use ask_user instead of guessing; never ask what you can find out yourself with tools.\n\n' +
    'CONTEXT:\n' +
    context
  );
}

/** Collect live workspace context (tree sample, active file, diagnostics). */
export async function buildAgentContext(
  cwd: string,
  activeFile: string | null,
  activeFileContent: string,
): Promise<string> {
  const parts: string[] = [];
  parts.push(
    cwd
      ? `Workspace root: ${cwd}`
      : 'Workspace root: (no folder open — file/process tools are unavailable; ask the user to open a folder)',
  );
  if (activeFile) {
    const c = activeFileContent || '';
    parts.push(`Active file: ${activeFile}`);
    parts.push(
      `Active file content (${c.length} chars${c.length > 6000 ? ', truncated' : ''}):\n${c.slice(0, 6000)}`,
    );
    const diags: DiagEntry[] = diagnosticStore.get(activeFile);
    if (diags.length) {
      parts.push(
        `IDE diagnostics for the active file:\n${diags
          .map((d) => `${d.severity} L${d.line}: ${d.message} (${d.source})`)
          .join('\n')}`,
      );
    }
  }
  if (cwd) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const entries = await invoke<FileEntry[]>('list_dir', { path: cwd });
      parts.push(
        `Top-level entries: ${entries.map((e) => `${e.is_dir ? '[dir] ' : ''}${e.name}`).join(', ')}`,
      );
    } catch {
      // ignore — context is best-effort
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function runAgent(
  cfg: AiProviderConfig,
  history: ChatMessage[],
  ctx: AgentContext,
  hooks: AgentHooks,
  options: AgentOptions = {},
): Promise<AgentRunResult> {
  const maxSteps = Math.max(1, options.maxSteps ?? 10);
  const mode: AgentMode = options.mode ?? 'build';
  const messages: ChatMessage[] = [...history];
  const stopped = () => Boolean(options.signal?.aborted) || Boolean(options.shouldStop?.());

  let lastText = '';
  let toolsUsed = 0; // tool calls executed successfully in this run
  let nudges = 0; // "emit real tool blocks" corrections sent to the model
  let malformedRounds = 0; // consecutive replies with only malformed tool blocks
  for (let step = 1; step <= maxSteps; step++) {
    if (stopped()) throw new DOMException('Agent stopped', 'AbortError');
    hooks.onEvent({ type: 'step', step, maxSteps });

    const full = await requestText(cfg, messages, options.signal, hooks.onUsage);
    const { text, calls } = parseToolBlocks(full);
    if (text) {
      lastText = text;
      hooks.onEvent({ type: 'assistant-text', text });
    }
    // Keep the raw reply (including tool JSON) in the transcript so the model
    // keeps its tool-call format across rounds.
    messages.push({ role: 'assistant', content: full.trim() || '(assistant)' });

    if (calls.some((c) => c.tool !== 'invalid')) malformedRounds = 0;
    else if (calls.length > 0) malformedRounds++;
    if (malformedRounds >= 3) {
      const giveUp =
        '(stopped: the model keeps emitting malformed tool blocks — no valid tool call could be parsed. Try a stronger model or rephrase the request.)';
      hooks.onEvent({ type: 'assistant-text', text: giveUp });
      return { text: lastText || giveUp, steps: step, messages };
    }

    if (calls.length === 0) {
      // Weak models sometimes list tool names as plain text instead of
      // emitting fenced blocks; nudge them back to the protocol instead of
      // ending the run on a fabricated "done" summary.
      if (mode === 'build' && toolsUsed === 0 && nudges < 2 && narratedToolNames(full).length > 0) {
        nudges++;
        messages.push({ role: 'user', name: 'tool', content: NO_BLOCK_HINT });
        continue;
      }
      return { text: lastText || full.trim(), steps: step, messages };
    }

    for (const call of calls) {
      if (stopped()) throw new DOMException('Agent stopped', 'AbortError');

      if (call.tool === 'invalid') {
        hooks.onEvent({
          type: 'tool-end',
          id: call.id,
          call,
          ok: false,
          output: 'Malformed tool JSON — cannot execute.',
        });
        messages.push({
          role: 'user',
          name: 'tool',
          content: MALFORMED_HINT,
        });
        continue;
      }

      if (mode === 'plan' && WRITE_TOOLS.has(call.tool)) {
        hooks.onEvent({ type: 'tool-start', id: call.id, call });
        hooks.onEvent({
          type: 'tool-end',
          id: call.id,
          call,
          ok: false,
          output: 'Blocked: Plan mode is read-only — switch to Build mode to apply changes.',
          label: `Blocked ${call.tool} (plan mode)`,
        });
        messages.push({
          role: 'user',
          name: call.tool,
          content: `TOOL RESULT (${call.tool}): blocked — plan mode is read-only. Do not emit mutating tool blocks; refine the plan with read-only tools or present the final plan.`,
        });
        continue;
      }

      if (call.tool === 'ask_user') {
        hooks.onEvent({ type: 'tool-start', id: call.id, call });
        let answer = '';
        let askOk = true;
        try {
          if (!hooks.requestUserInput) throw new Error('ask_user is unavailable in this view');
          answer = await hooks.requestUserInput(call, call.id);
        } catch (e) {
          askOk = false;
          answer = String(e);
        }
        hooks.onEvent({
          type: 'tool-end',
          id: call.id,
          call,
          ok: askOk,
          output: askOk ? `User replied: ${answer || '(no answer)'}` : `error: ${answer}`,
          label: 'Asked the user a question',
        });
        messages.push({
          role: 'user',
          name: 'ask_user',
          content: askOk
            ? `The user answered your question with: "${answer}". Use this answer; only ask again if it is unclear.`
            : `ask_user failed (${answer}). Continue with your best judgment.`,
        });
        continue;
      }

      let approved = true;
      if (WRITE_TOOLS.has(call.tool)) {
        approved = await hooks.requestApproval(call, call.id);
      }
      if (!approved) {
        hooks.onEvent({ type: 'tool-end', id: call.id, call, ok: false, denied: true, output: 'Denied by user.' });
        messages.push({
          role: 'user',
          name: call.tool,
          content: `TOOL RESULT (${call.tool}): denied by the user. Do not retry the same call; adapt your approach or ask for guidance.`,
        });
        continue;
      }

      hooks.onEvent({ type: 'tool-start', id: call.id, call });
      let result: ToolExecResult = { output: '' };
      let ok = true;
      try {
        result = await executeToolCall(call, ctx, hooks);
      } catch (e) {
        ok = false;
        result = { output: `error: ${String(e)}` };
      }
      hooks.onEvent({
        type: 'tool-end',
        id: call.id,
        call,
        ok,
        output: truncate(result.output, MAX_UI_OUTPUT),
        label: result.label,
        diff: result.diff,
      });
      if (ok) toolsUsed++;
      messages.push({
        role: 'user',
        name: call.tool,
        content: `TOOL RESULT (${call.tool}):\n${truncate(result.output, MAX_MODEL_OUTPUT)}`,
      });
    }

    messages.push({
      role: 'user',
      content: 'Continue the task using the tool results above. If the goal is achieved, reply with a summary and no tool block.',
    });
  }

  const limitText = '(stopped: step limit reached — ask me to continue if more work is needed)';
  hooks.onEvent({ type: 'assistant-text', text: limitText });
  return { text: lastText || limitText, steps: maxSteps, messages };
}

