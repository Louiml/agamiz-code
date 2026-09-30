'use client';

import React, { useMemo, useState } from 'react';
import { Icon, IconName } from '../Icon';

export interface SearchableFile {
  path: string;
  name: string;
  dir: string;
}

interface GlobalSearchProps {
  files: SearchableFile[];
  onOpen: (path: string, name: string) => void;
}

/**
 * Global Search & Replace panel. Filters workspace files by name (substring)
 * and shows a small preview of matches. Replace actions are stubbed until the
 * backend file-watcher index is wired in.
 */
export default function GlobalSearch({ files, onOpen }: GlobalSearchProps) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files.slice(0, 100);
    return files.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)).slice(0, 100);
  }, [query, files]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 bg-ide-raised border-b border-ide-border-soft">
        <span className="text-[10px] font-semibold tracking-wide text-ide-muted uppercase mb-2 block">
          Search
        </span>
        <div className="flex items-center gap-2">
          <Icon name="search" size={13} className="text-ide-muted shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files..."
            className="flex-1 bg-transparent outline-none text-xs text-ide-fg placeholder:text-ide-faint"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-ide-faint hover:text-ide-fg">
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-ide-border-soft text-[10px] text-ide-faint">
          <span>{matches.length} result{matches.length === 1 ? '' : 's'}</span>
          <button className="hover:text-ide-muted text-ide-faint" title="Replace (index incoming)">
            <Icon name="replace" size={11} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto ide-scrollbar py-1">
        {matches.length === 0 && (
          <div className="px-3 py-6 text-[11px] text-ide-faint text-center">No matching files</div>
        )}
        {matches.map((f) => (
          <button
            key={f.path}
            onClick={() => onOpen(f.path, f.name)}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-ide-hover text-left"
          >
            <Icon name="file-text" size={12} className="text-ide-faint shrink-0" />
            <span className="min-w-0">
              <span className="block text-[11px] text-ide-fg truncate">{f.name}</span>
              <span className="block text-[10px] text-ide-faint truncate">{f.dir}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}