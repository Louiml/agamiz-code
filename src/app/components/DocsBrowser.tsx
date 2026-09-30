'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

import { RAK_DOCS, RakDocEntry } from '../../extensions/rak/docs';


function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default function DocsBrowser({ onClose, onInsert }: { onClose: () => void; onInsert?: (snippet: string) => void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<RakDocEntry | null>(null);
  const queryRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return RAK_DOCS;
    return RAK_DOCS.filter((d) => {
      const hay = `${d.title} ${d.kind} ${d.signature ?? ''} ${d.body}`.toLowerCase();
      // All space-separated query tokens must appear (AND search).
      return q.split(/\s+/).every((tok) => hay.includes(tok));
    });
  }, [query]);

  const kindColor: Record<RakDocEntry['kind'], string> = {
    builtin: 'text-yellow-400',
    keyword: 'text-purple-400',
    snippet: 'text-green-400',
    guide: 'text-cyan-400',
  };

  return (
    <div className="flex flex-col h-full w-80 bg-zinc-900 border-l border-zinc-800 flex-shrink-0 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-800 border-b border-zinc-700">
        <span className="text-xs font-semibold text-zinc-300 flex items-center gap-2"><Icon name="book" size={13} className="text-emerald-400" /> Docs</span>
        <div className="flex items-center gap-2">
          <a
            href="https://rak-lang.dev"
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-zinc-500 hover:text-emerald-400"
            title="Open web documentation"
          >
            Web docs ↗
          </a>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200 px-1" title="Close docs (Ctrl+K)"><Icon name="x" size={13} /></button>
        </div>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-zinc-800">
        <div className="flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 focus-within:border-emerald-500">
          <Icon name="search" size={13} className="text-zinc-500" />
          <input
            ref={queryRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search docs (e.g. chacha, tunnel)..."
            className="flex-1 bg-transparent text-zinc-200 outline-none placeholder:text-zinc-600"
          />
        </div>
      </div>

      {/* Results / detail */}
      <div className="flex-1 overflow-y-auto">
        {selected ? (
          <div className="p-3 space-y-2">
            <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-zinc-200"><Icon name="arrow-up" size={12} /></button>
            <div>
              <div className={`font-semibold ${kindColor[selected.kind]}`}>{selected.title}</div>
              {selected.signature && <div className="text-[11px] font-mono text-zinc-400 mt-1">{selected.signature}</div>}
            </div>
            <p className="text-zinc-300 leading-relaxed whitespace-pre-wrap">{selected.body}</p>
            {onInsert && (
              <button
                onClick={() => onInsert(selected.title)}
                className="mt-2 w-full text-center bg-zinc-800 hover:bg-emerald-600 hover:text-white text-zinc-300 rounded px-2 py-1"
              >
                Insert <span className="font-mono">{selected.title}</span>
              </button>
            )}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-zinc-600 text-center">No docs match &quot;{query}&quot;.</div>
        ) : (
          filtered.map((d) => (
            <button
              key={d.title + d.kind}
              onClick={() => setSelected(d)}
              className="w-full text-left px-3 py-1.5 hover:bg-zinc-800 flex items-start gap-2 border-b border-zinc-800/50"
            >
              <Icon name={d.kind === 'keyword' ? 'key' : d.kind === 'builtin' ? 'zap' : d.kind === 'guide' ? 'book' : 'file-code'} size={12} className="mt-0.5 text-zinc-500 flex-shrink-0" />
              <span className="min-w-0">
                <span className={`block truncate ${kindColor[d.kind]}`}>{d.title}</span>
                {d.signature && <span className="block truncate text-[10px] text-zinc-500 font-mono">{d.signature}</span>}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="px-3 py-1.5 text-[10px] text-zinc-600 border-t border-zinc-800">
        {RAK_DOCS.length} entries · searchable reference
      </div>
    </div>
  );
}