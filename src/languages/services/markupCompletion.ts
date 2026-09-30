/**
 * HTML and CSS completion from the VS Code language services.
 *
 * These are the same packages VS Code and Monaco use, extracted so they can run
 * anywhere. They bring data that cannot reasonably be hand-maintained: 116
 * elements, 888 CSS properties, 180 named colours, and - the part that matters
 * most - attribute completion filtered per tag, so `<img` offers `srcset`,
 * `ismap` and `decoding` and `<div` does not.
 *
 * `doComplete` is synchronous for both services. `doComplete2` is the async
 * variant and is deliberately not used: it exists to await completion
 * participants, and awaiting would force the editor's whole suggestion path
 * through a promise for no gain.
 */

import { getLanguageService, type LanguageService as HtmlService } from 'vscode-html-languageservice';
import { getCSSLanguageService, type LanguageService as CssService } from 'vscode-css-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem, CompletionItemKind, MarkupContent } from 'vscode-languageserver-types';

import type { Suggestion } from '../completion';
import type { CompletionKind } from '../types';
import { blankOutside, embeddedRegionAt } from './htmlRegions';

export type MarkupLanguage = 'html' | 'css';

/** Created on first use: constructing either service is not free. */
let htmlService: HtmlService | null = null;
let cssService: CssService | null = null;

function html(): HtmlService {
  if (!htmlService) htmlService = getLanguageService();
  return htmlService;
}

function css(): CssService {
  if (!cssService) cssService = getCSSLanguageService();
  return cssService;
}

/**
 * LSP `CompletionItemKind` -> our own `CompletionKind`.
 *
 * Our vocabulary is smaller and the editor renders an icon and a colour per
 * kind, so this folds the 25 LSP kinds into the seven we show. Anything that
 * names something in the buffer becomes a `symbol`; anything that is a named
 * value becomes a `constant`.
 */
function toKind(kind: CompletionItemKind | undefined): CompletionKind {
  switch (kind) {
    case 2: // Method
    case 3: // Function
    case 4: // Constructor
    case 23: // Event
      return 'function';
    case 7: // Class
    case 8: // Interface
    case 9: // Module
    case 13: // Enum
    case 22: // Struct
    case 25: // TypeParameter
      return 'type';
    case 11: // Unit
    case 12: // Value
    case 20: // EnumMember
    case 21: // Constant
      return 'constant';
    case 14: // Keyword
      return 'keyword';
    case 15: // Snippet
      return 'snippet';
    case 24: // Operator
      return 'builtin';
    case 16: // Color
    case 17: // File
    case 18: // Reference
      return 'symbol';
    default:
      return 'symbol';
  }
}

/** Documentation arrives as a string or as MarkupContent. */
function documentation(item: CompletionItem): string {
  const doc = item.documentation;
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  const md = doc as MarkupContent;
  return typeof md.value === 'string' ? md.value : '';
}

/**
 * The one-line form shown at the right of the popup row.
 *
 * The services put the full spec text in `detail` for a CSS property, which is
 * a paragraph. Newlines and runs of whitespace collapse, and it is cut short,
 * because the popup is a single row and a wrapped paragraph breaks its layout.
 */
function toDetail(item: CompletionItem): string | undefined {
  const raw = (item.detail ?? documentation(item)).replace(/\s+/g, ' ').trim();
  if (!raw) return undefined;
  return raw.length > 72 ? `${raw.slice(0, 71)}…` : raw;
}

/**
 * Convert one LSP item, including the exact span it wants replaced.
 *
 * The `textEdit` range is authoritative and is carried through, so accepting a
 * completion replaces precisely what the service judged to be the token - which
 * is not always what a word-boundary heuristic would have picked.
 */
function toSuggestion(item: CompletionItem, lineStarts: number[]): Suggestion {
  // `textEdit` is typed `TextEdit | InsertReplaceEdit`. Only the former has a
  // `range`; the latter carries `insert`/`replace` ranges instead and is not
  // produced by either service here, so it is treated as "no known span".
  const edit = item.textEdit;
  const range = edit && 'range' in edit ? edit.range : undefined;
  const body = range ? edit!.newText : (item.insertText ?? item.label);
  return {
    label: item.label,
    kind: toKind(item.kind),
    body,
    detail: toDetail(item),
    replaceStart: range ? offsetOfLineStarts(range.start.line, range.start.character, lineStarts) : undefined,
    replaceEnd: range ? offsetOfLineStarts(range.end.line, range.end.character, lineStarts) : undefined,
  };
}

