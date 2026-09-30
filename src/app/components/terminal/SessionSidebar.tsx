/**
 * Right-hand session list inside the terminal panel.
 *
 * Mirrors VS Code's terminal tab list: one row per live shell, with an
 * overflow menu offering rename, colour tag, icon, split and close. The row
 * also reports the shell's short name and cwd so a user with four terminals
 * open can tell them apart at a glance.
 *
 * Rename is inline (a text input swaps in for the label) rather than a modal,
 * matching the reference editor.
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../Icon';
import type { SessionIcon, ShellProfile, TerminalInstance } from './types';

const SESSION_ICONS: { id: SessionIcon; label: string; icon: IconName }[] = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'powershell', label: 'PowerShell', icon: 'zap' },
  { id: 'cmd', label: 'Command Prompt', icon: 'square' },
  { id: 'wsl', label: 'WSL', icon: 'box' },
  { id: 'bash', label: 'Bash', icon: 'file-code' },
  { id: 'node', label: 'Node', icon: 'git-branch' },
  { id: 'server', label: 'Server', icon: 'monitor' },
];

/** Tag palette offered by "Change Color". */
const TAG_COLORS = [
  '#38bdf8', '#fbbf24', '#a78bfa', '#34d399', '#f472b6', '#f97316', '#94a3b8', '#10b981',
];

interface SessionSidebarProps {
  instances: TerminalInstance[];
  profilesById: Map<string, ShellProfile>;
  activeId: string | null;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onSplit: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSetColor: (id: string, color: string | null) => void;
  onSetIcon: (id: string, icon: SessionIcon | null) => void;
}

interface MenuState {
  id: string;
  x: number;
  y: number;
  section: 'root' | 'color' | 'icon';
}

