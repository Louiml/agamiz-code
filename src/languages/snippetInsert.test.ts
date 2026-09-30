/**
 * Snippet behaviour at the point of insertion.
 *
 * Bodies come from three places - the language services, the hand-written
 * tables, and a user's own `registerLanguageSnippets` - and they all end up
 * here. These are the rules that have to hold for all of them.
 */

import { describe, expect, it } from 'vitest';
import { registerBuiltinLanguages } from './builtin';
import { getSuggestions } from './completion';
import { expandSnippet, reindentSnippet } from './snippetText';

registerBuiltinLanguages();

const at = (source: string, languageId: string) =>
  getSuggestions({ languageId, source, offset: source.length }).map((s) => s.label);

describe('tabstop expansion', () => {
  it('expands a bare tabstop instead of typing a literal $1', () => {
    expect(expandSnippet('alt="$1"')).toEqual({ text: 'alt=""', caret: 5 });
  });

  it('keeps a default and lands the caret on it', () => {
    expect(expandSnippet('${1:href}="$2"')).toEqual({ text: 'href=""', caret: 0 });
  });

  it('honours the exit marker over an earlier placeholder', () => {
    expect(expandSnippet('${1:name} $0').caret).toBe(5);
  });

  it('treats an escaped dollar as a literal', () => {
    expect(expandSnippet('\\$5').text).toBe('$5');
  });

  it('leaves a body with no tabstops to the caller', () => {
    expect(expandSnippet('text-align: ;')).toEqual({
      text: 'text-align: ;',
      caret: undefined,
    });
  });

  it('leaves an unknown construct alone rather than deleting it', () => {
    // `$foo` is not a tabstop. Dropping it would silently lose text.
    expect(expandSnippet('cost: $foo').text).toBe('cost: $foo');
  });

  it('leaves an unterminated brace alone', () => {
    expect(expandSnippet('a ${1:x').text).toBe('a ${1:x');
  });
});

describe('re-indenting', () => {
  it('converts the authored four spaces to the editor unit', () => {
    const body = '<html>\n    <head>\n    </head>\n</html>';
    expect(reindentSnippet(body, '', '  ')).toBe('<html>\n  <head>\n  </head>\n</html>');
    expect(reindentSnippet(body, '', '\t')).toBe('<html>\n\t<head>\n\t</head>\n</html>');
  });

  it('shifts continuation lines by the caret line indent', () => {
    // The first line is spliced into a line that already has its own indent, so
    // only the lines after it move. The authored `</div>` sits at column 0 and
    // still has to move, or it would land at the start of the line.
    const body = '<div>\n    <span>\n    </span>\n</div>';
    expect(reindentSnippet(body, '  ', '  ')).toBe(
      '<div>\n    <span>\n    </span>\n  </div>',
    );
  });

  it('keeps relative depth across several levels', () => {
    const body = 'a {\n    b {\n        c {\n        }\n    }\n}';
    expect(reindentSnippet(body, '', '  ')).toBe('a {\n  b {\n    c {\n    }\n  }\n}');
  });

  it('leaves a single-line body alone', () => {
    expect(reindentSnippet('text-align: ;', 'xx', '  ')).toBe('text-align: ;');
  });

  it('does not add trailing whitespace to a blank line', () => {
    expect(reindentSnippet('a {\n\n}', '', '    ')).toBe('a {\n\n}');
  });
});

describe('snippets survive next to the language services', () => {
  // The services know every valid name and nothing about snippets. Returning
  // their rows on their own pushed ours off the list: `hov` offered `:hover`
  // from the CSS service and not the `hover` snippet, and `do` put the
  // `download` attribute above `doctype`.
  it('offers the hover snippet for a pseudo-class prefix', () => {
    expect(at('a { hov', 'css')).toContain('hover');
  });

  it('offers the doctype snippet', () => {
    expect(at('do', 'html')).toContain('doctype');
  });

  it('offers the element snippet even when the tag is already complete', () => {
    // `div` is also a valid element name, so the "already typed" rule answered
    // with nothing at all - but `<div></div>` is exactly what was wanted.
    expect(at('div', 'html')).toContain('div');
  });

  it('keeps a service result alongside a snippet of the same prefix', () => {
    expect(at('a { grid', 'css')).toContain('grid');
  });
});
