'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { ExecutionState } from '../../features/execution';

interface ExecutionControlsProps {
  state: ExecutionState;
  /** Label of the active run configuration, or null when none is selected. */
  configName: string | null;
  configCount: number;
  /** True when the active file is native Rak, which uses interpreter/VM/bench. */
  rakMode: 'interp' | 'vm' | 'bench';
  rakModeDisabled: boolean;
  onRakModeChange: (mode: 'interp' | 'vm' | 'bench') => void;
  onRun: () => void;
  onDebug: () => void;
  onStop: () => void;
  onOpenInterpreter: () => void;
  onOpenDebugConsole: () => void;
  onEditConfigurations: () => void;
  /** Short badge describing the active interpreter, e.g. `Python 3.12.1`. */
  interpreterLabel: string;
  /** False when the file type has no runner at all. */
  canRun: boolean;
  canDebug: boolean;
  /** Scripts discovered from `package.json`, as `name -> script` pairs. */
  scriptOptions: { name: string; script: string }[];
  /** The script the run button will launch; null when running the active file. */
  selectedScript: string | null;
  onSelectScript: (script: string | null) => void;
  onRunScript: (script: string) => void;
}

const STATUS_TEXT: Record<ExecutionState['status'], string | null> = {
  idle: null,
  starting: 'Starting…',
  building: 'Building…',
  running: 'Running…',
  debugging: 'Debugging…',
  paused: 'Paused',
};

/**
 * The top-right execution group.
 *
 * Replaces the single Run button with the Fleet/VS Code layout: an
 * [Run] [Debug] pair, a stop button that only exists while something is alive,
 * and a dropdown that both selects a saved run configuration and opens the
 * configuration editor. The interpreter badge doubles as a shortcut to the
 * quick pick, so the same choice is reachable from the header and the status
 * bar without duplicating logic.
 */
