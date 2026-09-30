/**
 * Workspace session persistence — the "restore last workspace" feature.
 *
 * On every meaningful workspace change the shell writes a small snapshot to
 * `<user config dir>/workspace-session.json`. On launch, `restoreSession()`
 * replays it: reopen the folder, reopen the tabs, and put the layout back
 * roughly where the user left it.
 *
 * Design constraints
 * ------------------
 * * **Never lose work.** Buffers are *not* captured. Only paths are stored,
 *   and restore re-reads each file from disk. A file that has since been
 *   deleted, renamed, or made unreadable is skipped and reported instead of
 *   aborting the whole restore.
 * * **Never block startup.** Every helper resolves to a safe default when
 *   Tauri is unavailable or the file is corrupt. A missing session file is the
 *   normal first-run case, not an error.
 * * **Opt-out.** With `restoreLastWorkspace` off, or with a layout mode that
 *   excludes editors, the snapshot is still written (so flipping the toggle
 *   back on restores something) but nothing is replayed.
 * * **One snapshot per window.** The app can run several windows at once (New
 *   Window), and they are independent — like a browser, or like VS Code. If
 *   they all wrote `workspace-session.json`, the last window to change
 *   anything would win and the others would silently restore *its* workspace
 *   and tab set on their next launch. Each window therefore gets its own file,
 *   keyed by its Tauri window label; the launch window keeps the historical
 *   un-suffixed name so existing users' saved session is not orphaned.
 *
 * This module is deliberately React-free: `restoreSession` takes the two
 * side-effecting callbacks it needs instead of reaching into component state,
 * which is what makes it testable and reusable from the welcome screen.
 */

import { currentWindowLabel, errText, isTauri } from '../../lib/tauri';
import type { Settings } from './schema';

/** Session file for the window the app launched in. */
const SESSION_FILE = 'workspace-session.json';

/** Schema version, so a future format change can migrate rather than throw. */
const SESSION_VERSION = 1;

/** A tab identity worth restoring. Content is intentionally absent. */
export interface SessionTab {
  path: string;
  name: string;
}

export interface WorkspaceSession {
  version: number;
  /** Absolute workspace root. Empty means "no workspace". */
  folder: string;
  openTabs: SessionTab[];
  /** Path of the focused tab at shutdown, or null. */
  activeTabPath: string | null;
  layout: {
    sidebarOpen: boolean;
    activity: string;
    sidebarWidth: number;
    panelOpen: boolean;
    bottomTab: string;
    panelHeight: number;
  };
  savedAt: number;
}

export const EMPTY_SESSION: WorkspaceSession = {
  version: SESSION_VERSION,
  folder: '',
  openTabs: [],
  activeTabPath: null,
  layout: {
    sidebarOpen: true,
    activity: 'explorer',
    sidebarWidth: 256,
    panelOpen: false,
    bottomTab: 'terminal',
    panelHeight: 220,
  },
  savedAt: 0,
};

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/** Separator used by a given path. Windows accepts both, but a session file
 *  must round-trip the exact style the user's shell produced, otherwise
 *  `path.startsWith(root)` style checks behave inconsistently. */
function separatorOf(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

/** Join a directory and a child name using the directory's own separator. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = separatorOf(dir);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** True when `child` lives inside `root` (or equals it). */
export function isInside(root: string, child: string): boolean {
  if (!root || !child) return false;
  const sep = separatorOf(root);
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  const r = norm(root);
  return norm(child) === r || norm(child).startsWith(r + sep);
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/** Absolute path of the user config directory, or null outside Tauri. */
export async function configDir(): Promise<string | null> {
  if (typeof window === 'undefined' || !isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke('user_config_dir')) as string;
  } catch (e) {
    console.warn('[workspace-session] could not resolve the config dir:', errText(e));
    return null;
  }
}

/**
 * Session file owned by *this* window.
 *
 * The launch window keeps `workspace-session.json` so upgrades do not strand an
 * existing user's saved session. Windows opened with New Window use
 * `editor-N`, sanitised to a safe filename, so N concurrent windows never
 * write over each other.
 */
function sessionFilePath(dir: string): string {
  const label = currentWindowLabel();
  if (!label || label === 'main') return joinPath(dir, SESSION_FILE);
  const safe = label.replace(/[^A-Za-z0-9._-]/g, '_');
  return joinPath(dir, `workspace-session.${safe}.json`);
}

function isSession(v: unknown): v is WorkspaceSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<WorkspaceSession>;
  if (typeof s.folder !== 'string') return false;
  if (!Array.isArray(s.openTabs)) return false;
  return s.openTabs.every((t) => !!t && typeof t.path === 'string' && typeof t.name === 'string');
}

/** Read the snapshot. Returns `null` for "no session", which is a normal
 *  first run, and also for a corrupt file we deliberately refuse to guess at. */
