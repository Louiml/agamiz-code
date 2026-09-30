/**
 * Tab bookkeeping.
 *
 * These were inline arrow functions in `page.tsx`, which made the most
 * destructive paths in the editor untestable — and several of them were wrong:
 *
 *   - "Close to the Right" indexed into the array without guarding `idx`,
 *     so a stale id from the tab context menu produced `filter((_, i) =>
 *     i <= -1)` and closed *every* tab.
 *   - "Close Others" kept the dirty tabs (the inverse of its label) and
 *     dropped the active tab without confirming, losing unsaved buffers.
 *   - "Save" cleared `isDirty` for whatever the tab had become by the time
 *     the IPC round-trip resolved, so keystrokes typed during the save were
 *     neither written to disk nor protected by the close prompt.
 *
 * Every function here is pure: it takes tabs and returns new tabs, so the
 * caller can keep using a `setTabs` updater and never read stale state.
 */

/** The two line-ending sequences we round-trip. Bare `\r` is not a line break here. */
export type Eol = '\r\n' | '\n';

export interface Tab {
  id: string;
  name: string;
  path: string;
  content: string;
  isDirty: boolean;
  /**
   * Line ending detected when the file was read, restored on save.
   *
   * Deliberately *not* persisted: the workspace session stores paths and names
   * but never buffer content, so a restored tab is re-read from disk and
   * re-detects its own EOL. Absent means LF — which is also what scratch
   * buffers get.
   */
  eol?: Eol;
}

/** New tabs plus the id that should be active afterwards. */
export interface TabSet {
  tabs: Tab[];
  activeTabId: string | null;
}

export const tabsWithUnsavedChanges = (tabs: Tab[]): Tab[] => tabs.filter((t) => t.isDirty);

/**
 * Pick the active tab after a mutation.
 *
 * When the previously-active tab was closed we activate whichever tab took its
 * place — its right-hand neighbour, or the left-hand one if it was last. The
 * previous code always jumped to `filtered[0]`, dragging focus to the front of
 * the bar; worse, it validated the *requested* id against the surviving list,
 * so a mutation that dropped the active tab left `activeTabId` dangling and the
 * editor rendering the welcome screen over an open file.
 */
function pickActive(kept: Tab[], preferred: string | null, fallbackIndex: number): string | null {
  return pickActiveTab(kept, preferred, fallbackIndex);
}

/** Close one tab, prompting policy left to the caller (it owns `confirm`). */
export function closeTab(tabs: Tab[], activeTabId: string | null, id: string): TabSet {
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return { tabs, activeTabId };
  const kept = tabs.filter((t) => t.id !== id);
  return { tabs: kept, activeTabId: pickActive(kept, activeTabId, index) };
}

/**
 * Close every tab except `id`.
 *
 * Dirty-tab confirmation is the caller's job — it needs a `confirm()` dialog —
 * but `hasUnsavedTabToClose` is exported so the prompt can name exactly the
 * tabs this operation is about to destroy.
 */
export function closeOthers(tabs: Tab[], activeTabId: string | null, id: string): TabSet {
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return { tabs, activeTabId };
  const kept = tabs.filter((t) => t.id === id);
  return { tabs: kept, activeTabId: id };
}

/** The tabs `closeOthers` would discard, so a prompt can list them by name. */
export function othersToClose(tabs: Tab[], id: string): Tab[] {
  return tabs.filter((t) => t.id !== id);
}

/**
 * Close every tab to the right of `id`.
 *
 * The `index < 0` guard is load-bearing: the tab context menu closes over a
 * snapshot taken when the menu opened, so by the time a click lands the tab can
 * already be gone, and `filter((_, i) => i <= -1)` returns `[]`.
 */
export function closeRight(tabs: Tab[], activeTabId: string | null, id: string): TabSet {
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return { tabs, activeTabId };
  const kept = tabs.slice(0, index + 1);
  return { tabs: kept, activeTabId: pickActive(kept, activeTabId, index) };
}

/** The tabs `closeRight` would discard, so a prompt can list them by name. */
export function rightToClose(tabs: Tab[], id: string): Tab[] {
  const index = tabs.findIndex((t) => t.id === id);
  return index < 0 ? [] : tabs.slice(index + 1);
}

export function closeAll(): TabSet {
  return { tabs: [], activeTabId: null };
}

/**
 * Mark a tab saved — but only if it still holds the bytes we wrote.
 *
 * `save_file` is an async IPC round-trip. Anything typed while it is in flight
 * made the tab dirty again; clearing the flag for it meant those keystrokes
 * were never written to disk *and* closing the tab no longer prompted.
 */
