/**
 * Shared types for the language registry and generic syntax tokenizer.
 *
 * The IDE highlights code with a small, language-agnostic set of token kinds.
 * Each language definition maps its own syntax onto these kinds.
 */

/** A single output token produced by the tokenizer (language-agnostic kinds). */
export type TokenType =
  | 'keyword'   // control/declaration keywords (if, for, class, let, fn…)
  | 'type'      // type names / user-struct-like names
  | 'builtin'   // language/standard-library function names
  | 'constant'  // true/false/null/nil/None/Some/this/self…
  | 'number'    // integer / hex / binary / typed numbers
  | 'float'     // floating point numbers
  | 'string'    // string literals (incl. template / interpolation / bytes)
  | 'regex'     // regex literals (JS/Rak-family only)
  | 'char'      // character literals
  | 'comment'   // line / block comments
  | 'ident'     // ordinary identifiers
  | 'op'        // operators and punctuation
  | 'ws'        // whitespace
  | 'tag'       // HTML/XML tag names
  | 'attr'      // HTML/XML attribute names
  | 'property'  // CSS property / object keys
  | 'selector'  // CSS selectors / classes
  | 'macro'     // preprocessor / macro syntax (#include, $var, macro!())
  | 'attr-string'; // CSS function values marker

export interface Token {
  type: TokenType;
  value: string;
}

/** Badge/colour bucket a completion entry is rendered under. */
export type CompletionKind =
  | 'keyword'  // reserved words
  | 'type'     // type / class / struct names
  | 'builtin'  // standard-library names, CSS properties, HTML attributes
  | 'constant' // true/false/null/nil/…
  | 'snippet'  // expands to a fragment
  | 'function' // a callable declared in the current buffer
  | 'symbol';  // any other name declared in the current buffer

/** An autocomplete snippet: a trigger prefix plus the text it expands to. */
export interface Snippet {
  /** Trigger prefix matched against the word under the caret. */
  prefix: string;
  /** Human-readable summary shown beside the trigger. */
  label: string;
  /** Insertion body. */
  body: string;
  description?: string;
}

/** A named snippet shown as a context prediction (e.g. `{ … }` after `if`). */
export interface BlockSnippet {
  label: string;
  body: string;
}

/**
 * A regex source whose first capture group is a name declared in the buffer.
 * Sources are stored as strings (not `RegExp`) so a `LanguageDef` stays plain
 * data; the completion engine compiles and caches them per language.
 */
export interface DeclarationPattern {
  /** Which bucket the captured name is offered under. */
  kind: Extract<CompletionKind, 'function' | 'symbol' | 'type' | 'constant'>;
  pattern: string;
}

/** A one-off completion entry outside the keyword/type/builtin vocabulary. */
export interface CompletionWord {
  label: string;
  kind: CompletionKind;
  /** Insertion body; defaults to the label. */
  body?: string;
  detail?: string;
}

/**
 * Text that should open the completion list on its own. Markup languages need
 * this: after `<` there is no word to match a prefix against, but the tag list
 * is exactly what the user wants.
 */
export interface CompletionTrigger {
  /** Text that must sit immediately before the caret, e.g. `<`. */
  text: string;
  /** Restrict the list to these kinds; defaults to everything but snippets. */
  kinds?: CompletionKind[];
  /**
   * Harvest pattern for buffer symbols the trigger should lead with.
   *
   * After `.` in CSS the useful answers are the class names the stylesheet
   * already defines; after `<div ` they are the ids and classes used elsewhere
   * in the document. Capture group 1 is the name, and the whole match is used
   * when there is no group.
   */
  symbolPattern?: string;
  /**
   * Regex source that the text before the caret must also match.
   *
   * `text` alone is too blunt a test for markup: a space appears in body prose
   * just as much as inside a tag, so a `' '` trigger for HTML attributes would
   * open the attribute list in the middle of a sentence. The guard narrows it
   * to "inside an unclosed tag". Tested against the text before the caret.
   */
  guard?: string;
}

/**
 * Per-language completion data. Everything the editor needs to offer
 * completions for a language lives here, so the engine itself stays
 * language-agnostic and a new language is supported by adding data.
 */
