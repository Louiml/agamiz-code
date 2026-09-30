/**
 * Keyboard shortcut model.
 *
 * The IDE previously hard-coded every binding three times: in the `keydown`
 * handler, in the command palette's display strings, and in the menu bar. This
 * module makes the *binding* the single artifact, so the settings keymap
 * editor, the palette and the global dispatcher can all read one table.
 *
 * A chord is a normalised, lowercase, `+`-joined string:
 *   "ctrl+shift+p", "ctrl+alt+delete", "f5", "ctrl+k"
 * Modifier order is fixed (ctrl, alt, shift, meta) so two chords that mean
 * the same thing always compare equal.
 */

import type { Settings } from './schema';

export interface KeymapCommand {
  id: string;
  label: string;
  /** Grouping heading in the keymap editor. */
  group: string;
  /** Built-in chord. A user override with the same shape is a *rebinding*,
   *  which the editor marks explicitly. */
  defaultChord: string;
  description: string;
}

export const KEYMAP_COMMANDS: KeymapCommand[] = [
  // File
  { id: 'file.newFile', label: 'New File', group: 'File', defaultChord: 'ctrl+n', description: 'Create an untitled buffer' },
  { id: 'file.openFolder', label: 'Open Folder', group: 'File', defaultChord: 'ctrl+o', description: 'Open a workspace folder' },
  { id: 'file.openFile', label: 'Quick Open File', group: 'File', defaultChord: 'ctrl+p', description: 'Jump to a file by name' },
  { id: 'file.save', label: 'Save File', group: 'File', defaultChord: 'ctrl+s', description: 'Save the active buffer' },
  { id: 'file.saveAll', label: 'Save All', group: 'File', defaultChord: 'ctrl+alt+s', description: 'Save every dirty buffer' },
  { id: 'file.closeEditor', label: 'Close Editor', group: 'File', defaultChord: 'ctrl+w', description: 'Close the active tab' },
  { id: 'file.newProject', label: 'New Project', group: 'File', defaultChord: 'ctrl+shift+n', description: 'Scaffold a project from a template and open it' },
  // Rebound off ctrl+shift+n, which `file.newProject` now owns. Only a
  // *default* changes, so a user who already remapped either keeps their own.
  { id: 'file.newWindow', label: 'New Window', group: 'File', defaultChord: 'ctrl+alt+n', description: 'Open another IDE window' },

  // Edit
  { id: 'edit.undo', label: 'Undo', group: 'Edit', defaultChord: 'ctrl+z', description: 'Undo the last buffer edit' },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', defaultChord: 'ctrl+y', description: 'Reapply the last undone edit' },
  { id: 'edit.find', label: 'Find', group: 'Edit', defaultChord: 'ctrl+f', description: 'Find in the active buffer' },
  { id: 'edit.replace', label: 'Replace', group: 'Edit', defaultChord: 'ctrl+h', description: 'Find and replace in the buffer' },
  { id: 'edit.toggleComment', label: 'Toggle Line Comment', group: 'Edit', defaultChord: 'ctrl+/', description: 'Comment or uncomment the line' },
  { id: 'edit.duplicateLine', label: 'Duplicate Line', group: 'Edit', defaultChord: 'ctrl+d', description: 'Copy the current line downward' },
  { id: 'edit.deleteLine', label: 'Delete Line', group: 'Edit', defaultChord: 'ctrl+shift+k', description: 'Remove the current line' },
  { id: 'edit.moveLineUp', label: 'Move Line Up', group: 'Edit', defaultChord: 'alt+up', description: 'Move the line above' },
  { id: 'edit.moveLineDown', label: 'Move Line Down', group: 'Edit', defaultChord: 'alt+down', description: 'Move the line below' },
  { id: 'edit.goToLine', label: 'Go to Line', group: 'Edit', defaultChord: 'ctrl+g', description: 'Jump to a line number' },

  // View
  { id: 'view.commandPalette', label: 'Command Palette', group: 'View', defaultChord: 'ctrl+shift+p', description: 'Run any command by name' },
  { id: 'view.toggleSidebar', label: 'Toggle Primary Sidebar', group: 'View', defaultChord: 'ctrl+b', description: 'Show or hide the activity sidebar' },
  { id: 'view.togglePanel', label: 'Toggle Bottom Panel', group: 'View', defaultChord: 'ctrl+j', description: 'Show or hide the output panel' },
  { id: 'view.toggleTerminal', label: 'Toggle Terminal', group: 'View', defaultChord: 'ctrl+shift+t', description: 'Show or hide the terminal tab' },
  { id: 'view.newTerminal', label: 'New Terminal', group: 'View', defaultChord: 'ctrl+shift+`', description: 'Spawn an extra shell session' },
  { id: 'view.splitTerminal', label: 'Split Terminal', group: 'View', defaultChord: 'ctrl+shift+5', description: 'Split the focused terminal pane' },
  { id: 'view.toggleDocs', label: 'Toggle Documentation', group: 'View', defaultChord: 'ctrl+k', description: 'Show or hide the docs browser' },
  { id: 'view.toggleFullscreen', label: 'Toggle Fullscreen', group: 'View', defaultChord: 'f11', description: 'Fullscreen the window' },

  // Run
  { id: 'run.run', label: 'Run File', group: 'Run', defaultChord: 'ctrl+r', description: 'Run the active buffer' },
  { id: 'run.runAlternate', label: 'Run File (Fallback)', group: 'Run', defaultChord: 'f5', description: 'Run using the default run mode' },
  { id: 'run.stop', label: 'Stop Run', group: 'Run', defaultChord: 'ctrl+shift+period', description: 'Stop the running process' },
];

