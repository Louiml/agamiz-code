'use client';

import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import EditorContextMenu from './EditorContextMenu';
import { Icon, IconName } from './Icon';
import { getSuggestions, Suggestion } from '../../languages/completion';
import { EditorHistory } from '../features/editorHistory';
import { indentBlock, outdentBlock } from '../features/indent';
import { contextAt, decideAutoClose } from '../features/autoClose';
import { lineAt, lineEndOffset, lineStartOffset, longestLine, normalizeBuffer, positionAt } from '../features/eol';
import { tokenize } from '../../languages/tokenizer';
import type { TokenType as LangTokenType } from '../../languages/types';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  onCursorChange?: (pos: { line: number; col: number }) => void;
  /** Language id of the buffer, used to drive autocomplete. */
  languageId?: string;
  fontSize?: number;
  tabSize?: number;
  autoClose?: boolean;
  /**
   * Indent with `tabSize` spaces (true) or a tab character (false).
   *
   * Backed by the `editor.insertSpaces` setting, which was declared and
   * editable but had no reader anywhere — so changing it did nothing.
   */
  insertSpaces?: boolean;
  /* --- Appearance (settings-driven) --- */
  /** CSS font stack for the code area. */
  fontFamily?: string;
  /** `fontVariantLigatures` for both text layers. */
  ligatures?: boolean;
  /** Line box as a multiple of `fontSize`; the gutter and caret track it. */
  lineHeight?: number;
  /** Gutter numbering mode. */
  lineNumbers?: 'on' | 'off' | 'relative';
  /** Soft-wrap long lines. `bounded` wraps at `wordWrapColumn`. */
  wordWrap?: 'off' | 'on' | 'bounded';
  wordWrapColumn?: number;
  /** Draw whitespace markers in the highlight layer. */
  renderWhitespace?: 'none' | 'boundary' | 'all';
  /** Tint the active line in the highlight layer. */
  activeLineHighlight?: boolean;
  /** Render the minimap rail. Purely presentational — the bespoke editor has
   *  no viewport mapping, so the rail is a proportional bar of line weights. */
  minimapEnabled?: boolean;
  minimapScale?: number;
  /* --- Debugging --- */
  /** 1-based lines carrying a breakpoint. Rendered as gutter dots. */
  breakpoints?: Set<number>;
  /** 1-based line execution is currently parked on, when paused. */
  pausedLine?: number | null;
  /** Toggle a breakpoint on a 1-based line. */
  onToggleBreakpoint?: (line: number) => void;
  /** Start a debug session (F5-style). */
  onDebug?: () => void;
  /**
   * Scroll to and select a 1-based line, once `token` changes.
   *
   * Token-guarded on purpose: the terminal's "Open File at Line" action fires
   * once per invocation, but `value` changes on every keystroke. Keying the
   * effect on the token means the reveal happens exactly when it is asked for
   * and is never re-run by an unrelated edit.
   */
  revealLine?: { line: number; token: number } | null;
}


const KIND_ICON: Record<Suggestion['kind'], IconName> = {
  keyword: 'key',
  type: 'box',
  builtin: 'zap',
  constant: 'dot',
  snippet: 'file-code',
  function: 'git-branch',
  symbol: 'list',
};

const KIND_CLASS: Record<Suggestion['kind'], string> = {
  keyword: 'text-purple-400',
  type: 'text-cyan-400',
  builtin: 'text-yellow-400',
  constant: 'text-amber-400',
  snippet: 'text-green-400',
  function: 'text-amber-300',
  symbol: 'text-emerald-400',
};


/**
 * Styles for the registry tokenizer's token vocabulary.
 *
 * Covers the full registry vocabulary, including the markup and`r`n * literal-value kinds that Rak never produced.
 */
function getTokenStyle(type: LangTokenType): React.CSSProperties {
  switch (type) {
    case 'keyword': return { color: 'var(--ag-syn-keyword)', fontWeight: 600 };
    case 'type': return { color: 'var(--ag-syn-type)' };
    case 'builtin': return { color: 'var(--ag-syn-builtin)' };
    case 'constant': return { color: 'var(--ag-syn-constant)' };
    case 'number':
    case 'float': return { color: 'var(--ag-syn-number)' };
    case 'string':
    case 'attr-string': return { color: 'var(--ag-syn-string)' };
    case 'regex': return { color: 'var(--ag-syn-regex)' };
    case 'char': return { color: 'var(--ag-syn-char)' };
    case 'comment': return { color: 'var(--ag-syn-comment)', fontStyle: 'italic' };
    case 'op': return { color: 'var(--ag-syn-operator)' };
    case 'tag': return { color: 'var(--ag-syn-tag)' };
    case 'attr': return { color: 'var(--ag-syn-attr)' };
    case 'property': return { color: 'var(--ag-syn-property)' };
    case 'selector': return { color: 'var(--ag-syn-selector)' };
    case 'macro': return { color: 'var(--ag-syn-macro)' };
    case 'ident': return { color: 'var(--ag-syn-ident)' };
    // Whitespace is rendered as-is; colouring it would fight the space markers
    // the overlay draws underneath.
    case 'ws': return {};
    default: return { color: 'var(--ag-syn-default)' };
  }
}

