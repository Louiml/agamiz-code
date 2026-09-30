/**
 * Line indentation for Tab and Shift+Tab.
 *
 * Tab inserted `tabSize` spaces at the caret unconditionally, with no check for
 * `shiftKey`. That made Shift+Tab — the universal outdent — *add* indentation,
 * which is data corruption rather than a missing feature. Block indent was
 * absent too: with a multi-line selection, Tab collapsed the selection and
 * inserted one indent at the caret.
 *
 * Kept pure and separate from the component so the selection arithmetic can be
 * tested directly; the awkward part of an editor operation is rarely the
 * keystroke, it is what happens to the selection afterwards.
 */

/** One indent unit: a tab character, or `tabSize` spaces. */
export type IndentUnit = string;

export interface IndentOptions {
  /** Rendered form of one indent level. */
  unit: IndentUnit;
  /**
   * When true, a line already starting with whitespace is left alone rather
   * than being stripped. This is what keeps outdent from eating a line's
   * content when a line has no indentation to remove.
   */
  keepNonIndented?: boolean;
}

export interface IndentResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** False when there was nothing to do, so the caller can skip emitting. */
  changed: boolean;
}

/** Split on '\n' while remembering the offsets, so selections survive. */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  return starts;
}

/** The half-open range of lines the selection touches. */
function affectedLines(text: string, start: number, end: number): { first: number; last: number } {
  const lines = text.split('\n');
  const starts = lineStarts(lines);
  const first = lineIndexAt(starts, start);
  // A selection ending exactly at a line start does not really touch that line.
  const last = end > start ? lineIndexAt(starts, Math.max(start, end - 1)) : first;
  return { first, last: Math.max(first, last) };
}

function lineIndexAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Leading whitespace of `line`, as a string. */
function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/**
 * Indent every line the selection touches.
 *
 * With a collapsed caret this is the single caret line. With a multi-line
 * selection it is every line the selection spans, and the selection grows to
 * cover the inserted units so a second Tab indents further rather than
 * replacing.
 */
export function indentBlock(
  text: string,
  start: number,
  end: number,
  options: IndentOptions,
): IndentResult {
  const lines = text.split('\n');
  const { first, last } = affectedLines(text, start, end);

  for (let i = first; i <= last; i++) lines[i] = options.unit + lines[i];

  const newText = lines.join('\n');
  const width = options.unit.length;

  // A collapsed caret keeps its position within the line, shifted past the unit
  // that was inserted in front of it. A multi-line selection snaps to whole
  // lines instead, so a second Tab deepens the same lines rather than
  // replacing the selection with a single indent.
  if (start === end) {
    const at = start + width;
    return { text: newText, selectionStart: at, selectionEnd: at, changed: true };
  }
  const newStarts = lineStarts(lines);
  return {
    text: newText,
    selectionStart: newStarts[first],
    selectionEnd: newStarts[last] + lines[last].length,
    changed: true,
  };
}

/**
 * Remove up to one indent level from every line the selection touches.
 *
 * A line with no leading whitespace is left untouched, so outdent at column 0
 * is a no-op rather than eating into the line's content. Whitespace-only lines
 * collapse to empty, which is the conventional behaviour and avoids leaving a
 * trail of spaces behind.
 */
export function outdentBlock(
  text: string,
  start: number,
  end: number,
  options: IndentOptions,
): IndentResult {
  const lines = text.split('\n');
  const starts = lineStarts(lines);
  const { first, last } = affectedLines(text, start, end);
  const width = options.unit.length;

  // How many characters each affected line loses, so the selection can be
  // re-expressed against the new text rather than guessed at.
  const removed: number[] = [];

  for (let i = first; i <= last; i++) {
    const line = lines[i];
    const lead = leadingWhitespace(line);
    if (lead === '') {
      if (line.trim() === '') {
        lines[i] = '';
        removed[i] = line.length;
      } else {
        removed[i] = 0;
      }
      continue;
    }
    const take = Math.min(width, lead.length);
    lines[i] = line.slice(take);
    removed[i] = take;
  }

  const total = removed.reduce((n, r) => n + (r ?? 0), 0);
  if (total === 0) {
    return { text, selectionStart: start, selectionEnd: end, changed: false };
  }

  const newLines = lines.slice();
  const newStarts = lineStarts(newLines);

  // A collapsed caret is re-expressed as (line, column) and its column shrinks
  // by what that line lost, so it stays on the same character. A multi-line
  // selection snaps to whole lines, for the same reason it does on indent.
  if (start === end) {
    const column = start - starts[first];
    const at = newStarts[first] + Math.max(0, column - (removed[first] ?? 0));
    return { text: newLines.join('\n'), selectionStart: at, selectionEnd: at, changed: true };
  }
  return {
    text: newLines.join('\n'),
    selectionStart: newStarts[first],
    selectionEnd: newStarts[last] + newLines[last].length,
    changed: true,
  };
}
