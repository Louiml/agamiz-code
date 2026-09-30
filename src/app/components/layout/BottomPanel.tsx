'use client';

import React from 'react';
import { Icon, IconName } from '../Icon';

export type BottomTabId = 'terminal' | 'output' | 'problems' | 'debug';

interface BottomTabDef {
  id: BottomTabId;
  label: string;
  icon: IconName;
  badge?: React.ReactNode;
}

interface BottomPanelProps {
  height: number;
  active: BottomTabId;
  onSelect: (id: BottomTabId) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  onClose: () => void;
  onSpawnTerminal: () => void;
  terminalNode: React.ReactNode;
  outputNode: React.ReactNode;
  problemsNode: React.ReactNode;
  debugNode: React.ReactNode;
  problemsBadge?: number;
  /**
   * Extra controls rendered in the header between the tabs and the panel
   * actions. The terminal publishes its toolbar here so the whole header is a
   * single row, as in VS Code.
   */
  headerActions?: React.ReactNode;
  /** Grows the panel to fill the editor area. */
  maximized?: boolean;
  onToggleMaximized?: () => void;
  /** Collapses the panel to just its header. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/**
 * Consolidated bottom panel: [ Terminal | Output | Problems | Debug Console ].
 * The top edge is a drag handle so the height can be adjusted freely.
 *
 * Every tab stays mounted and is hidden with `display: none` instead of being
 * unmounted. The terminal depends on this: unmounting a pane would tear down its
 * xterm view, and a live shell would have to be restarted on every tab switch.
 */
export default function BottomPanel({
  height, active, onSelect, onResizeStart, onClose, onSpawnTerminal,
  terminalNode, outputNode, problemsNode, debugNode, problemsBadge,
  headerActions, maximized = false, onToggleMaximized, collapsed = false, onToggleCollapsed,
}: BottomPanelProps) {
  const tabs: BottomTabDef[] = [
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
    { id: 'output', label: 'Output', icon: 'bar-chart' },
    { id: 'problems', label: 'Problems', icon: 'warning', badge: problemsBadge },
    { id: 'debug', label: 'Debug Console', icon: 'bug' },
  ];

  const content: Record<BottomTabId, React.ReactNode> = {
    terminal: terminalNode,
    output: outputNode,
    problems: problemsNode,
    debug: debugNode,
  };

  return (
    <div
      data-tour="terminal"
      style={{ height }}
      className="flex flex-col flex-shrink-0 bg-ide-bg border-t border-ide-border min-h-0"
    >
      {/* Drag handle */}
      <div
        onMouseDown={onResizeStart}
        data-tour="console"
        className="h-1 cursor-row-resize bg-ide-border-soft hover:bg-ide-accent transition-colors shrink-0"
      />

      {/* Tab strip. The tab/action group scrolls horizontally rather than
          wrapping: a wrapped tab label doubles the header height and shoves
          the panel's drag handle out of place. */}
      <div className="flex items-center h-8 bg-ide-raised border-b border-ide-border pl-1 shrink-0">
        <div className="ide-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.map((t) => {
            const isActive = active === t.id;
            return (
              <button
                key={t.id}
                onClick={() => onSelect(t.id)}
                className={`flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[11px] transition-colors ${
                  isActive
                    ? 'border-ide-accent text-ide-fg'
                    : 'border-transparent text-ide-muted hover:bg-ide-hover hover:text-ide-fg'
                }`}
              >
                <Icon name={t.icon} size={13} />
                {t.label}
                {t.badge != null && t.badge !== 0 && (
                  <span className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                    {t.badge}
                  </span>
                )}
              </button>
            );
          })}

          {onSpawnTerminal && (
            <button
              onClick={onSpawnTerminal}
              title="New Terminal  (Ctrl+Shift+`)"
              aria-label="New Terminal"
              className="ml-1 shrink-0 rounded px-2 py-1 text-ide-muted hover:bg-ide-hover hover:text-ide-fg"
            >
              <Icon name="plus" size={13} />
            </button>
          )}

          {headerActions}
        </div>

        {/* Panel actions stay pinned: they must never scroll out of reach. */}
        <div className="flex shrink-0 items-center gap-1 pr-1">
          {onToggleMaximized && (
            <button
              onClick={onToggleMaximized}
              title={maximized ? 'Restore panel size' : 'Maximize panel size'}
              aria-label={maximized ? 'Restore panel size' : 'Maximize panel size'}
              className="rounded px-2 py-1 text-ide-muted hover:bg-ide-hover hover:text-ide-fg"
            >
              <Icon name={maximized ? 'minimize' : 'maximize'} size={13} />
            </button>
          )}
          {onToggleCollapsed && (
            <button
              onClick={onToggleCollapsed}
              title={collapsed ? 'Expand panel' : 'Collapse panel'}
              aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
              className="rounded px-2 py-1 text-ide-muted hover:bg-ide-hover hover:text-ide-fg"
            >
              <Icon name="chevron-down" size={13} />
            </button>
          )}
          <button
            onClick={onClose}
            title="Close panel  (Ctrl+J)"
            aria-label="Close panel"
            className="rounded px-2 py-1 text-ide-muted hover:bg-ide-hover hover:text-ide-fg"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>

      {/* Tab content. Hidden rather than unmounted so a terminal session keeps
          running while the user visits another tab. */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tabs.map((t) => (
          <div
            key={t.id}
            hidden={active !== t.id}
            className="h-full min-h-0 overflow-hidden"
          >
            {content[t.id] ?? null}
          </div>
        ))}
      </div>
    </div>
  );
}