/**
 * Drop the leading and trailing whitespace tokens from a line.
 *
 * `renderWhitespace` peels the indentation off the front and the trailing run
 * off the back so it can draw space markers, and then highlights only what is
 * left. Handing `renderLine` the whole token list would colour the indentation
 * as ordinary text underneath those markers, so the two edge runs are removed
 * to match.
 */
function stripEdgeWs(tokens?: { type: LangTokenType; value: string }[]) {
  if (!tokens) return undefined;
  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start].type === 'ws') start++;
  while (end > start && tokens[end - 1].type === 'ws') end--;
  return tokens.slice(start, end);
}

function renderLine(line: string, tokens?: { type: LangTokenType; value: string }[]): React.ReactNode {
  if (line.length === 0) return '\u200B';
  const use = tokens ?? tokenize(line, 'rak')[0] ?? [];
  return use.map((token, i) => (
    <span key={i} style={getTokenStyle(token.type)}>{token.value}</span>
  ));
}

export default function CodeEditor({
  value, onChange, onRun, onCursorChange,
  languageId,
  fontSize = 14, tabSize = 4, autoClose = true,
  insertSpaces = true,
  fontFamily = 'var(--font-geist-mono), ui-monospace, monospace',
  ligatures = false,
  lineHeight: lineHeightScale = 1.45,
  lineNumbers = 'on',
  wordWrap = 'off',
  wordWrapColumn = 80,
  renderWhitespace: renderWhitespaceMode = 'none',
  activeLineHighlight = true,
  minimapEnabled = false,
  minimapScale = 1,
  breakpoints,
  pausedLine = null,
  onToggleBreakpoint,
  onDebug,
  revealLine,
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  /**
   * The editor's single coordinate system.
   *
   * The `<textarea>`'s DOM value is always LF — browsers normalize CRLF on
   * assignment and report the normalized form from `.value` — while `value`
   * arrives from `read_file` with whatever the file on disk used. Indexing the
   * CRLF string with an offset that came from the LF textarea was wrong by one
   * character for every preceding line, which is what desynced the gutter, the
   * caret tint, the status-bar column, and every line-bounds edit (duplicate,
   * comment, delete). Under `white-space: pre` a CR is also a CSS segment
   * break, so the highlight layer rendered each line as two line boxes.
   *
   * `buffer.text` is therefore the one string every offset in this component
   * is measured against, and `buffer.lines` is what the highlighter and gutter
   * walk. The file's real EOL is carried on the tab and restored in
   * `handleSave`, so nothing downstream has to think about it again.
   */
  const buffer = useMemo(() => normalizeBuffer(value), [value]);
  const lines = buffer.lines;

  /**
   * Every pixel metric in the editor derives from these two numbers. They were
   * previously hard-coded in four separate places (the highlight layer, the
   * textarea, the gutter row height, and the `goToLine` scroll maths), which
   * meant a line-height setting had to be threaded through all of them by hand
   * and would silently desync if one was missed.
   */
  const lineHeightPx = Math.round(fontSize * lineHeightScale);
  const fontLigatures = ligatures ? 'contextual' : 'none';

  /**
   * One style object shared by the highlight `<pre>` and the transparent
   * `<textarea>`. The two must agree character-for-character or the coloured
   * overlay drifts away from the caret, so they are derived together.
   */
  const textLayerStyle: React.CSSProperties = {
    fontFamily,
    fontSize,
    lineHeight: `${lineHeightPx}px`,
    fontVariantLigatures: fontLigatures,
    tabSize,
    whiteSpace: wordWrap === 'off' ? 'pre' : 'pre-wrap',
    overflowWrap: wordWrap === 'bounded' ? 'anywhere' : 'normal',
  };
  /** `bounded` needs a hard column; `pre-wrap` alone wraps at the viewport. */
  const wrapStyle: React.CSSProperties =
    wordWrap === 'bounded'
      ? { maxWidth: `${wordWrapColumn}ch`, minWidth: '100%' }
      : {};

  // Find/Replace state
  const [findOpen, setFindOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Autocomplete state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionTop, setSuggestionTop] = useState(0);
  const [suggestionLeft, setSuggestionLeft] = useState(0);

  /** Caret row, tracked locally for relative line numbers and the line tint. */
  const [cursorLine, setCursorLine] = useState(1);

  /* ---------------------------------------------------------------- */
  /* Undo / redo                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * The textarea is fully controlled, so React reassigns `value` on every
   * state change — and per the HTML spec that clears the browser's native undo
   * stack. Ctrl+Z therefore stopped working after the first keystroke, and every
   * programmatic edit (Tab, auto-close, duplicate line, replace) was
   * indistinguishable from a manual one. The history model is in
   * `features/editorHistory`; this is the plumbing.
   */
  // A lazy `useState` initialiser rather than a ref written during render: it
  // runs exactly once, before the first paint, and is stable for the component's
  // lifetime. Seeding it with the mount value matters — the effect below only
  // fires when `value` *changes*, so an unseeded history would make the first
  // undo a no-op on a freshly opened file.
  const [history] = useState(() => {
    const h = new EditorHistory();
    h.reset(value);
    return h;
  });

  /**
   * The last value the editor itself emitted.
   *
   * A `value` prop that differs from this did not come from typing: it is a
   * file switch, an external reload, or an agent write. Those must not be
   * undoable, or Ctrl+Z would walk one buffer into another.
   */
  const lastEmittedRef = useRef(value);

  // Reset whenever the buffer is replaced from outside.
  const historyValueRef = useRef(value);
  useEffect(() => {
    if (historyValueRef.current === value) return;
    historyValueRef.current = value;
    const ta = textareaRef.current;
    history.reset(value, ta?.selectionStart ?? 0, ta?.selectionEnd ?? ta?.selectionStart ?? 0);
    lastEmittedRef.current = value;
    // `history` is stable for the component's lifetime, so listing it costs
    // nothing and keeps the effect honest.
  }, [value, history]);

  /**
   * Apply an edit: publish it, record it, and remember it as ours.
   *
   * `anchor` is the caret position *before* the edit, which is what the
   * history uses to decide whether the next change continues the same burst.
   */
  const commit = useCallback((next: string, anchor: number, caret = next.length) => {
    lastEmittedRef.current = next;
    history.push({ content: next, selectionStart: caret, selectionEnd: caret }, anchor, Date.now());
    onChange(next);
  }, [history, onChange]);

  const undo = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const current = {
      content: lastEmittedRef.current,
      selectionStart: ta.selectionStart,
      selectionEnd: ta.selectionEnd,
    };
    const target = history.undo(current);
    if (!target) return;
    lastEmittedRef.current = target.content;
    onChange(target.content);
    // Restore the caret after React has committed the new value; assigning it
    // synchronously would be overwritten by the re-render.
    setTimeout(() => {
      if (!textareaRef.current) return;
      const at = Math.min(target.selectionStart, target.content.length);
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = at;
    }, 0);
  }, [history, onChange]);

  const redo = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const current = {
      content: lastEmittedRef.current,
      selectionStart: ta.selectionStart,
      selectionEnd: ta.selectionEnd,
    };
    const target = history.redo(current);
    if (!target) return;
    lastEmittedRef.current = target.content;
    onChange(target.content);
    setTimeout(() => {
      if (!textareaRef.current) return;
      const at = Math.min(target.selectionStart, target.content.length);
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = at;
    }, 0);
  }, [history, onChange]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const syncScroll = () => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Find/replace logic. All offsets are resolved against `buffer.text` because
  // they are handed to the textarea, whose value is LF-normalized; searching
  // `value` instead would put the selection `newline count` characters off on
  // a CRLF file.
  const findMatches = useCallback((query: string) => {
    if (!query) { setMatchCount(0); setCurrentMatch(0); return; }
    let count = 0;
    let pos = 0;
    while ((pos = buffer.text.indexOf(query, pos)) !== -1) { count++; pos += query.length; }
    setMatchCount(count);
    setCurrentMatch(count > 0 ? 1 : 0);
  }, [buffer]);

  useEffect(() => {
    if (findQuery) findMatches(findQuery);
  }, [findQuery, buffer, findMatches]);

  const findNext = () => {
    if (!findQuery || !textareaRef.current) return;
    const ta = textareaRef.current;
    const start = ta.selectionEnd;
    let pos = buffer.text.indexOf(findQuery, start);
    if (pos === -1) pos = buffer.text.indexOf(findQuery, 0);
    if (pos !== -1) {
      ta.focus();
      ta.selectionStart = pos;
      ta.selectionEnd = pos + findQuery.length;
      const matches = buffer.text.split(findQuery).length - 1;
      const current = buffer.text.substring(0, pos).split(findQuery).length;
      setCurrentMatch(current > matches ? 1 : current);
    }
  };

  const findPrev = () => {
    if (!findQuery || !textareaRef.current) return;
    const ta = textareaRef.current;
    const start = ta.selectionStart - 1;
    let pos = buffer.text.lastIndexOf(findQuery, start);
    if (pos === -1) pos = buffer.text.lastIndexOf(findQuery);
    if (pos !== -1) {
      ta.focus();
      ta.selectionStart = pos;
      ta.selectionEnd = pos + findQuery.length;
    }
  };

  const replaceNext = () => {
    if (!findQuery || !textareaRef.current) return;
    const ta = textareaRef.current;
    const selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
    if (selected === findQuery) {
      const newValue = buffer.text.substring(0, ta.selectionStart) + replaceQuery + buffer.text.substring(ta.selectionEnd);
      commit(newValue, ta.selectionStart, ta.selectionStart + replaceQuery.length);
      setTimeout(() => {
        if (textareaRef.current) {
          const pos = ta.selectionStart + replaceQuery.length;
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = pos;
        }
      }, 0);
    }
    findNext();
  };

  const replaceAll = () => {
    if (!findQuery) return;
    const newValue = buffer.text.split(findQuery).join(replaceQuery);
    if (newValue === buffer.text) return;
    // Anchor at the first match, so undoing a replace-all is one step and the
    // caret lands somewhere meaningful.
    commit(newValue, Math.max(0, buffer.text.indexOf(findQuery)));
    setMatchCount(0);
  };

  // Autocomplete logic. Everything language-specific — the vocabulary, the
  // buffer symbols and the context predictions — is decided by
  // `src/languages/completion.ts` from the active `languageId`.
  const updateSuggestions = (force = false) => {
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    const pos = ta.selectionStart;
    const before = buffer.text.substring(0, pos);
    const wordMatch = before.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
    const matches = getSuggestions({ languageId, source: buffer.text, offset: pos, force });

    if (matches.length > 0 && (matches.length > 1 || !wordMatch || matches[0].label !== wordMatch[0])) {
      setSuggestions(matches);
      setSuggestionIndex(0);
      setShowSuggestions(true);
      // Anchor the popup to the caret. The 16px is the `p-4` padding and the
      // 0.6em character width comes from the resolved font size, so the popup
      // stays glued to the caret under any font/line-height setting.
      const col = pos - lineStartOffset(buffer, lineAt(buffer, pos));
      const scrollTop = ta.scrollTop;
      const scrollLeft = ta.scrollLeft;
      const charWidth = lineHeightPx * 0.6;
      setSuggestionTop(16 + (lineAt(buffer, pos) + 1) * lineHeightPx - scrollTop);
      setSuggestionLeft(16 + (col + 1) * charWidth - scrollLeft);
      return;
    }
    setShowSuggestions(false);
  };

  const insertSuggestion = (suggestion: Suggestion) => {
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    const pos = ta.selectionStart;
    const before = buffer.text.substring(0, pos);
    const after = buffer.text.substring(pos);
    const wordMatch = before.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
    // Predictions / forced inserts replace nothing when there is no word prefix.
    const newBefore = wordMatch ? before.substring(0, before.length - wordMatch[0].length) : before;
    const inserted = suggestion.body ?? suggestion.label;
    const newValue = newBefore + inserted + after;
    // Anchor at the start of the replaced word so a completion is its own undo
    // step rather than merging into the typing that preceded it.
    commit(newValue, newBefore.length, newBefore.length);

    // Land the caret on the first line of the body that is not a closing
    // delimiter, which is the blank line the fragment left for the user. The
    // indent is read from the body rather than assumed, so `{ … }`, `: …` and
    // `… end` fragments all work.
    let cursorOffset = newBefore.length + inserted.length;
    const firstNewline = inserted.indexOf('\n');
    if (firstNewline !== -1) {
      const rest = inserted.slice(firstNewline + 1);
      cursorOffset = newBefore.length + firstNewline + 1 + (/^[ \t]*/.exec(rest)![0].length);
    }
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = cursorOffset;
        textareaRef.current.focus();
      }
    }, 0);
    setShowSuggestions(false);
  };

  const reportCursor = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Offsets come from the textarea (LF) and are resolved against the same
    // normalized text, so the column no longer drifts by one per preceding line.
    const { line, col } = positionAt(buffer, ta.selectionStart);
    // The gutter's relative numbering and the active-line tint both need the
    // caret row; the parent only cares about the status-bar readout.
    setCursorLine(line);
    onCursorChange?.({ line, col });
  }, [buffer, onCursorChange]);

  /**
   * Character bounds of the caret's line, in normalized-text coordinates.
   *
   * `selectionStart` is a DOM offset into the LF-normalized textarea value, so
   * it is only meaningful against `buffer.text`. Slicing `value` with it was
   * off by one for every preceding CRLF line, which made duplicate/comment/
   * delete-line operate on the wrong span.
   */
  const getLineBounds = (): { start: number; end: number } => {
    const start = textareaRef.current?.selectionStart ?? 0;
    const row = lineAt(buffer, start);
    return { start: lineStartOffset(buffer, row), end: lineEndOffset(buffer, row) };
  };

  const toggleComment = () => {
    const { start, end } = getLineBounds();
    const line = buffer.text.substring(start, end);
    if (line.trimStart().startsWith('//')) {
      const newLine = line.replace(/^\s*\/\/\s?/, '');
      commit(buffer.text.substring(0, start) + newLine + buffer.text.substring(end), start, start);
    } else {
      commit(buffer.text.substring(0, start) + '// ' + line + buffer.text.substring(end), start, start);
    }
  };

  const duplicateLine = () => {
    const { start, end } = getLineBounds();
    const line = buffer.text.substring(start, end);
    commit(buffer.text.substring(0, start) + line + '\n' + line + buffer.text.substring(end), start, start);
  };

  const deleteLine = () => {
    const { start, end } = getLineBounds();
    commit(buffer.text.substring(0, start) + buffer.text.substring(Math.min(end + 1, buffer.text.length)), start, start);
  };

  const moveLine = (dir: number) => {
    const next = buffer.lines.slice();
    const ta = textareaRef.current;
    if (!ta) return;
    const lineIdx = lineAt(buffer, ta.selectionStart);
    const target = lineIdx + dir;
    if (target < 0 || target >= next.length) return;
    const [line] = next.splice(lineIdx, 1);
    next.splice(target, 0, line);
    // A line move is not a contiguous edit, so it is always its own step: the
    // anchor is the line start and the length delta is large.
    commit(next.join('\n'), ta.selectionStart, ta.selectionStart);
  };

  const goToLine = (n: number) => {
    const idx = Math.max(0, Math.min(n - 1, buffer.lines.length - 1));
    const charPos = lineStartOffset(buffer, idx);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = charPos;
      // Both layers carry the same `p-4` top padding, so the target line has
      // to be offset by it — and centred rather than pinned to the top.
      const pad = 16;
      ta.scrollTop = Math.max(0, pad + idx * lineHeightPx - ta.clientHeight / 2);
      syncScroll();
    }
  };

  // Reveal a line requested from outside (the terminal's "Open File at Line").
  // Keyed on the token rather than the line, so repeated requests for the same
  // line still fire and ordinary edits never trigger a stray jump.
  useEffect(() => {
    if (!revealLine) return;
    goToLine(revealLine.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealLine?.token]);

  /**
   * Whole-buffer tokenization for the highlight layer and for auto-close
   * context.
   *
   * The registry tokenizer carries state across lines, which is the point: a
   * block comment or a Python triple-quoted string spans lines, and tokenizing
   * a single line in isolation cannot know it is still inside one. The previous
   * per-line approach highlighted the body of every multi-line construct as
   * ordinary code.
   *
   * Memoised on the text and language so this costs one pass per edit rather
   * than one per rendered line. For very large files that is still O(file) per
   * keystroke, which is the known rendering-performance follow-up.
   */
  const langTokens = useMemo(
    () => tokenize(buffer.text, languageId),
    [buffer.text, languageId],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;

    // Undo / redo, before anything else claims the chord.
    //
    // The browser's own handlers cannot work here: React reassigns `value` on
    // every change, which clears the native undo stack, so these would otherwise
    // be no-ops. Ctrl+Shift+Z is accepted alongside Ctrl+Y because both are
    // muscle memory and the two disagree between platforms.
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (k === 'y') {
        e.preventDefault();
        redo();
        return;
      }
    }

    // Ctrl+/ - Toggle comment
    if (mod && e.key === '/') {
      e.preventDefault();
      toggleComment();
      return;
    }
    // Ctrl+D - Duplicate line
    if (mod && e.key === 'd' && !e.shiftKey) {
      e.preventDefault();
      duplicateLine();
      return;
    }
    // Ctrl+Shift+K - Delete line
    if (mod && e.shiftKey && e.key === 'K') {
      e.preventDefault();
      deleteLine();
      return;
    }
    // Alt+Up / Alt+Down - Move line
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      moveLine(-1);
      return;
    }
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      moveLine(1);
      return;
    }
    // Ctrl+G - Go to line
    if (mod && e.key === 'g' && !e.shiftKey) {
      e.preventDefault();
      const n = prompt('Go to line:');
      if (n && !isNaN(Number(n))) {
        goToLine(Number(n));
      }
      return;
    }

    // Auto-close brackets and quotes.
    //
    // The decision lives in features/autoClose.ts because the rules are the
    // fiddly part: step over a closer that is already there, wrap a selection
    // rather than replacing it, and do nothing at all inside a string or a
    // comment. The component only supplies the token context and applies the
    // result.
    if (!mod && !e.altKey && !e.key.startsWith('Arrow')) {
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const row = lineAt(buffer, start);
      // Reuse the buffer's already-tokenized lines rather than re-scanning
      // this one: the caret is inside `langTokens[row]`, and multi-line
      // strings and comments are only tracked correctly because the pass
      // started at the top of the file.
      const lineTokens = langTokens[row] ?? [];
      const decision = decideAutoClose({
        key: e.key,
        text: buffer.text,
        selectionStart: start,
        selectionEnd: end,
        context: contextAt(lineTokens, start - lineStartOffset(buffer, row)),
        enabled: autoClose,
      });

      if (decision.kind === 'typeOver') {
        // Nothing to insert — just step the caret past the closer that is
        // already there, which is what stops `(` then `)` yielding `foo())`.
        e.preventDefault();
        const at = start + decision.closer.length;
        textareaRef.current?.setSelectionRange(at, at);
        return;
      }

      if (decision.kind === 'insert') {
        e.preventDefault();
        commit(
          buffer.text.substring(0, start) + decision.text + buffer.text.substring(end),
          start,
          start + 1,
        );
        setTimeout(() => {
          textareaRef.current?.setSelectionRange(start + 1, start + 1);
        }, 0);
        return;
      }

      if (decision.kind === 'surround') {
        // Typing a quote over a selection quotes it; the previous behaviour
        // replaced the selection outright and lost the text.
        e.preventDefault();
        const selected = buffer.text.substring(start, end);
        const wrapped = decision.before + selected + decision.after;
        commit(
          buffer.text.substring(0, start) + wrapped + buffer.text.substring(end),
          start,
          start + decision.before.length,
        );
        setTimeout(() => {
          textareaRef.current?.setSelectionRange(
            start + decision.before.length,
            start + decision.before.length + selected.length,
          );
        }, 0);
        return;
      }
    }
    // Ctrl+F - Find
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      setFindOpen(true);
      setReplaceOpen(false);
      setTimeout(() => findInputRef.current?.focus(), 0);
      return;
    }
    // Ctrl+H - Replace
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
      e.preventDefault();
      setFindOpen(true);
      setReplaceOpen(true);
      setTimeout(() => findInputRef.current?.focus(), 0);
      return;
    }
    // Escape - close find/replace or suggestions
    if (e.key === 'Escape') {
      setFindOpen(false);
      setShowSuggestions(false);
      return;
    }
    // Ctrl+Space - force completion suggestions / predictions
    if (mod && e.key === ' ') {
      e.preventDefault();
      updateSuggestions(true);
      return;
    }
    // Autocomplete navigation
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestionIndex(prev => (prev + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestionIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertSuggestion(suggestions[suggestionIndex]);
        return;
      }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      // `insertSpaces` is an editor setting that existed but was never read;
      // without a consumer, "Insert spaces" in the settings panel did nothing.
      const unit = insertSpaces ? ' '.repeat(tabSize) : '\t';
      const result = e.shiftKey
        ? outdentBlock(buffer.text, start, end, { unit })
        : indentBlock(buffer.text, start, end, { unit });
      if (!result.changed) return;
      commit(result.text, start, result.selectionStart);
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = result.selectionStart;
          textareaRef.current.selectionEnd = result.selectionEnd;
        }
      }, 0);
      return;
    }
    if (e.key === 'Enter') {
      const start = e.currentTarget.selectionStart;
      const before = buffer.text.substring(0, start);
      const currentLine = buffer.lines[lineAt(buffer, start)] ?? '';
      const indent = currentLine.match(/^\s*/)?.[0] || '';
      const lastChar = before.trim().slice(-1);
      if (lastChar === '{') {
        e.preventDefault();
        // Match the unit the line already uses, falling back to the setting. A
        // file indented with tabs should keep getting tabs here even when
        // `insertSpaces` is on, and vice versa.
        const unit = indent.includes('\t') ? '\t' : (insertSpaces ? ' '.repeat(tabSize) : '\t');
        const pad = unit;
        const insert = '\n' + indent + pad + '\n' + indent;
        commit(
          buffer.text.substring(0, start) + insert + buffer.text.substring(e.currentTarget.selectionEnd),
          start,
          start + 1 + indent.length + pad.length,
        );
        setTimeout(() => {
          if (textareaRef.current) {
            const pos = start + 1 + indent.length + pad.length;
            textareaRef.current.selectionStart = textareaRef.current.selectionEnd = pos;
          }
        }, 0);
      }
    }
  };

  const handleKeyUp = () => {
    updateSuggestions();
    reportCursor();
  };

  /**
   * Replace spaces/tabs with dimmed middle dots so indentation and stray
   * trailing whitespace are visible without changing the character count.
   *
   * `boundary` only marks the leading indentation and the trailing run —
   * the whitespace a reader actually cares about. `all` marks every space.
   * The glyphs are `aria-hidden` content inside an already-hidden `<pre>`, so
   * the text selection and copy behaviour of the textarea is unaffected.
   */
  const renderWhitespace = (line: string, lineTokens?: { type: LangTokenType; value: string }[]): React.ReactNode => {
    if (renderWhitespaceMode === 'none' || line.length === 0) return line;
    const isBlank = /^[ \t]*$/.test(line);
    if (isBlank) {
      if (renderWhitespaceMode === 'boundary') {
        return <span style={{ color: 'var(--ag-whitespace)' }}>{line.replace(/ /g, '·').replace(/\t/g, '→')}</span>;
      }
      return line;
    }

    const lead = line.match(/^[ \t]*/)![0];
    const rest = line.slice(lead.length);
    const trailMatch = rest.match(/[ \t]+$/);
    const body = trailMatch ? rest.slice(0, rest.length - trailMatch[0].length) : rest;

    return (
      <>
        <span style={{ color: 'var(--ag-whitespace)' }}>{lead.replace(/ /g, '·').replace(/\t/g, '→')}</span>
        {renderLine(body, stripEdgeWs(lineTokens))}
        {trailMatch && (
          <span style={{ color: 'var(--ag-whitespace)' }}>
            {trailMatch[0].replace(/ /g, '·').replace(/\t/g, '→')}
          </span>
        )}
      </>
    );
  };

  // Build highlighted content with search match highlights

  const renderHighlighted = () => {
    return lines.map((line, i) => (
      <div
        key={i}
        style={{
          minHeight: lineHeightPx,
          lineHeight: `${lineHeightPx}px`,
          // Active-line tint. Painted on the highlight layer only; the
          // textarea is transparent so the tint shows through.
          background: activeLineHighlight && i === cursorLine - 1 ? 'var(--ag-active-line)' : undefined,
        }}
      >
        {renderWhitespace(line, langTokens[i])}
      </div>
    ));
  };

  /** Line numbers, honouring the three gutter modes. */
  const renderGutter = () => {
    if (lineNumbers === 'off') return null;
    // `relative` counts away from the caret, which is what makes Alt+↑/↓ and
    // long jumps readable without losing absolute position (every 10th line
    // is rendered in full).
    const numbers = lines.map((_, i) => {
      if (lineNumbers === 'on') return { text: String(i + 1), absolute: true };
      const distance = Math.abs(i - (cursorLine - 1));
      if (distance === 0) return { text: String(i + 1), absolute: true };
      return { text: distance === 0 ? String(i + 1) : String(distance), absolute: i % 10 === 0 };
    });
    return numbers;
  };

  /**
   * Minimap. The bespoke editor has no viewport mapping, so this is a
   * proportional density rail rather than a true minimap: each line
   * contributes a bar whose weight is its length, which gives the same
   * "where am I in the file" affordance without a second layout engine.
   */
  const minimapRows = useMemo(() => {
    if (!minimapEnabled) return null;
    const longest = longestLine(lines);
    return lines.map((line, i) => ({
      key: i,
      width: Math.max(2, Math.round((line.length / longest) * 100)),
      active: i === cursorLine - 1,
    }));
    // `lines` is derived from `value`; keying on `value` keeps the dep stable
    // for the React Compiler, which cannot prove the array is not mutated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, minimapEnabled, cursorLine]);

  return (
    <div className="relative flex-1 flex bg-[var(--ag-editor-bg)] overflow-hidden">
      {/* Line numbers */}
      {lineNumbers !== 'off' && (
        <div
          ref={gutterRef}
          className="flex flex-col py-4 px-3 text-right select-none overflow-hidden flex-shrink-0 font-mono"
          style={{ background: 'var(--ag-gutter-bg)', borderRight: '1px solid var(--ag-gutter-border)', willChange: 'scroll-position' }}
        >
          {renderGutter()?.map((entry, i) => {
            const line = i + 1;
            const isBreakpoint = breakpoints?.has(line) ?? false;
            const isPaused = pausedLine === line;
            return (
              <div
                key={i}
                className="flex-shrink-0 flex items-center justify-end gap-1.5 group"
                style={{
                  fontSize: Math.max(10, fontSize - 2),
                  lineHeight: `${lineHeightPx}px`,
                  height: lineHeightPx,
                  color: isPaused ? '#fff' : entry.absolute ? 'var(--ag-gutter-fg)' : 'var(--ag-faint)',
                  opacity: entry.absolute || isBreakpoint || isPaused ? 1 : 0.7,
                  background: isPaused ? 'var(--ag-accent)' : undefined,
                }}
                // Clicking the row toggles a breakpoint, VS Code style. The hit
                // area is the whole row so the gutter stays a comfortable
                // target rather than demanding a 8px dot hit.
                onClick={() => onToggleBreakpoint?.(line)}
                title={onToggleBreakpoint ? `Toggle breakpoint on line ${line}` : undefined}
              >
                {isBreakpoint && (
                  <span
                    className="rounded-full bg-red-500 shrink-0"
                    style={{ width: Math.max(7, fontSize * 0.45), height: Math.max(7, fontSize * 0.45) }}
                  />
                )}
                <span className="group-hover:text-[var(--ag-fg)] transition-colors">{entry.text}</span>
              </div>
            );
          })}
          <div className="flex-shrink-0" style={{ height: lineHeightPx }} />
        </div>
      )}

      {/* Editor area */}
      <div className="relative flex-1 overflow-hidden">
        {/* Find/Replace bar */}
        {findOpen && (
          <div className="absolute top-0 right-0 z-20 bg-zinc-800 border-b border-l border-zinc-700 rounded-bl-lg p-2 flex flex-col gap-2 w-80 shadow-xl">
            <div className="flex items-center gap-2">
              <input
                ref={findInputRef}
                type="text"
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') findNext(); }}
                placeholder="Find..."
                className="flex-1 bg-zinc-900 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-700 outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-zinc-500 min-w-[60px]">
                {matchCount > 0 ? `${currentMatch}/${matchCount}` : '0/0'}
              </span>
              <button onClick={findPrev} className="text-zinc-400 hover:text-zinc-200 px-1"><Icon name="arrow-up" size={12} /></button>
              <button onClick={findNext} className="text-zinc-400 hover:text-zinc-200 px-1"><Icon name="arrow-down" size={12} /></button>
              <button onClick={() => { setFindOpen(false); setReplaceOpen(false); }} className="text-zinc-400 hover:text-zinc-200 px-1"><Icon name="x" size={12} /></button>
            </div>
            {replaceOpen && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={replaceQuery}
                  onChange={(e) => setReplaceQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') replaceNext(); }}
                  placeholder="Replace..."
                  className="flex-1 bg-zinc-900 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-700 outline-none focus:border-emerald-500"
                />
                <button onClick={replaceNext} className="text-xs text-zinc-300 hover:text-white bg-zinc-700 px-2 py-1 rounded">Replace</button>
                <button onClick={replaceAll} className="text-xs text-zinc-300 hover:text-white bg-zinc-700 px-2 py-1 rounded">All</button>
              </div>
            )}
            {!replaceOpen && (
              <button onClick={() => setReplaceOpen(true)} className="text-xs text-zinc-500 hover:text-zinc-300 text-left">
                Toggle replace...
              </button>
            )}
          </div>
        )}

        {/* Autocomplete dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div
            role="listbox"
            aria-label="Completions"
            className="absolute z-20 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 max-h-48 overflow-y-auto text-xs"
            style={{ top: suggestionTop, left: suggestionLeft, minWidth: 180 }}
          >
            {suggestions.map((s, i) => (
              <div
                key={s.label + s.kind}
                role="option"
                aria-selected={i === suggestionIndex}
                onClick={() => insertSuggestion(s)}
                className={`px-3 py-1 cursor-pointer flex items-center gap-2 ${
                  i === suggestionIndex ? 'bg-emerald-600 text-white' : 'text-zinc-300 hover:bg-zinc-700'
                }`}
              >
                <span className="w-4 flex items-center justify-center"><Icon name={KIND_ICON[s.kind]} size={12} className={i === suggestionIndex ? 'text-white' : 'text-zinc-400'} /></span>
                <span className={i === suggestionIndex ? 'text-white' : KIND_CLASS[s.kind]}>
                  {s.label}
                </span>
                {s.detail && (
                  <span className={`ml-auto pl-3 truncate ${i === suggestionIndex ? 'text-emerald-100' : 'text-zinc-500'}`}>
                    {s.detail}
                  </span>
                )}
                {s.kind === 'snippet' && !s.detail && <span className="ml-auto"><Icon name="tab" size={11} className="text-zinc-500" /></span>}
              </div>
            ))}
          </div>
        )}

        {/* Syntax highlight overlay. Its metrics must match the textarea
            character-for-character or the colours drift away from the caret,
            so both render from `textLayerStyle`. */}
        <pre
          ref={highlightRef}
          aria-hidden="true"
          className="absolute inset-0 p-4 pointer-events-none overflow-auto ide-scrollbar"
          style={{ ...textLayerStyle, ...wrapStyle, margin: 0 }}
        >
          {renderHighlighted()}
          <div style={{ minHeight: lineHeightPx }}>{'\u200B'}</div>
        </pre>

        {/* Actual textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            // The anchor is the caret position *before* this change. React's
            // onChange fires after the DOM value is updated, so the previous
            // caret has to be captured from the event's own selection tracking
            // — `selectionStart` here is already the post-change position, and
            // `lastEmittedRef` is the pre-change content.
            const before = lastEmittedRef.current;
            const next = e.target.value;
            if (next === before) return;
            // The change started where the old selection began. For a plain
            // insertion that is the old caret; for a replacement it is the start
            // of the replaced range. Deriving it from the length delta keeps
            // both cases contiguous.
            const delta = next.length - before.length;
            const caret = e.target.selectionStart ?? next.length;
            const anchor = Math.max(0, caret - Math.max(delta, 0));
            commit(next, anchor, caret);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onScroll={syncScroll}
          onClick={() => { setShowSuggestions(false); reportCursor(); }}
          onSelect={reportCursor}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
          }}
          spellCheck={false}
          className="absolute inset-0 p-4 bg-transparent text-transparent resize-none outline-none ide-scrollbar"
          style={{ ...textLayerStyle, ...wrapStyle, caretColor: 'var(--ag-caret)' }}
        />
      </div>

      {/* Minimap density rail */}
      {minimapRows && (
        <div
          aria-hidden="true"
          className="flex flex-col py-4 px-1 gap-[1px] flex-shrink-0 select-none overflow-hidden"
          style={{
            width: `${Math.round(52 * minimapScale)}px`,
            background: 'var(--ag-bg)',
            borderLeft: '1px solid var(--ag-border-soft)',
          }}
        >
          {minimapRows.map((row) => (
            <div
              key={row.key}
              className="flex-shrink-0 rounded-[1px]"
              style={{
                height: Math.max(1, lineHeightPx * 0.4),
                width: `${row.width}%`,
                background: row.active ? 'var(--ag-accent-bright)' : 'var(--ag-gutter-fg)',
                opacity: row.active ? 0.9 : 0.5,
              }}
            />
          ))}
        </div>
      )}

      {/* Editor context menu */}
      {contextMenu && (
        <EditorContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: 'Cut',
              icon: 'scissors',
              action: () => {
                const ta = textareaRef.current;
                if (!ta) return;
                // Capture the selection before `execCommand`, which collapses
                // it. The anchor is where the removed text started, so the cut
                // is one undo step.
                const anchor = ta.selectionStart;
                document.execCommand('cut');
                if (ta.value !== buffer.text) commit(ta.value, anchor, anchor);
              },
            },
            {
              label: 'Copy',
              icon: 'copy',
              action: () => {
                const ta = textareaRef.current;
                if (ta) document.execCommand('copy');
              },
            },
            {
              label: 'Paste',
              icon: 'clipboard',
              action: async () => {
                const ta = textareaRef.current;
                if (ta) {
                  const text = await navigator.clipboard.readText();
                  const start = ta.selectionStart;
                  const end = ta.selectionEnd;
                  const newValue = buffer.text.substring(0, start) + text + buffer.text.substring(end);
                  commit(newValue, start, start + text.length);
                  setTimeout(() => {
                    if (textareaRef.current) {
                      const pos = start + text.length;
                      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = pos;
                    }
                  }, 0);
                }
              },
            },
            {
              label: 'Select All',
              icon: 'list',
              action: () => {
                const ta = textareaRef.current;
                if (ta) {
                  ta.focus();
                  ta.selectionStart = 0;
                  ta.selectionEnd = value.length;
                }
              },
            },
            { separator: true },
            {
              label: 'Find...',
              icon: 'search',
              action: () => {
                setFindOpen(true);
                setReplaceOpen(false);
                setTimeout(() => findInputRef.current?.focus(), 0);
              },
            },
            {
              label: 'Replace...',
              icon: 'replace',
              action: () => {
                setFindOpen(true);
                setReplaceOpen(true);
                setTimeout(() => findInputRef.current?.focus(), 0);
              },
            },
            { separator: true },
            {
              label: 'Toggle Comment',
              icon: 'message-square',
              action: toggleComment,
            },
            {
              label: 'Duplicate Line',
              icon: 'copy',
              action: duplicateLine,
            },
            {
              label: 'Go to Line...',
              icon: 'ruler',
              action: () => {
                const n = prompt('Go to line:');
                if (n && !isNaN(Number(n))) goToLine(Number(n));
              },
            },
            { separator: true },
            {
              label: 'Run Script',
              icon: 'play',
              action: () => onRun?.(),
            },
            {
              label: 'Debug Script',
              icon: 'bug',
              action: () => onDebug?.(),
            },
            {
              label: cursorLine ? `Toggle Breakpoint (Ln ${cursorLine})` : 'Toggle Breakpoint',
              icon: 'dot',
              disabled: !onToggleBreakpoint,
              action: () => onToggleBreakpoint?.(cursorLine),
            },
          ]}
        />
      )}
    </div>
  );
}