export function markSaved(tabs: Tab[], id: string, savedContent: string): Tab[] {
  return tabs.map((t) =>
    t.id === id && t.content === savedContent ? { ...t, isDirty: false } : t,
  );
}

/** A save that changed the tab's identity (Save As) — only then is it clean. */
export function markSavedAs(
  tabs: Tab[],
  oldId: string,
  next: { id: string; name: string; path: string; eol: Eol },
): Tab[] {
  return tabs.map((t) =>
    t.id === oldId ? { ...t, id: next.id, name: next.name, path: next.path, eol: next.eol, isDirty: false } : t,
  );
}

/**
 * Re-point a tab at a new path after a rename or move in the file explorer.
 *
 * The tab `id` *is* the path (see `handleFileSelect`), so a rename that is not
 * propagated here leaves Ctrl+S writing a brand-new file at the old location.
 */
export function remapPath(tabs: Tab[], from: string, to: string): Tab[] {
  const index = tabs.findIndex((t) => t.path === from);
  if (index < 0) return tabs;
  const name = to.split(/[\\/]/).pop() || to;
  return tabs.map((t) => (t.id === from ? { ...t, id: to, path: to, name } : t));
}

/**
 * True when `candidate` is `root` or lives underneath it.
 *
 * Separator-agnostic, because two paths describing the same file can disagree
 * about `/` vs `\` — one comes from a directory listing, the other from a
 * rename dialog. Both separators are checked explicitly rather than
 * normalized, because normalizing a path here would mean re-resolving a string
 * we are only comparing.
 */
export function isUnderPath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  if (!root) return false;
  const trimmed = root.replace(/[\\/]+$/, '');
  return candidate.startsWith(`${trimmed}/`) || candidate.startsWith(`${trimmed}\\`);
}

/** Re-point several tabs at once (a directory rename moves everything under it). */
export function remapPrefix(tabs: Tab[], from: string, to: string): Tab[] {
  if (!tabs.some((t) => isUnderPath(t.path, from))) return tabs;
  return tabs.map((t) => {
    if (!isUnderPath(t.path, from)) return t;
    const path = to + t.path.slice(from.length);
    return { ...t, id: path, path, name: path.split(/[\\/]/).pop() || path };
  });
}

/** Drop tabs whose file no longer exists. Returns the surviving tabs. */
export function removePath(tabs: Tab[], path: string): Tab[] {
  return tabs.filter((t) => t.path !== path);
}

/**
 * The tabs a delete of `path` would take with it.
 *
 * A directory delete takes everything beneath it, which is why `isDir` is an
 * explicit argument rather than something guessed from the path: a file whose
 * name happens to prefix another tab's path must not drag that tab out too.
 */
export function tabsUnder(tabs: Tab[], path: string, isDir: boolean): Tab[] {
  return tabs.filter((t) => (isDir ? isUnderPath(t.path, path) : t.path === path));
}

/** Drop the tabs a delete of `path` would take with it. */
export function removePathUnder(tabs: Tab[], path: string, isDir: boolean): Tab[] {
  return tabs.filter((t) => !(isDir ? isUnderPath(t.path, path) : t.path === path));
}

/**
 * The active id that should follow a mutation.
 *
 * Exported so a caller doing its own `setTabs` transform does not have to
 * re-implement the fallback: a dangling `activeTabId` renders the Welcome
 * screen over an editor that still has open files.
 */
export function pickActiveTab(
  kept: Tab[],
  preferred: string | null,
  fallbackIndex = 0,
): string | null {
  if (preferred && kept.some((t) => t.id === preferred)) return preferred;
  if (kept.length === 0) return null;
  return kept[Math.min(Math.max(fallbackIndex, 0), kept.length - 1)].id;
}

/**
 * Append a tab unless one for that path is already open.
 *
 * `handleFileSelect` used to test the render-time `tabs` array and *then*
 * `await read_file`, so two rapid opens both saw no existing tab and both
 * appended — producing duplicate ids, a React key collision, and a close that
 * removed both.
 */
export function appendIfAbsent(tabs: Tab[], tab: Tab): Tab[] {
  return tabs.some((t) => t.path === tab.path) ? tabs : [...tabs, tab];
}

/** A new tab for a file just read off disk. */
export function tabForFile(args: { path: string; name: string; content: string; eol: Eol }): Tab {
  return {
    id: args.path,
    name: args.name,
    path: args.path,
    content: args.content,
    isDirty: false,
    eol: args.eol,
  };
}

/** An unsaved buffer that exists only in memory (no path yet). */
export function tabForScratch(args: { id: string; name: string; content: string }): Tab {
  return { id: args.id, name: args.name, path: '', content: args.content, isDirty: true, eol: '\n' };
}