/** Same as `offsetOf` but against precomputed line starts. */
function offsetOfLineStarts(line: number, character: number, lineStarts: number[]): number {
  if (line >= lineStarts.length) return lineStarts[lineStarts.length - 1] ?? 0;
  return Math.min(lineStarts[line] + character, (lineStarts[line + 1] ?? Infinity) - 1);
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

export interface MarkupRequest {
  language: MarkupLanguage;
  /** The whole buffer. */
  source: string;
  /** Caret offset. */
  offset: number;
  limit: number;
  /**
   * When the caret is inside `<style>`, the region to hand to the CSS service
   * instead of parsing the outer document as CSS.
   */
  embedded?: { start: number; end: number; text: string };
}

/**
 * Suggestions for one position, or an empty list.
 *
 * Returning an empty list is meaningful: it means the service had nothing to
 * offer, and the caller is free to fall back to its own data.
 */
export function markupSuggestions(req: MarkupRequest): Suggestion[] {
  const { source, offset, limit } = req;

  // Inside `<style>`, hand the region to the CSS service. The rest of the
  // document is blanked to spaces so offsets line up exactly.
  //
  // The region's own text is required. Passing a region with an empty `text`
  // and relying on `blankOutside` to slice it produced an all-whitespace
  // document, so the CSS service had an empty stylesheet to complete against.
  if (req.embedded) {
    const region = {
      language: 'css' as const,
      text: req.embedded.text,
      start: req.embedded.start,
      end: req.embedded.end,
    };
    return completeCss(blankOutside(source, region), offset, limit);
  }

  if (req.language === 'css') return completeCss(source, offset, limit);
  return completeHtml(source, offset, limit);
}

function completeCss(text: string, offset: number, limit: number): Suggestion[] {
  const doc = TextDocument.create('file:///markup.css', 'css', 1, text);
  const service = css();
  const stylesheet = service.parseStylesheet(doc);
  const list = service.doComplete(doc, doc.positionAt(offset), stylesheet);
  const starts = lineStartsOf(text);
  return (list?.items ?? []).slice(0, limit).map((i) => toSuggestion(i, starts));
}

function completeHtml(text: string, offset: number, limit: number): Suggestion[] {
  const doc = TextDocument.create('file:///markup.html', 'html', 1, text);
  const service = html();
  const htmlDoc = service.parseHTMLDocument(doc);
  const list = service.doComplete(doc, doc.positionAt(offset), htmlDoc);
  const starts = lineStartsOf(text);
  return (list?.items ?? []).slice(0, limit).map((i) => toSuggestion(i, starts));
}

/** For tests and for the diagnostic path: does the offset sit in a `<style>`/`<script>`? */
export function embeddedAt(source: string, offset: number) {
  return embeddedRegionAt(source, offset);
}

/**
 * How many rows to ask the service for.
 *
 * Effectively all of them. The service does not filter by the typed prefix: it
 * returns every valid name for the position and leaves matching to the client,
 * which is why it hands back 888 properties for `text-al`. Capping here lost
 * `text-align` outright, because the tail of an alphabetical list is where the
 * `t`s are. The list is filtered and cut to `limit` after it comes back.
 */
export const MARKUP_FETCH = 5000;

/**
 * Markup names worth promoting, most-used first.
 *
 * A judgement, not a fact from the service: the service knows what is valid,
 * this knows what people reach for. Anything unlisted keeps the service's own
 * order, behind everything that is listed.
 */
const MARKUP_PRIORITY = new Map<string, number>([
  // Attributes, valid across elements.
  ['id', 0], ['class', 1], ['style', 2], ['href', 3], ['src', 4], ['alt', 5],
  ['title', 6], ['type', 7], ['name', 8], ['value', 9], ['placeholder', 10],
  ['width', 11], ['height', 12], ['target', 13], ['rel', 14], ['role', 15],
  ['for', 16], ['action', 17], ['method', 18], ['disabled', 19], ['checked', 20],
  // Elements, roughly by how often they turn up in real markup.
  ['div', 30], ['span', 31], ['p', 32], ['a', 33], ['ul', 34], ['li', 35],
  ['h1', 36], ['h2', 37], ['h3', 38], ['button', 39], ['img', 40], ['input', 41],
  ['section', 42], ['header', 43], ['footer', 44], ['nav', 45], ['main', 46],
  ['form', 47], ['table', 48], ['tr', 49], ['td', 50], ['th', 51], ['label', 52],
  ['select', 53], ['option', 54], ['textarea', 55], ['strong', 56], ['em', 57],
  ['code', 58], ['pre', 59], ['small', 60], ['br', 61], ['hr', 62], ['html', 63],
  ['head', 64], ['body', 65], ['title', 66], ['meta', 67], ['link', 68],
  ['script', 69], ['style', 70], ['template', 71], ['svg', 72], ['iframe', 73],
  // CSS values, in a second tier so they only surface where markup names are
  // absent. The service lists 180 named colours alphabetically, which puts
  // `red` at about position 140 - past the end of any list worth reading. These
  // are the ones typed by hand constantly.
  ['inherit', 100], ['initial', 101], ['unset', 102], ['revert', 103],
  ['transparent', 104], ['currentcolor', 105], ['none', 106], ['auto', 107],
  ['black', 110], ['white', 111], ['red', 112], ['green', 113], ['blue', 114],
  ['yellow', 115], ['orange', 116], ['purple', 117], ['gray', 118], ['grey', 119],
  // Units, for numeric values.
  ['px', 130], ['rem', 131], ['em', 132], ['%', 133], ['vh', 134], ['vw', 135],
  ['s', 136], ['ms', 137], ['fr', 138], ['deg', 139], ['ch', 140], ['vmin', 141],
]);

/**
 * Promote common markup names, stably.
 *
 * Two unlisted names keep the service's relative order, so this only ever moves
 * rows up and never reshuffles the tail.
 */
export function rankMarkupSuggestions(items: Suggestion[]): Suggestion[] {
  return items
    .map((s, i) => ({ s, i, rank: MARKUP_PRIORITY.get(s.label.toLowerCase()) }))
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.i - b.i)
    .map((x) => x.s);
}
