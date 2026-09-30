/**
 * Right-click menu for the terminal.
 *
 * Context-sensitive, like VS Code's: the clipboard group is always present but
 * disables itself without a selection, the link group only appears over a URL,
 * and the file group only over a `file:line` reference. Each group is built by
 * the caller from what xterm reported as hovered, so this component stays a
 * dumb, easily-previewed renderer.
 *
 * Rendered through a portal because every pane sits inside an
 * `overflow-hidden` wrapper with a percentage size — a plain absolutely
 * positioned child would be clipped to the pane and unable to overflow it.
 */

'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../Icon';

export interface TerminalMenuItem {
  label?: string;
  /** Right-aligned hint, e.g. `Ctrl+Shift+V`. */
  shortcut?: string;
  icon?: IconName;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
  /** Section headings, e.g. between the clipboard and link groups. */
  heading?: string;
  danger?: boolean;
}

interface TerminalContextMenuProps {
  x: number;
  y: number;
  items: TerminalMenuItem[];
  onClose: () => void;
}

export default function TerminalContextMenu({ x, y, items, onClose }: TerminalContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Measure after mount, then pull the menu back inside the viewport. Doing it
  // in an effect (rather than guessing a width) keeps the clamp correct for
  // whatever items the caller produced.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - height - pad)),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase: the terminal binds Escape itself, and the menu has to win.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[60]"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="menu"
        className="fixed z-[61] min-w-[180px] overflow-hidden rounded-md border border-ide-border bg-ide-raised py-1 shadow-2xl"
        style={{ left: pos.left, top: pos.top }}
      >
        {items.map((item, i) => {
          if (item.separator) {
            return <div key={i} role="separator" className="my-1 border-t border-ide-border-soft" />;
          }
          if (item.heading) {
            return (
              <div
                key={i}
                className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-ide-faint"
              >
                {item.heading}
              </div>
            );
          }
          return (
            <button
              key={i}
              role="menuitem"
              disabled={item.disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                item.action?.();
                onClose();
              }}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors disabled:cursor-default disabled:opacity-35 ${
                item.danger
                  ? 'text-red-400 hover:bg-red-500/15'
                  : 'text-ide-fg hover:bg-ide-hover'
              }`}
            >
              {item.icon ? (
                <span className="flex w-3.5 shrink-0 items-center justify-center">
                  <Icon name={item.icon} size={12} className={item.disabled ? '' : 'text-ide-muted'} />
                </span>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.shortcut && (
                <span className="ml-4 shrink-0 font-mono text-[10px] text-ide-faint">{item.shortcut}</span>
              )}
            </button>
          );
        })}
      </div>
    </>,
    document.body,
  );
}