export async function loadSession(): Promise<WorkspaceSession | null> {
  const dir = await configDir();
  if (!dir) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = (await invoke('read_file', { path: sessionFilePath(dir) })) as string;
    const parsed: unknown = JSON.parse(raw);
    if (!isSession(parsed)) {
      console.warn('[workspace-session] ignoring an unrecognised snapshot shape');
      return null;
    }
    return {
      ...EMPTY_SESSION,
      ...parsed,
      layout: { ...EMPTY_SESSION.layout, ...(parsed.layout ?? {}) },
    };
  } catch (e) {
    // A missing file is the common case; anything else is worth a line.
    if (!String(errText(e)).toLowerCase().includes('not found')
      && !String(errText(e)).toLowerCase().includes('no such file')) {
      console.warn('[workspace-session] read failed:', errText(e));
    }
    return null;
  }
}

/** Persist the snapshot. Fire-and-forget: a failed session write must never
 *  surface as an error in the UI. */
export async function saveSession(session: WorkspaceSession): Promise<boolean> {
  const dir = await configDir();
  if (!dir) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_file', {
      path: sessionFilePath(dir),
      content: `${JSON.stringify({ ...session, version: SESSION_VERSION, savedAt: Date.now() }, null, 2)}\n`,
    });
    return true;
  } catch (e) {
    console.warn('[workspace-session] write failed:', errText(e));
    return false;
  }
}

export async function clearSession(): Promise<void> {
  const dir = await configDir();
  if (!dir) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_file', { path: sessionFilePath(dir) });
  } catch {
    /* already gone */
  }
}

/** Build a snapshot from the shell's current state, dropping any tab that
 *  lives outside the workspace root. Storing those would restore a tab the
 *  user can no longer reach, and the path would dangle after a move. */
export function buildSession(input: {
  folder: string;
  tabs: SessionTab[];
  activeTabPath: string | null;
  layout: WorkspaceSession['layout'];
}): WorkspaceSession {
  const root = input.folder;
  const openTabs = root
    ? input.tabs.filter((t) => isInside(root, t.path)).slice(0, 40)
    : [];
  const active = input.activeTabPath && openTabs.some((t) => t.path === input.activeTabPath)
    ? input.activeTabPath
    : null;
  return {
    version: SESSION_VERSION,
    folder: root,
    openTabs,
    activeTabPath: active,
    layout: input.layout,
    savedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Restore                                                             */
/* ------------------------------------------------------------------ */

export interface RestoreCallbacks {
  /** Point the shell at `folder` (updates the path, clears stale tabs). */
  openFolder: (folder: string) => void;
  /** Open one file. May reject; the restore treats that as "skip this tab". */
  openFile: (path: string, name: string) => Promise<void>;
  /** Reapply the saved layout. All fields optional. */
  applyLayout?: (layout: WorkspaceSession['layout']) => void;
}

export interface RestoreOutcome {
  restored: boolean;
  folder: string;
  tabsRequested: number;
  tabsOpened: number;
  /** Tabs that could not be reopened, with the reason. */
  skipped: { path: string; reason: string }[];
  /** Tab the user was last focused on, or null when it is gone. The caller
   *  focuses this *after* the tabs are open, so the tab strip is settled. */
  activeTabPath: string | null;
  /** Set when the user opted out, or there was nothing to restore. */
  reason?: 'disabled' | 'no-session' | 'no-folder' | 'no-editors';
}

/**
 * Replay a snapshot.
 *
 * Ordering matters: the folder is opened *before* any file, so every tab
 * read runs against the restored workspace root. Tabs open sequentially
 * rather than in parallel — `openFile` appends to shared state, and an
 * unordered append would scramble the tab strip the user had arranged.
 */
export async function restoreSession(
  session: WorkspaceSession | null,
  settings: Pick<Settings, 'general'>,
  cb: RestoreCallbacks,
): Promise<RestoreOutcome> {
  const empty: RestoreOutcome = {
    restored: false,
    folder: '',
    tabsRequested: 0,
    tabsOpened: 0,
    skipped: [],
    activeTabPath: null,
  };

  if (!settings.general.restoreLastWorkspace) return { ...empty, reason: 'disabled' };
  if (!session) return { ...empty, reason: 'no-session' };
  if (!session.folder) return { ...empty, folder: session.folder, reason: 'no-folder' };

  const wantsEditors = settings.general.reopenClosedEditors
    && settings.general.startupLayout !== 'empty';

  const outcome: RestoreOutcome = {
    restored: true,
    folder: session.folder,
    tabsRequested: wantsEditors ? session.openTabs.length : 0,
    tabsOpened: 0,
    skipped: [],
    activeTabPath: null,
  };

  // Layout first: the sidebar and panel are chrome, and restoring them before
  // the tabs keeps the first painted frame looking like the last session.
  if (settings.general.startupLayout === 'full') cb.applyLayout?.(session.layout);

  cb.openFolder(session.folder);

  if (!wantsEditors) {
    if (!settings.general.reopenClosedEditors) outcome.reason = 'no-editors';
    return outcome;
  }

  for (const tab of session.openTabs) {
    try {
      await cb.openFile(tab.path, tab.name);
      outcome.tabsOpened++;
    } catch (e) {
      outcome.skipped.push({ path: tab.path, reason: errText(e) });
    }
  }

  // Only refocus if that file actually came back — pointing the selection at a
  // tab that failed to open would leave the editor blank.
  if (session.activeTabPath && !outcome.skipped.some((s) => s.path === session.activeTabPath)) {
    outcome.activeTabPath = session.activeTabPath;
  }

  return outcome;
}
