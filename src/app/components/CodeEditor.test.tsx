/**
 * @vitest-environment jsdom
 *
 * Behavioural tests for the editor surface.
 *
 * Written *before* the editor-correctness work, against the behaviour as it
 * stood, so the known-bad cases are recorded explicitly rather than silently
 * changed. A test whose name starts with "SHALL" states the intended
 * behaviour; the ones that currently fail for that reason are the work items
 * for 1.1-1.3, and get inverted as each lands.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CodeEditor from './CodeEditor';

type EditorProps = React.ComponentProps<typeof CodeEditor>;

/** The two props every test must supply; everything else is optional. */
type Overrides = Partial<Omit<EditorProps, 'value' | 'onChange'>>;

/**
 * Render the editor.
 *
 * Props go in through a spread rather than JSX attributes on purpose: a JSX
 * string attribute does not process backslash escapes, so `value="a\nb"` would
 * pass a literal backslash-n to the component and every assertion would be
 * measuring the wrong string.
 */
function setup(value: string, overrides: Overrides = {}) {
  const onChange = vi.fn();
  const utils = render(<CodeEditor {...({ value, onChange, ...overrides } as EditorProps)} />);
  const ta = utils.container.querySelector('textarea');
  if (!ta) throw new Error('no textarea rendered');
  return { ...utils, onChange, ta };
}

/** Put the caret somewhere and fire the events the editor listens for. */
function placeCaret(ta: HTMLTextAreaElement, start: number, end = start) {
  ta.setSelectionRange(start, end);
  fireEvent.select(ta);
  fireEvent.keyUp(ta, { key: 'ArrowRight' });
}

describe('rendering', () => {
  it('renders the buffer in a textarea', () => {
    const { ta } = setup('let a = 1;\nlet b = 2;');
    expect(ta.value).toBe('let a = 1;\nlet b = 2;');
  });

  it('renders one highlight row per line', () => {
    const { container } = setup('let a = 1;\nlet b = 2;');
    const pre = container.querySelector('pre')!;
    const rows = Array.from(pre.children);
    // One row per line, plus a trailing zero-width-space row that gives the
    // last line room to scroll into view.
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('let a = 1;');
    expect(rows[1].textContent).toContain('let b = 2;');
    expect(rows[2].textContent).toBe('\u200B');
  });
});

describe('CRLF buffers', () => {
  // A file read from disk keeps its CRLF. The browser's textarea API
  // normalizes to LF on assignment, so the highlight layer has to agree —
  // otherwise every line renders as two line boxes and the gutter and caret
  // drift from the first line down.
  it('normalizes CRLF so the highlight layer agrees with the textarea', () => {
    const { ta, container } = setup('let a = 1;\r\nlet b = 2;');
    expect(ta.value).toBe('let a = 1;\nlet b = 2;');
    const rows = Array.from(container.querySelector('pre')!.children);
    // Two lines plus the trailing ZWSP row — a retained `\r` would read as a
    // CSS segment break and produce an extra line box per line.
    expect(rows).toHaveLength(3);
    // The invariant that actually matters: no carriage return reaches the DOM.
    for (const row of rows) expect(row.textContent).not.toContain('\r');
  });

  it('reports the correct line and column on a CRLF buffer', () => {
    const onCursorChange = vi.fn();
    const { ta } = setup('aa\r\nbb\r\ncc', { onCursorChange });
    // Start of line 3. Measured against the LF text the answer is column 1;
    // indexing the raw CRLF string would report one short per preceding line.
    placeCaret(ta, 6);
    expect(onCursorChange.mock.calls.at(-1)?.[0]).toEqual({ line: 3, col: 1 });
  });
});

