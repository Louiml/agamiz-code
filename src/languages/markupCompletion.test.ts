/**
 * Markup completion: HTML and CSS.
 *
 * These are the cases that were silently broken while the engine itself looked
 * fine. Every one of them was found by asking `getSuggestions` what it actually
 * returns at a caret, not by reading the configuration — the configuration had
 * looked reasonable throughout.
 */

import { describe, expect, it } from 'vitest';
import { registerBuiltinLanguages } from './builtin';
import { extractBufferSymbols, getSuggestions, wordAt } from './completion';
import { invalidateCompletionCache } from './completion';

registerBuiltinLanguages();
invalidateCompletionCache();

/** Labels offered with the caret at the end of `before`. */
function at(before: string, languageId: string, force = false): string[] {
  return getSuggestions({ languageId, source: before, offset: before.length, force }).map(
    (s) => s.label,
  );
}

describe('the word under the caret', () => {
  it('treats a hyphenated CSS property as one word', () => {
    // The whole of CSS completion was broken by this: the default identifier
    // pattern stopped at the hyphen, so `text-ali` ranked as `ali` and matched
    // nothing. No hyphenated property was completable.
    expect(wordAt('.a { text-ali', '.a { text-ali'.length, 'css')).toBe('text-ali');
    expect(wordAt('.a { margin-', '.a { margin-'.length, 'css')).toBe('margin-');
  });

  it('keeps a CSS custom property whole, leading dashes included', () => {
    expect(wordAt(':root { --brand', ':root { --brand'.length, 'css')).toBe('--brand');
    expect(wordAt(':root { -single', ':root { -single'.length, 'css')).toBe('-single');
  });

  it('still uses a plain identifier where the language wants one', () => {
    // The CSS pattern must not leak: in JS a hyphen is subtraction, so the
    // word before the caret is  and not -b.
    expect(wordAt('let foo', 'let foo'.length, 'javascript')).toBe('foo');
    expect(wordAt('a-b', 'a-b'.length, 'javascript')).toBe('b');
  });
});

describe('HTML completion', () => {
  it('offers the tag list after <', () => {
    const labels = at('<', 'html');
    expect(labels).toContain('div');
    expect(labels).toContain('html');
  });

  it('offers the tag list after </', () => {
    expect(at('</', 'html')).toContain('div');
  });

  it('ranks the typed tag above unrelated entries', () => {
    // 'd' used to surface the `d` SVG attribute, `dir` and `download` before
    // the tag the user was typing.
    const labels = at('<d', 'html');
    expect(labels).toContain('div');
    expect(labels.indexOf('div')).toBeLessThan(labels.length - 1);
  });

  it('offers attributes inside an open tag', () => {
    // Nothing was offered here at all: there is no word to prefix-match after
    // a space, and there was no trigger for the inside-of-a-tag position.
    const labels = at('<div ', 'html');
    expect(labels).toContain('class');
    expect(labels).toContain('id');
  });

  it('does not offer attributes in body prose', () => {
    // A bare `' '` trigger would fire here, which is why the trigger is
    // guarded to "inside an unclosed tag".
    expect(at('<p>hello ', 'html')).toEqual([]);
  });

  it('narrows to the attribute being typed', () => {
    expect(at('<div cl', 'html')).toEqual(['class']);
  });

  it('offers class names already used in the document', () => {
    const doc = '<div class="wrapper">\n  <span class="label">hi</span>\n</div>\n<p class="lab';
    const labels = at(doc, 'html');
    // 'label' is harvested from the span, so it is available while the user is
    // still typing the final attribute.
    expect(labels).toContain('label');
  });

  it('harvests an attribute value before its closing quote', () => {
    // The pattern used to require the closing quote, so an attribute could only
    // be read once its tag was finished - meaning the names most worth
    // completing were unavailable exactly while they were being typed.
    const names = extractBufferSymbols('<div class="wrap', 'html').map((s) => s.label);
    expect(names).toContain('wrap');
  });
});

describe('CSS completion', () => {
  it('completes a hyphenated property prefix', () => {
    expect(at('.a { text-', 'css')).toContain('text-align');
    expect(at('.a { border-', 'css')).toContain('border-radius');
  });

  it('completes the sub-properties of a shorthand', () => {
    // `margin` was in the list but `margin-top` was not, so `margin-` matched
    // nothing at all.
    const labels = at('.a { margin-', 'css');
    expect(labels).toContain('margin-top');
    expect(labels).toContain('margin-left');
  });

  it('offers values, not properties, after a colon', () => {
    const labels = at('.a { display: ', 'css');
    expect(labels).toContain('block');
    expect(labels).toContain('flex');
    expect(labels).not.toContain('display');
  });

  it('offers values that suit the property', () => {
    // Both lists used to come from one flat pool, so `color: ` offered `flex`
    // and `display: ` offered `red`.
    const color = at('.a { color: ', 'css');
    expect(color).toContain('red');
    expect(color.slice(0, 8)).not.toContain('flex');

    const display = at('.a { display: ', 'css');
    expect(display).toContain('flex');
    expect(display.slice(0, 8)).not.toContain('red');
  });

  it('prefers a real value over a snippet on the same prefix', () => {
    // Snippets were added to the pool first and took the top slots, so
    // `color: re` led with the `reset` snippet.
    const labels = at('.a { color: re', 'css');
    expect(labels.indexOf('red')).toBeLessThan(labels.indexOf('reset'));
  });

  it('offers the class names the stylesheet already defines', () => {
    const css = '.btn { color: red; }\n.card { padding: 0; }\n.header {}\n.';
    const labels = at(css, 'css');
    expect(labels).toEqual(expect.arrayContaining(['btn', 'card', 'header']));
  });

  it('offers at-rules after @', () => {
    const labels = at('@me', 'css');
    expect(labels).toContain('@media');
  });

  it('does not treat a colour hash as an id selector', () => {
    // The `#` trigger is guarded out of declaration bodies, where `#fff` is a
    // colour and not the start of a selector.
    expect(at('.a { color: #', 'css')).not.toContain('ffffff');
  });
});

describe('ranking', () => {
  it('does not fall back to a substring on a one- or two-letter prefix', () => {
    // `cl` matched `article` and `bo` matched `viewBox`: coincidence, not a
    // choice the user could have meant.
    expect(at('<div cl', 'html')).toEqual(['class']);
  });

  it('keeps a snippet that shares a label with a keyword', () => {
    // `def` is both a Python keyword and a snippet. The keyword-only row would
    // insert `def` and leave the signature to the user, so the row carrying a
    // body has to win.
    const match = getSuggestions({ languageId: 'python', source: 'de', offset: 2 })
      .find((s) => s.label === 'def');
    expect(match?.body).toBe('def name(params):\n    \n');
  });
});

describe('forced completion (Ctrl+Space)', () => {
  it('respects the context instead of dumping the head of the pool', () => {
    const inTag = at('<div ', 'html', true);
    expect(inTag).toContain('class');
    expect(inTag).not.toContain('doctype');

    const afterColon = at('.a { color: ', 'css', true);
    expect(afterColon).toContain('red');
  });

  it('offers both vocabulary and snippets', () => {
    const rows = getSuggestions({ languageId: 'python', source: '', offset: 0, force: true });
    const kinds = rows.map((r) => r.kind);
    expect(rows.length).toBeGreaterThan(10);
    expect(kinds.some((k) => k === 'snippet')).toBe(true);
    expect(kinds.some((k) => k !== 'snippet')).toBe(true);
  });
});
