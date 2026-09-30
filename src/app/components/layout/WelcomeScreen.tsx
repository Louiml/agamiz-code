'use client';

import React from 'react';
import { Icon, IconName } from '../Icon';

export interface WelcomeAction {
  id: string;
  label: string;
  sublabel?: string;
  icon: IconName;
  shortcut?: string;
  run: () => void;
}

interface WelcomeScreenProps {
  title: string;
  subtitle: string;
  actions: WelcomeAction[];
  footerHint?: string;
}

/**
 * Improved editor empty state: a quick-action palette for opening files,
 * recent projects, and the command palette.
 */
export default function WelcomeScreen({ title, subtitle, actions, footerHint }: WelcomeScreenProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-ide-bg text-center px-8">
      <div className="w-14 h-14 mb-5 rounded-2xl bg-gradient-to-br from-ide-accent to-ide-accent-bright flex items-center justify-center shadow-lg shadow-emerald-900/40">
        <span className="text-black font-black text-2xl">A</span>
      </div>
      <h2 className="text-lg font-semibold text-ide-fg mb-1">{title}</h2>
      <p className="text-xs text-ide-muted mb-8 max-w-sm">{subtitle}</p>

      <div className="grid gap-2 w-full max-w-sm">
        {actions.map((a) => (
          <button
            key={a.id}
            onClick={a.run}
            className="group flex items-center gap-3 px-3 py-2 rounded-md bg-ide-raised border border-ide-border-soft hover:border-ide-accent/60 hover:bg-ide-hover transition-colors text-left"
          >
            <Icon name={a.icon} size={16} className="text-ide-muted group-hover:text-ide-accent-bright" />
            <span className="flex-1 min-w-0">
              <span className="block text-xs text-ide-fg">{a.label}</span>
              {a.sublabel && <span className="block text-[10px] text-ide-faint truncate">{a.sublabel}</span>}
            </span>
            {a.shortcut && (
              <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-ide-border text-ide-muted group-hover:text-ide-accent-bright">
                {a.shortcut}
              </kbd>
            )}
          </button>
        ))}
      </div>

      {footerHint && <p className="mt-6 text-[10px] text-ide-faint">{footerHint}</p>}
    </div>
  );
}