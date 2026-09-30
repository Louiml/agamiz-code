/**
 * Interpreter Resolver (frontend half).
 *
 * Owns everything the UI needs to answer "which runtime will run this file?"
 * and "what did the user pin to that answer?":
 *
 *   - `detectInterpreters` caches a machine scan for a short window. The scan
 *     is not free (it probes `--version` for every tool plus a WSL round-trip),
 *     so it is memoised per workspace and only refreshed on demand.
 *   - `.agamiz/settings.json` holds the *user's* choices: per-workspace
 *     interpreter pins and run/task configuration. Settings live in the repo so
 *     a team shares toolchains; anything that is not checked in falls back to
 *     localStorage, which keeps preferences working outside a workspace.
 */

import { isTauri } from '../lib/tauri';

/** One discovered toolchain, mirroring `src-tauri/src/interpreter.rs`. */
export interface InterpreterInfo {
  /** Stable id. Env ids are namespaced: `venv:C:\p\.venv`, `custom:…`, `python`. */
  id: string;
  /** Display label, e.g. `Python 3.12.1 (.venv)`. */
  label: string;
  /** Bare version string, or `unknown`. */
  version: string;
  /** Absolute executable path, or a command line for WSL entries. */
  path: string;
  kind: 'interpreter' | 'compiler' | 'runtime' | 'shell';
  /** Where it came from — drives both grouping and the badge suffix. */
  source: 'path' | 'venv' | 'conda' | 'wsl' | 'manual';
  /** Language ids this tool can run or compile. */
  languages: string[];
}

/** Shape of `.agamiz/settings.json`. All fields optional. */
export interface WorkspaceSettings {
  /** Tool id → absolute executable path pinned by the user. */
  interpreters?: Record<string, string>;
  /** Language id → tool id preferred when several tools can run it. */
  defaultTool?: Record<string, string>;
  /** Debug adapter id per language, e.g. `{ python: 'debugpy' }`. */
  debugAdapter?: Record<string, string>;
  /** Extra args appended to every run of a language. */
  runArgs?: Record<string, string[]>;
  /** Ad-hoc command for file types with no built-in runner. */
  tasks?: Record<string, { program: string; args?: string[] }>;
}

const SETTINGS_FILE = '.agamiz/settings.json';
const GLOBAL_KEY = 'agamiz.code.workspaceSettings';
/** Machine scans are expensive; hold the result briefly so re-opening the
 *  picker does not re-probe every toolchain. */
const SCAN_TTL_MS = 30_000;

let cache: { cwd: string; at: number; items: InterpreterInfo[] } | null = null;

async function invokeSafe<T>(command: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  if (!isTauri()) return fallback;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args).catch((e) => {
    console.error(`[interpreter] ${command} failed:`, e);
    return fallback;
  });
}

/** Scan the machine for interpreters, compilers and runtimes. */
export async function detectInterpreters(cwd: string, force = false): Promise<InterpreterInfo[]> {
  if (!force && cache && cache.cwd === cwd && Date.now() - cache.at < SCAN_TTL_MS) {
    return cache.items;
  }
  const items = await invokeSafe<InterpreterInfo[]>('detect_interpreters', { cwd }, []);
  cache = { cwd, at: Date.now(), items };
  return items;
}

/** Invalidate the scan cache (after the user pins a new toolchain). */
export function invalidateScan(): void {
  cache = null;
}

/** Validate a user-typed or browsed executable path before committing to it. */
export async function probeInterpreter(path: string): Promise<InterpreterInfo> {
  if (!isTauri()) throw new Error('Interpreter probing requires the desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<InterpreterInfo>('probe_interpreter', { path });
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function readLocal(): WorkspaceSettings {
  if (typeof localStorage === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(GLOBAL_KEY) ?? '{}') as WorkspaceSettings;
  } catch {
    return {};
  }
}

function writeLocal(value: WorkspaceSettings) {
  try {
    localStorage.setItem(GLOBAL_KEY, JSON.stringify(value));
  } catch {
    /* storage disabled; workspace file remains the source of truth */
  }
}

/** Load `.agamiz/settings.json`, falling back to localStorage. */
export async function loadWorkspaceSettings(cwd: string): Promise<WorkspaceSettings> {
  const local = readLocal();
  if (!cwd || !isTauri()) return local;
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const raw = (await invoke<string>('read_file', { path: joinPath(cwd, SETTINGS_FILE) })) as string;
    const parsed = JSON.parse(raw) as WorkspaceSettings;
    // Workspace file wins, but local-only keys (an unsaved workspace choice)
    // are merged underneath so nothing silently disappears.
    return { ...local, ...parsed };
  } catch {
    return local;
  }
}

/** Persist settings to `.agamiz/settings.json` (creating the folder) and mirror
 *  to localStorage so the choice survives before the file is committed. */
export async function saveWorkspaceSettings(cwd: string, value: WorkspaceSettings): Promise<boolean> {
  writeLocal(value);
  if (!cwd || !isTauri()) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const folder = cwd + (/[\\/]/.test(cwd) ? '\\.agamiz' : '/.agamiz');
    try {
      await invoke('create_dir', { path: folder });
    } catch {
      /* already exists */
    }
    const path = cwd + (/[\\/]/.test(cwd) ? `\\${SETTINGS_FILE.split('/').join('\\')}` : `/${SETTINGS_FILE}`);
    await invoke('save_file', { path, content: JSON.stringify(value, null, 2) });
    return true;
  } catch (e) {
    console.error('[interpreter] saveWorkspaceSettings failed:', e);
    return false;
  }
}

