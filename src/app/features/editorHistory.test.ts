import { describe, expect, it } from 'vitest';
import { EditorHistory, type HistoryEntry } from './editorHistory';

const at = (content: string, caret = content.length): HistoryEntry => ({
  content,
  selectionStart: caret,
  selectionEnd: caret,
});

/** Simulate typing `text` at `pos`, one character at a time, 50ms apart. */
function type(h: EditorHistory, base: string, pos: number, text: string, startMs = 0) {
  let content = base;
  let now = startMs;
  for (const ch of text) {
    content = content.slice(0, pos) + ch + content.slice(pos);
    h.push(at(content, pos + 1), pos, now);
    pos += 1;
    now += 50;
  }
  return { content, pos, now };
}

describe('reset', () => {
  it('makes the seeded state the only undoable baseline', () => {
    const h = new EditorHistory();
    h.reset('hello');
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it('discards a previous document history', () => {
    const h = new EditorHistory();
    h.reset('a');
    h.push(at('ab'), 1, 0);
    expect(h.canUndo).toBe(true);
    h.reset('different file');
    expect(h.canUndo).toBe(false);
  });
});

describe('push and undo', () => {
  it('restores the previous content', () => {
    const h = new EditorHistory();
    h.reset('one\ntwo');
    h.push(at('one\ntwo\nthree'), 8, 0);
    expect(h.canUndo).toBe(true);
    // Undo returns the *baseline* state, which `reset` seeded at caret 0.
    expect(h.undo(at('one\ntwo\nthree'))).toEqual(at('one\ntwo', 0));
  });

  it('is a no-op with nothing to undo', () => {
    const h = new EditorHistory();
    h.reset('only');
    expect(h.undo(at('only'))).toBeNull();
  });

  it('walks back through several steps one at a time', () => {
    const h = new EditorHistory();
    h.reset('a');
    h.push(at('ab'), 1, 0);
    h.push(at('abc'), 2, 10_000);
    h.push(at('abcd'), 3, 20_000);
    let current = at('abcd');
    expect(h.undo(current)?.content).toBe('abc');
    current = at('abc');
    expect(h.undo(current)?.content).toBe('ab');
    current = at('ab');
    expect(h.undo(current)?.content).toBe('a');
    current = at('a');
    expect(h.undo(current)).toBeNull();
  });
});

describe('redo', () => {
  it('replays a undone change', () => {
    const h = new EditorHistory();
    h.reset('one');
    h.push(at('one two'), 7, 0);
    const undone = h.undo(at('one two'))!;
    expect(undone.content).toBe('one');
    expect(h.canRedo).toBe(true);
    expect(h.redo(undone)?.content).toBe('one two');
  });

  it('is a no-op with nothing to redo', () => {
    const h = new EditorHistory();
    h.reset('a');
    expect(h.redo(at('a'))).toBeNull();
  });

  it('is discarded by a new edit after an undo', () => {
    // The behaviour every editor has: undo, type something else, and the
    // future you had undone is gone rather than silently restored later.
    const h = new EditorHistory();
    h.reset('one');
    h.push(at('one two'), 7, 0);
    const undone = h.undo(at('one two'))!;
    expect(undone.content).toBe('one');
    expect(h.canRedo).toBe(true);
    h.push(at('one three'), 9, 10_000);
    expect(h.canRedo).toBe(false);
  });
});

describe('coalescing', () => {
  it('collapses a burst of typing into one undo step', () => {
    const h = new EditorHistory();
    h.reset('let x = ;');
    const { content } = type(h, 'let x = ;', 8, 'value', 0);
    expect(content).toBe('let x = value;');
    // One undo removes the whole word, not one character.
    expect(h.undo(at(content))?.content).toBe('let x = ;');
  });

  it('starts a new step after a pause', () => {
    const h = new EditorHistory({ coalesceMs: 400 });
    h.reset('');
    h.push(at('a'), 0, 0);
    h.push(at('ab'), 1, 1000); // > 400ms later
    expect(h.depth.undo).toBe(3);
  });

  it('starts a new step when the caret jumps elsewhere', () => {
    const h = new EditorHistory();
    h.reset('one two three');
    h.push(at('one Xtwo three', 5), 4, 0);
    // Second edit is at the start of the buffer, not after the first.
    h.push(at('Yone Xtwo three', 2), 0, 50);
    expect(h.depth.undo).toBe(3);
    expect(h.undo(at('Yone Xtwo three', 2))?.content).toBe('one Xtwo three');
  });

  it('never coalesces across a new line break', () => {
    const h = new EditorHistory();
    h.reset('a');
    h.push(at('ab'), 1, 0);
    h.push(at('ab\n'), 2, 50); // Enter
    expect(h.depth.undo).toBe(3);
  });

  it('never coalesces a paste into the preceding typing', () => {
    // The case that makes coalescing dangerous: without the length rule, one
    // undo would remove the pasted block *and* the word typed before it.
    const h = new EditorHistory();
    h.reset('');
    h.push(at('ab'), 0, 0);
    h.push(at('ab LOTS AND LOTS OF TEXT'), 2, 40);
    expect(h.depth.undo).toBe(3);
    expect(h.undo(at('ab LOTS AND LOTS OF TEXT'))?.content).toBe('ab');
  });

  it('gives a multi-character delete its own step', () => {
    // Deleting five characters is not a single-character edit, so it does not
    // join the step before it.
    const h = new EditorHistory();
    h.reset('keep drop rest');
    h.push(at('keep  rest', 9), 14, 0);
    expect(h.depth.undo).toBe(2);
    expect(h.undo(at('keep  rest', 9))?.content).toBe('keep drop rest');
  });

  it('coalesces a backspace run', () => {
    const h = new EditorHistory();
    h.reset('');
    let content = '';
    let now = 0;
    for (const ch of 'hello') {
      const caretBefore = content.length;
      content += ch;
      h.push(at(content), caretBefore, now);
      now += 50;
    }
    // The anchor is the caret *before* each delete, which is where the previous
    // delete left the caret — that is what makes the run contiguous despite the
    // caret moving backwards each time.
    for (let i = 0; i < 5; i++) {
      const caretBefore = content.length;
      content = content.slice(0, -1);
      h.push(at(content), caretBefore, now);
      now += 50;
    }
    expect(h.depth.undo).toBe(2);
    expect(h.undo(at('', 0))?.content).toBe('');
  });

  it('collapses typing a word and then deleting it into one step', () => {
    // The property that makes the contiguity rule worth having: because the
    // deletes are contiguous with the typing, the whole excursion undoes at
    // once instead of replaying backwards through every character.
    const h = new EditorHistory();
    h.reset('');
    let content = '';
    let now = 0;
    for (const ch of 'hello') {
      const before = content.length;
      content += ch;
      h.push(at(content), before, now);
      now += 50;
    }
    for (let i = 0; i < 5; i++) {
      const before = content.length;
      content = content.slice(0, -1);
      h.push(at(content), before, now);
      now += 50;
    }
    expect(h.depth.undo).toBe(2);
    expect(h.undo(at('', 0))?.content).toBe('');
  });

  it('keeps the caret where the burst began', () => {
    const h = new EditorHistory();
    h.reset('|');
    const start = 0;
    type(h, '', start, 'abc', 0);
    const undone = h.undo(at('abc', 3));
    // Undo restores the caret to the beginning of the typed run, not the end.
    expect(undone?.selectionStart).toBe(0);
  });
});

describe('limit', () => {
  it('drops the oldest entries past the limit', () => {
    const h = new EditorHistory({ limit: 5, coalesceMs: 0 });
    h.reset('0');
    for (let i = 1; i <= 20; i++) h.push(at(`v${i}`), 0, i * 1000);
    expect(h.depth.undo).toBe(5);
  });

  it('a default-sized history is bounded', () => {
    const h = new EditorHistory({ coalesceMs: 0 });
    h.reset('0');
    for (let i = 1; i <= 2000; i++) h.push(at(`v${i}`), 0, i);
    expect(h.depth.undo).toBeLessThanOrEqual(500);
  });
});

describe('undo then type then undo', () => {
  it('behaves like a linear history', () => {
    const h = new EditorHistory({ coalesceMs: 0 });
    h.reset('base');
    h.push(at('v1'), 4, 0);
    h.push(at('v2'), 4, 1000);
    // Undo back to v1, then edit forward.
    const atV1 = h.undo(at('v2'))!;
    expect(atV1.content).toBe('v1');
    h.push(at('v1 + more'), 10, 2000);
    // Undo once: the post-undo edit goes away.
    expect(h.undo(at('v1 + more'))?.content).toBe('v1');
  });
});
