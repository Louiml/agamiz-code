/**
 * Line-ending and line-index helpers for the editor.
 *
 * The editor keeps its buffer in whatever form it arrived in, but the
 * `<textarea>`'s DOM value is always LF — the browser normalizes CRLF to LF
 * on assignment *and* reports the normalized form from `.value`. So a file
 * opened off disk with CRLF used to put the highlighter (which split on
 * `'\n'` and kept the `\r`) out of sync with the text the user actually sees:
 * under `white-space: pre` a CR is a CSS segment break, so every line rendered
 * as two line boxes while the textarea rendered one. Gutter, ruler, caret tint
 * and every reported line/column drifted from the first line down.
 *
 * The fix has two halves and both live here:
 *
 *   1. Normalize once on the way in, so highlighting and index arithmetic share
 *      a single coordinate system with the textarea.
 *   2. Restore the file's original EOL on the way out, so a one-character edit
 *      does not rewrite every line ending in the file (a whole-file diff).
 */

import type { Eol } from './tabs';

export type { Eol };

/** A `\r\n` or a `\n` that is not part of one. A bare `\r` is ordinary text. */
const EOL_RE = /\r\n|\n/g;
const CRLF_RE = /\r\n/g;

/**
 * The dominant line ending in `text`.
 *
 * A file that has been through Windows and Unix tooling is often mixed, so this
 * counts rather than samples: whichever sequence appears more often wins, and a
 * buffer with no newline at all defaults to LF.
 */
export function detectEol(text: string): Eol {
  const crlf = text.match(CRLF_RE)?.length ?? 0;
  const total = text.match(EOL_RE)?.length ?? 0;
  if (total === 0) return '\n';
  return crlf * 2 > total ? '\r\n' : '\n';
}

/** CRLF → LF. Idempotent, and leaves a bare `\r` alone. */
export function normalizeEol(text: string): string {
  return text.includes('\r\n') ? text.replace(CRLF_RE, '\n') : text;
}

/**
 * Split into logical lines on the same boundaries `normalizeEol` produces, so
 * `line` indices agree with what the highlighter and the textarea see.
 */
export function splitLines(text: string): string[] {
  return normalizeEol(text).split('\n');
}

/**
 * Normalized-text view of a buffer: the exact string every index in the editor
 * is measured against. Memoize this on `content` and thread it through.
 */
export interface NormalizedBuffer {
  /** Buffer with every CRLF collapsed to LF. */
  text: string;
  lines: string[];
  eol: Eol;
  /** Character offset where each line starts, for O(1) line/col lookups. */
  starts: number[];
}

export function normalizeBuffer(content: string, eol?: Eol): NormalizedBuffer {
  const text = normalizeEol(content);
  const lines = text.split('\n');
  const starts: number[] = new Array(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = at;
    at += lines[i].length + 1;
  }
  return { text, lines, eol: eol ?? detectEol(content), starts };
}

/** Offset of the first character of `line` (0-based) in the normalized text. */
export function lineStartOffset(buffer: NormalizedBuffer, line: number): number {
  const i = Math.min(Math.max(line, 0), buffer.lines.length - 1);
  return buffer.starts[i];
}

/** Offset just past the last character of `line` (0-based), before its newline. */
export function lineEndOffset(buffer: NormalizedBuffer, line: number): number {
  const i = Math.min(Math.max(line, 0), buffer.lines.length - 1);
  return buffer.starts[i] + buffer.lines[i].length;
}

/**
 * 1-based `{line, col}` for a caret offset in the *normalized* text.
 *
 * This is what the status bar and the extension host are given. Deriving it
 * from a string that still contains CRLF was the source of the off-by-one-per-
 * preceding-line column drift.
 */
export function positionAt(buffer: NormalizedBuffer, index: number): { line: number; col: number } {
  const at = Math.min(Math.max(index, 0), buffer.text.length);
  let line = 0;
  for (let i = 0; i < at; i++) {
    if (buffer.text.charCodeAt(i) === 10) line++;
  }
  return { line: line + 1, col: at - buffer.starts[line] + 1 };
}

/** 0-based line containing `index`. */
export function lineAt(buffer: NormalizedBuffer, index: number): number {
  return positionAt(buffer, index).line - 1;
}

/**
 * Rewrite a normalized buffer with the file's own line ending.
 *
 * Applied immediately before `save_file`. Doing it in `handleSave` rather than
 * in the editor keeps the buffer LF-only in memory, so nothing downstream has
 * to think about CRLF again.
 */
export function restoreEol(content: string, eol: Eol): string {
  if (eol === '\n') return normalizeEol(content);
  return normalizeEol(content).replace(/\n/g, '\r\n');
}

/** The width of the widest line, for the ruler. Never 0, so the divide is safe. */
export function longestLine(lines: string[]): number {
  let max = 1;
  for (const line of lines) {
    if (line.length > max) max = line.length;
  }
  return max;
}
