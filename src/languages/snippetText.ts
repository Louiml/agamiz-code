/**
 * Snippet body expansion.
 *
 * The language services return snippet bodies in VS Code's snippet syntax -
 * `alt="$1"`, `text-align: $0;`, `${1:href}`. Nothing expands those, so
 * accepting a completion would have typed the literal `$1` into the file.
 *
 * This is deliberately not a full snippet implementation. There are no
 * variables, no mirrors and no nested tabstop choices, because nothing produces
 * them. What is here is the part that appears in real bodies: a tabstop with a
 * default, a bare tabstop, and the final caret marker.
 */

export interface ExpandedSnippet {
  /** The text to insert. */
  text: string;
  /**
   * Offset into `text` to leave the caret at, or `undefined` when the body has
   * no tabstops and the caller should apply its own rule.
   */
  caret?: number;
}

/** One tabstop found while scanning. */
interface Stop {
  /** Offset in the output where this tabstop's default text begins. */
  at: number;
  /** Higher is later: `$0` is always the last position. */
  order: number;
}

export function expandSnippet(body: string): ExpandedSnippet {
  let out = '';
  const stops: Stop[] = [];

  for (let i = 0; i < body.length; i++) {
    const c = body[i];

    // `\$` is an escaped dollar and stands for itself.
    if (c === '\\' && body[i + 1] === '$') {
      out += '$';
      i++;
      continue;
    }

    if (c !== '$') {
      out += c;
      continue;
    }

    // `${...}` - either `${N}` or `${N:default}`.
    if (body[i + 1] === '{') {
      const close = body.indexOf('}', i + 2);
      if (close === -1) {
        out += c;
        continue;
      }
      const inner = body.slice(i + 2, close);
      const colon = inner.indexOf(':');
      const num = Number(colon === -1 ? inner : inner.slice(0, colon));
      if (!Number.isInteger(num)) {
        out += c;
        continue;
      }
      const def = colon === -1 ? '' : inner.slice(colon + 1);
      stops.push({ at: out.length, order: num });
      out += def;
      i = close;
      continue;
    }

    // `$N`, including `$0`.
    const rest = /^(\d+)/.exec(body.slice(i + 1));
    if (!rest) {
      // Not a tabstop. Left as written rather than silently deleted, so an
      // unknown construct is visible instead of vanishing.
      out += c;
      continue;
    }
    const num = Number(rest[1]);
    stops.push({ at: out.length, order: num });
    i += rest[0].length;
  }

  if (stops.length === 0) return { text: out, caret: undefined };

  // `$0` marks where the caret ends up. Without one, the first placeholder is
  // the sensible landing spot.
  const exit = stops.find((s) => s.order === 0);
  const target = exit ?? stops[0];
  return { text: out, caret: Math.min(target.at, out.length) };
}

/**
 * The indent a snippet body was authored with.
 *
 * Bodies in `builtin/snippets.ts` are written with four spaces per level,
 * expanded from a shared constant at module load. Treating that as *one level*
 * rather than as literal text is what lets a body follow the editor's own
 * `tabSize` and `insertSpaces` instead of always inserting four spaces.
 */
const AUTHORED_INDENT = 4;

/**
 * Re-indent an inserted body to the caret's line and the editor's indent unit.
 *
 * The first line is left alone: it is spliced into the middle of an existing
 * line, so it already carries whatever indent that line had. Continuation lines
 * keep their *relative* depth, converted from the authored four spaces to
 * `unit`, and are then shifted by `base` so the fragment lines up with the line
 * it was inserted on.
 *
 * A blank line is left completely empty rather than given trailing whitespace.
 */
export function reindentSnippet(text: string, base: string, unit: string): string {
  const lines = text.split('\n');
  if (lines.length === 1) return text;
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      // A genuinely empty line stays empty, so the fragment does not gain
      // trailing whitespace on its blank lines.
      if (line.length === 0) return line;
      const lead = /^[ \t]*/.exec(line)![0];
      // Depth zero is normal and meaningful: a closing `</div>` is written at
      // column 0 in the authored body and still has to move with the fragment,
      // or it lands at the start of the line in an indented block.
      const depth = Math.round(lead.length / AUTHORED_INDENT);
      return base + unit.repeat(depth) + line.slice(lead.length);
    })
    .join('\n');
}
