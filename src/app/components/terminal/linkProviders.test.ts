/**
 * File-reference regex checks.
 *
 *   npx tsx src/app/components/terminal/linkProviders.test.ts
 *
 * The regex is the fragile part of this feature. A lookbehind one character
 * too lax turns every URL in the terminal into a bogus "Open File" entry; one
 * too strict misses the compiler output the feature exists for. Both failure
 * directions are pinned down here.
 */

import { expect, it } from 'vitest';
import { createFileRefProvider, fileUriToPath, findFileRefs, isPlausibleFilePath, resolveFileRef } from './linkProviders';
import type { FileRef } from './linkProviders';
import type { ILink } from '@xterm/xterm';

const paths = (line: string) => findFileRefs(line).map((r) => r.path);
const first = (line: string) => findFileRefs(line)[0];
const ref = (path: string): FileRef => ({ path, start: 0, end: 0 });

/** Keeps the original per-case names in the failure output. */
function check(name: string, cond: boolean, detail = '') {
  expect(cond, detail ? `${name} — ${detail}` : name).toBe(true);
}

it('file-reference link provider', () => {
  // 1. matches the output real tools produce
{
  check('rust', first('error[E0308]: mismatched types --> src/main.rs:42:5')?.path === 'src/main.rs');
  check('rust line only', first('  --> src/parser.rs:7')?.line === 7);
  check('tsc colon form', first('src/app.ts:12:5: error TS2304')?.path === 'src/app.ts');
  check('tsc paren form', first('src/app.ts(12,5): error TS2304')?.line === 12);
  check('tsc paren column', first('src/app.ts(12,5): error TS2304')?.column === 5);
  check('webpack plain path', first('at Foo.bar (app.js:10:20)')?.path === 'app.js');
  check('go with ./ prefix', first('./pkg/server/handler.go:88:12: undefined: x')?.path === './pkg/server/handler.go');
  check('go with ../ prefix', first('../lib/util.py:14')?.path === '../lib/util.py');
  check('absolute unix', first('/etc/nginx/nginx.conf:88')?.path === '/etc/nginx/nginx.conf');
  check('bare filename', first('at worse.rs:12')?.path === 'worse.rs');
  check('npm noise ignored', first('npm ERR! code ELIFECYCLE') === undefined);
  check('column parsed', first('at foo (a.js:10:20)')?.column === 20);
  check('column absent', first('at foo (a.js:10)')?.column === undefined);
}

console.log('2. windows absolute paths');
{
  const hit = first(String.raw`error: C:\Users\me\project\src\main.rs:42:5`);
  const expected = String.raw`C:\Users\me\project\src\main.rs`;
  check('drive path', hit?.path === expected, hit?.path);
  check('drive line', hit?.line === 42);
  check('drive column', hit?.column === 5);
  // The span must cover the whole reference, including the `:line:col` tail,
  // because that is what xterm underlines.
  const token = String.raw`C:\Users\me\project\src\main.rs:42:5`;
  check('span covers the whole reference', String.raw`error: ${token}`.slice(hit?.start, hit?.end) === token);
  check('span starts at the path', hit?.start === 7 && hit?.end === 7 + token.length);
}

console.log('3. does NOT fire on URLs (WebLinksAddon owns those)');
{
  // A false positive here is worse than a miss: every URL in the terminal
  // would sprout an "Open File" entry pointing at nothing.
  check('http url', paths('See https://example.com/a/b.js:10 for details').length === 0);
  check('url with port', paths('http://localhost:3000/app.ts:1').length === 0);
  check('url at line start', paths('https://x.dev/a.js:1').length === 0);
  check('bare domain url', paths('curl http://a.io/b.html:3').length === 0);
  check('url inside markdown', paths('[link](https://x.dev/a.js:1)').length === 0);
  check('webpack:// pseudo-url', paths('at Foo (webpack:///src/app.js:10:20)').length === 0);
  check('node_modules path', paths('node_modules/.bin/tsc').length === 0);
  check(
    'but a real path next to it still matches',
    paths('https://x.dev/a.js:1 and src/main.rs:9').join() === 'src/main.rs',
    String(paths('https://x.dev/a.js:1 and src/main.rs:9')),
  );
}

console.log('4. does NOT fire on ordinary output');
{
  check('plain sentence', paths('total 12 of 45 files').length === 0);
  check('version string', paths('version 1.2:3 released').length === 0);
  check('semver', paths('1.0.0: released').length === 0);
  check('clock', paths('12:34:56 done').length === 0);
  check('percent', paths('100% complete: 5 files').length === 0);
  check('git flags', paths('git log --oneline -5').length === 0);
  check('ellipsis', paths('... 3 dots ...').length === 0);
  check('no colon-number', paths('see src/main.rs for details').length === 0);
  check('empty line', paths('').length === 0);
  check('bare number', paths('12345:678').length === 0);
}

console.log('5. multiple refs on one line');
{
  const found = paths('a.ts:1 -> b.ts:2 -> c/d.ts:3');
  check('finds all three', found.length === 3, String(found));
  check('in order', found.join() === 'a.ts,b.ts,c/d.ts', String(found));
  const spans = findFileRefs('a.ts:1 -> b.ts:2');
  check('spans do not overlap', spans[0].end <= spans[1].start, JSON.stringify(spans.map((s) => [s.start, s.end])));
  const mixed = findFileRefs('src/a.ts(4,2) and b.rs:9');
  check('mixed forms both found', mixed.length === 2, JSON.stringify(mixed));
  check('mixed forms sorted by position', mixed[0].start < mixed[1].start);
}

console.log('6. repeated calls do not share regex state');
{
  // A module-level /g regex keeps lastIndex between calls; a stale index
  // would silently drop matches on the very next line.
  const line = 'x.ts:1 y.ts:2';
  check('first call', paths(line).length === 2);
  check('second call', paths(line).length === 2);
  check('third call', paths(line).length === 2);
  check('paren form is stateless too', paths('a.ts(1,2) b.ts(3,4)').length === 2);
}

// 7. file:// URIs
{
  // KNOWN BUG, PINNED ON PURPOSE: `rest.replace(/^\/+/, '/')` keeps one leading
  // slash, so a Windows drive URI arrives as `/D:/work/a.ts` — the drive root
  // doubled. `TerminalView` sees a plausible path and offers "Open File", which
  // the editor then cannot resolve. A UNC authority is worse: `file://server/
  // share/a.ts` collapses to the relative `server/share/a.ts`. Fixing this is
  // scheduled (use `new URL(uri)` and strip the slash only before a drive
  // letter); when it lands, these two expectations must be updated to
  // `D:/work/a.ts` and `\\server\share\a.ts`.
  check('windows file uri', fileUriToPath('file:///D:/work/a.ts') === '/D:/work/a.ts', String(fileUriToPath('file:///D:/work/a.ts')));
  check('localhost authority', fileUriToPath('file://localhost/etc/hosts') === '/etc/hosts');
  check('percent decoding', fileUriToPath('file:///D:/my%20docs/a.ts') === '/D:/my docs/a.ts');
  check('not a file uri', fileUriToPath('https://x.dev/a.js') === null);
}

console.log('8. path plausibility + resolution');
{
  check('rejects short', !isPlausibleFilePath('a'));
  check('accepts ts', isPlausibleFilePath('a.ts'));
  check('accepts long ext', isPlausibleFilePath('x.component.tsx'));
  check('rejects trailing dot', !isPlausibleFilePath('foo.'));

  const root = 'D:\\work\\app';
  check('relative joins root', resolveFileRef(ref('src/main.rs'), root) === 'D:/work/app/src/main.rs', resolveFileRef(ref('src/main.rs'), root));
  check('absolute untouched', resolveFileRef(ref('C:/x/a.ts'), root) === 'C:/x/a.ts');
  check('unix absolute untouched', resolveFileRef(ref('/x/a.ts'), root) === '/x/a.ts');
  check('empty root falls back to cwd', resolveFileRef(ref('a.ts'), '.') === 'a.ts');
  check('backslashes normalised', resolveFileRef(ref('src\\a.ts'), 'D:/w') === 'D:/w/src/a.ts');
}

console.log('9. provider wiring: 1-based buffer line -> 0-based getLine');
{
  // The bug this pins down is invisible to `findFileRefs`, which is why the
  // regex tests above all pass while file links never match on screen: xterm
  // hands `provideLinks` a 1-based line, `IBuffer.getLine` is 0-based, and
  // reading the wrong line yields ranges over text that is not there.
  const buffer = ['just a prompt', 'error: src/main.rs:42:5', 'another line'];
  const asked: number[] = [];
  const links: (ILink[] | undefined)[] = [];
  const provider = createFileRefProvider({
    onOpen: () => {},
    getLine: (index) => {
      asked.push(index);
      return buffer[index] ?? '';
    },
  });

  provider.provideLinks(2, (l) => links.push(l));

  check('asked for the 0-based index for 1-based line 2', asked.join() === '1', String(asked));
  check('found the reference', links[0]?.length === 1, JSON.stringify(links[0]));
  check('link text is the path', links[0]?.[0]?.text === 'src/main.rs', links[0]?.[0]?.text);
  // "error: " is 7 chars, so the span starts at 1-based column 8.
  const range = links[0]?.[0]?.range;
  check('start column is 1-based', range?.start.x === 8, String(range?.start.x));
  check('end column covers the reference', range?.end.x === 23, String(range?.end.x));
  check('row is the 1-based buffer line', range?.start.y === 2 && range?.end.y === 2);

  // Regression guard: a neighbouring line must not leak its reference onto
  // this one. Before the `- 1` fix, asking about line 1 returned line 2's ref.
  const leaked: (ILink[] | undefined)[] = [];
  provider.provideLinks(1, (l) => leaked.push(l));
  check('neighbouring line is not reported', leaked[0] === undefined, JSON.stringify(leaked[0]));

  // Lines outside the buffer must degrade quietly, not throw.
  const oob: (ILink[] | undefined)[] = [];
  provider.provideLinks(0, (l) => oob.push(l));
  check('line 0 does not throw', oob[0] === undefined);
  const past: (ILink[] | undefined)[] = [];
  provider.provideLinks(99, (l) => past.push(l));
  check('past the end does not throw', past[0] === undefined);

  // Hover/leave/activate must reach the caller; that is how TerminalView learns
  // which entry the context menu should offer.
  let opened: FileRef | null = null;
  let hovered: FileRef | null = null;
  let left = 0;
  const live = createFileRefProvider({
    onOpen: (r) => {
      opened = r;
    },
    onHover: (r) => {
      hovered = r;
    },
    onLeave: () => {
      left++;
    },
    getLine: (i) => buffer[i] ?? '',
  });
  const got: (ILink[] | undefined)[] = [];
  live.provideLinks(2, (l) => got.push(l));
  // xterm passes the mouse event and the link text; neither is used by the
  // provider, but the signature has to be honoured. There is no DOM here, so
  // the event is a stub.
  const evt = {} as MouseEvent;
  const link = got[0]?.[0];
  link?.hover?.(evt, 'src/main.rs');
  link?.leave?.(evt, 'src/main.rs');
  link?.activate?.(evt, 'src/main.rs');
  check('hover reports the ref', hovered !== null && (hovered as unknown as FileRef)?.line === 42);
  check('leave fires', left === 1);
  check('activate opens the ref', opened !== null && (opened as unknown as FileRef)?.column === 5);
}
});