/** Modifier rendering order, so `"ctrl+shift+p"` and `"shift+ctrl+p"` never
 *  both appear for the same physical press. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

const MODIFIER_LABELS: Record<(typeof MODIFIER_ORDER)[number], string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Win',
};

/** Keys whose `KeyboardEvent.key` differs from the label we want to show. */
const KEY_LABELS: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  backquote: '`',
  escape: 'Esc',
  ' ': 'Space',
  space: 'Space',
  period: '.',
  comma: ',',
  slash: '/',
  backslash: '\\',
  minus: '-',
  equal: '=',
  semicolon: ';',
  quote: "'",
  bracketleft: '[',
  bracketright: ']',
};

const MODIFIER_KEY_NAMES: Record<string, string> = {
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  meta: 'meta',
  os: 'meta',
};

/**
 * Normalise any chord-shaped string: lower-case, de-duplicate modifiers, and
 * sort modifiers into `MODIFIER_ORDER`. Returns `''` for input that is only
 * modifiers, which the caller treats as "unbound".
 */
export function normalizeChord(chord: string): string {
  const parts = chord.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  const mods = new Set<string>();
  let key = '';
  for (const part of parts) {
    const alias = MODIFIER_KEY_NAMES[part];
    const isModifier = alias !== undefined || (MODIFIER_ORDER as readonly string[]).includes(part);
    if (isModifier) mods.add(alias ?? part);
    else key = part;
  }
  if (!key) return '';

  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** Capture a live key event as a chord. Modifier-only presses return `''` so
 *  the recorder keeps listening instead of writing a useless binding. */
export function chordFromEvent(e: KeyboardEvent): string {
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
  if (['control', 'alt', 'shift', 'meta', 'os'].includes(key)) return '';

  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');

  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m));
  return normalizeChord([...ordered, key].join('+'));
}

/** Human-readable form for the palette, menus and the keymap table. */
export function formatChord(chord: string): string {
  if (!chord) return '';
  return chord
    .split('+')
    .map((part) => {
      if (part in MODIFIER_LABELS) return MODIFIER_LABELS[part as (typeof MODIFIER_ORDER)[number]];
      if (part in KEY_LABELS) return KEY_LABELS[part];
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('+');
}

/** Split a chord into display tokens, so each key can be its own `<kbd>`. */
export function chordTokens(chord: string): string[] {
  if (!chord) return [];
  return formatChord(chord).split('+');
}

export interface ResolvedBinding {
  commandId: string;
  chord: string;
  /** True when the user replaced the built-in binding. */
  overridden: boolean;
  defaultChord: string;
}

/**
 * Flatten defaults + user overrides into one lookup table.
 *
 * Only *overrides* are persisted (`keymap.bindings` in settings.json), so a
 * later change to a default reaches users who never touched the binding —
 * unless they overrode it, in which case theirs wins.
 */
export function resolveKeymap(bindings: Settings['keymap']['bindings']): Record<string, string> {
  const table: Record<string, string> = {};
  for (const cmd of KEYMAP_COMMANDS) table[cmd.id] = cmd.defaultChord;
  for (const [id, chord] of Object.entries(bindings)) {
    if (!(id in table)) continue;
    const normalized = normalizeChord(chord);
    if (normalized) table[id] = normalized;
  }
  return table;
}

export function resolvedBindings(bindings: Settings['keymap']['bindings']): ResolvedBinding[] {
  const table = resolveKeymap(bindings);
  return KEYMAP_COMMANDS.map((cmd) => ({
    commandId: cmd.id,
    chord: table[cmd.id],
    defaultChord: cmd.defaultChord,
    overridden: !!normalizeChord(bindings[cmd.id] ?? '') && normalizeChord(bindings[cmd.id]) !== cmd.defaultChord,
  }));
}

/**
 * Does this key event match the binding for `commandId`?
 *
 * The `ctrl` slot means "primary modifier" (Ctrl *or* Meta) so one table
 * serves every platform without duplicating each command — the same
 * convention the pre-existing global handler used. `alt` and `shift` are
 * matched literally, and a press carrying an unnamed modifier is rejected so
 * `ctrl+s` cannot fire while `ctrl+shift+s` is held.
 */
export function matchesChord(e: KeyboardEvent, chord: string): boolean {
  if (!chord) return false;
  const wanted = new Set(normalizeChord(chord).split('+'));
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();

  // A press that is *only* modifiers reports `key` as a modifier's own name —
  // "Shift", "Control", "Alt", "Meta". That value is also a member of `wanted`
  // for any binding that uses that modifier, so the `wanted.has(key)` test
  // below would accept it and every `ctrl+shift+X` command would fire on a
  // bare Ctrl+Shift, once per keydown repeat. Because the shortcuts live in
  // separate listeners, that opened the project wizard *and* spawned a terminal
  // per event, which is enough PTYs to freeze the app.
  //
  // No binding can legitimately want a bare modifier: `normalizeChord` returns
  // `''` for a modifier-only chord, so the keymap editor never records one.
  if (MODIFIER_KEY_NAMES[key] !== undefined) return false;

  if (!wanted.has(key)) return false;

  const primary = e.ctrlKey || e.metaKey;
  if (wanted.has('ctrl') !== primary) return false;
  if (wanted.has('meta') && !e.metaKey) return false;
  if (wanted.has('alt') !== e.altKey) return false;
  if (wanted.has('shift') !== e.shiftKey) return false;
  return true;
}
