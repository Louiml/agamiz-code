import { describe, expect, it } from 'vitest';
import {
  appendIfAbsent,
  closeAll,
  closeOthers,
  closeRight,
  closeTab,
  isUnderPath,
  markSaved,
  markSavedAs,
  othersToClose,
  pickActiveTab,
  remapPath,
  remapPrefix,
  removePath,
  removePathUnder,
  rightToClose,
  tabForFile,
  tabForScratch,
  tabsUnder,
  tabsWithUnsavedChanges,
  type Tab,
} from './tabs';

const t = (id: string, over: Partial<Tab> = {}): Tab => ({
  id,
  name: id.split(/[\\/]/).pop() ?? id,
  path: id,
  content: '',
  isDirty: false,
  ...over,
});

describe('closeRight', () => {
  it('closes only the tabs to the right', () => {
    const tabs = [t('a'), t('b'), t('c')];
    const r = closeRight(tabs, 'a', 'a');
    expect(r.tabs.map((x) => x.id)).toEqual(['a']);
  });

  it('keeps tabs to the left and closes the rest', () => {
    const tabs = [t('a'), t('b'), t('c')];
    expect(closeRight(tabs, 'c', 'c').tabs.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  // Regression: `filter((_, i) => i <= idx)` with idx === -1 returns [], which
  // closed the entire tab set when the context menu handed over a stale id.
  it('is a no-op for an id that is not present', () => {
    const tabs = [t('a'), t('b'), t('c')];
    const r = closeRight(tabs, 'a', 'ghost');
    expect(r.tabs.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(r.activeTabId).toBe('a');
  });

  it('moves the active tab when the active tab is closed', () => {
    const tabs = [t('a'), t('b'), t('c')];
    const r = closeRight(tabs, 'c', 'a');
    expect(r.tabs.map((x) => x.id)).toEqual(['a']);
    expect(r.activeTabId).toBe('a');
    expect(r.tabs.some((x) => x.id === r.activeTabId)).toBe(true);
  });

  it('leaves the active tab alone when it survives', () => {
    const r = closeRight([t('a'), t('b'), t('c')], 'b', 'c');
    expect(r.tabs.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(r.activeTabId).toBe('b');
  });

  it('reports the tabs it would discard', () => {
    const tabs = [t('a'), t('b', { isDirty: true })];
    expect(rightToClose(tabs, 'a').map((x) => x.id)).toEqual(['b']);
    expect(rightToClose(tabs, 'ghost')).toEqual([]);
  });
});

describe('closeOthers', () => {
  it('closes every other tab regardless of dirtiness', () => {
    const tabs = [t('a', { isDirty: true }), t('b'), t('c', { isDirty: true })];
    const r = closeOthers(tabs, 'a', 'b');
    expect(r.tabs.map((x) => x.id)).toEqual(['b']);
  });

  it('activates the surviving tab', () => {
    const r = closeOthers([t('a', { isDirty: true }), t('b')], 'a', 'b');
    expect(r.activeTabId).toBe('b');
  });

  // Regression: the old filter kept every dirty tab, so "Close Others"
  // silently refused to close them, and the active tab was dropped with no
  // confirm — the buffer was gone and activeTabId dangled.
  it('does not preserve dirty tabs it is told to close', () => {
    const tabs = [t('a', { isDirty: true }), t('b', { isDirty: true })];
    const r = closeOthers(tabs, 'a', 'a');
    expect(r.tabs.map((x) => x.id)).toEqual(['a']);
    expect(r.tabs).toHaveLength(1);
  });

  it('is a no-op for an id that is not present', () => {
    const tabs = [t('a'), t('b')];
    const r = closeOthers(tabs, 'a', 'ghost');
    expect(r.tabs.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.activeTabId).toBe('a');
  });

  it('reports the tabs it would discard so a prompt can name them', () => {
    const tabs = [t('a', { isDirty: true }), t('b', { isDirty: true })];
    expect(othersToClose(tabs, 'b').map((x) => x.id)).toEqual(['a']);
  });
});

describe('closeTab / closeAll', () => {
  it('clears the active id when the last tab closes', () => {
    expect(closeTab([t('a')], 'a', 'a').activeTabId).toBeNull();
  });

  // When the active tab closes we activate its right-hand neighbour, falling
  // back to the left when it was the last one. The previous code always took
  // `filtered[0]`, which yanked focus to the front of the tab bar.
  it('falls back to the right-hand neighbour when the active tab closes', () => {
    const r = closeTab([t('a'), t('b'), t('c')], 'b', 'b');
    expect(r.activeTabId).toBe('c');
    expect(r.tabs.some((x) => x.id === r.activeTabId)).toBe(true);
  });

  it('falls back to the left-hand neighbour at the end of the bar', () => {
    expect(closeTab([t('a'), t('b'), t('c')], 'c', 'c').activeTabId).toBe('b');
  });

  it('never leaves a dangling active id', () => {
    const r = closeTab([t('a'), t('b'), t('c')], 'c', 'c');
    expect(r.tabs.some((x) => x.id === r.activeTabId)).toBe(true);
  });

  it('is a no-op for an id that is not present', () => {
    const r = closeTab([t('a')], 'a', 'ghost');
    expect(r.tabs).toHaveLength(1);
    expect(r.activeTabId).toBe('a');
  });

  it('clears everything on closeAll', () => {
    expect(closeAll()).toEqual({ tabs: [], activeTabId: null });
  });
});

describe('markSaved', () => {
  // Regression: the dirty flag was cleared for whatever the tab had become by
  // the time the IPC round-trip resolved, so keystrokes typed during a save
  // were never written to disk and no longer triggered the close prompt.
  it('keeps the tab dirty when its content changed during the save', () => {
    const tabs = [t('a', { content: 'v2', isDirty: true })];
    const r = markSaved(tabs, 'a', 'v1');
    expect(r[0].isDirty).toBe(true);
  });

  it('clears the dirty flag when the content still matches', () => {
    const tabs = [t('a', { content: 'v1', isDirty: true })];
    expect(markSaved(tabs, 'a', 'v1')[0].isDirty).toBe(false);
  });

  it('leaves other tabs untouched', () => {
    const tabs = [t('a', { content: 'v1', isDirty: true }), t('b', { content: 'x', isDirty: true })];
    const r = markSaved(tabs, 'a', 'v1');
    expect(r[0].isDirty).toBe(false);
    expect(r[1].isDirty).toBe(true);
  });
});

describe('markSavedAs', () => {
  it('rewrites identity and clears dirty in one step', () => {
    const tabs = [t('a', { content: 'hello', isDirty: true })];
    const r = markSavedAs(tabs, 'a', { id: 'out/a2', name: 'a2', path: 'out/a2', eol: '\r\n' });
    expect(r[0]).toMatchObject({ id: 'out/a2', path: 'out/a2', name: 'a2', isDirty: false, eol: '\r\n' });
    expect(r[0].content).toBe('hello');
  });
});

describe('remapPath', () => {
  // Regression: nothing told the tab set that a rename happened, so Ctrl+S
  // recreated the file at its old path.
  it('repoints id, path and name at the new location', () => {
    const tabs = [t('src/a.rak', { name: 'a.rak' })];
    const r = remapPath(tabs, 'src/a.rak', 'src/b.rak');
    expect(r[0]).toMatchObject({ id: 'src/b.rak', path: 'src/b.rak', name: 'b.rak' });
  });

  it('keeps content and dirty state', () => {
    const tabs = [t('a.rak', { content: 'x', isDirty: true })];
    const r = remapPath(tabs, 'a.rak', 'b.rak');
    expect(r[0].content).toBe('x');
    expect(r[0].isDirty).toBe(true);
  });

  it('is a no-op when the path is not open', () => {
    const tabs = [t('a.rak')];
    expect(remapPath(tabs, 'zzz.rak', 'y.rak')).toBe(tabs);
  });
});

describe('remapPrefix', () => {
  it('moves every tab under a renamed directory', () => {
    const tabs = [t('src/a.rak'), t('src/deep/b.rak'), t('other/c.rak')];
    const r = remapPrefix(tabs, 'src', 'lib');
    expect(r.map((x) => x.path)).toEqual(['lib/a.rak', 'lib/deep/b.rak', 'other/c.rak']);
    expect(r[0].id).toBe('lib/a.rak');
  });

  it('does not match a sibling that merely shares the prefix', () => {
    const tabs = [t('src/a.rak'), t('src-old/b.rak')];
    const r = remapPrefix(tabs, 'src', 'lib');
    expect(r[1].path).toBe('src-old/b.rak');
  });

  it('is a no-op when nothing is under the path', () => {
    const tabs = [t('other/a.rak')];
    expect(remapPrefix(tabs, 'src', 'lib')).toBe(tabs);
  });
});

describe('removePath', () => {
  it('drops only the deleted path', () => {
    expect(removePath([t('a'), t('b')], 'a').map((x) => x.id)).toEqual(['b']);
  });
});

describe('isUnderPath', () => {
  it('accepts the path itself', () => {
    expect(isUnderPath('src/a.ts', 'src/a.ts')).toBe(true);
  });
  it('accepts a descendant with either separator', () => {
    expect(isUnderPath('src/deep/a.ts', 'src')).toBe(true);
    expect(isUnderPath('src\\deep\\a.ts', 'src')).toBe(true);
  });
  it('accepts a descendant of a root with a trailing separator', () => {
    expect(isUnderPath('src/a.ts', 'src/')).toBe(true);
    expect(isUnderPath('src/a.ts', 'src\\')).toBe(true);
  });
  it('rejects a sibling that shares the prefix', () => {
    expect(isUnderPath('src-old/a.ts', 'src')).toBe(false);
  });
  it('rejects a non-descendant', () => {
    expect(isUnderPath('other/a.ts', 'src')).toBe(false);
  });
  it('rejects everything for an empty root', () => {
    expect(isUnderPath('src/a.ts', '')).toBe(false);
  });
});

describe('tabsUnder / removePathUnder', () => {
  const tree = [t('src/a.ts'), t('src/deep/b.ts'), t('other/c.ts')];

  it('takes only the exact path for a file delete', () => {
    expect(tabsUnder(tree, 'src/a.ts', false).map((x) => x.id)).toEqual(['src/a.ts']);
    expect(removePathUnder(tree, 'src/a.ts', false).map((x) => x.id)).toEqual(['src/deep/b.ts', 'other/c.ts']);
  });

  it('takes the whole subtree for a directory delete', () => {
    expect(tabsUnder(tree, 'src', true).map((x) => x.id)).toEqual(['src/a.ts', 'src/deep/b.ts']);
    expect(removePathUnder(tree, 'src', true).map((x) => x.id)).toEqual(['other/c.ts']);
  });

  it('does not let a file delete take a same-prefixed sibling', () => {
    const siblings = [t('src/a.ts'), t('src-old/b.ts')];
    expect(tabsUnder(siblings, 'src/a.ts', false).map((x) => x.id)).toEqual(['src/a.ts']);
  });

  it('is a no-op when nothing matches', () => {
    expect(tabsUnder(tree, 'nope', true)).toEqual([]);
  });
});

describe('pickActiveTab', () => {
  it('keeps a preferred id that survived', () => {
    expect(pickActiveTab([t('a'), t('b')], 'b')).toBe('b');
  });
  it('falls back to the first tab when the preferred one is gone', () => {
    expect(pickActiveTab([t('a'), t('b')], 'gone')).toBe('a');
  });
  it('honours an explicit fallback index', () => {
    expect(pickActiveTab([t('a'), t('b'), t('c')], null, 2)).toBe('c');
  });
  it('clamps an out-of-range fallback index', () => {
    expect(pickActiveTab([t('a'), t('b')], null, 99)).toBe('b');
  });
  it('returns null when nothing is left', () => {
    expect(pickActiveTab([], 'a')).toBeNull();
  });
});

describe('appendIfAbsent', () => {
  // Regression: the existence check ran before `await read_file`, so two rapid
  // opens of the same file both appended — duplicate ids, React key warning,
  // and closing one closed both.
  it('does not append a duplicate path', () => {
    const first = tabForFile({ path: 'a.rak', name: 'a.rak', content: 'x', eol: '\n' });
    const second = tabForFile({ path: 'a.rak', name: 'a.rak', content: 'x', eol: '\n' });
    const tabs = appendIfAbsent(appendIfAbsent([], first), second);
    expect(tabs).toHaveLength(1);
  });

  it('appends a genuinely new path', () => {
    const a = tabForFile({ path: 'a.rak', name: 'a.rak', content: '', eol: '\n' });
    const b = tabForFile({ path: 'b.rak', name: 'b.rak', content: '', eol: '\r\n' });
    expect(appendIfAbsent([a], b)).toHaveLength(2);
  });

  it('records the detected eol', () => {
    const tab = tabForFile({ path: 'a', name: 'a', content: '', eol: '\r\n' });
    expect(tab.eol).toBe('\r\n');
  });
});

describe('tabForScratch', () => {
  it('is dirty, pathless and LF', () => {
    const tab = tabForScratch({ id: 'scratch_1', name: 'scratch_1.rak', content: '' });
    expect(tab).toMatchObject({ path: '', isDirty: true, eol: '\n' });
  });
});

describe('tabsWithUnsavedChanges', () => {
  it('lists only dirty tabs', () => {
    const tabs = [t('a'), t('b', { isDirty: true })];
    expect(tabsWithUnsavedChanges(tabs).map((x) => x.id)).toEqual(['b']);
  });

  it('is empty when everything is saved', () => {
    expect(tabsWithUnsavedChanges([t('a')])).toEqual([]);
  });
});
