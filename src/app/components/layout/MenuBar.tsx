'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  /** Omitted for separators (id === 'separator'). */
  action?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface MenuGroup {
  id: string;
  label: string;
  items: MenuItem[];
}

interface MenuBarProps {
  menus: MenuGroup[];
}

/**
 * Lightweight, dependency-free menu bar (File / Edit / View / Help).
 * Opens a dropdown on click, closes on outside click or Escape.
 */
export default function MenuBar({ menus }: MenuBarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openId) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenId(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openId]);

  return (
    // NOTE: intentionally NO data-tauri-drag-region here. In Tauri 2 the
    // injected drag script turns any clickable element that carries that
    // attribute into a window-drag region: mousedown would start a native
    // drag loop and swallow the click, so the menus would never open.
    <div ref={barRef} className="flex items-center h-full select-none">
      {menus.map((menu) => {
        const open = openId === menu.id;
        return (
          <div key={menu.id} className="relative h-full">
            <button
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                setOpenId(open ? null : menu.id);
              }}
              className={`h-full px-2.5 text-xs transition-colors ${
                open
                  ? 'bg-ide-raised text-ide-fg'
                  : 'text-ide-muted hover:text-ide-fg hover:bg-ide-hover'
              }`}
            >
              {menu.label}
            </button>

            {open && (
              <div className="absolute left-0 top-full z-50 min-w-[220px] py-1 bg-ide-raised border border-ide-border rounded-md shadow-2xl shadow-black/50">
                {menu.items.map((item, i) =>
                  item.id === 'separator' ? (
                    <div key={i} className="my-1 h-px bg-ide-border-soft" />
                  ) : (
                    <button
                      key={item.id}
                      disabled={item.disabled}
                      onClick={() => {
                        setOpenId(null);
                        item.action?.();
                      }}
                      className={`w-full flex items-center justify-between gap-6 px-3 py-1.5 text-xs text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        item.danger
                          ? 'text-red-400 hover:bg-red-500/10'
                          : 'text-ide-fg hover:bg-ide-accent/90 hover:text-black'
                      }`}
                    >
                      <span className="whitespace-nowrap">{item.label}</span>
                      {item.shortcut && (
                        <span className="ml-auto text-[10px] text-ide-muted whitespace-nowrap">
                          {item.shortcut}
                        </span>
                      )}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}