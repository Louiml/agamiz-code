/**
 * The settings store: one reactive object, two override layers.
 *
 * Resolution order (first defined value wins)
 *   1. `DEFAULT_SETTINGS`   — compiled in, always complete
 *   2. user layer           — `~/.agamizcode/settings.json`
 *   3. workspace layer      — `<root>/.agamiz/settings.json`
 *
 * Only *differences* are persisted at each layer. That is what makes a
 * workspace override survive a change to the user defaults, and what lets
 * "Reset to Defaults" mean "drop my diff" instead of "write 60 values back".
 *
 * Why a hand-rolled store instead of `useState` in a context
 * ----------------------------------------------------------
 * The palette, editor metrics, terminal fonts and the keymap table are read
 * from places that are not React components (the global `keydown` handler, the
 * `applyTheme` bootstrap, a `useEffect` in a panel). A module-level
 * observable with `useSyncExternalStore` on the React side gives both worlds
 * the same value and keeps the "no stale closure" convention already used for
 * the shortcut handler.
 *
 * The localStorage mirror exists only so the very first paint can read a
 * complete settings object synchronously (the app statically exports, so there
 * is no server to ask). The JSON file is authoritative and reconciles over it
 * as soon as Tauri answers.
 */

import { errText, isTauri } from '../../lib/tauri';
import {
  DEFAULT_SETTINGS,
  cloneSettings,
  diffSettings,
  getByPath,
  mergeSettings,
  serializeSettings,
  stripDefaults,
  unsetByPath,
  validateSettings,
  type SettingValue,
  type Settings,
  type SettingsLayer,
} from './schema';
import { joinPath } from './workspace';

/** localStorage mirror of the user layer. */
const MIRROR_KEY = 'agamiz.code.settings';

/** Directory holding per-project overrides inside a workspace root. */
const WORKSPACE_DIR = '.agamiz';
const WORKSPACE_FILE = 'settings.json';

export type SettingsScope = 'user' | 'workspace';
export type SettingSource = 'default' | 'user' | 'workspace';

export interface SettingsState {
  /** Overrides only — never a full copy of the defaults. See `SettingsLayer`. */
  user: SettingsLayer;
  workspace: SettingsLayer;
  /** Absolute workspace root the workspace layer was loaded for. */
  workspaceRoot: string;
  /** False until the JSON file has been reconciled over the localStorage
   *  mirror. The UI stays interactive either way — it just shows a subtle
   *  "loading" hint on the JSON tab. */
  hydrated: boolean;
}

type Listener = (state: SettingsState) => void;

const state: SettingsState = {
  user: {},
  workspace: {},
  workspaceRoot: '',
  hydrated: false,
};

/**
 * Immutable snapshot handed to `useSyncExternalStore`.
 *
 * `getSnapshot` must return a *stable* reference between changes and a *new*
 * one whenever something changed — React compares snapshots with `Object.is`.
 * Returning the mutable `state` object directly would therefore make React
 * bail out of every notification and the UI would silently stop updating, so
 * the snapshot is rebuilt inside `emit()` and nowhere else.
 */
let snapshot: SettingsState = { ...state };

const listeners = new Set<Listener>();

function emit(): void {
  snapshot = { ...state };
  for (const l of listeners) l(snapshot);
}

