import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";

export interface GitGutterLine {
  /** 1-based line in the working tree. */
  line: number;
  kind: "added" | "modified" | "deleted";
  status: string;
}

const setLines = StateEffect.define<GitGutterLine[]>();

const gitGutterField = StateField.define<GitGutterLine[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setLines)) next = effect.value;
    }
    return next;
  },
});

class Marker extends GutterMarker {
  constructor(private kind: "added" | "modified" | "deleted") {
    super();
  }

  toDOM() {
    const div = document.createElement("div");
    div.className = `git-gutter-mark git-gutter-${this.kind}`;
    return div;
  }

  eq(other: Marker) {
    return this.kind === other.kind;
  }
}

/**
 * Gutter showing line-level diff indicators (green added, yellow modified,
 * red deleted) for the current file. Populate it by calling
 * `setGitGutterLines(view, lines)` whenever git status changes.
 */
export function gitGutter(): Extension {
  return [
    gitGutterField,
    gutter({
      class: "cm-git-gutter",
      lineMarker: (view, line) => {
        const lines = view.state.field(gitGutterField, false) ?? [];
        const lineNo = view.state.doc.lineAt(line.from).number;
        const hit = lines.find((l) => l.line === lineNo);
        return hit ? new Marker(hit.kind) : null;
      },
      initialSpacer: () => new Marker("modified"),
      lineMarkerChange: (u) =>
        u.docChanged ||
        u.transactions.some((tr) => tr.effects.some((e) => e.is(setLines))),
    }),
  ];
}

/** Set the diff lines for a given CodeMirror view. */
export function setGitGutterLines(view: EditorView, lines: GitGutterLine[]) {
  view.dispatch({ effects: setLines.of(lines) });
}

export function _gutterSetForTest(l: GitGutterLine[]): { line: number; kind: string }[] {
  return l.map((x) => ({ line: x.line, kind: x.kind }));
}