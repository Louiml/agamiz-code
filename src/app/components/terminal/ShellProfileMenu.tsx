/**
 * Shell profile picker.
 *
 * Lists the profiles the backend detected (PowerShell, Command Prompt, each
 * WSL distribution, Git Bash, the Unix login shell, plus anything the user
 * configured) and marks the default. Clicking an entry either spawns a new
 * session or re-targets the current one, which is what the dropdown chevron
 * in the panel header does.
 */

'use client';

import React, { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import type { ShellProfile } from './types';

interface ShellProfileMenuProps {
  profiles: ShellProfile[];
  defaultProfileId: string;
  activeProfileId: string | null;
  onSpawn: (profile: ShellProfile) => void;
  onRetarget: (profile: ShellProfile) => void;
  onSetDefault: (profileId: string) => void;
  onClose: () => void;
  /** Anchors the popup; clamped to the viewport on the right edge. */
  anchor: { left: number; bottom: number };
}

export default function ShellProfileMenu({
  profiles,
  defaultProfileId,
  activeProfileId,
  onSpawn,
  onRetarget,
  onSetDefault,
  onClose,
  anchor,
}: ShellProfileMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const available = profiles.filter((p) => p.available);
  const unavailable = profiles.filter((p) => !p.available);

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} onContextMenu={onClose} />
      <div
        ref={ref}
        role="menu"
        className="ide-scrollbar fixed z-50 max-h-[60vh] w-[290px] overflow-y-auto rounded-md border border-ide-border bg-ide-raised py-1 shadow-2xl"
        style={{ left: Math.max(8, anchor.left), bottom: Math.max(8, anchor.bottom) }}
      >
        <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-ide-faint">
          Change shell for session
        </div>
        {available.map((profile) => (
          <Row
            key={profile.id}
            profile={profile}
            trailing={
              activeProfileId === profile.id ? (
                <Icon name="check" size={12} className="text-ide-accent" />
              ) : defaultProfileId === profile.id ? (
                <span className="text-[9px] text-ide-faint">default</span>
              ) : null
            }
            onUse={() => {
              onRetarget(profile);
              onClose();
            }}
            onSpawn={() => {
              onSpawn(profile);
              onClose();
            }}
            onSetDefault={() => onSetDefault(profile.id)}
          />
        ))}

        {unavailable.length > 0 && (
          <>
            <div className="my-1 border-t border-ide-border-soft" />
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-ide-faint">
              Not installed
            </div>
            {unavailable.map((profile) => (
              <div
                key={profile.id}
                title={`${profile.program} was not found on this machine`}
                className="flex cursor-not-allowed items-center gap-2 px-3 py-1.5 text-[11px] text-ide-faint"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" />
                <span className="truncate">{profile.name}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function Row({
  profile,
  trailing,
  onUse,
  onSpawn,
  onSetDefault,
}: {
  profile: ShellProfile;
  trailing?: React.ReactNode;
  onUse: () => void;
  onSpawn: () => void;
  onSetDefault: () => void;
}) {
  return (
    <div
      role="menuitem"
      tabIndex={0}
      onClick={onUse}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onUse();
      }}
      onDoubleClick={onSpawn}
      className="group flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[11px] text-ide-fg hover:bg-ide-hover"
      title={`${profile.program}${profile.args.length ? ` ${profile.args.join(' ')}` : ''} — click to use here, double-click for a new session`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: profile.color }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{profile.name}</span>
      {trailing}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSetDefault();
          }}
          title="Set as default profile"
          className="rounded p-0.5 text-ide-faint hover:bg-ide-border hover:text-ide-fg"
        >
          <Icon name="check" size={11} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSpawn();
          }}
          title="Create a new session with this profile"
          className="rounded p-0.5 text-ide-faint hover:bg-ide-border hover:text-ide-fg"
        >
          <Icon name="plus" size={11} />
        </button>
      </span>
    </div>
  );
}
