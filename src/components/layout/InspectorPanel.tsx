import { useInspectorStore } from "../../store";

export function InspectorPanel() {
  const visible = useInspectorStore((s) => s.visible);
  const width = useInspectorStore((s) => s.width);

  if (!visible) return null;

  return (
    <aside
      className="flex flex-col shrink-0 border-l border-[var(--color-border-glass)] glass animate-slide-right scrollbar-apple overflow-y-auto"
      style={{ width }}
    >
      <div className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)] mb-3">
          Inspector
        </p>

        <section className="mb-5">
          <h3 className="text-[11px] font-medium text-[var(--color-text-secondary)] mb-2">
            Diagnostics
          </h3>
          <div className="text-[12px] text-[var(--color-text-tertiary)] italic">
            No issues detected
          </div>
        </section>

        <section className="mb-5">
          <h3 className="text-[11px] font-medium text-[var(--color-text-secondary)] mb-2">
            Symbols
          </h3>
          <div className="text-[12px] text-[var(--color-text-tertiary)] italic">
            Select a file to browse symbols
          </div>
        </section>

        <section>
          <h3 className="text-[11px] font-medium text-[var(--color-text-secondary)] mb-2">
            Outline
          </h3>
          <div className="text-[12px] text-[var(--color-text-tertiary)] italic">
            No outline available
          </div>
        </section>
      </div>
    </aside>
  );
}