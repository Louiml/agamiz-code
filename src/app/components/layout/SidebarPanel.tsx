'use client';

import React, { useRef } from 'react';

interface SidebarPanelProps {
  open: boolean;
  width: number;
  onResize: (width: number) => void;
  children: React.ReactNode;
}

const MIN_WIDTH = 180;
const MAX_WIDTH = 520;

/**
 * Collapsible primary sidebar. Uses a CSS width transition when toggling so
 * open/close animates smoothly, and a drag handle for free resizing.
 */
export default function SidebarPanel({ open, width, onResize, children }: SidebarPanelProps) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const next = dragRef.current.startW + (ev.clientX - dragRef.current.startX);
      onResize(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <>
      <div
        className={`flex flex-col flex-shrink-0 min-h-0 overflow-hidden bg-ide-bg border-r border-ide-border transition-[width] duration-150 ease-out ${
          open ? 'ide-panel-enter' : ''
        }`}
        style={{ width: open ? width : 0 }}
      >
        {open && <div className="flex-1 flex flex-col min-h-0">{children}</div>}
      </div>

      {open && (
        <div
          onMouseDown={startDrag}
          className="w-1 cursor-col-resize bg-ide-border-soft hover:bg-ide-accent active:bg-ide-accent-bright transition-colors flex-shrink-0"
          title="Drag to resize sidebar"
        />
      )}
    </>
  );
}