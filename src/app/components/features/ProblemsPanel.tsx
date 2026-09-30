'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Diagnostic, DiagnosticStore, SEVERITY_ORDER, severityBadgeColor, severityLabel, severityColor } from '../../features/diag';

interface ProblemsPanelProps {
  store: DiagnosticStore;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

/** Group diagnostics by file, then by severity; supports filtering. */
export default function ProblemsPanel({ store, activeFile, onOpenFile }: ProblemsPanelProps) {
  const [, force] = useState(0);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning' | 'info'>('all');

  useEffect(() => {
    const un = store.onDidChangeCounts(() => { setTick((t) => t + 1); force((x) => x + 1); });
    return un;
  }, [store]);

  const grouped = useMemo(() => {
    const map = new Map<string, Diagnostic[]>();
    for (const d of store.all()) {
      if (filter !== 'all' && d.severity !== filter) continue;
      const arr = map.get(d.path) ?? [];
      arr.push(d);
      map.set(d.path, arr);
    }
    const entries: { path: string; diags: Diagnostic[] }[] = [];
    for (const [path, diags] of map) entries.push({ path, diags });
    entries.sort((a, b) => {
      const ka = a.path.toLowerCase();
      const kb = b.path.toLowerCase();
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return entries;
  }, [store, filter, tick]);

  const counts = store.counts();
  const activePath = activeFile;

  const filterTabs = [
    { id: 'all' as const, label: 'All', n: store.all().length },
    { id: 'error' as const, label: 'Errors', n: counts.error },
    { id: 'warning' as const, label: 'Warnings', n: counts.warning },
    { id: 'info' as const, label: 'Info', n: counts.info },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800 bg-zinc-900">
        {filterTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setFilter(t.id)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium ${
              filter === t.id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'
            }`}
          >
            {t.label} {t.n}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {grouped.length === 0 && (
          <div className="p-4 text-xs text-zinc-600">No problems detected.</div>
        )}
        {grouped.map(({ path, diags }) => {
          const isActive = path && activePath ? sameFile(path, activePath) : false;
          const hasErrors = diags.some((d) => d.severity === 'error');
          return (
            <div key={path} className="text-xs">
              <button
                onClick={() => path && onOpenFile(path)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 font-medium hover:bg-zinc-800 ${
                  isActive ? 'bg-emerald-500/10 text-emerald-400' : 'text-zinc-300'
                }`}
                title={path}
              >
                <span className={hasErrors ? 'text-red-400' : 'text-amber-400'}>
                  <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor" /></svg>
                </span>
                <span className="truncate">{basename(path)}</span>
                <span className="ml-auto text-zinc-600 whitespace-nowrap">{diags.length}</span>
              </button>
              {diags
                .slice()
                .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
                .map((d, i) => (
                  <button
                    key={i}
                    onClick={() => onOpenFile(path)}
                    className={`w-full text-left flex gap-2 px-2 py-1 pl-6 hover:bg-zinc-800/60 ${isActive ? 'text-zinc-200' : 'text-zinc-400'}`}
                  >
                    <span className={severityBadgeColor(d.severity) + ' shrink-0 px-1 rounded text-[9px] font-bold leading-4'}>
                      {severityLabel(d.severity)}
                    </span>
                    <span className="truncate"><span className={severityColor(d.severity)}>Ln {d.line},</span> {d.message}</span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function sameFile(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}