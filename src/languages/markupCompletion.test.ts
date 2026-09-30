/**
 * Markup completion: HTML and CSS.
 *
 * HTML and CSS are answered by the VS Code language services
 * (`vscode-html-languageservice` / `vscode-css-languageservice`), so these
 * tests are mostly about the glue: that the service is consulted, that its
 * output is ranked sensibly, that embedded `<style>` and `<script>` bodies
 * delegate correctly, and that the data-driven path still covers what the
 * services do not.
 */

import { describe, expect, it } from 'vitest';
import { registerBuiltinLanguages } from './builtin';
import { expandSnippet } from './snippetText';
import { getSuggestions, wordAt } from './completion';
import { blankOutside, embeddedRegionAt, findEmbeddedRegions } from './services/htmlRegions';

registerBuiltinLanguages();

/** Labels offered with the caret at the `|`, which is then removed. */
function at(marked: string, languageId: string): string[] {
  const offset = marked.indexOf('|');
  return getSuggestions({ languageId, source: marked.replace('|', ''), offset }).map(
    (s) => s.label,
  );
}

/** The raw service list, before any ranking, for assertions about what exists. */
function rowsAt(marked: string, languageId: string) {
  const offset = marked.indexOf('|');
  return getSuggestions({ languageId, source: marked.replace('|', ''), offset });
}

describe('the word under the caret', () => {
  it('treats a hyphenated CSS property as one word', () => {
    // The whole of CSS completion was broken by this: the default identifier
    // pattern stopped at the hyphen, so `text-ali` ranked as `ali`.
    expect(wordAt('.a { text-ali', '.a { text-ali'.length, 'css')).toBe('text-ali');
    expect(wordAt('.a { margin-', '.a { margin-'.length, 'css')).toBe('margin-');
  });

  it('keeps a CSS custom property and an at-rule whole', () => {
    expect(wordAt(':root { --brand', ':root { --brand'.length, 'css')).toBe('--brand');
    expect(wordAt('@med', '@med'.length, 'css')).toBe('@med');
  });

  it('still uses a plain identifier where the language wants one', () => {
    // The CSS pattern must not leak: in JS a hyphen is subtraction, so the word
    // before the caret is `b` and not `a-b`.
    expect(wordAt('let foo', 'let foo'.length, 'javascript')).toBe('foo');
    expect(wordAt('a-b', 'a-b'.length, 'javascript')).toBe('b');
  });
});

describe('HTML completion', () => {
  it('offers the tag list after <', () => {
    const labels = at('<|', 'html');
    expect(labels).toContain('div');
    expect(labels).toContain('section');
  });

  it('narrows to the tag being typed', () => {
    expect(at('<de|', 'html')).toEqual(['del', 'details']);
  });

  it('offers only the tag that is actually open when closing', () => {
    // The service closes what is open, which is more useful than offering every
    // element in the language.
    expect(at('<div><span></|', 'html')).toEqual(['/span']);
  });

  it('offers attributes filtered to the tag', () => {
    // The reason to use the service at all: `srcset`, `ismap` and `decoding`
    // are valid on <img> and not on <div>.
    const img = at('<img class="a" al|', 'html');
    expect(img).toContain('alt');
    const div = at('<div class="a" al|', 'html');
    expect(div).not.toContain('srcset');
    expect(div).not.toContain('ismap');
  });

  it('promotes the attributes that are on nearly every tag', () => {
    // The service orders alphabetically, which puts `accesskey` above `id`.
    const labels = at('<div |', 'html');
    expect(labels.slice(0, 2)).toEqual(['id', 'class']);
  });

  it('narrows to the attribute being typed', () => {
    expect(at('<div cl|', 'html')).toEqual(['class']);
  });

  it('offers class names already used in the document', () => {
    const doc = '<div class="wrap"><b class="lab|';
    // The service does not do this, so it comes from our own harvest - which is
    // why the closing quote is optional in the pattern.
    expect(at(doc, 'html')).toContain('label');
  });
});

