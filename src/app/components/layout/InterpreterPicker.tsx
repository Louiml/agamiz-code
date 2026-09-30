'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Icon } from '../Icon';
import {
  InterpreterInfo,
  WorkspaceSettings,
  canonicalToolFor,
  detectInterpreters,
  groupInterpreters,
  probeInterpreter,
  updateSettings,
} from '../../features/interpreter';
import { errText } from '../../lib/tauri';

interface InterpreterPickerProps {
  cwd: string;
  /** Language id of the active file, used to preselect and to scope defaults. */
  language: string;
  settings: WorkspaceSettings;
  detected: InterpreterInfo[];
  onSettingsChange: (next: WorkspaceSettings) => void;
  onDetectedChange: (next: InterpreterInfo[]) => void;
  onClose: () => void;
  onNotice: (msg: string, kind: 'success' | 'error' | 'info') => void;
}

/** One-line summary of where a tool comes from, shown under its label. */
function sourceNote(item: InterpreterInfo): string {
  if (item.source === 'venv' || item.source === 'conda') return item.path;
  return item.path;
}

const KIND_ICON: Record<InterpreterInfo['kind'], 'terminal' | 'box' | 'zap' | 'file-code'> = {
  interpreter: 'terminal',
  compiler: 'box',
  runtime: 'zap',
  shell: 'terminal',
};

/**
 * Interpreter Quick Pick.
 *
 * Opens from the header badge or the status-bar item and answers three
 * questions in one place: what is available, what is pinned, and how to change
 * it. Detected tools are grouped by provenance so a workspace virtualenv is
 * visibly distinct from a system Python, and the pin is written to
 * `.agamiz/settings.json` so it travels with the repository.
 */