function update(patch: Partial<SettingsState>, persist: boolean): void {
  Object.assign(state, patch);
  if (persist) persistUserLayer();
  emit();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current snapshot. Treat the result as read-only. */
export function getState(): SettingsState {
  return snapshot;
}

/** Escape hatch for tests and the "Reset to Defaults" footer action. */
export function getMutableState(): SettingsState {
  return state;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * Override layers, **highest precedence first**.
 *
 * `getValue` returns the first layer that defines the key, so the order here
 * *is* the precedence: workspace beats user beats (via the fallback) the
 * defaults. `DEFAULT_SETTINGS` is deliberately not in the list — it is
 * complete, so including it would make every lookup stop at the default and no
 * override would ever be reached.
 */
function layers(): unknown[] {
  return [state.workspace, state.user];
}

/** Fully-resolved settings: defaults with both override layers applied. */
export function getResolved(): Settings {
  return mergeSettings(mergeSettings(DEFAULT_SETTINGS, state.user), state.workspace);
}

// Re-exported so consumers that already import the store do not need a second
// import from the schema module for the one operation they perform.
export { mergeSettings };

/** Read one setting through the layer stack, then the defaults. */
export function getValue<T extends SettingValue>(key: string): T {
  for (const layer of layers()) {
    const v = getByPath(layer, key);
    if (v !== undefined) return v as T;
  }
  return getByPath(DEFAULT_SETTINGS, key) as T;
}

/**
 * Which layer actually supplies this key. Drives the "Modified in Workspace"
 * hint next to a control and decides what a reset clears.
 */
export function sourceOf(key: string): SettingSource {
  if (getByPath(state.workspace, key) !== undefined) return 'workspace';
  if (getByPath(state.user, key) !== undefined) return 'user';
  return 'default';
}

/** Dotted keys in `scope` that differ from the defaults. */
export function modifiedKeys(scope: SettingsScope): string[] {
  return diffSettings(DEFAULT_SETTINGS, scope === 'user' ? state.user : state.workspace);
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Set one key in one layer.
 *
 * Writing a value equal to the default *removes* the key from the layer
 * instead of storing it. Two reasons: the file stays small and readable, and
 * a user who toggles a setting on and then back off gets a genuinely clean
 * layer rather than a stale literal that would pin the old value forever.
 */
export function setValue(key: string, value: SettingValue, scope: SettingsScope = 'user'): void {
  const current = scope === 'user' ? state.user : state.workspace;
  const equalsDefault = JSON.stringify(getByPath(DEFAULT_SETTINGS, key)) === JSON.stringify(value);
  const alreadyThere = JSON.stringify(getByPath(current, key)) === JSON.stringify(value);
  if (alreadyThere) return;

  const next: SettingsLayer = equalsDefault ? unsetByPath(current, key) : setPathValue(current, key, value);
  if (next === current) return;

  if (scope === 'user') {
    update({ user: next }, true);
  } else {
    update({ workspace: next }, false);
    scheduleWorkspaceWrite();
  }
}

/**
 * Immutably set a dotted path on a `Settings` object.
 *
 * `schema.setByPath` is the generic version; this wrapper exists only so the
 * store call sites do not repeat the `as SettingValue` cast. The clone-along-
 * the-path shape is identical — every untouched branch is shared, so a slider
 * drag does not deep-copy the whole object per frame.
 */
function setPathValue(target: SettingsLayer, key: string, value: SettingValue): SettingsLayer {
  const segs = key.split('.');
  const root = cloneSettings(target) as Record<string, unknown>;
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const child = node[seg];
    node[seg] = typeof child === 'object' && child !== null && !Array.isArray(child)
      ? { ...(child as Record<string, unknown>) }
      : {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segs[segs.length - 1]] = value;
  return root as SettingsLayer;
}

/** Drop one key from a layer, falling back to whatever the layer below has. */
export function resetValue(key: string, scope: SettingsScope = 'user'): void {
  setValue(key, getByPath(DEFAULT_SETTINGS, key) as SettingValue, scope);
}

/** Drop an entire layer. */
export function resetScope(scope: SettingsScope): void {
  if (scope === 'user') {
    update({ user: {} }, true);
  } else {
    update({ workspace: {} }, false);
    scheduleWorkspaceWrite();
  }
}

/** Drop only the keys listed in `keys` from a layer. */
export function resetKeys(keys: string[], scope: SettingsScope = 'user'): void {
  if (keys.length === 0) return;
  const current = scope === 'user' ? state.user : state.workspace;
  let next = current;
  for (const key of keys) next = unsetByPath(next, key);
  if (next === current) return;
  if (scope === 'user') update({ user: next }, true);
  else {
    update({ workspace: next }, false);
    scheduleWorkspaceWrite();
  }
}

/**
 * Replace a whole layer from a fully-resolved settings object (the JSON
 * editor's Save).
 *
 * The value is reduced to its differences from the defaults before it becomes
 * a layer, so a user who pastes a *complete* settings.json does not end up
 * with every default pinned — the next change to a default would otherwise
 * never reach them.
 */
export function replaceScope(scope: SettingsScope, settings: Settings): void {
  const layer = stripDefaults(settings);
  if (scope === 'user') update({ user: layer }, true);
  else {
    update({ workspace: layer }, false);
    scheduleWorkspaceWrite();
  }
}

/* ------------------------------------------------------------------ */
/* Persistence — user layer                                            */
/* ------------------------------------------------------------------ */

/** Serialise writes so a burst of slider drags cannot interleave two
 *  `save_file` calls for the same path. */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task);
  // Swallow rejections for the chain's own sake; callers still see theirs.
  writeChain = next.catch(() => undefined);
  return next;
}

function writeMirror(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(state.user));
  } catch {
    /* a full quota must not break settings */
  }
}

function persistUserLayer(): void {
  writeMirror();
  void enqueue(writeUserFile);
}

/** Absolute path of the user `settings.json`, or null outside Tauri. The
 *  Settings Center's "Open settings.json" action uses this. */
export async function userSettingsPath(): Promise<string | null> {
  if (typeof window === 'undefined' || !isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dir = (await invoke('user_config_dir')) as string;
    return joinPath(dir, 'settings.json');
  } catch (e) {
    console.warn('[settings] could not resolve settings.json path:', errText(e));
    return null;
  }
}

async function writeUserFile(): Promise<boolean> {
  if (typeof window === 'undefined' || !isTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dir = (await invoke('user_config_dir')) as string;
    await invoke('save_file', { path: joinPath(dir, 'settings.json'), content: serializeSettings(state.user) });
    return true;
  } catch (e) {
    console.warn('[settings] could not write settings.json:', errText(e));
    return false;
  }
}

