'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { ExecutionState, executionService } from '../../features/execution';

/**
 * One line of program/console output.
 *
 * Structurally identical to the page's `ConsoleOutput`, because there is only
 * one output buffer in the app: the side panel and the bottom Output panel
 * render the same list rather than each keeping a private copy.
 */
export interface PanelLine {
  type: 'output' | 'error';
  content: string;
  timestamp: Date;
  role?: 'build' | 'run' | 'debug';
}

interface RunDebugPanelProps {
  activeFile: string | null;
  state: ExecutionState;
  output: PanelLine[];
  /** Output is owned by the page (it is shared with the bottom panel). */
  onClearOutput: () => void;
  onRun: () => void;
  onDebug: () => void;
  onStop: () => void;
  onToggleBreakpoint: (line: number) => void;
  onClearBreakpoints: () => void;
  onEvaluate: (expression: string) => Promise<string>;
  onOpenInterpreter: () => void;
  onWriteInput: (text: string) => void;
}

type Tab = 'output' | 'variables' | 'breakpoints';

const STEP_CLASS =
  'px-2 py-0.5 rounded bg-ide-hover hover:bg-ide-border text-ide-fg inline-flex items-center';

/**
 * Run & Debug side panel.
 *
 * Output is rendered from props rather than local state because the page owns
 * one buffer for both this panel and the bottom Output panel � duplicating it
 * here used to mean the two views could disagree about what had run.
 */