function joinPath(cwd: string, rel: string) {
  return cwd + (/[\\/]/.test(cwd) ? `\\${rel.replace(/\//g, '\\')}` : `/${rel}`);
}

/** Patch settings and persist, returning the merged result. */
export async function updateSettings(
  cwd: string,
  patch: Partial<WorkspaceSettings>,
): Promise<WorkspaceSettings> {
  const current = await loadWorkspaceSettings(cwd);
  const next: WorkspaceSettings = { ...current, ...patch };
  await saveWorkspaceSettings(cwd, next);
  return next;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Languages a language id implies, so `tsx` still finds the `typescript` pin. */
function equivalentLanguages(language: string): string[] {
  if (language === 'typescriptreact') return ['typescriptreact', 'typescript', 'javascript'];
  if (language === 'javascriptreact') return ['javascriptreact', 'javascript'];
  return [language];
}

/** The tool spec a language needs, when there is only one sensible choice. */
export function canonicalToolFor(language: string): string | null {
  switch (language) {
    case 'python':
      return 'python';
    case 'javascript':
    case 'javascriptreact':
      return 'node';
    case 'typescript':
    case 'typescriptreact':
      return 'node';
    case 'c':
      return 'gcc';
    case 'cpp':
      return 'g++';
    case 'go':
      return 'go';
    case 'rust':
      return 'cargo';
    case 'java':
      return 'javac';
    case 'shellscript':
      return 'bash';
    case 'powershell':
      return 'pwsh';
    case 'php':
      return 'php';
    case 'ruby':
      return 'ruby';
    default:
      return null;
  }
}

/** Build the `tools` map the backend executor expects from the pinned paths. */
export function toolOverrides(settings: WorkspaceSettings): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [tool, path] of Object.entries(settings.interpreters ?? {})) {
    if (path) map[tool] = path;
  }
  // A per-language default that is not itself pinned still has to reach the
  // executor, otherwise "use the workspace venv" would be ignored.
  for (const [language, tool] of Object.entries(settings.defaultTool ?? {})) {
    const canonical = canonicalToolFor(language);
    if (canonical && !map[canonical] && settings.interpreters?.[tool]) {
      map[canonical] = settings.interpreters[tool];
    }
  }
  return map;
}

/**
 * Resolve which interpreter runs `language`.
 *
 * Preference order, matching what the picker shows first:
 *   1. an explicit per-language default the user pinned,
 *   2. an explicit pin for the canonical tool of that language,
 *   3. a workspace/Conda virtualenv (only for Python),
 *   4. whatever the PATH scan found.
 */
export function resolveInterpreter(
  language: string,
  detected: InterpreterInfo[],
  settings: WorkspaceSettings,
): InterpreterInfo | null {
  if (!language || language === 'plaintext') return null;

  const candidates = equivalentLanguages(language);
  const serves = (item: InterpreterInfo) => item.languages.some((l) => candidates.includes(l));
  const byId = (id: string | undefined) => (id ? (detected.find((d) => d.id === id) ?? null) : null);

  const pinned = settings.defaultTool?.[language];
  const canonical = canonicalToolFor(language);
  const explicit = byId(pinned ?? undefined) ?? byId(canonical ?? undefined);
  if (explicit) return explicit;

  if (language === 'python') {
    // A workspace venv is what the user actually installed into, so it wins
    // over the system Python even though the PATH hit is listed first.
    const venv = detected.find((d) => serves(d) && (d.source === 'venv' || d.source === 'conda'));
    if (venv) return venv;
  }

  const fallback = detected.find(serves);
  if (fallback) return fallback;

  // Nothing detected: synthesise an entry for the canonical tool so the status
  // bar can still say "Python 3.x — not installed" instead of going blank.
  const canonicalEntry = canonical
    ? detected.find((d) => d.id === canonical)
    : undefined;
  return canonicalEntry ?? null;
}

/** Short badge text for the status bar, e.g. `Python 3.12.1 (.venv)`. */
export function badgeFor(item: InterpreterInfo | null): string {
  if (!item) return 'No interpreter';
  if (item.source === 'venv' || item.source === 'conda') return item.label;
  return item.label;
}

/** Extra arguments configured for a language. */
export function argsFor(language: string, settings: WorkspaceSettings): string[] {
  return settings.runArgs?.[language] ?? [];
}

/** Custom task command registered for a file extension, if any. */
export function taskFor(
  file: string,
  settings: WorkspaceSettings,
): { program: string; args: string[] } | null {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  const entry = settings.tasks?.[ext];
  return entry?.program ? { program: entry.program, args: entry.args ?? [] } : null;
}

/** Group detected tools the way the picker renders them. */
export function groupInterpreters(items: InterpreterInfo[]): {
  key: InterpreterInfo['source'];
  label: string;
  items: InterpreterInfo[];
}[] {
  const order: InterpreterInfo['source'][] = ['venv', 'conda', 'manual', 'path', 'wsl'];
  const titles: Record<InterpreterInfo['source'], string> = {
    venv: 'Workspace environments',
    conda: 'Conda environments',
    manual: 'Custom',
    path: 'System (PATH)',
    wsl: 'WSL',
  };
  return order
    .map((source) => ({
      key: source,
      label: titles[source],
      items: items.filter((i) => i.source === source),
    }))
    .filter((group) => group.items.length > 0);
}
