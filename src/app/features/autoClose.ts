/**
 * Bracket and quote auto-close decisions.
 *
 * The editor inserted a closing character for every opening one, with no
 * exceptions. Two consequences, both of which feel like the editor is broken:
 *
 *  - **No type-over.** Typing `(` produced `()`, then typing `)` produced
 *    `foo())` — the closer was inserted a second time instead of the caret
 *    stepping over the one already there.
 *  - **No context test.** Typing `'` inside a string or a comment inserted
 *    another quote, compounding the mess.
 *
 * Kept pure so the rules can be tested directly. The component's only job is to
 * supply the token context and apply the returned decision.
 */

/** What surrounds the caret. Derived from the highlighter's tokens. */
export type EditContext = 'code' | 'string' | 'comment';

/** Opening character -> the closer it should insert. */
export const AUTO_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
};

/** Closing character -> the opener it pairs with, for type-over. */
const CLOSER_TO_OPENER: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
  '"': '"',
  "'": "'",
};

export type AutoCloseDecision =
  /** Nothing to do: not an auto-close key, disabled, or inside a string/comment. */
  | { kind: 'none' }
  /** The caret sits just before a matching closer — step over it, change nothing. */
  | { kind: 'typeOver'; closer: string }
  /** Insert an open/close pair at a collapsed caret. */
  | { kind: 'insert'; text: string }
  /** Wrap the current selection in a pair. */
  | { kind: 'surround'; before: string; after: string };

export interface AutoCloseInput {
  key: string;
  text: string;
  selectionStart: number;
  selectionEnd: number;
  context: EditContext;
  enabled: boolean;
}

export function decideAutoClose(input: AutoCloseInput): AutoCloseDecision {
  const { key, text, selectionStart, selectionEnd, context, enabled } = input;
  if (!enabled) return { kind: 'none' };

  // Inside a string or a comment, every one of these is literal text. Adding a
  // closer there only compounds the problem the user is trying to escape.
  if (context !== 'code') return { kind: 'none' };

  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);

  // A non-empty selection gets wrapped, which is why typing a quote over a
  // selection quotes it instead of destroying it.
  if (end > start) {
    const before = AUTO_PAIRS[key];
    if (!before) return { kind: 'none' };
    return { kind: 'surround', before: key, after: before };
  }

  const closer = AUTO_PAIRS[key];
  if (!closer) {
    // Not an opening key — but it may be the closer for a pair the editor
    // inserted, in which case the caret steps over it.
    const opener = CLOSER_TO_OPENER[key];
    if (opener && text[start] === key) return { kind: 'typeOver', closer: key };
    return { kind: 'none' };
  }

  // Type-over: the auto-inserted closer is already under the caret.
  if (text[start] === closer) return { kind: 'typeOver', closer };

  return { kind: 'insert', text: key + closer };
}

/** A token as the highlighter produces it — no offsets, just type and text. */
export interface ContextToken {
  type: string;
  value: string;
}

/** Token types that mean "the caret is in literal text, not code". */
const LITERAL_TOKENS = new Set(['string', 'comment', 'char', 'regex', 'bytes']);

/**
 * Where the caret sits, from the tokens of the line it is on.
 *
 * Strictly-inside matters: an offset at the very start of a comment is still
 * code, because the `//` has not been typed yet. An offset at the end of a
 * token is code again, which is what makes typing the closing quote of a string
 * work.
 *
 * The distinction between `string` and `comment` is kept because they are
 * suppressed for different reasons and the two will diverge (a bracket inside a
 * string is usually wanted, a bracket inside a comment never is).
 */
export function contextAt(tokens: ContextToken[], offset: number): EditContext {
  let at = 0;
  for (const token of tokens) {
    const start = at;
    const end = start + token.value.length;
    if (offset > start && offset < end) {
      if (token.type === 'comment') return 'comment';
      if (LITERAL_TOKENS.has(token.type)) return 'string';
      return 'code';
    }
    at = end;
  }
  return 'code';
}
