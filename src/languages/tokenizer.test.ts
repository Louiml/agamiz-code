import { describe, expect, it, beforeAll } from 'vitest';
import { tokenize } from './tokenizer';
import { registerBuiltinLanguages } from './builtin';
import { registerLanguage } from './registry';
import { RAK_LANGUAGE } from '../extensions/rak/language';
import type { Token } from './types';

// `tokenize` resolves the language through the registry, which starts empty —
// the app registers its built-ins once at launch (`src/extensions/index.ts`).
beforeAll(() => {
  registerBuiltinLanguages();
  registerLanguage(RAK_LANGUAGE);
});

const typesIn = (langId: string, src: string): Set<string> =>
  new Set(tokenize(src, langId).flat().map((t) => t.type));

/** The number of lines the tokenizer returned. */
const lineCount = (langId: string, src: string): number => tokenize(src, langId).length;

describe('unbalanced quotes', () => {
  // One stray quote used to re-highlight every following line as a string,
  // because an unterminated string was carried across lines unconditionally.
  it('does not leak a string past the end of the line in python', () => {
    // Lines 2 and 3 are code, not string.
    const line2 = tokenize('x = "abc\ny = 2\nz = 3', 'python')[1] ?? [];
    expect(line2.some((t) => t.type === 'string')).toBe(false);
    expect(line2.some((t) => t.value === 'y')).toBe(true);
  });

  it('does not leak a string past the end of the line in go', () => {
    const out = tokenize('x := "oops\ny := 2\nz := 3', 'go');
    expect(out[1]?.some((t) => t.type === 'string')).toBe(false);
    expect(out[2]?.some((t) => t.type === 'ident' && t.value === 'z')).toBe(true);
  });

  it('does not leak a string past the end of the line in rust', () => {
    const out = tokenize('let a = "oops\nlet b = 2;', 'rust');
    expect(out[1]?.some((t) => t.type === 'string')).toBe(false);
  });

  it('still closes a terminated string normally', () => {
    const types = typesIn('python', 'a = "ok"\nb = 2');
    expect(types.has('string')).toBe(true);
    expect(tokenize('a = "ok"\nb = 2', 'python')[1]?.some((t) => t.type === 'string')).toBe(false);
  });
});

describe('triple-quoted strings', () => {
  // `tripleQuotes` was `string[]`, so the same text opened and closed. A bare
  // `]]` — from indexing a nested table — therefore opened a string that could
  // never terminate.
  it('does not treat a bare ]] as an opening delimiter in lua', () => {
    const types = typesIn('lua', 'x = a[b[1]]\nprint(2)');
    expect(types.has('string')).toBe(false);
  });

  it('highlights code after a bare ]] in lua', () => {
    const out = tokenize('x = a[b[1]]\nprint(2)', 'lua');
    expect(out[1]?.some((t) => t.type === 'string')).toBe(false);
    // `print` is a Lua builtin, not a plain identifier.
    expect(out[1]?.some((t) => t.value === 'print')).toBe(true);
  });

  it('parses a lua long string as a string', () => {
    const types = typesIn('lua', 'local s = [==[hello]==]');
    expect(types.has('string')).toBe(true);
  });

  it('parses a python docstring as a string', () => {
    const out = tokenize('"""Doc.\nmore."""\nx = 1', 'python');
    expect(out[0]?.some((t) => t.type === 'string')).toBe(true);
    // The docstring continues onto line 2 and closes there.
    expect(out[1]?.some((t) => t.type === 'string')).toBe(true);
    // Line 3 is code again.
    expect(out[2]?.some((t) => t.type === 'ident' && t.value === 'x')).toBe(true);
  });
});

