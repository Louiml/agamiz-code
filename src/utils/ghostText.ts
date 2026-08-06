import { EditorView, WidgetType, Decoration, keymap } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { ai } from "./ai";

// ---- State ---------------------------------------------------------------

interface GhostSpec {
  pos: number;
  text: string;
}

const setGhost = StateEffect.define<GhostSpec>();
const clearGhost = StateEffect.define();

const ghostField = StateField.define<GhostSpec | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhost)) return effect.value;
      if (effect.is(clearGhost)) return null;
    }
    if (tr.docChanged) return null; // discard on any edit
    return value;
  },
});

// ---- inline widget -------------------------------------------------------

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.textContent = this.text;
    return span;
  }

  eq(other: GhostWidget) {
    return this.text === other.text;
  }
}

// ---- decoration layer ----------------------------------------------------

function ghostDecorator(): Extension {
  return EditorView.decorations.compute(
    ["doc", ghostField],
    (state) => {
      const ghost = state.field(ghostField, false);
      if (!ghost) return Decoration.none;
      let pos = ghost.pos;
      if (pos > state.doc.length) pos = state.doc.length;
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(pos),
      ]);
    },
  );
}

// ---- completion debouncer -------------------------------------------------

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleComplete(view: EditorView, filePath: string) {
  const prev = pending.get(filePath);
  if (prev != null) clearTimeout(prev);
  const timer = setTimeout(() => {
    pending.delete(filePath);
    const pos = view.state.selection.main.head;
    const prefix = view.state.doc.slice(0, pos).toString();
    void ai.complete(prefix).then((suggestion) => {
      if (suggestion != null && suggestion.length > 0) {
        view.dispatch({ effects: setGhost.of({ pos, text: suggestion }) });
      }
    }).catch(() => {});
  }, 300);
  pending.set(filePath, timer);
}

// ---- extension -----------------------------------------------------------

/**
 * AI-powered ghost-text extension. Waits for typing pauses, then queries
 * the local completion engine and renders a faded hint after the cursor.
 * Tab inserts the hint; any edit or Escape dismisses it.
 */
export function ghostTextExtension(filePath: string): Extension {
  return [
    ghostField,
    ghostDecorator(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        update.view.dispatch({ effects: clearGhost.of(null) });
        scheduleComplete(update.view, filePath);
      }
    }),
    keymap.of([
      {
        key: "Tab",
        run: (view: EditorView) => {
          const ghost = view.state.field(ghostField, false);
          if (!ghost) return false;
          const from = view.state.selection.main.head;
          view.dispatch({
            changes: { from, to: from, insert: ghost.text },
            effects: clearGhost.of(null),
          });
          return true;
        },
        preventDefault: true,
      },
      {
        key: "Escape",
        run: (view: EditorView) => {
          view.dispatch({ effects: clearGhost.of(null) });
          return true;
        },
      },
    ]),
  ];
}