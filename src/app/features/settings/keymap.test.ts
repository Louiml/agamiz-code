/**
 * Chord matching checks.
 *
 * Run with: npx tsx src/app/features/settings/keymap.test.ts
 * (or via `node --experimental-strip-types` on Node 22+).
 *
 * The modifier-only cases are the reason this file exists. `KeyboardEvent.key`
 * reports the modifier's own name when only modifiers are held, which used to
 * satisfy the "is the pressed key in the binding?" test for every
 * `ctrl+shift+…` command at once.
 */

import { expect, it } from 'vitest';
import { KEYMAP_COMMANDS, formatChord, matchesChord, normalizeChord, resolveKeymap } from './keymap';

/** Keeps the original per-case names in the failure output. */
function check(name: string, cond: boolean, detail = '') {
  expect(cond, detail ? `${name} — ${detail}` : name).toBe(true);
}

/** Build a key event with only the fields `matchesChord` reads. */
function keyEvent(key: string, mods: Partial<Record<'ctrl' | 'shift' | 'alt' | 'meta', boolean>> = {}) {
  return { key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta } as KeyboardEvent;
}

it('keymap chord matching', () => {
  // 1. regression: a bare modifier press must not match anything
{
  // The reported bug. `e.key` is "Shift" here, and "shift" is in the wanted set
  // for any ctrl+shift binding, so all of these used to fire on one keydown.
  for (const chord of ['ctrl+shift+n', 'ctrl+shift+t', 'ctrl+shift+`', 'ctrl+shift+p', 'ctrl+shift+5']) {
    check(`${chord} ignores bare Shift`, !matchesChord(keyEvent('Shift', { ctrl: true, shift: true }), chord));
    check(`${chord} ignores bare Control`, !matchesChord(keyEvent('Control', { ctrl: true, shift: true }), chord));
    check(`${chord} ignores bare Alt`, !matchesChord(keyEvent('Alt', { ctrl: true, shift: true, alt: true }), chord));
    check(`${chord} ignores bare Meta`, !matchesChord(keyEvent('Meta', { meta: true, shift: true }), chord));
  }
  // Ctrl alone, for the single-modifier bindings.
  check('ctrl+s ignores bare Control', !matchesChord(keyEvent('Control', { ctrl: true }), 'ctrl+s'));
  // The whole shipped table, checked against a bare Ctrl+Shift — nothing in the
  // IDE may fire on it.
  const table = resolveKeymap({});
  const fired = KEYMAP_COMMANDS.filter((c) => matchesChord(keyEvent('Shift', { ctrl: true, shift: true }), table[c.id] ?? ''));
  check('no shipped command fires on a bare Ctrl+Shift', fired.length === 0, fired.map((c) => c.id).join(', '));
}

console.log('\n2. real chords still match');
{
  check('ctrl+shift+n', matchesChord(keyEvent('N', { ctrl: true, shift: true }), 'ctrl+shift+n'));
  check('ctrl+s', matchesChord(keyEvent('s', { ctrl: true }), 'ctrl+s'));
  check('ctrl+shift+t', matchesChord(keyEvent('T', { ctrl: true, shift: true }), 'ctrl+shift+t'));
  check('ctrl+shift+`', matchesChord(keyEvent('`', { ctrl: true, shift: true }), 'ctrl+shift+`'));
  check('ctrl+alt+n', matchesChord(keyEvent('n', { ctrl: true, alt: true }), 'ctrl+alt+n'));
  check('f5', matchesChord(keyEvent('F5'), 'f5'));
  check('f11', matchesChord(keyEvent('F11'), 'f11'));
  check('space', matchesChord(keyEvent(' '), 'space'));
  // `ctrl` means "primary modifier", so Meta stands in for Ctrl on macOS.
  check('cmd+s matches ctrl+s', matchesChord(keyEvent('s', { meta: true }), 'ctrl+s'));
}

console.log('\n3. mismatched modifiers are rejected');
{
  check('ctrl+s needs no shift', !matchesChord(keyEvent('S', { ctrl: true, shift: true }), 'ctrl+s'));
  check('ctrl+shift+n needs shift', !matchesChord(keyEvent('n', { ctrl: true }), 'ctrl+shift+n'));
  check('ctrl+alt+n needs alt', !matchesChord(keyEvent('n', { ctrl: true }), 'ctrl+alt+n'));
  check('alt+x rejects bare ctrl', !matchesChord(keyEvent('x', { ctrl: true }), 'alt+x'));
  check('wrong key', !matchesChord(keyEvent('m', { ctrl: true, shift: true }), 'ctrl+shift+n'));
  check('unbound command never matches', !matchesChord(keyEvent('n', { ctrl: true, shift: true }), ''));
}

console.log('\n4. every shipped binding is internally consistent');
{
  const table = resolveKeymap({});
  for (const cmd of KEYMAP_COMMANDS) {
    const chord = table[cmd.id];
    check(`${cmd.id} is bound`, !!chord, 'unbound command would be dead UI');
    check(`${cmd.id} normalizes to itself`, normalizeChord(chord) === chord, `${chord} -> ${normalizeChord(chord)}`);
    // The key is the last segment; it must not be a modifier, or the chord
    // would be unreachable — and, before the modifier guard, would also match
    // on a bare press of that modifier.
    const segments = chord.split('+');
    const key = segments[segments.length - 1];
    check(`${cmd.id} has a real key`, !['ctrl', 'shift', 'alt', 'meta', 'os'].includes(key), chord);
    check(`${cmd.id} renders a label`, formatChord(chord).length > 0);
  }
  // Two commands sharing a chord means one is unreachable, because the
  // dispatcher is an `else if` chain.
  const seen = new Map<string, string>();
  for (const cmd of KEYMAP_COMMANDS) {
    const chord = table[cmd.id];
    const prior = seen.get(chord);
    check(`${cmd.id} does not collide with ${prior ?? ''}`, prior === undefined, `both on ${chord}`);
    seen.set(chord, cmd.id);
  }
}
});
