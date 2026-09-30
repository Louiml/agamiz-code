'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { diagTauriBridge, isTauri, errText, safeUnlisten } from '../lib/tauri';

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  // Transient, VISIBLE explanation when a window action cannot run. Turns
  // "button does nothing" into a concrete reason (plain browser tab vs. a
  // denied IPC call) without opening DevTools.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);

  // Keep the maximize/restore icon in sync with the REAL window state —
  // Win+Up, Aero Snap, double-click on the bar, taskbar actions, etc.
  useEffect(() => {
    diagTauriBridge();
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    win.isMaximized().then(setIsMaximized).catch((e) => {
      console.error('[titlebar] isMaximized failed:', errText(e));
    });
    win.onResized(async () => {
      if (disposed) return;
      try { setIsMaximized(await win.isMaximized()); } catch { /* best-effort */ }
    }).then((fn) => {
      if (disposed) safeUnlisten(fn);
      else unlisten = fn;
    }).catch(() => { /* resize syncing is optional */ });
    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  }, []);

  const runWindowAction = useCallback(async (
    label: string,
    action: (win: TauriWindow) => Promise<unknown>,
  ) => {
    if (!isTauri()) {
      showNotice(`⚠ ${label} needs the desktop app (npm run tauri:dev) — window controls are unavailable in a plain browser tab`);
      return;
    }
    try {
      await action(getCurrentWindow());
    } catch (e) {
      console.error(`[titlebar] ${label} failed:`, errText(e));
      showNotice(`⚠ ${label} failed: ${errText(e)}`);
    }
  }, [showNotice]);

  const handleMinimize = () => runWindowAction('Minimize', (win) => win.minimize());

  const handleMaximize = () => runWindowAction('Maximize', async (win) => {
    const maximized = await win.isMaximized();
    if (maximized) {
      await win.unmaximize();
      setIsMaximized(false);
    } else {
      await win.maximize();
      setIsMaximized(true);
    }
  });

  const handleFullscreen = useCallback(() => runWindowAction('Full screen', async (win) => {
    const fullscreen = await win.isFullscreen();
    await win.setFullscreen(!fullscreen);
  }), [runWindowAction]);

  const handleClose = () => runWindowAction('Close', (win) => win.close());

  // F11 toggles true (borderless) full screen, like any desktop IDE.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        handleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleFullscreen]);

  return (
    <div
      // `deep` = the WHOLE bar (background and logo/title text) is a drag
      // region, while interactive children stay normal controls: Tauri's
      // injected script makes clickable elements (buttons/links) block
      // dragging, so the window-control buttons still receive their clicks.
      // Double-clicking the bar toggles maximize (core command
      // `internal_toggle_maximize`, allowed via the app capability file).
      data-tauri-drag-region="deep"
      className="relative flex items-center justify-between h-8 bg-zinc-900 border-b border-zinc-800 select-none flex-shrink-0"
    >
      {/* Left: Logo + Title (draggable via the bar's `deep` region) */}
      <div className="flex items-center gap-2 px-3">
        <span className="text-emerald-500 font-bold text-sm">A</span>
        <span className="text-zinc-400 text-xs">Agamiz Code</span>
        <span className="text-zinc-700 text-[10px]">v0.7</span>
      </div>

      {/* Center: Spacer (draggable) */}
      <div className="flex-1 h-full" />

      {/* Transient explanation when a window action cannot run */}
      {notice && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-[120] px-3 py-1.5 rounded-lg bg-zinc-900 border border-amber-500/40 text-amber-200 text-[11px] shadow-2xl whitespace-nowrap max-w-[90vw] overflow-hidden text-ellipsis">
          {notice}
        </div>
      )}

      {/* Right: Window Controls */}
      <div className="flex items-center h-full">
        <button
          onClick={handleMinimize}
          className="h-full w-11 flex items-center justify-center text-zinc-400 hover:bg-zinc-800 transition-colors"
          title="Minimize"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="h-full w-11 flex items-center justify-center text-zinc-400 hover:bg-zinc-800 transition-colors"
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="2" y="3" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="3.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="h-full w-11 flex items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white transition-colors"
          title="Close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M1 1 L11 11 M11 1 L1 11" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}