describe('CSS completion', () => {
  it('completes a hyphenated property prefix', () => {
    expect(at('.a { text-al| }', 'css')).toContain('text-align');
  });

  it('keeps uncommon but valid properties reachable by scrolling', () => {
    // Slicing the service's alphabetical list to the popup size put
    // `border-radius` past the end of the list, i.e. nowhere.
    expect(at('.a { border-| }', 'css')).toContain('border-radius');
  });

  it('offers values that suit the property', () => {
    const color = at('.a { color: | }', 'css');
    expect(color).toContain('red');

    // 180 colours arrive alphabetically, so the ones typed by hand are promoted.
    expect(color.indexOf('red')).toBeLessThan(color.indexOf('aliceblue'));
  });

  it('offers at-rules after @', () => {
    expect(at('@med|', 'css')).toEqual(['@media']);
  });
});

describe('embedded regions', () => {
  it('finds a <style> body and ignores its surroundings', () => {
    const src = '<style>\n.a { color: red; }\n</style>';
    const regions = findEmbeddedRegions(src);
    expect(regions).toHaveLength(1);
    expect(regions[0].language).toBe('css');
    expect(regions[0].text.trim()).toBe('.a { color: red; }');
  });

  it('finds several regions, and both kinds', () => {
    const src = '<style>.a{}</style><script>var x = 1;</script>';
    const found = findEmbeddedRegions(src).map((r) => r.language);
    expect(found).toEqual(['css', 'javascript']);
  });

  it('leaves a non-JavaScript script type alone', () => {
    // `type="application/json"` is not JavaScript, and completing it as such
    // would be wrong rather than merely unhelpful.
    const src = '<script type="application/json">{"a":|}</script>';
    expect(embeddedRegionAt(src, src.indexOf('|'))).toBeNull();
  });

  it('keeps an unterminated <style> open to the end of the document', () => {
    const src = '<style>\n.a { color: red; }';
    const region = embeddedRegionAt(src, src.length);
    expect(region).not.toBeNull();
    expect(region!.end).toBe(src.length);
  });

  it('blanks the document outside the region but keeps every offset', () => {
    const src = '<style>.a{}</style>';
    const region = embeddedRegionAt(src, 8)!;
    const blanked = blankOutside(src, region);
    expect(blanked).toHaveLength(src.length);
    expect(blanked.slice(region.start, region.end)).toBe('.a{}');
    expect(blanked.slice(0, region.start).trim()).toBe('');
  });

  it('completes CSS inside <style>', () => {
    const labels = at('<style>\n.a { text-al| }\n</style>', 'html');
    expect(labels).toContain('text-align');
  });

  it('offers values inside <style>, not HTML attributes', () => {
    const labels = at('<style>\n.a { color: | }\n</style>', 'html');
    expect(labels).toContain('red');
    expect(labels).not.toContain('accesskey');
  });

  it('completes JavaScript inside <script>, not HTML attributes', () => {
    // There is no JavaScript service in this project, so the region recurses
    // through our own data. Without that, the popup offered `cols` and
    // `controls` in the middle of a script.
    const labels = at('<script>\nconst a = 1;\nco|\n</script>', 'html');
    expect(labels).toContain('console');
    expect(labels).not.toContain('controls');
  });
});

describe('completion spans', () => {
  it('replaces exactly the attribute name the service matched', () => {
    const alt = rowsAt('<img al|', 'html').find((s) => s.label === 'alt');
    expect(alt?.replaceStart).toBe(5);
    expect(alt?.replaceEnd).toBe(7);
  });

  it('replaces exactly the property name the service matched', () => {
    const row = rowsAt('.a { text-al| }', 'css').find((s) => s.label === 'text-align');
    expect(row?.replaceStart).toBe(5);
    expect(row?.replaceEnd).toBe(12);
  });
});

describe('snippet bodies from the services', () => {
  it('expands a tabstop instead of typing a literal $1', () => {
    // `alt="$1"` is what the service returns. Inserted raw it types `$1`.
    const r = expandSnippet('alt="$1"');
    expect(r.text).toBe('alt=""');
    expect(r.caret).toBe(5);
  });

  it('expands a default and lands the caret on it', () => {
    const r = expandSnippet('<a href="${1:https://}">$0</a>');
    expect(r.text).toBe('<a href="https://"></a>');
    expect(r.caret).toBe(19);
  });

  it('leaves a body with no tabstops to the caller', () => {
    const r = expandSnippet('text-align: ;');
    expect(r.text).toBe('text-align: ;');
    expect(r.caret).toBeUndefined();
  });

  it('treats an escaped dollar as a literal', () => {
    expect(expandSnippet('\\$5').text).toBe('$5');
  });
});
