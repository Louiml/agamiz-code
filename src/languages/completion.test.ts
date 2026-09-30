/**
 * Completion engine checks.
 *
 * Run with: npx tsx src/languages/completion.test.ts
 * (or via `node --experimental-strip-types` on Node 22+).
 *
 * The point of these cases is the property the IDE actually depends on: a
 * buffer's completions come from *its* language, not from one hard-wired
 * vocabulary. Every bundled language therefore has to produce completions, and
 * a buffer must never be offered another language's identifiers.
 */

import { expect, it } from 'vitest';
import { getCompletionPool, getSuggestions, extractBufferSymbols, getPrediction } from './completion';
import { listLanguages, registerLanguage } from './registry';
import { registerBuiltinLanguages } from './builtin';
import { registerLanguageSnippets } from './snippets';
import { RAK_LANGUAGE } from '../extensions/rak/language';

registerBuiltinLanguages();
registerLanguage(RAK_LANGUAGE);

/** Keeps the original per-case names in the failure output. */
function check(name: string, cond: boolean, detail = '') {
  expect(cond, detail ? `${name} — ${detail}` : name).toBe(true);
}

/** Completions as if the caret sits at the end of `source`. */
function labels(source: string, languageId: string, force = false): string[] {
  return getSuggestions({ languageId, source, offset: source.length, force }).map((s) => s.label);
}

/** Bodies of the suggestions a typed prefix produces. */
function bodies(prefix: string, languageId: string): (string | undefined)[] {
  const source = prefix;
  return getSuggestions({ languageId, source, offset: source.length }).map((s) => s.body);
}

