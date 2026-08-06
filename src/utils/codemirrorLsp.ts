import { autocompletion } from "@codemirror/autocomplete";
import { linter, type Diagnostic as LintDiagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, type Tooltip, type TooltipView } from "@codemirror/view";
import { useLspDiagnosticsStore } from "../store";
import { lsp, supportedLanguage, type CompletionItem } from "./lsp";

function completionKind(item: CompletionItem): string {
  const kinds: Record<number, string> = {
    1: "txt", 2: "mth", 3: "fn", 4: "cons", 5: "cls",
    6: "ifc", 7: "mod", 8: "prop", 9: "var", 10: "cnst",
    13: "enum", 14: "ifc", 15: "prop", 17: "var",
  };
  return kinds[item.kind ?? 0] ?? "txt";
}

function completionSource(path: string) {
  return async (context: import("@codemirror/autocomplete").CompletionContext) => {
    const word = context.matchBefore(/[\w$.-]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const line = context.state.doc.lineAt(context.pos).number - 1;
    const character = context.pos - context.state.doc.lineAt(context.pos).from;
    try {
      const items = await lsp.completion(path, line, character);
      if (!items || items.length === 0) return null;
      return {
        from: word.from,
        options: items.map((item) => ({
          label: item.label,
          type: completionKind(item),
          detail: item.detail,
          apply: item.insertText ?? item.label,
        })),
      };
    } catch {
      return null;
    }
  };
}

function hoverSource(path: string) {
  return (view: EditorView, pos: number): Tooltip | Promise<Tooltip | null> | null => {
    const line = view.state.doc.lineAt(pos).number - 1;
    const character = pos - view.state.doc.lineAt(pos).from;
    return lsp.hover(path, line, character).then((result) => {
      if (!result?.contents?.value) return null;
      const dom = document.createElement("div");
      dom.className = "lsp-hover";
      dom.textContent = result.contents.value.replace(/```[\s\S]*?```/g, "").trim();
      return {
        pos,
        end: pos,
        above: true,
        create: (): TooltipView => ({ dom }),
      } as Tooltip;
    });
  };
}

function lintSource(path: string) {
  return (view: EditorView): LintDiagnostic[] => {
    if (!path) return [];
    const diagnostics = useLspDiagnosticsStore.getState().getForFile(path);
    return diagnostics.map((d) => ({
      from: lineColToPos(view, d.line, d.col),
      to: lineColToPos(view, d.endLine, d.endCol),
      severity: d.severity === "error" ? "error" : "warning",
      message: d.message,
      source: d.source,
    }));
  };
}

function lineColToPos(view: EditorView, line: number, col: number): number {
  if (line <= 0) return 0;
  const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
  return l.from + Math.min(col, l.length);
}

export function lspExtensions(
  path: string,
  onOpenLocation?: (uri: string, line: number, character: number) => void,
): Extension[] {
  if (!path || !supportedLanguage(pathToLanguage(path))) return [];
  const goToDefinition = () => {
    return (view: EditorView) => {
      const pos = view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos).number - 1;
      const character = pos - view.state.doc.lineAt(pos).from;
      void lsp
        .definition(path, line, character)
        .then((locations) => {
          const first = locations?.[0];
          if (first) onOpenLocation?.(first.uri, first.range.start.line, first.range.start.character);
        })
        .catch(() => {});
      return true;
    };
  };
  return [
    autocompletion({ override: [completionSource(path)] }),
    linter(lintSource(path), { delay: 300 }),
    hoverTooltip(hoverSource(path), { hideOnChange: true }),
    keymap.of([
      { key: "Mod-Alt-.", run: goToDefinition() },
      { key: "F12", run: goToDefinition() },
    ]),
  ];
}

export function pathToLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts": case "tsx": case "mts": case "cts": return "typescript";
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "rs": return "rust";
    case "py": return "python";
    case "go": return "go";
    default: return ext;
  }
}