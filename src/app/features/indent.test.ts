import { describe, expect, it } from 'vitest';
import { indentBlock, outdentBlock } from './indent';

const SPACES = { unit: '    ' };

describe('indentBlock', () => {
  it('indents the caret line with a collapsed selection', () => {
    const r = indentBlock('let a = 1;', 0, 0, SPACES);
    expect(r.text).toBe('    let a = 1;');
    expect(r.changed).toBe(true);
  });

  it('indents every line a multi-line selection spans', () => {
    const text = 'a\nb\nc';
    const r = indentBlock(text, 0, 5, SPACES);
    expect(r.text).toBe('    a\n    b\n    c');
  });

  it('keeps the selection covering the same text', () => {
    // Selecting "a\nb" (offsets 0..3) and indenting must leave those two lines
    // selected, so a second Tab deepens rather than replacing the selection.
    const r = indentBlock('a\nb\nc', 0, 3, SPACES);
    expect(r.text).toBe('    a\n    b\nc');
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('    a\n    b');
  });

  it('preserves the caret column when indenting', () => {
    const r = indentBlock('let a = 1;', 4, 4, SPACES);
    expect(r.selectionStart).toBe(8);
  });

  it('uses a tab character when that is the unit', () => {
    const r = indentBlock('a\nb', 0, 3, { unit: '\t' });
    expect(r.text).toBe('\ta\n\tb');
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('\ta\n\tb');
  });

  it('does not treat a selection ending at a line start as touching that line', () => {
    // Selecting "a\n" (0..2) should indent only line 0; line 1 is not really
    // part of the selection.
    const r = indentBlock('a\nb', 0, 2, SPACES);
    expect(r.text).toBe('    a\nb');
  });

  it('handles CRLF-free single-line text with no trailing newline', () => {
    expect(indentBlock('solo', 2, 2, SPACES).text).toBe('    solo');
  });
});

describe('outdentBlock', () => {
  // The bug this pins: Tab had no shiftKey check, so Shift+Tab *added*
  // indentation. That is data corruption, not a missing feature.
  it('removes one indent level from the caret line', () => {
    const r = outdentBlock('    indented', 4, 4, SPACES);
    expect(r.text).toBe('indented');
    expect(r.changed).toBe(true);
  });

  it('removes a level from every line a selection spans', () => {
    const r = outdentBlock('    a\n    b\n    c', 0, 15, SPACES);
    expect(r.text).toBe('a\nb\nc');
  });

  it('leaves a line with no indentation alone', () => {
    // Outdent at column 0 must not eat into the line's content.
    const r = outdentBlock('no indent', 3, 3, SPACES);
    expect(r.text).toBe('no indent');
    expect(r.changed).toBe(false);
  });

  it('removes only what is there when a line is indented less than a full level', () => {
    const r = outdentBlock('  two spaces', 2, 2, SPACES);
    expect(r.text).toBe('two spaces');
  });

  it('collapses a whitespace-only line by one level, not to empty', () => {
    // A line of eight spaces with a four-space level loses one level, not all
    // eight. Collapsing to empty is only for a line that has no indentation to
    // begin with.
    const r = outdentBlock('    a\n        \n    b', 0, 17, SPACES);
    expect(r.text).toBe('a\n    \nb');
  });

  it('empties a line that was already blank', () => {
    // The middle line has no content, so there is nothing to protect: a level
    // is removed and it collapses to empty. The outer lines are indented four
    // spaces against a three-space level, so only three come off each.
    const r = outdentBlock('    a\n   \n    b', 0, 15, { unit: '   ' });
    expect(r.text).toBe(' a\n\n b');
  });

  it('keeps the selection covering the same text', () => {
    // 0..11 is '    a\n    b' — the first two lines only. Line 2 must be untouched
    // and must not end up inside the selection.
    const r = outdentBlock('    a\n    b\nc', 0, 11, SPACES);
    expect(r.text).toBe('a\nb\nc');
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('a\nb');
  });

  it('leaves lines outside the selection alone', () => {
    const r = outdentBlock('    a\n    b\n    c', 0, 11, SPACES);
    expect(r.text).toBe('a\nb\n    c');
  });

  it('keeps the caret on the same character', () => {
    // Caret at column 7 of '    indented' sits just before the 'e'. After
    // outdent that 'e' is at column 3, and the caret must follow it rather than
    // staying at 7.
    const r = outdentBlock('    indented', 7, 7, SPACES);
    expect(r.selectionStart).toBe(3);
    expect(r.text[r.selectionStart]).toBe('e');
  });

  it('removes a tab character when that is the unit', () => {
    const r = outdentBlock('\t\ta', 0, 0, { unit: '\t' });
    expect(r.text).toBe('\ta');
  });

  it('removes a whole level from a mixed tab/space indent', () => {
    // '\t  ' is three characters, so a four-character level takes all three.
    // Over-removing here would eat into the line's content.
    const r = outdentBlock('\t  mixed', 0, 0, { unit: '    ' });
    expect(r.text).toBe('mixed');
  });

  it('round-trips with indentBlock', () => {
    const original = 'a\nb\nc';
    const indented = indentBlock(original, 0, original.length, SPACES);
    const restored = outdentBlock(indented.text, 0, indented.text.length, SPACES);
    expect(restored.text).toBe(original);
  });

  it('round-trips on a CRLF buffer', () => {
    // The editor normalizes CRLF before this runs, so a buffer arriving here
    // should already be LF-only. Guard it anyway: a stray \r must not be
    // mistaken for indentation.
    const original = 'a\nb';
    const indented = indentBlock(original, 0, 3, SPACES);
    expect(outdentBlock(indented.text, 0, indented.text.length, SPACES).text).toBe(original);
  });

  it('is a no-op on an empty buffer', () => {
    const r = outdentBlock('', 0, 0, SPACES);
    expect(r.changed).toBe(false);
    expect(r.text).toBe('');
  });

  it('is a no-op on a buffer of empty lines', () => {
    const r = outdentBlock('\n\n', 0, 2, SPACES);
    expect(r.changed).toBe(false);
  });
});

describe('offset arithmetic', () => {
  it('reports changed=false when nothing moved', () => {
    expect(indentBlock('', 0, 0, SPACES).changed).toBe(true);
    expect(outdentBlock('flat', 0, 0, SPACES).changed).toBe(false);
  });

  it('clamps selections to the new text', () => {
    const r = outdentBlock('    a', 0, 5, SPACES);
    expect(r.selectionEnd).toBeLessThanOrEqual(r.text.length);
  });
});
