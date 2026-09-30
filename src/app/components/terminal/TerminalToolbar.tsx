/**
 * Terminal toolbar.
 *
 * Rendered inline in the bottom panel's tab strip rather than above the
 * terminal body, so the header reads as one row: panel tabs on the left,
 * terminal actions on the right — the VS Code arrangement.
 *
 * This component is pure: it owns no state. `TerminalPanel` builds the
 * element and hands it to the host through the `onToolbar` callback, because
 * the toolbar lives outside this component's DOM subtree.
 */

'use client';

import React from 'react';
import { Icon } from '../Icon';
import type { ShellProfile, SplitDirection, TerminalViewSettings } from './types';

interface TerminalToolbarProps {
  defaultProfile: ShellProfile | undefined;
  profileCount: number;
  activeProfileName: string | null;
  hasActive: boolean;
  hasSessions: boolean;
  sidebarOpen: boolean;
  settings: TerminalViewSettings;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onOpenProfileMenu: () => void;
  onNew: () => void;
  /** Splits the active pane; repeated clicks flip the orientation. */
  onSplit: () => void;
  splitDirection: SplitDirection;
  onKill: () => void;
  onClear: () => void;
  onToggleSidebar: () => void;
  onCycleFont: (delta: 1 | -1) => void;
}

export default function TerminalToolbar({
  defaultProfile,
  profileCount,
  activeProfileName,
  hasActive,
  hasSessions,
  sidebarOpen,
  settings,
  anchorRef,
  onOpenProfileMenu,
  onNew,
  onSplit,
  splitDirection,
  onKill,
  onClear,
  onToggleSidebar,
  onCycleFont,
}: TerminalToolbarProps) {
  return (
    <>
      <span className="mx-1 h-4 w-px shrink-0 bg-ide-border-soft" />

      <button
        ref={anchorRef}
        onClick={onOpenProfileMenu}
        title={
          defaultProfile
            ? `Default profile: ${defaultProfile.name}\nClick to see all ${profileCount} detected shells`
            : 'No shell detected'
        }
        className="flex min-w-0 shrink items-center gap-1 rounded px-1.5 py-1 text-[11px] text-ide-muted hover:bg-ide-hover hover:text-ide-fg"
      >
        <Icon name="terminal" size={12} />
        <span className="max-w-[130px] truncate">{defaultProfile?.name ?? 'No shell'}</span>
        <Icon name="chevron-down" size={10} />
      </button>

      <ToolButton icon="plus" title="New terminal  (Ctrl+Shift+`)" onClick={onNew} />
      <ToolButton
        icon="split"
        title={`Split terminal ${splitDirection === 'row' ? 'right' : 'down'}  (Ctrl+Shift+5 — click again to flip)`}
        onClick={onSplit}
        disabled={!hasSessions}
      />
      <ToolButton
        icon="trash"
        title="Kill the active terminal session"
        onClick={onKill}
        disabled={!hasActive}
      />
      <ToolButton
        icon="eraser"
        title="Clear the active terminal  (Ctrl+K)"
        onClick={onClear}
        disabled={!hasActive}
      />

      <span className="mx-1 h-4 w-px shrink-0 bg-ide-border-soft" />

      <ToolButton
        icon="chevron-up"
        title="Decrease terminal font size"
        onClick={() => onCycleFont(-1)}
      />
      <span className="w-7 shrink-0 text-center text-[10px] tabular-nums text-ide-faint">
        {Math.round(settings.fontSize)}
      </span>
      <ToolButton
        icon="chevron-down"
        title="Increase terminal font size"
        onClick={() => onCycleFont(1)}
      />

      <ToolButton
        icon="sidebar"
        title="Toggle the session list"
        onClick={onToggleSidebar}
        active={sidebarOpen}
      />

      {activeProfileName && (
        <span
          className="ml-1 hidden max-w-[140px] shrink-0 truncate text-[10px] text-ide-faint lg:inline"
          title="Shell of the focused session"
        >
          {activeProfileName}
        </span>
      )}
    </>
  );
}

function ToolButton({
  icon,
  title,
  onClick,
  disabled,
  active,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`shrink-0 rounded p-1 transition-colors ${
        active
          ? 'bg-ide-hover text-ide-accent'
          : 'text-ide-muted hover:bg-ide-hover hover:text-ide-fg disabled:opacity-30 disabled:hover:bg-transparent'
      }`}
    >
      <Icon name={icon} size={13} />
    </button>
  );
}
