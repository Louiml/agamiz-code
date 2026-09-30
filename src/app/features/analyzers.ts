/**
 * Language analyzers. These provide quick, in-process diagnostics with no
 * external server: bracket/string/comment balancing (driven by the language
 * registry definitions) plus a real JS syntax check. External LSP servers can
 * supersede these, but the built-ins keep quality decent for every file.
 */

import { Diagnostic } from './diag';
import { getLanguage } from '../../languages/registry';

export interface AnalyzerCtx {
  path: string;
  text: string;
  languageId: string;
}

/** Skip a JS template-literal interpolation block (brace-aware). */
function skipInterpolation(src: string, i: number): number {
  let depth = 0;
  let j = i + 1;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return j;
}

interface LexOpts {
  lineComments: string[];
  blockComments: [string, string][];
  strings: { open: string; close?: string; template?: boolean }[];
}

interface Bc {
  ch: string;
  line: number;
  character: number;
}

function mk(path: string, line: number, a: number, b: number, severity: 'error' | 'warning', source: string, message: string): Diagnostic {
  return {
    path,
    line,
    range: { start: { line: line - 1, character: a }, end: { line: line - 1, character: Math.max(b, a + 1) } },
    severity,
    source,
    message,
  };
}

/**
 * Lex a file tracking string/comment state and bracket balance. Produces
 * structural diagnostics (unmatched brackets, unterminated strings/comments)
 * that work for any registered language.
 */
export function analyzeBrackets(text: string, opts: LexOpts, path = ''): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = text.split('\n');
  const isLineComment = (c: string) => opts.lineComments.some((m) => c.startsWith(m));

  let inBlock = false;
  let blockAt = { line: 0, character: 0 };
  let inStr: { open: string; template: boolean } | null = null;

  const stack: Bc[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let i = 0;
    const push = (ch: string) => stack.push({ ch, line: li, character: i });

    while (i < line.length) {
      const c = line[i];
      const rest = line.slice(i);

      if (!inStr && !inBlock) {
        for (const [open] of opts.blockComments) {
          if (rest.startsWith(open)) {
            inBlock = true;
            blockAt = { line: li, character: i };
            i += open.length;
            break;
          }
        }
        if (inBlock) continue;
      }
      if (inBlock) {
        for (const [, close] of opts.blockComments) {
          if (rest.startsWith(close)) { inBlock = false; i += close.length; break; }
        }
        if (inBlock) {
          if (i >= line.length) break;
          i++;
          continue;
        }
        continue;
      }

      if (!inStr && isLineComment(rest)) break;

      if (!inStr) {
        const sm = opts.strings.find((s) => rest.startsWith(s.open));
        if (sm && sm.template) {
          inStr = { open: sm.open, template: true };
          i += sm.open.length;
          continue;
        }
        if (sm) {
          if (sm.close) {
            const endIdx = rest.indexOf(sm.close, sm.open.length);
            if (endIdx === -1) {
              out.push(mk(path, li + 1, i, line.length, 'error', 'syntax', `Unterminated string literal (missing ${sm.close}).`));
              break;
            }
            i += endIdx + sm.close.length;
            continue;
          }
          const q = sm.open;
          let j = i + q.length;
          let closed = false;
          while (j < line.length) {
            if (line[j] === '\\') { j += 2; continue; }
            if (line[j] === q) { closed = true; j++; break; }
            j++;
          }
          if (!closed) {
            out.push(mk(path, li + 1, i, line.length, 'error', 'syntax', 'Unterminated string literal.'));
            break;
          }
          i = j;
          continue;
        }
      } else if (inStr.template) {
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { inStr = null; i++; continue; }
        if (c === '$' && line[i + 1] === '{') { i = skipInterpolation(line, i + 1); continue; }
        i++;
        continue;
      }

      if (!inStr && c === "'" && opts.strings.some((s) => s.open === "'")) {
        const j = i + 1;
        if (j < line.length) {
          let k = line[j] === '\\' ? j + 2 : j + 1;
          if (line[k] === "'") { i = k + 1; continue; }
        }
      }

      if (c === '(' || c === '[' || c === '{') push(c);
      else if (c === ')' || c === ']' || c === '}') {
        const expect = c === ')' ? '(' : c === ']' ? '[' : '{';
        if (stack.length && stack[stack.length - 1].ch === expect) stack.pop();
        else out.push(mk(path, li + 1, i, i, 'error', 'syntax', `Unmatched '${c}'.`));
      }
      i++;
    }
  }

  if (inBlock) {
    out.push(mk(path, blockAt.line + 1, blockAt.character, lines[blockAt.line]?.length ?? 0, 'warning', 'syntax', 'Unterminated block comment.'));
  }
  for (const b of stack) {
    const expect = b.ch === '(' ? ')' : b.ch === '[' ? ']' : '}';
    out.push(mk(path, b.line + 1, b.character, b.character, 'error', 'syntax', `Unclosed '${b.ch}' — expected '${expect}'.`));
  }

  return out;
}

/**
 * A quick JS (script-mode) syntax check using the embedded V8 engine.
 *
 * `new Function` is the whole of this feature and the reason the app's CSP
 * carries `'unsafe-eval'` in `script-src` (see `tauri.conf.json`). That is a
 * deliberate, bounded trade: the input is the user's own open buffer, it is
 * parsed and never invoked (`void fn`), and nothing that reaches this editor
 * from outside the app is ever passed here. Dropping this check would let
 * `script-src` be `'self'` alone, which is the stricter option if the JS
 * diagnostics are not worth it.
 */
export function analyzeJavaScript(path: string, text: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let fn: Function;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(text);
    void fn;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lm = msg.match(/line (\d+)/);
    const cm = msg.match(/column (\d+)/);
    const line = lm ? Number(lm[1]) : 1;
    const character = cm ? Math.max(0, Number(cm[1]) - 1) : 0;
    out.push({
      path,
      line,
      range: { start: { line: line - 1, character }, end: { line: line - 1, character: character + 1 } },
      severity: 'error',
      source: 'syntax',
      message: msg,
    });
  }
  return out;
}

/**
 * Analyze an open buffer and return diagnostics for the given language.
 */
export function analyzeSource(ctx: AnalyzerCtx): Diagnostic[] {
  const { path, text, languageId } = ctx;
  const def = getLanguage(languageId);
  const out: Diagnostic[] = [];

  const lineComments =
    def?.lineComments ??
    (languageId === 'python' ? ['#'] : languageId === 'lua' ? ['--'] : ['//', '#']);
  const blockComments = def?.blockComments ?? [];
  const strings = def?.strings ?? [{ open: '"' }, { open: "'" }];

  out.push(...analyzeBrackets(text, { lineComments, blockComments, strings }, path));

  if (languageId === 'javascript') {
    out.push(...analyzeJavaScript(path, text));
  }

  if (languageId === 'python') {
    text.split('\n').forEach((line, idx) => {
      const m = line.match(/^(\t+ +| +\t+)/);
      if (m) {
        out.push(
          mk(
            path,
            idx + 1,
            0,
            line.length - line.trimStart().length,
            'warning',
            'pylint',
            'Mixture of tabs and spaces in indentation.',
          ),
        );
      }
    });
  }

  return out;
}