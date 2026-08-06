import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { useDebugStore } from "../store";

const setBreakpointLines = StateEffect.define<number[]>();

/** Holds the 1-based line numbers of breakpoints for this file. */
const breakpointField = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setBreakpointLines)) {
        next = new Set(effect.value);
      }
    }
    return next;
  },
});

class BreakpointMarker extends GutterMarker {
  toDOM() {
    const span = document.createElement("span");
    span.className = "breakpoint-marker";
    span.style.cssText =
      "display:inline-block;width:11px;height:11px;border-radius:50%;background:var(--color-accent-red);margin-left:4px;cursor:pointer;";
    return span;
  }
}

/**
 * Gutter showing breakpoints for the current file. Clicking a line toggles the
 * breakpoint (persisted in `useDebugStore`). The store is kept in sync so the
 * breakpoint list panel and the DAP session both observe the same set.
 */
export function breakpointGutter(filePath: string): Extension {
  return [
    breakpointField,
    EditorView.updateListener.of((update) => {
      const state = useDebugStore.getState();
      const active = state.breakpointFile === filePath ? state.breakpoints : [];
      const current = update.state.field(breakpointField, false) ?? new Set<number>();
      const hasChanged =
        current.size !== active.length || active.some((l) => !current.has(l));
      if (hasChanged) {
        update.view.dispatch({ effects: setBreakpointLines.of(active) });
      }
    }),
    gutter({
      class: "cm-breakpoint-gutter",
      lineMarker: (view, line) => {
        const lines = view.state.field(breakpointField, false) ?? new Set<number>();
        const lineNo = view.state.doc.lineAt(line.from).number;
        return lines.has(lineNo) ? new BreakpointMarker() : null;
      },
      initialSpacer: () => new BreakpointMarker(),
      lineMarkerChange: (u) =>
        u.docChanged ||
        u.transactions.some((tr) => tr.effects.some((e) => e.is(setBreakpointLines))),
      domEventHandlers: {
        mousedown: (view, block) => {
          const line = view.state.doc.lineAt(block.from).number;
          const state = useDebugStore.getState();
          const active =
            state.breakpointFile === filePath ? new Set(state.breakpoints) : new Set<number>();
          const next = active.has(line)
            ? [...active].filter((l) => l !== line).sort((a, b) => a - b)
            : [...active, line].sort((a, b) => a - b);
          state.setBreakpoints(filePath, next);
          return true;
        },
      },
    }),
  ];
}