export interface LanguageCompletion {
  /** Trigger-prefixed fragments. */
  snippets?: Snippet[];
  /** Extra vocabulary (CSS properties, HTML attributes, …). */
  words?: CompletionWord[];
  /** Text that opens the list without a typed prefix (e.g. `<` in HTML). */
  triggers?: CompletionTrigger[];
  /** Patterns that harvest user-declared names from the open buffer. */
  declarations?: DeclarationPattern[];
  /** Keyword -> the block body to offer right after that keyword. */
  blocks?: Record<string, BlockSnippet>;
  /** Keyword -> the binding tail to offer (`let` -> `= value`). */
  bindings?: Record<string, BlockSnippet>;
  /**
   * Regex source for "the word under the caret" — the span a completion
   * replaces, and the prefix it is ranked against. Defaults to a plain
   * identifier.
   *
   * CSS needs its own. Its property names are hyphenated (`text-align`) and its
   * custom properties start with `--`; neither matches an identifier pattern,
   * so the default reduced `text-ali` to the prefix `ali` and matched nothing.
   * Every hyphenated CSS property was therefore uncompletable.
   */
  wordPattern?: string;
  /**
   * Values worth offering after a specific property, keyed by property name.
   *
   * A single flat value list is wrong often enough to be annoying: `color: `
   * offered `block`, `inline` and `flex`, and `display: ` offered `red`. These
   * take precedence over the generic list when the caret follows
   * `this-property: `, and the generic list is still offered afterwards so an
   * unusual value is reachable.
   */
  propertyValues?: Record<string, CompletionWord[]>;
}

/** A keyword run (multi-word phrases like `end if` in Lua or `is not` in Python). */
export interface LanguageDef {
  id: string;
  name: string;
  extensions: string[];
  filenames?: string[];
  /** Line comment markers, e.g. ["//", "#"] */
  lineComments: string[];
  /** Block comment pairs, e.g. ["/*", "*\\/"] */
  blockComments: [string, string][];
  /**
   * String delimiters.
   *
   * `multiline` marks a delimiter that legitimately continues past end-of-line —
   * a template literal, a raw string. Only those may carry their unterminated
   * state into the next line. This is per-delimiter rather than per-language
   * because Python has both: `"""` spans lines, but a lone `"` that fails to
   * close is a typo, and treating it as multiline turned every following line
   * into a string.
   *
   * `template` implies `multiline`; it is the existing "has interpolation" flag.
   */
  strings: {
    open: string;
    close?: string;
    template?: boolean;
    prefix?: string;
    multiline?: boolean;
  }[];
  /** Character literal delimiter, e.g. "'", or null if unsupported. */
  charQuote?: string;
  keywords: string[];
  builtins?: string[];
  types?: string[];
  constants?: string[];
  /** numeric prefixes handled specially, e.g. "0x", "0b", "0o", "0X" */
  hexPrefixes?: string[];
  binaryPrefixes?: string[];
  octalPrefixes?: string[];
  /** typed number suffixes, e.g. i32/u64/f32 */
  numberSuffixes?: string[];
  /** regex literal enabled (operand context), e.g. Rak, JavaScript */
  regexLiteral?: boolean;
  /**
   * Multi-line string delimiters, as explicit open/close pairs.
   *
   * This is a pair rather than a single delimiter because the previous shape,
   * `string[]`, forced the tokenizer to use the same text to open and close. A
   * bare `]]` in Lua — from `x = a[b[1]]` — was therefore matched as an *opening*
   * `]]`, which then never closed, so the rest of the file rendered as a string.
   * Asymmetric delimiters (`[[` … `]]`, `"""` … `"""`) are the whole point, so
   * the type has to be able to express them.
   */
  tripleQuotes?: { open: string; close: string }[];
  /** treat `$name` as a macro / interpolation var */
  macroVar?: boolean;
  /** object-like `key:` highlighting for indentation languages */
  propertyColon?: boolean;
  /** HTML-like language */
  markup?: boolean;
  /** Autocomplete data: snippets, buffer-harvest patterns, context predictions. */
  completion?: LanguageCompletion;
}

export interface LanguageDescription {
  /** the language definitions keyed by language id, in registration order */
  defs: Record<string, LanguageDef>;
  /** maps a lower-cased file extension to a language id */
  byExtension: Record<string, string>;
  /** maps an exact file name to a language id */
  byFilename: Record<string, string>;
}