it('completion engine', () => {
  // 1. every registered language produces completions
{
  // Plain text is deliberately vocabulary-free: a .txt buffer should not pop up.
  const silent = new Set(['plaintext']);
  for (const def of listLanguages()) {
    const size = getCompletionPool(def.id).length;
    check(
      `${def.id} has a vocabulary`,
      silent.has(def.id) ? size === 0 : size > 0,
      `pool for "${def.id}" has ${size} entries`,
    );
  }
}

console.log('\n2. completions are scoped to the buffer language');
{
  const py = labels('pr', 'python');
  check('python offers print', py.includes('print'), py.join(','));
  check('python does not offer C printf', !py.includes('printf'), py.join(','));
  check('python does not offer Rak tunnel', !py.includes('tunnel'));

  const rak = labels('tun', 'rak');
  check('rak offers tunnel', rak.includes('tunnel'), rak.join(','));
  check('rak does not offer python print', !rak.includes('print'));

  const c = labels('print', 'c');
  check('c offers printf', c.includes('printf'), c.join(','));

  const css = labels('backgro', 'css');
  check('css offers background', css.includes('background'), css.join(','));
  check('css does not offer python print', !css.includes('print'));
}

console.log('\n3. the buffer itself is harvested for declared names');
{
  const py = extractBufferSymbols('def handler(evt):\n    count = 1\n', 'python');
  const names = py.map((s) => s.label);
  check('python def', names.includes('handler'), names.join(','));
  check('python assignment', names.includes('count'), names.join(','));

  const go = extractBufferSymbols('func main() {\n\ttotal := 1\n}\n', 'go').map((s) => s.label);
  check('go func', go.includes('main'), go.join(','));
  check('go := binding', go.includes('total'), go.join(','));

  const rs = extractBufferSymbols('struct Point {}\nimpl Point {}\nlet origin = Point;\n', 'rust')
    .map((s) => s.label);
  check('rust struct/impl', rs.includes('Point'), rs.join(','));
  check('rust let', rs.includes('origin'), rs.join(','));

  const js = extractBufferSymbols('const { alpha, beta: renamed } = src;\n', 'javascript')
    .map((s) => s.label);
  check('js destructuring', js.includes('alpha') && js.includes('renamed'), js.join(','));

  // A capture that lands on a keyword is noise, not a declaration.
  const c = extractBufferSymbols('if (ready) {\n}\n', 'c').map((s) => s.label);
  check('c drops keyword captures', !c.includes('if'), c.join(','));

  const json = extractBufferSymbols('{\n  "name": "x",\n  "age": 1\n}\n', 'json').map((s) => s.label);
  check('json keys', json.includes('name') && json.includes('age'), json.join(','));

  const css = extractBufferSymbols(':root {\n  --brand: red;\n}\n.card { color: var(--brand); }\n', 'css')
    .map((s) => s.label);
  check('css custom property', css.includes('--brand'), css.join(','));
  check('css class', css.includes('card'), css.join(','));
}

console.log('\n4. symbols are offered ahead of the built-in vocabulary');
{
  const got = labels('def handleRequest(evt):\n    pass\nhandleR', 'python');
  check('buffer symbol is suggested', got.includes('handleRequest'), got.join(','));
  check('buffer symbol outranks the keyword', got[0] === 'handleRequest', got.join(','));
}

console.log('\n5. context predictions follow each language block style');
{
  check(
    'python if -> colon',
    getPrediction('python', 'if ')?.body === ':\n    ',
    JSON.stringify(getPrediction('python', 'if ')),
  );
  check(
    'python def -> signature',
    getPrediction('python', 'def ')?.body === 'name(params):\n    ',
  );
  check('lua if -> end', getPrediction('lua', 'if ')?.body === '\n    \nend');
  check('shell if -> fi', getPrediction('shell', 'if ')?.body === 'then\n    \nfi');
  check('shell for -> done', getPrediction('shell', 'for ')?.body === 'in "$@"\n    \ndone');
  check('rust fn -> braces', getPrediction('rust', 'fn ')?.body === 'name(args) {\n    \n}');
  check('typescript let -> = value', getPrediction('typescript', 'let ')?.body === 'name = value');
  check('rak tunnel -> link block', getPrediction('rak', 'tunnel ')?.body === 'link "passphrase" {\n    \n}');
  // Mid-word the prefix path applies, so no prediction is offered.
  check('no prediction mid-word', getPrediction('python', 'if x') === null);
  check('no prediction for an unrelated word', getPrediction('python', 'zz ') === null);
  check('plaintext has no predictions', getPrediction('plaintext', 'if ') === null);
}

console.log('\n6. a prediction is only offered where the language has one');
{
  check('python if shows the colon block', labels('if ', 'python').join() === ': …', labels('if ', 'python').join());
  check('json after a key shows nothing', labels('"name": ', 'json').length === 0);
  // Mid-word the prefix path applies, so the prediction must not leak in.
  check('typing a word drops the prediction', !labels('if x', 'python').includes(': …'), labels('if x', 'python').join(','));
}

console.log('\n6b. a trigger opens the list where there is no word');
{
  const tags = getSuggestions({ languageId: 'html', source: '<', offset: 1, limit: 40 }).map((s) => s.label);
  check('html < offers tags', tags.includes('div') && tags.includes('section'), tags.join(','));
  check('html < offers no attributes', !tags.includes('href'), tags.join(','));
  check('html < list is capped by limit', labels('<', 'html').length <= 8);
  check('closing tag trigger', labels('</', 'html').includes('div'), labels('</', 'html').join(','));
  // `color: ` has no word either, but CSS wants the value list.
  check('css after a colon offers values', labels('color: ', 'css').includes('flex'), labels('color: ', 'css').join(','));
  check('languages without triggers stay quiet', labels('( ', 'python').length === 0);
}

console.log('\n7. ranking: exact, then prefix, then camelCase, then substring');
{
  const js = 'function getUser() {}\nfunction getUsername() {}\ngu';
  const got = labels(js, 'javascript');
  check('camelCase abbreviation matches', got.includes('getUser'), got.join(','));
  check('camelCase ranks ahead of the longer name', got[0] === 'getUser', got.join(','));

  const contains = labels('function computeTotal() {}\ncompu', 'javascript');
  check('substring still matches', contains.includes('computeTotal'), contains.join(','));

  // The typed word is already the only match: stay out of the way.
  check('exact-only match is suppressed', labels('print', 'python').length === 0);
}

console.log('\n8. forced completion offers the whole pool');
{
  const all = getSuggestions({ languageId: 'python', source: '', offset: 0, force: true });
  check('force returns rows', all.length > 10, String(all.length));
  check('force is capped', all.length <= 16, String(all.length));
  check('snippets come first', all[0].kind === 'snippet', `${all[0].kind}:${all[0].label}`);

  const quiet = getSuggestions({ languageId: 'python', source: '', offset: 0 });
  check('no force and no prefix shows nothing', quiet.length === 0);
  check('unknown language shows nothing', getSuggestions({ languageId: undefined, source: 'pr', offset: 2 }).length === 0);
  // Plain text has no vocabulary, so a .txt buffer must stay silent.
  check('plaintext stays silent', getSuggestions({ languageId: 'plaintext', source: 'hel', offset: 3 }).length === 0);
  check('unknown id stays silent', getSuggestions({ languageId: 'brainfuck', source: 'hel', offset: 3 }).length === 0);
}

console.log('\n9. snippet bodies are language-correct');
{
  const fnSnippet = getSuggestions({ languageId: 'python', source: 'de', offset: 2 })
    .find((s) => s.label === 'def');
  check('python def body', fnSnippet?.body === 'def name(params):\n    \n', JSON.stringify(fnSnippet?.body));

  const luaFn = getSuggestions({ languageId: 'lua', source: 'func', offset: 4 })
    .find((s) => s.label === 'func');
  check('lua func body ends with end', luaFn?.body?.endsWith('end') === true, JSON.stringify(luaFn?.body));

  check('css property inserts a colon', bodies('backgr', 'css').includes('background: '));
  check('html attribute inserts a quote', bodies('clas', 'html').includes('class="'));
}

console.log('\n10. extensions can contribute snippets at runtime');
{
  const dispose = registerLanguageSnippets('python', [
    { prefix: 'zqz', label: 'contributed', body: 'pass' },
  ]);
  check('contributed snippet appears', labels('zq', 'python').includes('zqz'), labels('zq', 'python').join(','));
  dispose();
  check('disposing removes it', !labels('zq', 'python').includes('zqz'), labels('zq', 'python').join(','));
}

});