export default function ExecutionControls({
  state,
  configName,
  configCount,
  rakMode,
  rakModeDisabled,
  onRakModeChange,
  onRun,
  onDebug,
  onStop,
  onOpenInterpreter,
  onOpenDebugConsole,
  onEditConfigurations,
  scriptOptions,
  selectedScript,
  onSelectScript,
  onRunScript,
  interpreterLabel,
  canRun,
  canDebug,
}: ExecutionControlsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const scriptRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const alive = state.status !== 'idle';
  const statusText = STATUS_TEXT[state.status];

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // The script picker is a second popover with its own open state, so it
  // needs its own dismissal. Sharing the menu popover would close one when
  // the other opens.
  useEffect(() => {
    if (!scriptOpen) return;
    const onDown = (e: MouseEvent) => {
      if (scriptRef.current && !scriptRef.current.contains(e.target as Node)) setScriptOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setScriptOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [scriptOpen]);

  const toggleMenu = useCallback(() => setMenuOpen((v) => !v), []);

  return (
    <div className="flex items-center gap-1.5 px-2 h-full">
      {/* Interpreter badge — same destination as the status-bar item. */}
      <button
        onClick={onOpenInterpreter}
        title={`${interpreterLabel} — click to change`}
        className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-ide-muted hover:bg-ide-hover hover:text-ide-fg max-w-[180px]"
      >
        <Icon name="terminal" size={11} className="text-ide-accent" />
        <span className="truncate">{interpreterLabel}</span>
      </button>

      {/* Rak's native run modes are Rak-only, so they only appear for Rak. */}
      {!rakModeDisabled && (
        <select
          value={rakMode}
          onChange={(e) => onRakModeChange(e.target.value as 'interp' | 'vm' | 'bench')}
          disabled={alive}
          title="Rak runtime mode"
          data-tour="mode"
          className="bg-ide-hover text-ide-fg text-[11px] px-2 py-0.5 rounded border border-ide-border outline-none focus:border-ide-accent disabled:opacity-50"
        >
          <option value="interp">Interpreter</option>
          <option value="vm">VM</option>
          <option value="bench">Bench</option>
        </select>
      )}

      {alive && (
        <button
          onClick={onStop}
          className="px-2.5 py-0.5 bg-red-600 hover:bg-red-500 text-white text-[11px] font-semibold rounded inline-flex items-center gap-1.5"
          title="Stop (Ctrl+Shift+F5)"
        >
          <span className="w-2 h-2 rounded-[1px] bg-white" />
          Stop
        </button>
      )}

      {/*
        A Node project declares its own run targets in `package.json`. The
        picker sits next to Run rather than replacing it, because running the
        active file is still the right thing most of the time and "Run" has to
        keep meaning that.
      */}
      {scriptOptions.length > 0 && (
        <div className="relative" ref={scriptRef}>
          <button
            onClick={() => setScriptOpen((v) => !v)}
            title="Choose a package.json script to run"
            data-tour="run-script"
            className="h-full px-2 inline-flex items-center gap-1 text-[11px] text-ide-muted hover:bg-ide-hover hover:text-ide-fg max-w-[170px]"
          >
            <span className="truncate">
              {selectedScript ?? 'Run active file'}
            </span>
            <Icon name="chevron-down" size={10} />
          </button>
          {scriptOpen && (
            <div className="absolute right-0 top-full mt-1 z-[130] min-w-[200px] max-w-[320px] bg-zinc-900 border border-ide-border rounded-md shadow-2xl py-1 overflow-y-auto max-h-72">
              <button
                onClick={() => { onSelectScript(null); setScriptOpen(false); }}
                className={`w-full text-left px-3 py-1 text-[11px] hover:bg-ide-hover ${selectedScript === null ? 'text-ide-accent' : 'text-ide-fg'}`}
              >
                Run active file
              </button>
              <div className="my-1 border-t border-ide-border" />
              {scriptOptions.map((opt) => (
                <button
                  key={opt.script}
                  onClick={() => { onSelectScript(opt.script); onRunScript(opt.script); setScriptOpen(false); }}
                  title={opt.name}
                  className={`w-full text-left px-3 py-1 text-[11px] hover:bg-ide-hover flex items-center gap-2 ${selectedScript === opt.script ? 'text-ide-accent' : 'text-ide-fg'}`}
                >
                  <Icon name="terminal" size={10} className="shrink-0 opacity-60" />
                  <span className="truncate">{opt.script}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="inline-flex items-stretch rounded overflow-hidden">
        <button
          onClick={onRun}
          disabled={!canRun}
          data-tour="run"
          title={
            state.descriptor?.preview ||
            (canRun ? `Run with ${interpreterLabel}` : 'No runner for this file type')
          }
          className="px-3 py-0.5 bg-ide-accent hover:bg-ide-accent-bright disabled:bg-ide-hover disabled:text-ide-faint text-black text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:cursor-not-allowed"
        >
          {statusText ? (
            <>
              <div className="w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
              {statusText}
            </>
          ) : (
            <>
              <Icon name="play" size={10} />
              Run
            </>
          )}
        </button>

        <button
          onClick={onDebug}
          disabled={!canDebug}
          title={
            canDebug
              ? `Debug with ${state.descriptor?.adapter || 'the default adapter'}`
              : 'No debug adapter for this file type'
          }
          className="px-2 py-0.5 bg-ide-accent/90 hover:bg-ide-accent-bright disabled:bg-ide-hover disabled:text-ide-faint text-black border-l border-black/20 disabled:border-ide-border inline-flex items-center"
          aria-label="Debug"
        >
          <Icon name="bug" size={11} />
        </button>
      </div>

      {/* Configuration selector + editor entry point. */}
      <div ref={menuRef} className="relative">
        <button
          onClick={toggleMenu}
          title={configName ? `Run configuration: ${configName}` : 'No run configuration'}
          className="px-2 py-0.5 bg-ide-hover hover:bg-ide-border text-ide-fg text-[11px] rounded inline-flex items-center gap-1 max-w-[170px]"
        >
          <Icon name="gear" size={11} className="text-ide-faint" />
          <span className="truncate">{configName ?? 'No configuration'}</span>
          <Icon name="chevron-down" size={10} className="text-ide-faint" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 z-[150] w-[260px] rounded-lg border border-ide-border bg-ide-raised shadow-2xl py-1 overflow-hidden">
            <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-ide-faint font-semibold">
              Run configuration
            </div>
            {configCount === 0 ? (
              <div className="px-3 py-2 text-[10px] text-ide-faint leading-relaxed">
                No <code className="px-1 rounded bg-ide-bg">.vscode/launch.json</code> entry
                yet. The active file is routed automatically; add one to customise args.
              </div>
            ) : (
              <div className="px-3 py-1 text-[11px] text-ide-fg truncate">{configName}</div>
            )}
            <div className="my-1 h-px bg-ide-border-soft" />
            <button
              onClick={() => {
                setMenuOpen(false);
                onEditConfigurations();
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-ide-fg hover:bg-ide-hover flex items-center gap-2"
            >
              <Icon name="gear" size={11} className="text-ide-faint" />
              Edit Run/Debug Configurations…
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onOpenInterpreter();
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-ide-fg hover:bg-ide-hover flex items-center gap-2"
            >
              <Icon name="terminal" size={11} className="text-ide-faint" />
              Select Interpreter…
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onOpenDebugConsole();
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-ide-fg hover:bg-ide-hover flex items-center gap-2"
            >
              <Icon name="monitor" size={11} className="text-ide-faint" />
              Open Debug Console
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
