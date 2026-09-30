'use client';

import React from 'react';
import { Icon, IconName } from './Icon';

export type ActivityPanelId = 'explorer' | 'search' | 'problems' | 'scm' | 'run' | 'ai' | 'extensions' | 'none';

export interface ActivityItem {
  id: ActivityPanelId;
  icon: IconName;
  title: string;
  badge?: number | string;
}

interface ActivityBarProps {
  active: ActivityPanelId;
  onSelect: (id: ActivityPanelId) => void;
  items: ActivityItem[];
  disabled?: boolean;
  onSettings: () => void;
}

/**
 * Far-left vertical activity rail. Primary panels live in the top group; the
 * Settings gear is pinned to the bottom, matching VS Code conventions.
 */
export default function ActivityBar({ active, onSelect, items, disabled, onSettings }: ActivityBarProps) {
  return (
    <div className="flex flex-col items-center py-2 bg-ide-bg border-r border-ide-border w-12 flex-shrink-0 select-none">
      <div className="flex flex-col items-center gap-1.5">
        {items.map((item) => {
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              title={item.title}
              disabled={disabled}
              onClick={() => onSelect(isActive ? 'none' : item.id)}
              className={`relative w-10 h-9 flex items-center justify-center rounded-md transition-colors ${
                isActive
                  ? 'text-ide-accent-bright bg-ide-accent/10'
                  : 'text-ide-muted hover:text-ide-fg hover:bg-ide-hover'
              } disabled:opacity-40`}
            >
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] bg-ide-accent-bright rounded-full" />
              )}
              <Icon name={item.icon} size={20} />
              {item.badge != null && item.badge !== 0 && (
                <span className="absolute top-0 right-0 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold leading-none">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Settings — pinned to bottom */}
      <div className="mt-auto flex flex-col items-center">
        <button
          onClick={onSettings}
          title="Settings"
          className={`relative w-10 h-9 flex items-center justify-center rounded-md transition-colors ${
            active === 'none' ? '' : ''
          } text-ide-muted hover:text-ide-fg hover:bg-ide-hover`}
        >
          <Icon name="gear" size={20} />
        </button>
      </div>
    </div>
  );
}