describe('line editing', () => {
  it('Ctrl+D duplicates the caret line', () => {
    const { ta, onChange } = setup('let a = 1;\nlet b = 2;');
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: 'd', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('let a = 1;\nlet a = 1;\nlet b = 2;');
  });

  it('Ctrl+/ toggles a line comment on', () => {
    const { ta, onChange } = setup('let a = 1;\nlet b = 2;');
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: '/', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('// let a = 1;\nlet b = 2;');
  });

  it('Ctrl+Shift+K deletes the caret line', () => {
    const { ta, onChange } = setup('let a = 1;\nlet b = 2;');
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: 'K', ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledWith('let b = 2;');
  });

  it('edits the correct line on a CRLF buffer', () => {
    // The regression this pins: line bounds were computed from the raw CRLF
    // string using an offset that came from the LF-normalized textarea, so
    // every line operation landed `line - 1` characters early.
    const { ta, onChange } = setup('one\r\ntwo\r\nthree');
    placeCaret(ta, 8); // inside "three"
    fireEvent.keyDown(ta, { key: 'K', ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledWith('one\ntwo\n');
  });
});

describe('Tab and Shift+Tab', () => {
  it('Tab inserts spaces at the caret', () => {
    const { ta, onChange } = setup('let a = 1;', { tabSize: 4 });
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith('    let a = 1;');
  });

  // `it.fails` marks a known-broken behaviour: the suite stays green while the
  // bug is present and *fails loudly* the moment it is fixed, which is the cue
  // to flip it back to a plain `it`.
  it('outdents on Shift+Tab', () => {
    // There was no shiftKey check, so Shift+Tab inserted another indent instead
    // of removing one — data corruption, not a missing feature. Fixed by 1.2.
    const { ta, onChange } = setup('    indented', { tabSize: 4 });
    placeCaret(ta, 4);
    fireEvent.keyDown(ta, { key: 'Tab', shiftKey: true });
    expect(onChange).toHaveBeenCalledWith('indented');
  });

  it('outdents every line a multi-line selection spans', () => {
    const { ta, onChange } = setup('    a\n    b\nc', { tabSize: 4 });
    ta.setSelectionRange(0, 11);
    fireEvent.select(ta);
    fireEvent.keyDown(ta, { key: 'Tab', shiftKey: true });
    expect(onChange).toHaveBeenCalledWith('a\nb\nc');
  });

  it('indents every line a multi-line selection spans', () => {
    // Block indent did not exist: Tab collapsed the selection and inserted one
    // indent at the caret.
    const { ta, onChange } = setup('a\nb\nc', { tabSize: 4 });
    ta.setSelectionRange(0, 3);
    fireEvent.select(ta);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith('    a\n    b\nc');
  });

  it('outdent is a no-op on an unindented line', () => {
    const { ta, onChange } = setup('flat', { tabSize: 4 });
    placeCaret(ta, 2);
    fireEvent.keyDown(ta, { key: 'Tab', shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('outdent can be undone', () => {
    const { ta, onChange } = setup('    indented', { tabSize: 4 });
    placeCaret(ta, 4);
    fireEvent.keyDown(ta, { key: 'Tab', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith('indented');
    onChange.mockClear();
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('    indented');
  });

  it('indents with a tab character when insertSpaces is off', () => {
    const { ta, onChange } = setup('a', { tabSize: 4, insertSpaces: false });
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith('\ta');
  });
});

describe('auto-close', () => {
  it('inserts a pair for an opening bracket', () => {
    const { ta, onChange } = setup('');
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: '(' });
    expect(onChange).toHaveBeenCalledWith('()');
  });

  it('does not auto-close a closing bracket', () => {
    // Typing `)` must never insert a pair — `autoCloseMap` has no entry for it.
    // The complementary case (typing `)` *over* an auto-inserted `)`, which
    // should just step the caret past it) is unobservable in jsdom until 1.3
    // lands, because jsdom performs no native text insertion on keydown, so
    // "nothing happened" and "type-over worked" are indistinguishable here.
    // That test is added alongside the implementation.
    const { ta, onChange } = setup('()');
    placeCaret(ta, 1);
    fireEvent.keyDown(ta, { key: ')' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('find and replace', () => {
  it('Ctrl+F opens the find bar', () => {
    const { ta } = setup('abc');
    fireEvent.keyDown(ta, { key: 'f', ctrlKey: true });
    expect(screen.getByPlaceholderText(/find/i)).toBeTruthy();
  });

  it('Ctrl+H opens find together with the replace field', () => {
    const { ta } = setup('abc');
    fireEvent.keyDown(ta, { key: 'h', ctrlKey: true });
    expect(screen.getByPlaceholderText(/replace/i)).toBeTruthy();
  });
});

describe('undo', () => {
  it('undoes a programmatic edit', () => {
    // The editor is a fully controlled textarea, so React reassigns `value` on
    // every change and the browser's native undo stack is cleared — Ctrl+Z used
    // to do nothing at all. This is the regression net for the history added in
    // 1.1.
    const { ta, onChange } = setup('one\ntwo');
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: 'd', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('one\none\ntwo');

    onChange.mockClear();
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('one\ntwo');
  });

  it('redoes an undone edit', () => {
    const { ta, onChange } = setup('one\ntwo');
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: 'd', ctrlKey: true });
    onChange.mockClear();
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith('one\ntwo');
    onChange.mockClear();
    fireEvent.keyDown(ta, { key: 'y', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('one\none\ntwo');
  });

  it('accepts Ctrl+Shift+Z as redo', () => {
    const { ta, onChange } = setup('abc');
    placeCaret(ta, 3);
    fireEvent.change(ta, { target: { value: 'abcd' } });
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    onChange.mockClear();
    fireEvent.keyDown(ta, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledWith('abcd');
  });

  it('undoes a burst of typing as one step', () => {
    const { ta, onChange } = setup('');
    // One character at a time, as a real keyboard delivers it. Firing a single
    // change with the finished word would be a paste, and the history
    // deliberately refuses to coalesce a multi-character jump — otherwise one
    // undo would remove a pasted block and the word typed before it together.
    for (const partial of ['h', 'he', 'hel', 'hell', 'hello']) {
      fireEvent.change(ta, { target: { value: partial } });
    }
    onChange.mockClear();
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('does not coalesce a multi-character change into the preceding typing', () => {
    const { ta, onChange } = setup('');
    fireEvent.change(ta, { target: { value: 'ab' } }); // two keystrokes' worth
    fireEvent.change(ta, { target: { value: 'ab LOTS OF TEXT' } }); // a paste
    onChange.mockClear();
    // Undo once removes only the paste.
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('ab');
    onChange.mockClear();
    // Undo again removes the typing.
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('does not undo a value that came from outside the editor', () => {
    // A file switch or an agent write replaces `value` without passing through
    // the editor. Ctrl+Z must not walk one buffer into another.
    const { ta, onChange, rerender } = setup('original');
    placeCaret(ta, 0);
    fireEvent.change(ta, { target: { value: 'original!' } });
    expect(onChange).toHaveBeenCalledWith('original!');

    onChange.mockClear();
    // Simulate the host swapping the file.
    rerender(<CodeEditor {...({ value: 'a different file', onChange } as EditorProps)} />);
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('undoes a Tab insert', () => {
    const { ta, onChange } = setup('x', { tabSize: 2 });
    placeCaret(ta, 0);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith('  x');
    onChange.mockClear();
    fireEvent.keyDown(ta, { key: 'z', ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith('x');
  });
});

describe('gutter', () => {
  it('numbers every line', () => {
    const { container } = setup('one\ntwo\nthree');
    // Gutter rows are spans, one per line, carrying the line number.
    const text = container.textContent ?? '';
    expect(text).toContain('1');
    expect(text).toContain('2');
    expect(text).toContain('3');
  });

  it('marks a line carrying a breakpoint', () => {
    const before = render(<CodeEditor value="one&#10;two" onChange={() => {}} />);
    const after = render(
      <CodeEditor value="one&#10;two" onChange={() => {}} breakpoints={new Set([1])} />,
    );
    // The breakpoint dot is the only thing that changes.
    expect(after.container.innerHTML).not.toEqual(before.container.innerHTML);
  });
});