export default function RunDebugPanel({
  activeFile,
  state,
  output,
  onClearOutput,
  onRun,
  onDebug,
  onStop,
  onToggleBreakpoint,
  onClearBreakpoints,
  onEvaluate,
  onOpenInterpreter,
  onWriteInput,
}: RunDebugPanelProps) {
  const [tabChoice, setTabChoice] = useState<Tab | null>(null);
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState<string>('');
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const outRef = useRef<HTMLDivElement>(null);

  const alive = state.status !== 'idle';
  const paused = state.status === 'paused';
  const debugging = state.status === 'debugging' || paused;

  /**
   * Effective tab.
   *
   * Derived rather than pushed by an effect: starting a debug session with
   * breakpoints set should surface the variables view, but a later automatic
   * switch must not yank the user away from a tab they deliberately picked. So
   * the default is computed here and any explicit click pins the choice.
   */
  const tab: Tab =
    tabChoice ?? (debugging && state.breakpoints.length > 0 ? 'variables' : 'output');

  // Auto-scroll the output list, but only while it is the visible tab.
  useEffect(() => {
    if (tab === 'output' && outRef.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
  }, [output, tab]);

  const runEvaluate = useCallback(async () => {
    const expr = expression.trim();
    if (!expr) return;
    try {
      setResult(String(await onEvaluate(expr)));
    } catch (e) {
      setResult(`Error: ${String(e)}`);
    }
  }, [expression, onEvaluate]);

  const scopeNames = useMemo(() => Object.keys(state.variables), [state.variables]);

  /** Route a step request through whichever transport is attached. */
  const executionStep = useCallback((kind: 'resume' | 'over' | 'into' | 'out') => {
    if (kind === 'resume') return executionService.resume();
    if (kind === 'over') return executionService.stepOver();
    if (kind === 'into') return executionService.stepInto();
    return executionService.stepOut();
  }, []);

  const target = state.descriptor;
  const canRun = target?.runnable ?? false;
  const canDebug = target?.debuggable ?? false;

  return (
    <div className="flex flex-col h-full min-h-0 text-xs">
      {/* Target summary: what will run, and with what. */}
      <div className="px-3 py-2 border-b border-ide-border-soft space-y-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon name="file-code" size={11} className="text-ide-faint shrink-0" />
          <span className="text-[10px] text-ide-fg truncate">
            {activeFile ? basename(activeFile) : 'No file open'}
          </span>
          {target && (
            <span
              className={`ml-auto px-1.5 py-0.5 rounded text-[9px] shrink-0 ${
                canRun
                  ? 'bg-ide-accent/20 text-ide-accent-bright'
                  : 'bg-amber-500/20 text-amber-400'
              }`}
              title={target.note}
            >
              {target.kind === 'rak'
                ? 'Native Rak'
                : target.kind === 'unsupported'
                  ? 'No runner'
                  : `${target.kind}${target.buildstep ? ' + build' : ''}`}
            </span>
          )}
        </div>
        <button
          onClick={onOpenInterpreter}
          className="w-full text-left px-2 py-1 rounded bg-ide-hover hover:bg-ide-border text-[10px] text-ide-fg inline-flex items-center gap-1.5"
          title={target?.preview || 'Choose which interpreter runs this file'}
        >
          <Icon name="terminal" size={10} className="text-ide-accent" />
          <span className="truncate">{state.interpreter?.label ?? 'Select an interpreter'}</span>
          <Icon name="chevron-right" size={9} className="ml-auto text-ide-faint shrink-0" />
        </button>
        {target?.preview && (
          <div
            className="px-2 py-1 rounded bg-[var(--ag-editor-bg)] text-[9px] text-ide-faint font-mono truncate"
            title={target.preview}
          >
            {target.preview}
          </div>
        )}
      </div>

      {/* Execution controls */}
      <div className="px-3 py-2 flex items-center gap-1 border-b border-ide-border-soft">
        {alive ? (
          <button
            onClick={onStop}
            className="px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white inline-flex items-center gap-1"
          >
            <span className="w-2 h-2 rounded-[1px] bg-white" />
            Stop
          </button>
        ) : (
          <>
            <button
              onClick={onRun}
              disabled={!canRun}
              className="px-2 py-1 rounded bg-ide-accent hover:bg-ide-accent-bright text-black font-semibold disabled:bg-ide-hover disabled:text-ide-faint inline-flex items-center gap-1"
              title={canRun ? 'Run this file' : 'No runner for this file type'}
            >
              <Icon name="play" size={9} />
              Run
            </button>
            <button
              onClick={onDebug}
              disabled={!canDebug}
              className="px-2 py-1 rounded bg-ide-hover hover:bg-ide-border text-ide-fg disabled:text-ide-faint inline-flex items-center gap-1"
              title={canDebug ? `Debug via ${target?.adapter}` : 'No debug adapter for this file type'}
            >
              <Icon name="bug" size={9} />
              Debug
            </button>
          </>
        )}
        {target && !canRun && (
          <span className="text-[9px] text-amber-400 truncate ml-1" title={target.note}>
            {target.note}
          </span>
        )}
      </div>

      {/* Step controls � only meaningful while a debug session is attached. */}
      {debugging && (
        <div className="px-3 py-1.5 flex items-center gap-1 border-b border-ide-border-soft bg-ide-bg/60">
          <button
            onClick={() => executionStep('resume')}
            disabled={!paused}
            className="px-2 py-0.5 rounded bg-ide-accent text-black disabled:bg-ide-hover disabled:text-ide-faint"
            title="Continue (F5)"
          >
            <Icon name="play" size={9} />
          </button>
          <button onClick={() => executionStep('over')} className={STEP_CLASS} title="Step over (F10)">
            <Icon name="arrow-down" size={10} />
          </button>
          <button onClick={() => executionStep('into')} className={STEP_CLASS} title="Step into (F11)">
            <Icon name="arrow-down" size={10} className="rotate-90" />
          </button>
          <button onClick={() => executionStep('out')} className={STEP_CLASS} title="Step out (Shift+F11)">
            <Icon name="arrow-up" size={10} />
          </button>
          <button
            onClick={onStop}
            className="px-2 py-0.5 rounded bg-red-600/80 hover:bg-red-500 text-white"
            title="Stop debugging"
          >
            <span className="w-2 h-2 rounded-[1px] bg-white inline-block" />
          </button>
          <span
            className={`ml-auto text-[10px] truncate ${paused ? 'text-amber-400' : 'text-ide-faint'}`}
            title={state.stoppedReason}
          >
            {paused ? state.stoppedReason || 'Paused' : 'Running'}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-ide-border-soft">
        {(['output', 'variables', 'breakpoints'] as Tab[]).map((id) => (
          <button
            key={id}
            onClick={() => setTabChoice(id)}
            className={`px-2 py-0.5 rounded text-[10px] capitalize ${
              tab === id ? 'bg-ide-hover text-ide-fg' : 'text-ide-faint hover:text-ide-fg'
            }`}
          >
            {id}
            {id === 'breakpoints' && state.breakpoints.length > 0 && (
              <span className="ml-1 text-ide-accent">{state.breakpoints.length}</span>
            )}
          </button>
        ))}
        {tab === 'output' && output.length > 0 && (
          <button
            onClick={onClearOutput}
            className="ml-auto text-[10px] text-ide-faint hover:text-ide-fg"
          >
            Clear
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'output' && (
          <div ref={outRef} className="h-full overflow-y-auto p-2 font-mono space-y-0.5">
            {output.length === 0 ? (
              <div className="text-ide-faint italic">
                Run output appears here. Press Run, or F5.
              </div>
            ) : (
              output.map((line, i) => (
                <div
                  key={i}
                  className={`whitespace-pre-wrap break-all ${
                    line.type === 'error'
                      ? 'text-red-400'
                      : line.content.startsWith('>')
                        ? 'text-sky-400'
                        : line.role === 'build'
                          ? 'text-amber-300/90'
                          : 'text-ide-fg'
                  }`}
                >
                  {line.content}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'variables' && (
          <div className="h-full overflow-y-auto">
            {state.frames.length === 0 ? (
              <div className="p-3 text-ide-faint italic">
                {paused ? 'No stack frames reported.' : 'Pause at a breakpoint to inspect variables.'}
              </div>
            ) : (
              <>
                <div className="px-3 py-1 bg-ide-bg text-[9px] uppercase tracking-wider text-ide-faint font-semibold sticky top-0">
                  Call stack
                </div>
                {state.frames.map((frame, i) => (
                  <div
                    key={frame.id}
                    className={`px-3 py-0.5 flex items-center gap-1.5 text-[10px] ${
                      i === 0 ? 'bg-ide-accent/10 text-ide-fg' : 'text-ide-muted hover:bg-ide-hover'
                    }`}
                  >
                    <Icon name="arrow-down" size={8} className="text-ide-faint shrink-0" />
                    <span className="truncate">{frame.name}</span>
                    <span className="ml-auto text-ide-faint truncate shrink-0" title={frame.sourcePath}>
                      {frame.sourceName || 'native'}:{frame.line}
                    </span>
                  </div>
                ))}

                {scopeNames.length === 0 ? (
                  <div className="p-3 text-ide-faint italic">No scopes available.</div>
                ) : (
                  scopeNames.map((scope) => {
                    const vars = state.variables[scope] ?? [];
                    const isOpen = expanded[scope] ?? true;
                    return (
                      <div key={scope}>
                        <button
                          onClick={() => setExpanded((p) => ({ ...p, [scope]: !isOpen }))}
                          className="w-full text-left px-3 py-1 bg-ide-bg text-[9px] uppercase tracking-wider text-ide-faint font-semibold flex items-center gap-1"
                        >
                          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={9} />
                          {scope}
                          <span className="ml-auto normal-case tracking-normal">{vars.length}</span>
                        </button>
                        {isOpen &&
                          vars.map((v, i) => (
                            <div key={`${scope}-${v.name}-${i}`} className="px-3 py-0.5 flex gap-2 text-[10px] hover:bg-ide-hover">
                              <span className="text-sky-400 truncate shrink-0 max-w-[45%]" title={v.name}>
                                {v.name}
                              </span>
                              <span
                                className="text-ide-fg truncate"
                                title={`${v.type} ${v.value}`}
                              >
                                {v.value}
                              </span>
                            </div>
                          ))}
                      </div>
                    );
                  })
                )}

                {/* Debug console REPL */}
                <div className="px-3 py-1 mt-2 bg-ide-bg text-[9px] uppercase tracking-wider text-ide-faint font-semibold border-t border-ide-border-soft">
                  Debug console
                </div>
                <div className="px-3 py-1 flex gap-1">
                  <input
                    value={expression}
                    onChange={(e) => setExpression(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && runEvaluate()}
                    placeholder="Evaluate expression"
                    className="flex-1 bg-[var(--ag-editor-bg)] border border-ide-border rounded px-2 py-0.5 text-[10px] text-ide-fg outline-none focus:border-ide-accent"
                  />
                  <button onClick={runEvaluate} className="px-2 rounded bg-ide-hover hover:bg-ide-border text-ide-fg">
                    =
                  </button>
                </div>
                {result && (
                  <div className="px-3 py-1 font-mono text-[10px] text-emerald-400 whitespace-pre-wrap break-all">
                    {result}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'breakpoints' && (
          <div className="h-full overflow-y-auto">
            {state.breakpoints.length === 0 ? (
              <div className="p-3 text-ide-faint italic">
                Click a line number in the editor gutter to set a breakpoint.
              </div>
            ) : (
              <>
                {state.breakpoints.map((bp) => (
                  <button
                    key={`${bp.file}:${bp.line}`}
                    onClick={() => onToggleBreakpoint(bp.line)}
                    className="w-full text-left px-3 py-0.5 flex items-center gap-2 text-[10px] text-ide-fg hover:bg-ide-hover"
                    title={`${bp.file}:${bp.line}`}
                  >
                    <span
                      className={`rounded-full shrink-0 ${bp.verified ? 'bg-red-500' : 'bg-red-500/40'}`}
                      style={{ width: 7, height: 7 }}
                      title={bp.verified ? 'Verified' : 'Pending verification'}
                    />
                    <span className="truncate">{basename(bp.file)}</span>
                    <span className="ml-auto text-ide-faint shrink-0">Ln {bp.line}</span>
                  </button>
                ))}
                <button
                  onClick={onClearBreakpoints}
                  className="mx-3 my-2 px-2 py-0.5 rounded bg-ide-hover hover:bg-ide-border text-[10px] text-ide-fg"
                >
                  Remove all
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* stdin forwarder: makes an interactive REPL usable from the panel. */}
      {alive && state.status === 'running' && (
        <div className="px-2 py-1.5 border-t border-ide-border-soft flex gap-1">
          <span className="text-ide-faint text-[10px] self-center shrink-0">&gt;</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !input) return;
              onWriteInput(input);
              setInput('');
            }}
            placeholder="Send input to the running process"
            className="flex-1 bg-[var(--ag-editor-bg)] border border-ide-border rounded px-2 py-0.5 text-[10px] text-ide-fg outline-none focus:border-ide-accent"
          />
        </div>
      )}
    </div>
  );
}

function basename(path: string): string {
  const parts = path.replace(/^file:\/\//, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
