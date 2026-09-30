import { describe, expect, it } from 'vitest';
import {
  detectEol,
  lineAt,
  lineEndOffset,
  lineStartOffset,
  longestLine,
  normalizeBuffer,
  normalizeEol,
  positionAt,
  restoreEol,
  splitLines,
} from './eol';

describe('detectEol', () => {
  it('detects CRLF', () => {
    expect(detectEol('a\r\nb\r\nc')).toBe('\r\n');
  });

  it('detects LF', () => {
    expect(detectEol('a\nb\nc')).toBe('\n');
  });

  it('defaults to LF with no newline at all', () => {
    expect(detectEol('single line')).toBe('\n');
    expect(detectEol('')).toBe('\n');
  });

  it('picks the majority for a mixed file', () => {
    expect(detectEol('a\r\nb\r\nc\nd')).toBe('\r\n');
    expect(detectEol('a\r\nb\nc\nd')).toBe('\n');
  });

  it('treats a bare CR as ordinary text, not a line break', () => {
    expect(detectEol('a\rb\nc')).toBe('\n');
  });
});

describe('normalizeEol', () => {
  it('collapses CRLF to LF', () => {
    expect(normalizeEol('a\r\nb\r\nc')).toBe('a\nb\nc');
  });

  it('is idempotent', () => {
    const once = normalizeEol('a\r\nb');
    expect(normalizeEol(once)).toBe(once);
  });

  it('leaves a bare CR alone', () => {
    expect(normalizeEol('a\rb')).toBe('a\rb');
  });

  it('round-trips through restoreEol', () => {
    const original = 'a\r\nb\r\nc';
    expect(restoreEol(normalizeEol(original), '\r\n')).toBe(original);
  });
});

describe('splitLines', () => {
  // Regression: the highlighter split on '\n' and kept the '\r'. Under
  // `white-space: pre` a CR is a CSS segment break, so every line rendered as
  // two line boxes while the textarea rendered one.
  it('produces one entry per logical line for a CRLF file', () => {
    const lines = splitLines('let a = 1;\r\nlet b = 2;\r\nlet c = 3;');
    expect(lines).toEqual(['let a = 1;', 'let b = 2;', 'let c = 3;']);
    expect(lines.some((l) => l.includes('\r'))).toBe(false);
  });

  it('agrees with the LF form', () => {
    expect(splitLines('a\r\nb\nc')).toEqual(splitLines('a\nb\nc'));
  });

  it('keeps a trailing empty line', () => {
    expect(splitLines('a\n')).toEqual(['a', '']);
    expect(splitLines('a\r\n')).toEqual(['a', '']);
  });

  it('handles an empty buffer as one line', () => {
    expect(splitLines('')).toEqual(['']);
  });
});

describe('normalizeBuffer', () => {
  it('records the eol it was given', () => {
    expect(normalizeBuffer('a\r\nb', '\r\n').eol).toBe('\r\n');
  });

  it('detects the eol when not told', () => {
    expect(normalizeBuffer('a\r\nb').eol).toBe('\r\n');
  });

  it('computes line start offsets in normalized coordinates', () => {
    const buf = normalizeBuffer('aa\r\nbbb\r\nc');
    // The textarea's API value is LF-only, so offsets must not count the CRs.
    expect(buf.text).toBe('aa\nbbb\nc');
    expect(buf.starts).toEqual([0, 3, 7]);
  });
});

describe('line offsets', () => {
  const buf = normalizeBuffer('aa\r\nbbb\r\nc');

  it('finds the start of each line', () => {
    expect(lineStartOffset(buf, 0)).toBe(0);
    expect(lineStartOffset(buf, 1)).toBe(3);
    expect(lineStartOffset(buf, 2)).toBe(7);
  });

  it('finds the end of each line, excluding the newline', () => {
    expect(lineEndOffset(buf, 0)).toBe(2);
    expect(lineEndOffset(buf, 1)).toBe(6);
  });

  it('clamps out-of-range lines instead of returning undefined', () => {
    expect(lineStartOffset(buf, 99)).toBe(7);
    expect(lineEndOffset(buf, -5)).toBe(2);
  });
});

describe('positionAt', () => {
  // Regression: the status bar column was computed with a raw `substring` on
  // the CRLF string while the offset came from the LF-normalized textarea, so
  // the column was short by one for every preceding line.
  it('reports 1-based line and column', () => {
    const buf = normalizeBuffer('aa\r\nbbb\r\nc');
    expect(positionAt(buf, 0)).toEqual({ line: 1, col: 1 });
    expect(positionAt(buf, 1)).toEqual({ line: 1, col: 2 });
    expect(positionAt(buf, 3)).toEqual({ line: 2, col: 1 });
    expect(positionAt(buf, 7)).toEqual({ line: 3, col: 1 });
    // The caret sits after 'c' at the very end of the buffer.
    expect(positionAt(buf, 8)).toEqual({ line: 3, col: 2 });
  });

  it('does not drift by a character per preceding line', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\r\n');
    const buf = normalizeBuffer(text, '\r\n');
    // Start of the 10th line.
    const start = buf.starts[9];
    expect(positionAt(buf, start)).toEqual({ line: 10, col: 1 });
  });

  it('clamps out-of-range offsets', () => {
    const buf = normalizeBuffer('a\nb');
    expect(positionAt(buf, -10)).toEqual({ line: 1, col: 1 });
    expect(positionAt(buf, 9999)).toEqual({ line: 2, col: 2 });
  });

  it('lineAt is the 0-based form', () => {
    const buf = normalizeBuffer('a\nbb\nccc');
    expect(lineAt(buf, 0)).toBe(0);
    expect(lineAt(buf, 2)).toBe(1);
    expect(lineAt(buf, 5)).toBe(2);
  });
});

describe('restoreEol', () => {
  it('writes CRLF back', () => {
    expect(restoreEol('a\nb\nc', '\r\n')).toBe('a\r\nb\r\nc');
  });

  it('writes LF back and normalizes', () => {
    expect(restoreEol('a\r\nb', '\n')).toBe('a\nb');
  });

  it('is a no-op for an already-correct LF buffer', () => {
    expect(restoreEol('a\nb', '\n')).toBe('a\nb');
  });

  it('leaves a bare CR in the content alone', () => {
    expect(restoreEol('a\rb\nc', '\n')).toBe('a\rb\nc');
  });

  it('is idempotent', () => {
    const once = restoreEol('a\nb', '\r\n');
    expect(restoreEol(once, '\r\n')).toBe(once);
  });
});

describe('longestLine', () => {
  it('finds the widest line', () => {
    expect(longestLine(['a', 'abc', 'ab'])).toBe(3);
  });

  it('never returns 0, so the ruler division is safe', () => {
    expect(longestLine([''])).toBeGreaterThan(0);
    expect(longestLine([])).toBeGreaterThan(0);
  });
});
