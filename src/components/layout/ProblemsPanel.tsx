import { useMemo } from "react";
import { useEditorStore, useLspDiagnosticsStore } from "../../store";

export function ProblemsPanel() {
  const byFile = useLspDiagnosticsStore((s) => s.byFile);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);

  const rows = useMemo(() => {
    return Object.entries(byFile)
      .flatMap(([file, diags]) =>
        diags.map((d) => ({
          file,
          line: d.line + 1,
          col: d.col + 1,
          severity: d.severity,
          message: d.message,
          source: d.source,
        })),
      )
      .sort((a, b) => {
        const order = { error: 0, warning: 1, info: 2, hint: 3 };
        return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
      });
  }, [byFile]);

  const openEditor = (file: string) => {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const tabs = useEditorStore.getState().tabs;
    const match = tabs.find((t) => norm(t.path).endsWith(norm(file)));
    if (match) setActiveTab(match.id);
  };

  const sevColors: Record<string, string> = {
    error: "text-[var(--color-accent-red)]",
    warning: "text-[var(--color-accent-orange)]",
    info: "text-[var(--color-accent-teal)]",
    hint: "text-[var(--color-text-tertiary)]",
  };
  const sevDot: Record<string, string> = {
    error: "\u25CF",
    warning: "\u25B2",
    info: "\u25C6",
    hint: "\u25C7",
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-apple">
      {rows.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center py-8">
          <span className="text-[12px] text-[var(--color-text-tertiary)]">
            No problems detected.
          </span>
        </div>
      ) : (
        rows.map((r, i) => (
          <button
            key={i}
            className="w-full flex items-start gap-2 px-3 py-1 text-left text-[12px] hover:bg-[var(--color-bg-glass)] transition-colors"
            onClick={() => openEditor(r.file)}
          >
            <span
              className={`${sevColors[r.severity]} select-none leading-relaxed`}
            >
              {sevDot[r.severity]}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block truncate text-[var(--color-text-primary)]">
                {r.message}
              </span>
              <span className="block truncate text-[11px] text-[var(--color-text-tertiary)] font-mono">
                {r.file.split(/[\\/]/).pop()} · {r.line}:{r.col}
                {r.source ? ` · ${r.source}` : ""}
              </span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}