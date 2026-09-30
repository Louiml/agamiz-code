'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { errText } from '../../lib/tauri';

type Status = 'untested' | 'running' | 'ok' | 'fail';

interface Row { key: string; label: string; status: Status; detail?: string }

/**
 * On-screen IPC diagnostic panel (bottom-left pill).
 *
 * Lets us diagnose "buttons do nothing inside the Tauri window" WITHOUT
 * DevTools: every probe renders its result as visible on-screen text and the
 * summary can be copied to the clipboard in one click.
 *
 * Safe by construction: auto-run probes are read-only / side-effect free.
 * Side-effecting (new_window) or blocking (dialog) actions are manual.
 */
export default function DiagnosticsPanel() {
  const [openPanel, setOpenPanel] = useState(false);
  const [reactClicks, setReactClicks] = useState(0);
  const [rows, setRows] = useState<Row[]>([
    { key: 'bridge', label: 'Tauri bridge (__TAURI_INTERNALS__)', status: 'untested', detail: '' },
    { key: 'react', label: 'React click handlers + state', status: 'untested', detail: 'click the React test button' },
    { key: 'windowApi', label: 'Window API (isMaximized)', status: 'untested', detail: '' },
    { key: 'listDir', label: "Custom command list_dir('.')", status: 'untested', detail: '' },
    { key: 'addRecent', label: "Custom command add_recent('C:\\')", status: 'untested', detail: '' },
    { key: 'newWindow', label: 'Custom command new_window()', status: 'untested', detail: 'manual — spawns a window' },
    { key: 'dialog', label: 'Dialog plugin open()', status: 'untested', detail: 'manual — shows a picker' },
  ]);

  const setRow = useCallback((key: string, patch: Partial<Row>) => {
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const runSafeProbes = useCallback(async () => {
    // 1) Bridge presence — the single most important fact.
    setRow('bridge', { status: 'running', detail: '' });
    const w = window as unknown as Record<string, unknown>;
    const internals = w.__TAURI_INTERNALS__ as Record<string, unknown> | undefined;
    if (!internals) {
      setRow('bridge', { status: 'fail', detail: 'MISSING — not inside the Tauri webview (browser tab?)' });
    } else if (typeof internals.invoke !== 'function') {
      setRow('bridge', { status: 'fail', detail: `present but invoke missing (keys: ${Object.keys(internals).join(', ')})` });
    } else {
      setRow('bridge', { status: 'ok', detail: 'present, invoke available' });
    }

    // 2) Window API (read-only, no side effects)
    setRow('windowApi', { status: 'running', detail: '' });
    try {
      const maximized = await getCurrentWindow().isMaximized();
      setRow('windowApi', { status: 'ok', detail: `isMaximized=${maximized}` });
    } catch (e) {
      setRow('windowApi', { status: 'fail', detail: errText(e) });
    }

    // 3) Custom command: list_dir (read-only)
    setRow('listDir', { status: 'running', detail: '' });
    try {
      const entries = await invoke<unknown[]>('list_dir', { path: '.' });
      setRow('listDir', { status: 'ok', detail: `${Array.isArray(entries) ? entries.length : '?'} entries` });
    } catch (e) {
      setRow('listDir', { status: 'fail', detail: errText(e) });
    }

    // 4) Custom command: add_recent (writes OS Recent list, no UI)
    setRow('addRecent', { status: 'running', detail: '' });
    try {
      await invoke('add_recent', { path: 'C:\\' });
      setRow('addRecent', { status: 'ok', detail: 'invoke resolved' });
    } catch (e) {
      setRow('addRecent', { status: 'fail', detail: errText(e) });
    }
  }, [setRow]);

  // Auto-run the safe probes the first time the panel is opened.
  useEffect(() => {
    if (openPanel) void runSafeProbes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel]);

  const testNewWindow = async () => {
    setRow('newWindow', { status: 'running', detail: '' });
    try {
      await invoke('new_window');
      setRow('newWindow', { status: 'ok', detail: 'window spawned' });
    } catch (e) {
      setRow('newWindow', { status: 'fail', detail: errText(e) });
    }
  };

  const testDialog = async () => {
    setRow('dialog', { status: 'running', detail: '' });
    try {
      const picked = await open({ directory: true, multiple: false, title: 'Diagnostics: pick any folder' });
      setRow('dialog', { status: 'ok', detail: `resolved: ${String(picked)}` });
    } catch (e) {
      setRow('dialog', { status: 'fail', detail: errText(e) });
    }
  };

  const summary = rows
    .map(r => `${r.label}: ${r.status.toUpperCase()}${r.detail ? ` — ${r.detail}` : ''}`)
    .join('\n');

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(`Agamiz Code IPC diagnostics\n${summary}`);
    } catch { /* clipboard may be blocked; text is still visible on screen */ }
  };

  const statusDot = (s: Status) =>
    s === 'ok' ? 'bg-emerald-500' : s === 'fail' ? 'bg-red-500' : s === 'running' ? 'bg-amber-400 animate-pulse' : 'bg-zinc-600';
  const statusText = (s: Status) =>
    s === 'ok' ? 'text-emerald-400' : s === 'fail' ? 'text-red-400' : s === 'running' ? 'text-amber-300' : 'text-zinc-500';

  return (
    <div className="fixed bottom-4 left-4 z-[60] font-mono">
      {!openPanel ? (
        <button
          onClick={() => setOpenPanel(true)}
          className="px-3 py-1.5 rounded-full bg-zinc-900/90 border border-zinc-700 text-zinc-400 text-[10px] hover:border-amber-500/60 hover:text-amber-300 transition-colors shadow-lg"
          title="Run Tauri IPC diagnostics"
        >
          ⚠ Diagnostics
        </button>
      ) : (
        <div className="w-[22rem] max-h-[70vh] overflow-y-auto rounded-lg bg-zinc-900/95 border border-zinc-700 shadow-2xl p-3 text-left">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold tracking-wide uppercase text-zinc-400">Tauri IPC Diagnostics</span>
            <button onClick={() => setOpenPanel(false)} className="text-zinc-500 hover:text-zinc-200 text-[10px] px-1" title="Close">✕</button>
          </div>

          <div className="space-y-1.5">
            {rows.map(r => (
              <div key={r.key} className="flex items-start gap-2">
                <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${statusDot(r.status)}`} />
                <div className="min-w-0">
                  <div className={`text-[10px] ${statusText(r.status)}`}>{r.label}</div>
                  {r.detail && <div className="text-[9px] text-zinc-500 break-words">{r.detail}</div>}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5 mt-3 pt-2 border-t border-zinc-800">
            <button
              onClick={() => setReactClicks(c => c + 1)}
              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px]"
              title="Proves React handlers + state updates work"
            >
              React test{reactClicks > 0 ? ` (${reactClicks})` : ''}
            </button>
            <button onClick={testNewWindow} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px]">Test New Window</button>
            <button onClick={testDialog} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px]">Test Open Folder</button>
            <button onClick={() => void runSafeProbes()} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px]">Re-run</button>
            <button onClick={copySummary} className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-[10px]">Copy</button>
          </div>
        </div>
      )}
    </div>
  );
}
