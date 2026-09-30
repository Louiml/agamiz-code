import { describe, expect, it } from 'vitest';
import { AUTO_PAIRS, contextAt, decideAutoClose, type EditContext } from './autoClose';

/** A collapsed caret at `pos` in `text`. */
const at = (key: string, text: string, pos: number, context: EditContext = 'code') =>
  decideAutoClose({ key, text, selectionStart: pos, selectionEnd: pos, context, enabled: true });

describe('decideAutoClose: inserting a pair', () => {
  it('inserts a pair for an opening bracket', () => {
    expect(at('(', '', 0)).toEqual({ kind: 'insert', text: '()' });
  });

  it('inserts a pair for each supported opener', () => {
    for (const [open, close] of Object.entries(AUTO_PAIRS)) {
      expect(at(open, '', 0)).toEqual({ kind: 'insert', text: open + close });
    }
  });

  it('inserts at the caret, not at the start of the line', () => {
    expect(at('(', 'foo', 3)).toEqual({ kind: 'insert', text: '()' });
  });

  it('does nothing when the feature is off', () => {
    expect(decideAutoClose({
      key: '(', text: '', selectionStart: 0, selectionEnd: 0, context: 'code', enabled: false,
    })).toEqual({ kind: 'none' });
  });
});

describe('decideAutoClose: type-over', () => {
  // The bug this pins: typing `(` then `)` gave `foo())`, because the closer
  // was inserted again instead of the caret stepping over the existing one.
  it('steps over an existing closer instead of doubling it', () => {
    expect(at(')', '()', 1)).toEqual({ kind: 'typeOver', closer: ')' });
  });

  it('steps over a quote that is already there', () => {
    expect(at('"', '""', 1)).toEqual({ kind: 'typeOver', closer: '"' });
    expect(at("'", "''", 1)).toEqual({ kind: 'typeOver', closer: "'" });
  });

  it('steps over a closer for a typed-in bracket', () => {
    // `[` auto-closed to `[]`, the user typed `x` inside it, so the buffer is
    // `[x]` and the caret sits at index 2, just before the auto-inserted `]`.
    expect(at(']', '[x]', 2)).toEqual({ kind: 'typeOver', closer: ']' });
  });

  it('still inserts when the character ahead is not the closer', () => {
    // `foo(` followed by a letter: there is no closer to skip.
    expect(at(')', 'foo(x', 4)).toEqual({ kind: 'none' });
  });

  it('inserts a pair when a different character is ahead', () => {
    // The character ahead is `x`, not `)`, so there is nothing to step over.
    expect(at('(', 'axb', 1)).toEqual({ kind: 'insert', text: '()' });
  });

  it('steps over the closer even when it belongs to a different opener', () => {
    // `(a)` with the caret before the `)` — typing `(` there should step over
    // it rather than nesting another pair.
    expect(at('(', '(a)', 2)).toEqual({ kind: 'typeOver', closer: ')' });
  });

  it('does nothing at the very end with no closer ahead', () => {
    expect(at(')', 'foo', 3)).toEqual({ kind: 'none' });
  });
});

describe('decideAutoClose: suppression in literals', () => {
  // Auto-closing inside a string or comment only compounds the problem the user
  // is trying to escape.
  it('does not insert inside a string', () => {
    expect(at('"', 'let s = "hi"', 9, 'string')).toEqual({ kind: 'none' });
  });

  it('does not insert a bracket inside a string', () => {
    expect(at('(', 'let s = "x"', 9, 'string')).toEqual({ kind: 'none' });
  });

  it('does not insert inside a comment', () => {
    expect(at('(', '// note', 4, 'comment')).toEqual({ kind: 'none' });
  });

  it('inserts normally at the end of a string', () => {
    // The offset sits just past the closing quote, which is code again.
    expect(at('(', 'let s = "hi"', 11, 'code')).toEqual({ kind: 'insert', text: '()' });
  });
});

describe('decideAutoClose: wrapping a selection', () => {
  const over = (key: string, text: string, start: number, end: number) =>
    decideAutoClose({ key, text, selectionStart: start, selectionEnd: end, context: 'code', enabled: true });

  it('wraps a selection in a pair rather than replacing it', () => {
    // Typing a quote over a selection quotes it. Replacing it was the old
    // behaviour and lost the text outright.
    expect(over('"', 'abc', 0, 3)).toEqual({ kind: 'surround', before: '"', after: '"' });
  });

  it('wraps a selection in brackets', () => {
    expect(over('(', 'abc', 0, 3)).toEqual({ kind: 'surround', before: '(', after: ')' });
  });

  it('does not wrap for a character that is not a pair', () => {
    expect(over('x', 'abc', 0, 3)).toEqual({ kind: 'none' });
  });

  it('handles a backwards selection', () => {
    expect(over('(', 'abc', 3, 0)).toEqual({ kind: 'surround', before: '(', after: ')' });
  });

  it('does not wrap inside a string', () => {
    expect(decideAutoClose({
      key: '"', text: '"abc"', selectionStart: 1, selectionEnd: 4, context: 'string', enabled: true,
    })).toEqual({ kind: 'none' });
  });
});

describe('contextAt', () => {
  const tokens = (parts: [string, string][]) => parts.map(([type, value]) => ({ type, value }));

  it('reports code at the start of the line', () => {
    expect(contextAt(tokens([['ident', 'foo']]), 0)).toBe('code');
  });

  it('reports code at the very start of a token', () => {
    // The `//` has not been typed yet, so this is still code.
    expect(contextAt(tokens([['comment', '// hi']]), 0)).toBe('code');
  });

  it('reports comment inside a comment', () => {
    expect(contextAt(tokens([['comment', '// hi']]), 3)).toBe('comment');
  });

  it('reports string inside a string', () => {
    // The string token is `"hi"` — four characters, both quotes included — and
    // spans offsets 4..7 inclusive. Offset 8 is the end, which is code again.
    const line = tokens([['ident', 's'], ['ws', ' '], ['op', '='], ['ws', ' '], ['string', '"hi"']]);
    expect(contextAt(line, 5)).toBe('string');
    expect(contextAt(line, 7)).toBe('string');
    expect(contextAt(line, 8)).toBe('code');
  });

  it('reports code after a token ends', () => {
    expect(contextAt(tokens([['string', '"hi"']]), 4)).toBe('code');
  });

  it('reports code on a line with no tokens', () => {
    expect(contextAt([], 3)).toBe('code');
  });

  it('accumulates offsets across ws tokens', () => {
    // Real lines are full of whitespace tokens; the offsets have to add up.
    const line = tokens([['ident', 'let'], ['ws', ' '], ['string', '"x"']]);
    expect(contextAt(line, 0)).toBe('code');
    expect(contextAt(line, 3)).toBe('code');
    expect(contextAt(line, 6)).toBe('string');
  });
});
