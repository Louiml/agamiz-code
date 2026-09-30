import { LanguageDef, Token, TokenType } from './types';
import { getLanguage } from './registry';

/**
 * A generic, data-driven, stateful syntax tokenizer for any language in the
 * registry. Multi-line block comments and string literals carry across lines.
 */

interface Lookups {
  kw: Set<string>;
  types: Set<string>;
  builtins: Set<string>;
  constants: Set<string>;
  hex: string[];
  bin: string[];
  oct: string[];
  suffixes: string[];
}

function makeLookups(lang: LanguageDef): Lookups {
  const set = (xs?: string[]) => new Set((xs ?? []).map((s) => s.toLowerCase()));
  return {
    kw: set(lang.keywords),
    types: set(lang.types),
    builtins: set(lang.builtins),
    constants: set(lang.constants),
    hex: lang.hexPrefixes ?? ['0x'],
    bin: lang.binaryPrefixes ?? ['0b'],
    oct: lang.octalPrefixes ?? ['0o'],
    suffixes: lang.numberSuffixes ?? [],
  };
}

function isIdStart(c: string): boolean { return /[A-Za-z_]/.test(c); }
function isIdPart(c: string): boolean { return /[A-Za-z0-9_]/.test(c); }
function isDigit(c: string): boolean { return /[0-9]/.test(c); }

function lastSig(out: Token[]): Token | null {
  for (let k = out.length - 1; k >= 0; k--) if (out[k].type !== 'ws') return out[k];
  return null;
}

/**
 * Whether the previous meaningful token can end an expression.
 *
 * This is what distinguishes a regex literal from a division: in `a / b` the
 * preceding token is an identifier, so `/` is division, while after `=`, `(` or
 * `return` the `/` opens a regex. Without it, Rak and JavaScript regexes were
 * highlighted as a run of identifiers and operators.
 */
function canEndExpr(t: Token | null): boolean {
  if (!t) return false; // start of line -> operand position
  if (['ident', 'number', 'float', 'string', 'char', 'macro', 'tag', 'attr', 'property'].includes(t.type)) {
    return true;
  }
  if (t.type === 'op' && [')', ']', '}'].includes(t.value)) return true;
  return false;
}

/**
 * Characters after which a `/` opens a regex rather than dividing.
 *
 * Used to break up a glued operator run: in `f(/x+/)` the run is `(/`, and the
 * `(` is what says the next token is an operand.
 */