export default function SessionSidebar({
  instances,
  profilesById,
  activeId,
  onFocus,
  onClose,
  onSplit,
  onRename,
  onSetColor,
  onSetIcon,
}: SessionSidebarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, [menu]);

  const startRename = (instance: TerminalInstance) => {
    setDraft(instance.name);
    setRenaming(instance.id);
    setMenu(null);
  };

  const commitRename = () => {
    if (renaming && draft.trim()) onRename(renaming, draft);
    setRenaming(null);
  };

  return (
    <aside className="flex w-[190px] shrink-0 flex-col border-l border-ide-border bg-ide-bg">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-ide-border-soft px-2.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-ide-faint">
          Sessions
        </span>
        <span className="rounded-full bg-ide-raised px-1.5 text-[9px] tabular-nums text-ide-faint">
          {instances.length}
        </span>
      </div>

      <div className="ide-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
        {instances.length === 0 && (
          <div className="px-3 py-2 text-[10px] leading-4 text-ide-faint">No sessions</div>
        )}
        {instances.map((instance) => {
          const profile = profilesById.get(instance.profileId);
          const accent = instance.color || profile?.color || '#94a3b8';
          const isActive = instance.id === activeId;
          return (
            <div
              key={instance.id}
              role="button"
              tabIndex={0}
              onClick={() => onFocus(instance.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onFocus(instance.id);
                }
              }}
              className={`group mx-1 flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 transition-colors ${
                isActive ? 'bg-ide-hover text-ide-fg' : 'text-ide-muted hover:bg-ide-hover/60'
              } ${instance.alive ? '' : 'opacity-50'}`}
              title={`${instance.name} — ${profile?.name ?? instance.profileId}`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: accent }}
                aria-hidden
              />
              {renaming === instance.id ? (
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 flex-1 rounded border border-ide-accent bg-ide-bg px-1 text-[11px] text-ide-fg outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-[11px] leading-4">
                  {instance.name}
                  <span className="block truncate text-[9px] text-ide-faint">
                    {instance.alive ? shortenCwd(instance.cwd) : `exited (${instance.exitCode ?? '?'})`}
                  </span>
                </span>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu({ id: instance.id, x: box.left - 96, y: box.bottom + 2, section: 'root' });
                }}
                title="Session actions"
                className="shrink-0 rounded p-0.5 text-ide-faint opacity-0 transition-opacity hover:bg-ide-border hover:text-ide-fg focus:opacity-100 group-hover:opacity-100"
              >
                <Icon name="list" size={11} />
              </button>
            </div>
          );
        })}
      </div>

      {menu && (
        <SessionMenu
          menu={menu}
          instances={instances}
          onNavigate={(section) => setMenu((m) => (m ? { ...m, section } : m))}
          onRename={(id) => {
            const target = instances.find((i) => i.id === id);
            if (target) startRename(target);
          }}
          onColor={(id, color) => {
            onSetColor(id, color);
            setMenu(null);
          }}
          onIcon={(id, icon) => {
            onSetIcon(id, icon);
            setMenu(null);
          }}
          onSplit={(id) => {
            onSplit(id);
            setMenu(null);
          }}
          onClose={(id) => {
            onClose(id);
            setMenu(null);
          }}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------

interface SessionMenuProps {
  menu: MenuState;
  instances: TerminalInstance[];
  onNavigate: (section: 'root' | 'color' | 'icon') => void;
  onRename: (id: string) => void;
  onColor: (id: string, color: string | null) => void;
  onIcon: (id: string, icon: SessionIcon | null) => void;
  onSplit: (id: string) => void;
  onClose: (id: string) => void;
}

function SessionMenu({
  menu,
  instances,
  onNavigate,
  onRename,
  onColor,
  onIcon,
  onSplit,
  onClose,
}: SessionMenuProps) {
  const instance = instances.find((i) => i.id === menu.id);
  if (!instance) return null;
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 w-56 rounded-md border border-ide-border bg-ide-raised py-1 shadow-2xl"
      style={{
        left: Math.min(Math.max(8, menu.x), Math.max(8, window.innerWidth - 232)),
        top: Math.min(menu.y, Math.max(8, window.innerHeight - 190)),
      }}
    >
      {menu.section === 'root' && (
        <>
          <MenuItem icon="pencil" label="Rename…" onClick={() => onRename(instance.id)} />
          <MenuItem icon="split" label="Split Terminal" onClick={() => onSplit(instance.id)} />
          <MenuItem icon="dot" label="Change Color…" onClick={() => onNavigate('color')} />
          <MenuItem icon="terminal" label="Change Icon…" onClick={() => onNavigate('icon')} />
          <div className="my-1 border-t border-ide-border-soft" />
          <MenuItem icon="trash" label="Kill Terminal" danger onClick={() => onClose(instance.id)} />
        </>
      )}

      {menu.section === 'color' && (
        <>
          <MenuHeading>Tag color</MenuHeading>
          <div className="grid grid-cols-8 gap-1 px-3 py-1.5">
            {TAG_COLORS.map((color) => (
              <button
                key={color}
                title={color}
                onClick={() => onColor(instance.id, color)}
                className="h-4 w-4 rounded-full border border-black/40 transition-transform hover:scale-110"
                style={{ background: color }}
              />
            ))}
          </div>
          <div className="my-1 border-t border-ide-border-soft" />
          <MenuItem
            icon="rotate-cw"
            label="Reset to profile color"
            onClick={() => onColor(instance.id, null)}
          />
        </>
      )}

      {menu.section === 'icon' && (
        <>
          <MenuHeading>Session icon</MenuHeading>
          <div className="max-h-56 overflow-y-auto">
            {SESSION_ICONS.map(({ id, label, icon }) => (
              <button
                key={id}
                onClick={() => onIcon(instance.id, id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-ide-fg hover:bg-ide-hover"
              >
                <Icon name={icon} size={12} />
                {label}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-ide-border-soft" />
          <MenuItem icon="rotate-cw" label="Reset to default icon" onClick={() => onIcon(instance.id, null)} />
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-ide-hover ${
        danger ? 'text-red-400' : 'text-ide-fg'
      }`}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-ide-faint">{children}</div>
  );
}

/** `C:\Users\me\work\app` -> `…\work\app` so the sidebar stays narrow. */
export function shortenCwd(cwd: string): string {
  if (!cwd || cwd === '.') return '~';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…${cwd.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(cwd.includes('\\') ? '\\' : '/')}`;
}
