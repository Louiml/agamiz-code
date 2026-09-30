/**
 * `file:line:col` link detection for the terminal.
 *
 * xterm's own link machinery is doing the hard work: `provideLinks` is handed
 * each visible buffer line, and xterm hit-tests the ranges it gets back, draws
 * the underline, and reports hover/leave on the resulting `ILink`. That means
 * no manual mouse-to-cell maths and no fragility when the font or the
 * renderer changes — the alternative (dividing mouse coordinates by a guessed
 * cell size) breaks the moment WebGL is on.
 *
 * `WebLinksAddon` covers http(s); this covers the compiler output that
 * developers actually click on.
 */

import type { ILink, ILinkProvider } from '@xterm/xterm';

/** A located file reference, already split into its parts. */
export interface FileRef {
  /** Path exactly as it appeared, so "Copy Path" round-trips. */
  path: string;
  /** 1-based line, when the reference carried one. */
  line?: number;
  /** 1-based column, when the reference carried one. */
  column?: number;
  /** 0-based character offsets of the whole reference in its buffer line. */
  start: number;
  end: number;
}

/**
 * Turn a `file://` URI into a local path, if it is one.
 *
 * `file://` is handled here rather than in the regex on purpose: the buffer
 * matcher has no way to tell a scheme's host from a path segment, and guessing
 * there is how URLs end up with bogus "Open File" entries. Here the URI is
 * already parsed, so `file:///D:/work/a.ts` → `D:/work/a.ts` is unambiguous.
 */
export function fileUriToPath(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null;
  let rest = uri.replace(/^file:\/\//i, '');
  // Strip an (empty or literal-localhost) authority component.
  rest = rest.replace(/^localhost\//i, '/');
  rest = rest.replace(/^\/+/, '/');
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/**
 * A path token: optional drive root, then `name/segment` pairs, a final name,
 * and an extension that must start with a letter or underscore.
 */
const PATH_CORE = String.raw`(?:[A-Za-z]:[\\/])?(?:[\\/]?[\w.\-]+[\\/])*[\w\-]+\.[A-Za-z_]\w{0,9}`;

/**
 * Refuse a match whose first character follows a word character, slash,
 * backslash, colon, dot or `@`.
 *
 * This is what stops `https://example.com/a/b.js:10` from being reported as a
 * file — without it, every URL in the terminal would grow an "Open File" entry
 * pointing somewhere that does not exist. Only the leftmost start position of a
 * path survives it, so `src/main.rs:42` yields one ref, not `main.rs` as well.
 *
 * The consequence is deliberate: `webpack:///src/app.js:10` is treated as the
 * URL it is and left to `WebLinksAddon`. Guessing that the host is really a
 * path segment is the same false-positive risk in reverse.
 */
const NO_PREFIX = `(?<![A-Za-z0-9_\\\\/:.@-])`;

/** `path:line[:col]` — rustc, tsc, webpack, eslint, go, npm. */
const COLON_FORM = new RegExp(`${NO_PREFIX}(${PATH_CORE}):(\\d+)(?::(\\d+))?`, 'g');
/** `path(line,col)` — the parenthesised form `tsc` still emits. */
const PAREN_FORM = new RegExp(`${NO_PREFIX}(${PATH_CORE})\\((\\d+),(\\d+)\\)`, 'g');

/** Find every file reference on one line of terminal output. */
export function findFileRefs(line: string): FileRef[] {
  const out: FileRef[] = [];
  if (!line) return out;
  for (const re of [COLON_FORM, PAREN_FORM]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const [raw, path, a, b] = m;
      // Both forms put the path first; the pair that follows is line then
      // column, in either order-independently identical layout.
      out.push({
        path,
        line: Number(a),
        column: b === undefined ? undefined : Number(b),
        // 0-based offsets, which TerminalView converts to xterm's 1-based
        // columns when it builds the link range.
        start: m.index,
        end: m.index + raw.length,
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** True when `path` looks like something worth offering "Open File" for. */
export function isPlausibleFilePath(path: string): boolean {
  if (!path || path.length < 3) return false;
  // Needs a real extension; `3.14` or a bare version string is not a file.
  return /\.[A-Za-z0-9_]{1,10}$/.test(path);
}

export interface FileRefProviderOptions {
  /** Invoked when a reference is clicked, or chosen from the context menu. */
  onOpen: (ref: FileRef) => void;
  /** Called when the pointer enters / leaves a reference. */
  onHover?: (ref: FileRef) => void;
  onLeave?: (ref: FileRef) => void;
  /** Pulls the text of a buffer line, indexed from 0. */
  getLine: (index: number) => string;
}

/**
 * xterm link provider for file references.
 *
 * Registered alongside `WebLinksAddon` rather than instead of it: xterm keeps
 * an array of providers and merges their links, so a line containing both a
 * URL and a `file:line` gets both. `hover`/`leave` on each returned link are
 * how the caller learns what is under the pointer — xterm has already done the
 * hit-testing, so no coordinate maths is needed anywhere in this feature.
 */
export function createFileRefProvider(options: FileRefProviderOptions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      // xterm hands us a 1-based buffer line, but `IBuffer.getLine` is 0-based.
      // Its own `WebLinkProvider` does this same `- 1`; skipping it reads the
      // neighbouring line, so ranges get reported for text that is not there
      // and the pointer never matches what the user can see.
      const text = options.getLine(bufferLineNumber - 1);
      const refs = findFileRefs(text).filter((r) => isPlausibleFilePath(r.path));
      if (refs.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = refs.map((ref) => ({
        text: ref.path,
        // y is the buffer line (1-based, as handed to us); x is 1-based too.
        range: {
          start: { x: ref.start + 1, y: bufferLineNumber },
          end: { x: ref.end, y: bufferLineNumber },
        },
        activate: () => options.onOpen(ref),
        hover: () => options.onHover?.(ref),
        leave: () => options.onLeave?.(ref),
      }));
      callback(links);
    },
  };
}

/**
 * Resolve a reference against the workspace root.
 *
 * Terminal output is usually relative to the shell's working directory, which
 * is the workspace root unless the user `cd`-ed. Absolute paths are returned
 * untouched. The path is returned even if it does not exist, so "Copy Path"
 * still works for paths that were never on this machine (build logs, CI).
 */
export function resolveFileRef(ref: FileRef, root: string): string {
  const { path } = ref;
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return path;
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!base || base === '.') return normalized;
  return `${base}/${normalized}`;
}