/** Seed the store from the localStorage mirror. Synchronous and SSR-safe, so
 *  it can run in a `useState` initialiser without risking a hydration
 *  mismatch: the server has no localStorage, so it renders defaults, and the
 *  modal is only mounted after user interaction anyway. */
export function initFromMirror(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return;
    const { value } = validateSettings(JSON.parse(raw));
    state.user = stripDefaults(value);
  } catch {
    /* corrupt mirror — defaults are a fine fallback */
  }
}

/**
 * Reconcile against the authoritative file. Called once on mount.
 *
 * The file wins over the mirror: it is what the user edited in an external
 * editor, and a mirror written by an older build could otherwise resurrect
 * values the user has since deleted.
 */
export async function hydrateUserLayer(): Promise<void> {
  if (typeof window === 'undefined' || !isTauri()) {
    update({ hydrated: true }, false);
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dir = (await invoke('user_config_dir')) as string;
    let layer: SettingsLayer = {};
    try {
      const raw = (await invoke('read_file', { path: joinPath(dir, 'settings.json') })) as string;
      const { value, violations } = validateSettings(JSON.parse(raw));
      if (violations.length) {
        console.warn(`[settings] settings.json had ${violations.length} issue(s); unknown keys were dropped.`);
      }
      layer = stripDefaults(value);
    } catch (e) {
      // No file yet (first run) — seed it with whatever the mirror held.
      const msg = errText(e).toLowerCase();
      if (!msg.includes('not found') && !msg.includes('no such file')) {
        console.warn('[settings] settings.json read failed; using the local mirror:', errText(e));
      }
      layer = cloneSettings(state.user);
      await writeUserFile();
    }
    update({ user: layer, hydrated: true }, false);
    writeMirror();
  } catch (e) {
    console.warn('[settings] hydration skipped:', errText(e));
    update({ hydrated: true }, false);
  }
}

/* ------------------------------------------------------------------ */
/* Persistence — workspace layer                                       */
/* ------------------------------------------------------------------ */

let workspaceWriteTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWorkspaceWrite(): void {
  if (typeof window === 'undefined' || !state.workspaceRoot) return;
  if (workspaceWriteTimer) clearTimeout(workspaceWriteTimer);
  // 300ms debounce: a slider drag would otherwise issue one write per frame.
  workspaceWriteTimer = setTimeout(() => {
    workspaceWriteTimer = null;
    void enqueue(writeWorkspaceFile);
  }, 300);
}

function workspaceFilePath(root: string): string {
  return joinPath(joinPath(root, WORKSPACE_DIR), WORKSPACE_FILE);
}

async function writeWorkspaceFile(): Promise<boolean> {
  const root = state.workspaceRoot;
  if (typeof window === 'undefined' || !root) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dir = joinPath(root, WORKSPACE_DIR);
    try {
      await invoke('create_dir', { path: dir });
    } catch {
      /* already exists */
    }
    await invoke('save_file', { path: workspaceFilePath(root), content: serializeSettings(state.workspace) });
    return true;
  } catch (e) {
    console.warn('[settings] could not write .agamiz/settings.json:', errText(e));
    return false;
  }
}

/**
 * Point the workspace layer at a folder. Passing the same root again is a
 * no-op so a file-open that re-sets `currentPath` does not thrash the layer.
 * Passing `''` clears it (the welcome screen has no project).
 */
export async function setWorkspaceRoot(root: string): Promise<void> {
  if (state.workspaceRoot === root) return;
  if (!root) {
    update({ workspaceRoot: '', workspace: {} }, false);
    return;
  }
  // Install an empty layer first so the UI is immediately correct (a project
  // with no `.agamiz/settings.json` has no overrides) while the read is in
  // flight. The root is re-checked before applying the result, because a
  // folder switch during the read must not install a stale layer.
  update({ workspaceRoot: root, workspace: {} }, false);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = (await invoke('read_file', { path: workspaceFilePath(root) })) as string;
    const { value } = validateSettings(JSON.parse(raw));
    if (state.workspaceRoot === root) update({ workspace: stripDefaults(value) }, false);
  } catch {
    // No `.agamiz/settings.json` in this project — the empty layer we already
    // installed is exactly right.
  }
}

export function workspaceSettingsPath(): string | null {
  return state.workspaceRoot ? workspaceFilePath(state.workspaceRoot) : null;
}

/* ------------------------------------------------------------------ */
/* Test / dev helpers                                                  */
/* ------------------------------------------------------------------ */

/** Reset every layer. Exposed for the "Reset to Defaults" footer action and
 *  for keeping a future test harness honest about global state. */
export function resetAll(): void {
  state.workspaceRoot = '';
  update({ user: {}, workspace: {} }, false);
  writeMirror();
  if (typeof window !== 'undefined') {
    try { localStorage.removeItem(MIRROR_KEY); } catch { /* ignore */ }
  }
  void enqueue(writeUserFile);
}