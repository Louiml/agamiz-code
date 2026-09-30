'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GitService, GitStatusEntry, formatScopeCounts } from '../../features/git';

interface SourceControlPanelProps {
  cwd: string;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const KIND_COLOR: Record<GitStatusEntry['kind'], string> = {
  added: 'text-emerald-400',
  modified: 'text-amber-400',
  deleted: 'text-red-400',
  renamed: 'text-sky-400',
  untracked: 'text-zinc-400',
  conflicted: 'text-red-400',
};

const KIND_LABEL: Record<GitStatusEntry['kind'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

export default function SourceControlPanel({ cwd, onToast }: SourceControlPanelProps) {
  const [branch, setBranch] = useState('');
  const [root, setRoot] = useState('');
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState('');
  const svcRef = useRef<GitService | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    const svc = new GitService(cwd);
    svcRef.current = svc;
    try {
      const info = await svc.detect();
      if (!info) {
        setBranch('');
        setRoot('');
        setEntries([]);
        return;
      }
      setBranch(info.branch);
      setRoot(info.root);
      const st = await svc.status();
      st.sort((a, b) => samePath(a.path).localeCompare(samePath(b.path)));
      setEntries(st);
      setLastError('');
    } catch (e) {
      setLastError(String(e));
    }
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const counts = formatScopeCounts(entries);

  const stage = async (path: string) => {
    await svcRef.current?.stage(path);
    refresh();
  };
  const unstage = async (path: string) => {
    await svcRef.current?.unstage(path);
    refresh();
  };
  const stageAll = async () => {
    await svcRef.current?.stageAll();
    refresh();
  };
  const commit = async () => {
    if (!commitMsg.trim()) { onToast('Enter a commit message', 'error'); return; }
    setBusy(true);
    try {
      const r = await svcRef.current?.commit(commitMsg.trim());
      if (r && r.code !== 0) {
        onToast(r.stderr || r.stdout || 'Commit failed', 'error');
      } else {
        onToast('Committed', 'success');
        setCommitMsg('');
        refresh();
      }
    } catch (e) {
      onToast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!cwd) {
    return <div className="p-4 text-xs text-zinc-600">Open a folder to use source control.</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-zinc-800 text-xs text-zinc-300">
        {branch ? (
          <>
            <span className="text-emerald-400">{branch}</span>
            <span className="text-zinc-600 truncate">{basename(root)}</span>
            <button onClick={refresh} className="ml-auto text-zinc-500 hover:text-zinc-200" title="Refresh">⟳</button>
          </>
        ) : (
          <span className="text-zinc-600">Not a git repository</span>
        )}
      </div>

      {lastError && <div className="px-3 py-1 text-[10px] text-red-400 border-b border-zinc-800">{lastError}</div>}

      <div className="flex flex-col gap-1 p-2 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <input
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            placeholder="Message (Ctrl+Enter to commit)"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500"
          />
          <button
            onClick={commit}
            disabled={busy || entries.length === 0}
            className="px-2 py-1 rounded bg-emerald-600 text-white text-xs disabled:opacity-40"
          >
            Commit
          </button>
        </div>
        <button onClick={stageAll} className="text-left text-[10px] text-zinc-500 hover:text-zinc-200">
          {counts.staged > 0 ? `Unstage All Changes` : `Stage All Changes (${counts.unstaged + counts.untracked})`}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 && branch && (
          <div className="p-4 text-xs text-zinc-600">No changes. Working tree clean.</div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="group flex items-center gap-2 px-3 py-1 hover:bg-zinc-800/60 text-xs">
            <button
              onClick={() => (e.staged ? unstage(e.path) : stage(e.path))}
              className={`w-4 h-4 rounded border text-[9px] font-bold flex items-center justify-center ${
                e.staged ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-zinc-600 text-transparent hover:text-zinc-600'
              }`}
              title={e.staged ? 'Unstage' : 'Stage'}
            >
              ✓
            </button>
            <span className={`${KIND_COLOR[e.kind]} w-4 text-center font-bold`}>{KIND_LABEL[e.kind]}</span>
            <span className="truncate text-zinc-300">{basename(e.path)}</span>
            <span className="truncate text-zinc-600 ml-1 hidden">{e.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
function samePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}