describe('block versus line comments', () => {
  // The line-comment rule ran first and returned, so a block-comment opener
  // that a line-comment marker prefixes was unreachable and the comment body
  // after the first line was highlighted as code.
  it('carries an html comment across lines', () => {
    const out = tokenize('<!-- a\nb -->\n<div/>', 'html');
    expect(out[0]?.some((t) => t.type === 'comment')).toBe(true);
    expect(out[1]?.every((t) => t.type === 'comment')).toBe(true);
    // Line 3 is markup again.
    expect(out[2]?.some((t) => t.type === 'tag')).toBe(true);
  });

  it('carries a lua long comment across lines', () => {
    const out = tokenize('--[[ m\nl ]]\nprint(1)', 'lua');
    expect(out[0]?.some((t) => t.type === 'comment')).toBe(true);
    expect(out[1]?.every((t) => t.type === 'comment')).toBe(true);
    // `print` is a Lua builtin.
    expect(out[2]?.some((t) => t.value === 'print')).toBe(true);
  });

  it('still handles an ordinary line comment', () => {
    const out = tokenize('let a = 1; // note\nlet b = 2;', 'rust');
    expect(out[0]?.some((t) => t.type === 'comment')).toBe(true);
    // `let` is a Rust keyword, not an identifier.
    expect(out[1]?.some((t) => t.type === 'keyword' && t.value === 'let')).toBe(true);
  });

  it('carries a c block comment across lines', () => {
    const out = tokenize('/* one\ntwo */\nint x;', 'c');
    expect(out[0]?.some((t) => t.type === 'comment')).toBe(true);
    expect(out[1]?.every((t) => t.type === 'comment')).toBe(true);
  });
});

describe('raw strings', () => {
  // `r#"` had no `close`, so the opener was used as the terminator and the
  // string never ended.
  it('terminates a rust raw string', () => {
    const out = tokenize('let a = r#"he"llo"#;\nlet b = 2;', 'rust');
    expect(out[0]?.some((t) => t.type === 'string')).toBe(true);
    // The second line is code, not a continuation of the raw string.
    expect(out[1]?.some((t) => t.type === 'string')).toBe(false);
    expect(out[1]?.some((t) => t.type === 'ident' && t.value === 'b')).toBe(true);
  });

  it('handles a go raw string', () => {
    const out = tokenize('x := `raw`\ny := 2', 'go');
    expect(out[0]?.some((t) => t.type === 'string')).toBe(true);
    expect(out[1]?.some((t) => t.type === 'string')).toBe(false);
  });
});

describe('shapes', () => {
  it('returns one entry per logical line', () => {
    expect(lineCount('javascript', 'a\nb\nc')).toBe(3);
    expect(lineCount('javascript', 'a\nb\nc\n')).toBe(4);
  });

  it('handles an empty document as a single line', () => {
    // The old seed (`text === '' ? [[]] : []`) plus the push produced two.
    expect(lineCount('javascript', '')).toBe(1);
  });

  it('normalizes nothing — CRLF stays for the caller to handle', () => {
    // The editor normalizes before tokenizing; the tokenizer is not that layer.
    expect(lineCount('javascript', 'a\r\nb')).toBe(2);
  });
});

describe('token coverage', () => {
  it('emits a type for every character', () => {
    // Reconstructing the input is the property that matters: the highlight
    // layer is rendered from these tokens, so if any character is dropped the
    // overlay drifts from the textarea. Lines are rejoined with the newline
    // that `tokenize` splits on — the separator belongs to no token.
    for (const [lang, src] of [
      ['javascript', 'const x = /re/g; // c\n`s` + `a${b}c`'],
      ['python', 'def f(x: int) -> str:\n    """d"""\n    return f"{x!r}"'],
      ['rust', 'fn main() { let v: Vec<u8> = vec![1]; println!("{}", v.len()); }'],
      ['html', '<a href="x" class=\'y\'>t</a>'],
      ['css', '.a { color: red; }'],
      ['lua', 'local t = {[==[k]==] = 1}\n--[[ c ]]'],
      ['go', 'func main() { s := `raw`; _ = s }'],
    ] as const) {
      const joined = tokenize(src, lang)
        .map((line) => line.map((t: Token) => t.value).join(''))
        .join('\n');
      expect(joined, `${lang}: tokens must reconstruct the input`).toBe(src);
    }
  });

  it('terminates on pathological input without hanging', () => {
    // Every scanner branch must advance; this is a cheap guard against a
    // delimiter that never matches.
    const nasty = ['"', "'", '`', '/*', '<!--', '"""', '[[', '\\', '/'];
    for (const chunk of nasty) {
      const src = chunk.repeat(40);
      expect(() => tokenize(src, 'javascript')).not.toThrow();
      expect(() => tokenize(src, 'lua')).not.toThrow();
      expect(() => tokenize(src, 'html')).not.toThrow();
    }
  });
});