const OPENS_OPERAND = /[([{,;:=+\-*%&|^!~<>?]/;

/** Scan a regex literal starting at `s`, returning null if it cannot close. */
function readRegex(text: string, s: number): { value: string; end: number } | null {
  let j = s + 1;
  let inClass = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') { inClass = true; j++; continue; }
    if (c === ']') { inClass = false; j++; continue; }
    // An unterminated literal is almost certainly a division or a stray slash,
    // so bail rather than swallowing the rest of the line.
    if (c === '/' && !inClass) {
      j++;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      return { value: text.slice(s, j), end: j };
    }
    j++;
  }
  return null;
}

function readId(text: string, s: number): { value: string; end: number } {
  let j = s;
  while (j < text.length && isIdPart(text[j])) j++;
  return { value: text.slice(s, j), end: j };
}

function readNumber(
  text: string,
  s: number,
  L: Lookups,
): { type: TokenType; value: string; end: number } | null {
  const rest = text.slice(s);
  for (const p of L.hex) if (rest.startsWith(p)) {
    let j = s + p.length;
    while (j < text.length && /[0-9A-Fa-f_]/.test(text[j])) j++;
    return { type: 'number', value: text.slice(s, j), end: j };
  }
  for (const p of L.bin) if (rest.startsWith(p)) {
    let j = s + p.length;
    while (j < text.length && /[01_]/.test(text[j])) j++;
    return { type: 'number', value: text.slice(s, j), end: j };
  }
  for (const p of L.oct) if (rest.startsWith(p)) {
    let j = s + p.length;
    while (j < text.length && /[0-7_]/.test(text[j])) j++;
    return { type: 'number', value: text.slice(s, j), end: j };
  }
  if (isDigit(text[s])) {
    let j = s;
    while (j < text.length && isDigit(text[j])) j++;
    let float = false;
    if (text[j] === '.' && isDigit(text[j + 1] ?? '')) {
      float = true; j++;
      while (j < text.length && isDigit(text[j])) j++;
    }
    for (const sfx of L.suffixes) if (text.startsWith(sfx, j)) { j += sfx.length; break; }
    return { type: float ? 'float' : 'number', value: text.slice(s, j), end: j };
  }
  return null;
}
// State carried between lines of a single buffer tokenization.
interface CarryState {
  blockClose: string | null;
  stringClose: string | null;
}

/**
 * Scan a string literal starting at `start` (where `line.startsWith(open, start)`
 * has already been confirmed). Emits one `string` token and returns whether the
 * closing delimiter was found within this line (plus the index to resume from).
 */
function scanQuoted(
  line: string,
  start: number,
  open: string,
  close0: string,
  out: Token[],
): { closed: boolean; end: number } {
  let j = start + open.length;
  const close = close0;
  while (j < line.length) {
    if (line[j] === '\\' && j + 1 < line.length) { j += 2; continue; }
    if (line.startsWith(close, j)) {
      j += close.length;
      out.push({ type: 'string', value: line.slice(start, j) });
      return { closed: true, end: j };
    }
    j++;
  }
  out.push({ type: 'string', value: line.slice(start) });
  return { closed: false, end: j };
}

/** The main per-line scanner; `state.blockClose`/`state.stringClose` carry across lines. */
function scanLine(line: string, lang: LanguageDef, L: Lookups, state: CarryState, out: Token[]) {
  let i = 0;

  // carry: remainder of a block comment opened on an earlier line
  if (state.blockClose) {
    const close = state.blockClose;
    const j = line.indexOf(close);
    if (j === -1) { out.push({ type: 'comment', value: line }); return; }
    out.push({ type: 'comment', value: line.slice(0, j + close.length) });
    state.blockClose = null;
    i = j + close.length;
  } else if (state.stringClose) {
    const close = state.stringClose;
    const r = scanQuoted(line, 0, '', close, out);
    state.stringClose = r.closed ? null : close;
    i = r.end;
  }

  let propOk = !!lang.propertyColon;

  while (i < line.length) {
    const c = line[i];
    const rest = line.slice(i);

    if (/\s/.test(c)) {
      let ws = '';
      while (i < line.length && /\s/.test(line[i])) { ws += line[i]; i++; }
      out.push({ type: 'ws', value: ws });
      continue;
    }

    let consumed = false;

    // Block comments are tried BEFORE line comments.
    //
    // The order matters whenever a line-comment marker prefixes a block-comment
    // opener, which is common: HTML registers `<!--` in both lists, and Lua's
    // `--` matches the `--[[` long-comment opener. With line comments first, the
    // block rule was unreachable, so a multi-line comment's body after the first
    // line was highlighted as code.
    for (const [open, close] of lang.blockComments) {
      if (rest.startsWith(open)) {
        const j = line.indexOf(close, i + open.length);
        if (j === -1) { out.push({ type: 'comment', value: rest }); state.blockClose = close; return; }
        out.push({ type: 'comment', value: line.slice(i, j + close.length) });
        i = j + close.length;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    // line comments
    for (const m of lang.lineComments) {
      if (rest.startsWith(m)) { out.push({ type: 'comment', value: rest }); return; }
    }

    // triple quoted strings
    for (const tq of lang.tripleQuotes ?? []) {
      if (rest.startsWith(tq.open)) {
        const r = scanQuoted(line, i, tq.open, tq.close, out);
        state.stringClose = r.closed ? null : tq.close;
        i = r.end;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;
// HTML/XML tags
    if (lang.markup && (c === '<' || c === '>')) {
      if (c === '<' && /[A-Za-z!/]/.test(line[i + 1] ?? '')) {
        let k = i + 1;
        const closing = line[k] === '/';
        if (closing) k++;
        if (line[k] === '!') {
          const j = line.indexOf('>', i);
          const closeAt = j === -1 ? line.length : j + 1;
          out.push({ type: 'tag', value: line.slice(i, closeAt) });
          i = closeAt;
          continue;
        }
        const nameStart = k;
        while (k < line.length && /[A-Za-z0-9:-]/.test(line[k])) k++;
        if (k > nameStart) {
          out.push({ type: 'op', value: closing ? '</' : '<' });
          out.push({ type: 'tag', value: line.slice(nameStart, k) });
          i = k;
          continue;
        }
      } else if (c === '>') {
        out.push({ type: 'op', value: '>' });
        i++;
        continue;
      }
    }

    // HTML attributes: `word=` (not after '=' already consumed)
    if (lang.markup && isIdStart(c) && i > 0 && /\s/.test(line[i - 1])) {
      const { value, end } = readId(line, i);
      if (line[end] === '=') {
        out.push({ type: 'attr', value });
        i = end;
        continue;
      }
    }

    // preprocessor directives for C/C++/Rust-style `#` (not a comment marker)
    if (c === '#' && lang.lineComments.indexOf('#') === -1 && lang.macroVar) {
      out.push({ type: 'macro', value: rest });
      return;
    }

    // macro placeholder `$name`
    if (c === '$' && lang.macroVar && isIdStart(line[i + 1] ?? '')) {
      const { value, end } = readId(line, i + 1);
      out.push({ type: 'macro', value: '$' + value });
      i = end;
      continue;
    }

    // ordinary strings (longest delimiters first)
    const quotes = (lang.strings ?? []).slice().sort((a, b) => b.open.length - a.open.length);
    let strHit = false;
    for (const s of quotes) {
      const close = s.close ?? s.open;
      if (rest.startsWith(s.open)) {
        const r = scanQuoted(line, i, s.open, close, out);
        // An unterminated string only carries onto the next line when the
        // delimiter is one that legitimately spans lines — a template literal
        // or a raw string. Otherwise a single stray `"` in Go, C, Rust, Java,
        // C# or JavaScript re-highlighted every following line as a string, and
        // an apostrophe typed inside a `//` comment did the same.
        const carries = s.multiline === true || s.template === true;
        state.stringClose = r.closed || !carries ? null : close;
        i = r.end;
        strHit = true;
        break;
      }
    }
    if (strHit) continue;

    // char literal
    if (lang.charQuote && c === lang.charQuote) {
      let j = i + 1;
      let ch = c;
      if (line[j] === '\\' && j + 1 < line.length) { ch += line[j] + line[j + 1]; j += 2; }
      else if (line[j] && line[j] !== c) { ch += line[j]; j++; }
      if (line[j] === c) { ch += c; j++; }
      out.push({ type: 'char', value: ch });
      i = j;
      continue;
    }

    // numbers
    if (isDigit(c) || (c === '.' && isDigit(line[i + 1] ?? ''))) {
      const n = readNumber(line, i, L);
      if (n) { out.push({ type: n.type, value: n.value }); i = n.end; continue; }
    }

    // identifiers / keywords / types / builtins / constants
    if (isIdStart(c)) {
      const { value, end } = readId(line, i);
      const lower = value.toLowerCase();
      if (propOk && line[end] === ':' && !lang.markup) {
        out.push({ type: 'property', value });
        i = end; propOk = false;
        continue;
      }
      if (L.kw.has(lower)) out.push({ type: 'keyword', value });
      else if (L.constants.has(lower)) out.push({ type: 'constant', value });
      else if (L.types.has(lower)) out.push({ type: 'type', value });
      else if (L.builtins.has(lower)) out.push({ type: 'builtin', value });
      else out.push({ type: 'ident', value });
      i = end;
      propOk = false;
      continue;
    }

    // regex literals, in operand position only.
    //
    // Must come before the operator rule or `/` is always punctuation. Only
    // languages that declare `regexLiteral` reach this, and only when the
    // previous token cannot end an expression — otherwise `a / b` would try to
    // open a regex and, finding no closing slash on the line, fall through to
    // the operator branch unchanged.
    if (lang.regexLiteral && c === '/' && !canEndExpr(lastSig(out))) {
      const r = readRegex(line, i);
      if (r) { out.push({ type: 'string', value: r.value }); i = r.end; continue; }
    }

    // operators / punctuation
    let emit = '';
    for (let Lx = 3; Lx >= 1; Lx--) {
      const cand = line.slice(i, i + Lx);
      if (cand.length === Lx && /^[+\-*/%&|^!~<>=.,:;()\[\]{}@?#]+$/.test(cand)) { emit = cand; break; }
    }
    // The run above is greedy, so it happily glued `(` and `/` into one token —
    // consuming the regex opener before the regex branch could see it, so
    // `f(/x+/)` came out as punctuation. When the run *begins* with something
    // that leaves us expecting an operand, stop it before any `/` so the next
    // iteration sees the slash.
    //
    // The test is on the run's first character, not on the previous token: for
    // `f(/` the previous token is the identifier `f`, which would say "this is
    // division", but the `(` in between is what puts us back in operand
    // position.
    if (emit && lang.regexLiteral && OPENS_OPERAND.test(emit[0])) {
      const slash = emit.indexOf('/', 1);
      if (slash > 0) emit = emit.slice(0, slash);
    }
    if (emit) {
      out.push({ type: 'op', value: emit });
      i += emit.length;
      propOk = /[{,\[]/.test(emit) ? true : propOk;
      continue;
    }

    // fallback
    out.push({ type: 'ident', value: c });
    i++;
  }
}

/**
 * Tokenize a complete buffer into per-line token arrays. The returned array
 * always has one entry per logical line of `text`.
 */
export function tokenize(text: string, langId: string | undefined): Token[][] {
  const lang = getLanguage(langId) ?? getLanguage('plaintext')!;
  const L = makeLookups(lang);
  // Starts empty: the loop below pushes one entry per line, so seeding `[[]]`
  // for an empty document produced *two* entries for a one-line file, breaking
  // the "one entry per logical line" contract above.
  const lines: Token[][] = [];
  const state: CarryState = { blockClose: null, stringClose: null };

  const parts = text.split('\n');
  for (let li = 0; li < parts.length; li++) {
    const arr: Token[] = [];
    scanLine(parts[li], lang, L, state, arr);
    lines.push(arr);
  }
  return lines;
}

/** Convenience wrapper returning a memoizable tokenizer for a language id. */
export function createTokenizer(langId: string | undefined): (text: string) => Token[][] {
  return (text: string) => tokenize(text, langId);
}