export default function InterpreterPicker({
  cwd,
  language,
  settings,
  detected,
  onSettingsChange,
  onDetectedChange,
  onClose,
  onNotice,
}: InterpreterPickerProps) {
  // The picker is mounted only while open, so the scan can start in the true
  // initial state and focus in a mount effect without a cascading render.
  const [scanning, setScanning] = useState(true);
  const [customPath, setCustomPath] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => groupInterpreters(detected), [detected]);

  /**
   * A flat, ordered candidate list drives keyboard navigation. Selection is
   * always by tool id so it round-trips through `.agamiz/settings.json`.
   */
  const candidates = useMemo(() => {
    const canonical = canonicalToolFor(language);
    const pinned = settings.interpreters ?? {};
    const usable = detected.filter(
      (item) => !language || item.languages.includes(language),
    );
    // Everything can be pinned even if it does not serve the current language,
    // but the list for the active language comes first.
    const rest = detected.filter(
      (item) => !usable.includes(item) && !language,
    );
    const ordered = [...usable, ...rest];
    // The currently pinned tool for this language floats to the top.
    const activeId = (canonical && pinned[canonical]) || settings.defaultTool?.[language];
    if (!activeId) return ordered;
    const index = ordered.findIndex(
      (i) => i.path === activeId || i.id === activeId,
    );
    if (index > 0) {
      const [found] = ordered.splice(index, 1);
      ordered.unshift(found);
    }
    return ordered;
  }, [detected, language, settings]);

  // Rescan on mount so a toolchain installed since the last look is picked up.
  useEffect(() => {
    searchRef.current?.focus();
    detectInterpreters(cwd, true)
      .then(onDetectedChange)
      .catch((e) => console.error('[interpreter] rescan failed:', e))
      // Asynchronous, so it does not cascade a render during the effect body.
      .finally(() => setScanning(false));
    // `onDetectedChange` is stable from the parent; the mount is the only
    // trigger, so it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Persist the choice to `.agamiz/settings.json` under the language's
   *  canonical tool id. The backend resolver then uses the concrete path
   *  verbatim, which is what makes a custom path actually take effect. */
  const pin = async (item: InterpreterInfo) => {
    const tool = canonicalToolFor(language) ?? item.id;
    const next = await updateSettings(cwd, {
      interpreters: { ...(settings.interpreters ?? {}), [tool]: item.path },
    });
    onSettingsChange(next);
    onNotice(`${item.label} selected`, 'success');
    onClose();
  };

  // The global key handler must not re-subscribe on every render, so it goes
  // through a ref that is refreshed after each paint rather than closing over
  // `pin` directly.
  const pinRef = useRef(pin);
  useEffect(() => {
    pinRef.current = pin;
  });

  // Outside click, Escape, and arrow/Enter navigation.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, candidates.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const picked = candidates[highlight];
        if (picked) void pinRef.current(picked);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  });

  /** Native file dialog, then probe the chosen binary before pinning it. */
  const browse = async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: 'Select an interpreter or compiler',
      });
      if (typeof picked !== 'string' || !picked) return;
      setCustomPath(picked);
      const info = await probeInterpreter(picked);
      onDetectedChange([...detected.filter((d) => d.path !== info.path), info]);
      await pin(info);
    } catch (e) {
      console.error('[interpreter] browse failed:', e);
      onNotice(`Could not use that interpreter: ${errText(e)}`, 'error');
    }
  };

  /** Probe and pin whatever path was typed into the search field. */
  const commitCustomPath = async () => {
    if (!customPath.trim()) return;
    try {
      const info = await probeInterpreter(customPath.trim());
      onDetectedChange([...detected.filter((d) => d.path !== info.path), info]);
      await pin(info);
    } catch (e) {
      onNotice(errText(e), 'error');
    }
  };
  /** Drop the pin for this language and fall back to auto-detection. */
  const clearPin = async () => {
    const tool = canonicalToolFor(language);
    if (!tool) return;
    const interpreters = { ...(settings.interpreters ?? {}) };
    delete interpreters[tool];
    const next = await updateSettings(cwd, { interpreters });
    onSettingsChange(next);
    onNotice('Reverted to the auto-detected interpreter', 'info');
  };

  const canonical = canonicalToolFor(language);
  const pinnedPath = canonical ? settings.interpreters?.[canonical] : undefined;

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={panelRef}
        className="relative w-[560px] max-w-[92vw] rounded-xl border border-ide-border bg-ide-raised shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
      >
        <div className="px-4 py-3 border-b border-ide-border-soft flex items-center gap-2">
          <Icon name="terminal" size={14} className="text-ide-accent" />
          <span className="text-xs font-semibold text-ide-fg">Select Interpreter</span>
          <span className="text-[10px] text-ide-faint ml-1">
            {language || 'no file open'}
          </span>
          <input
            ref={searchRef}
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commitCustomPath()}
            placeholder="…or type a path to an executable and press Enter"
            className="ml-auto flex-1 bg-ide-bg border border-ide-border rounded px-2 py-1 text-[11px] text-ide-fg outline-none focus:border-ide-accent"
          />
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {scanning && candidates.length === 0 && (
            <div className="px-4 py-6 text-[11px] text-ide-faint text-center">
              Scanning for interpreters and compilers…
            </div>
          )}

          {!scanning && candidates.length === 0 && (
            <div className="px-4 py-6 text-[11px] text-ide-faint text-center space-y-2">
              <p>No interpreter was found for this file type.</p>
              <p className="text-[10px]">
                Pin one manually below, or add a run command to
                <code className="mx-1 px-1 rounded bg-ide-bg">.agamiz/settings.json</code>
                under <code className="px-1 rounded bg-ide-bg">tasks</code>.
              </p>
            </div>
          )}

          {groups.map((group) => (
            <div key={group.key}>
              <div className="px-4 py-1 text-[9px] uppercase tracking-wider text-ide-faint font-semibold bg-ide-bg/60 sticky top-0">
                {group.label}
              </div>
              {group.items.map((item) => {
                const isPinned = item.path === pinnedPath;
                const index = candidates.findIndex((c) => c.path === item.path);
                return (
                  <button
                    key={item.id}
                    onClick={() => pin(item)}
                    onMouseEnter={() => setHighlight(index)}
                    className={`w-full text-left px-4 py-1.5 flex items-center gap-2 transition-colors ${
                      index === highlight ? 'bg-ide-hover' : 'hover:bg-ide-hover'
                    }`}
                  >
                    <Icon
                      name={KIND_ICON[item.kind]}
                      size={12}
                      className={item.source === 'path' ? 'text-ide-faint' : 'text-ide-accent'}
                    />
                    <span className="text-[11px] text-ide-fg truncate">{item.label}</span>
                    {isPinned && (
                      <span className="px-1.5 py-0.5 rounded bg-ide-accent/20 text-ide-accent-bright text-[9px]">
                        pinned
                      </span>
                    )}
                    <span
                      className="ml-auto text-[9px] text-ide-faint truncate max-w-[220px]"
                      title={sourceNote(item)}
                    >
                      {sourceNote(item)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="px-3 py-2 border-t border-ide-border-soft flex items-center gap-2 text-[10px]">
          <button
            onClick={browse}
            className="px-2 py-1 rounded bg-ide-hover hover:bg-ide-border text-ide-fg inline-flex items-center gap-1"
          >
            <Icon name="folder-search" size={11} />
            Browse…
          </button>
          {pinnedPath && (
            <button
              onClick={clearPin}
              className="px-2 py-1 rounded hover:bg-ide-hover text-ide-faint hover:text-ide-fg"
              title={pinnedPath}
            >
              Reset to auto-detected
            </button>
          )}
          <button
            onClick={() => setShowManual((v) => !v)}
            className="ml-auto px-2 py-1 rounded hover:bg-ide-hover text-ide-faint hover:text-ide-fg"
          >
            {showManual ? 'Hide details' : 'Details'}
          </button>
          <button onClick={onClose} className="px-2 py-1 rounded hover:bg-ide-hover text-ide-faint">
            Esc
          </button>
        </div>

        {showManual && (
          <div className="px-4 py-2 border-t border-ide-border-soft text-[10px] text-ide-faint space-y-1 max-h-32 overflow-y-auto">
            <p>
              Choices are stored per workspace in{' '}
              <code className="px-1 rounded bg-ide-bg">.agamiz/settings.json</code> and shared
              with the repository.
            </p>
            {Object.entries(settings.interpreters ?? {}).map(([tool, path]) => (
              <p key={tool} className="truncate">
                <span className="text-ide-accent">{tool}</span> → {path}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
