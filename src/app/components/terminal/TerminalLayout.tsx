/**
 * Recursive renderer for the split layout tree.
 *
 * Divider drags write pane sizes straight to the DOM and commit to the store
 * once, on release. Routing every pointermove through React state would
 * re-render the whole panel — and re-run every xterm view's render path under
 * it — at input frequency; with several live WebGL terminals that drops
 * frames badly enough to make the drag feel broken.
 *
 * The two supporting behaviours that make a divider feel right:
 *   - `drag-resizing-col` / `drag-resizing-row` on `<body>` (already defined
 *     in `globals.css` for the sidebar and panel resizers) suppresses text
 *     selection and pins the resize cursor for the whole document,
 *   - a stray click that did not move the divider must not commit, or the
 *     ratio gets rounded and the next click jitters by a pixel.
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TerminalView from './TerminalView';
import { MIN_RATIO, evenRatios, normalizeRatios, resizeRatios } from './ratios';
import type { SplitNode, ShellProfile, TerminalInstance, TerminalViewSettings } from './types';

/** Nudge applied by the arrow keys when the separator has focus. */
const KEY_STEP = 0.02;

interface TerminalLayoutProps {
  node: SplitNode | null;
  instances: TerminalInstance[];
  profilesById: Map<string, ShellProfile>;
  settings: TerminalViewSettings;
  cwd: string;
  activeId: string | null;
  focusToken: number;
  clearToken: number;
  onFocus: (id: string) => void;
  onReady: (id: string, ptyId: number) => void;
  onSpawnFailed: (id: string, error: string) => void;
  onScrollChange: (id: string, atBottom: boolean) => void;
  /** Persist the ratios of the split group addressed by `path` (e.g. `"0/1"`). */
  onResize: (path: string, sizes: number[]) => void;
  /** Panel + editor actions surfaced in the terminal's right-click menu. */
  onSplit?: () => void;
  onKill?: () => void;
  onClear?: () => void;
  onOpenFile?: (path: string, line?: number) => void;
  onNotice?: (message: string) => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 rounded border border-ide-border bg-ide-raised px-1 py-0.5 font-mono text-[10px] text-ide-muted">
      {children}
    </kbd>
  );
}

export default function TerminalLayout(props: TerminalLayoutProps) {
  if (!props.node) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[11px] leading-5 text-ide-faint">
        No terminal is open. Press <Kbd>Ctrl+Shift+`</Kbd> or use the <Kbd>+</Kbd> button in the panel
        header.
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 w-full">
      <SplitPane {...props} node={props.node} path="" />
    </div>
  );
}

function SplitPane(props: TerminalLayoutProps & { node: SplitNode; path: string }) {
  const { node, path, instances, onResize } = props;
  const isSplit = node.kind === 'split';
  const horizontal = isSplit && node.direction === 'row';
  const committed = useMemo(
    () => (node.kind === 'split' ? node.sizes : []),
    [node],
  );

  // DOM handles for the pane wrappers and the flex container. The container is
  // the sizing box its children are percentages of, so it is also the basis
  // for translating a pixel delta into a ratio delta.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const paneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [dragging, setDragging] = useState(false);

  interface Drag {
    index: number;
    start: number;
    base: number[];
    extent: number;
    /** Last ratio vector written, committed as-is on release. */
    result: number[];
  }
  const drag = useRef<Drag | null>(null);

  /** Push a ratio vector onto the pane wrappers without re-rendering. */
  const applyRatios = useCallback(
    (sizes: number[]) => {
      const total = sizes.reduce((a, b) => a + b, 0) || 1;
      for (let k = 0; k < sizes.length; k++) {
        const el = paneRefs.current[k];
        if (!el) continue;
        const pct = ((sizes[k] ?? 0) / total) * 100;
        if (horizontal) el.style.width = `${pct}%`;
        else el.style.height = `${pct}%`;
      }
    },
    [horizontal],
  );

  const endDrag = useCallback(() => {
    drag.current = null;
    setDragging(false);
    document.body.classList.remove('drag-resizing-col', 'drag-resizing-row');
  }, []);

  // A pane can unmount mid-drag (the tab is switched, the panel closes). The
  // body class is global, so it has to be dropped on the way out or the whole
  // window keeps the resize cursor and refuses to select text.
  useEffect(() => endDrag, [endDrag]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, index: number) => {
      if (!isSplit) return;
      e.preventDefault();
      // Capture keeps the stream flowing when the pointer outruns the 1px
      // rule, which is the normal case at any usable drag speed.
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const extent = horizontal
        ? containerRef.current?.clientWidth
        : containerRef.current?.clientHeight;
      if (!extent) return;
      drag.current = {
        index,
        start: horizontal ? e.clientX : e.clientY,
        base: [...committed],
        extent,
        result: [...committed],
      };
      document.body.classList.add(horizontal ? 'drag-resizing-col' : 'drag-resizing-row');
      setDragging(true);
    },
    [isSplit, horizontal, committed],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      const delta = ((horizontal ? e.clientX : e.clientY) - d.start) / d.extent;
      d.result = resizeRatios(d.base, d.index, delta);
      applyRatios(d.result);
    },
    [horizontal, applyRatios],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      if (!d) return;
      // Leave the DOM showing the settled ratios so the commit does not
      // produce a visible snap; React takes over from here.
      applyRatios(d.result);
      const before = normalizeRatios(d.base);
      if (Math.abs((d.result[d.index] ?? 0) - before[d.index]) >= 1e-4) {
        onResize(path, d.result);
      }
      endDrag();
    },
    [applyRatios, onResize, path, endDrag],
  );

  /** Arrow keys nudge; Home/End push the pane to its clamp limits. */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
      if (!isSplit) return;
      const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const increase = horizontal ? 'ArrowRight' : 'ArrowDown';
      let delta: number;
      if (e.key === decrease) delta = -KEY_STEP;
      else if (e.key === increase) delta = KEY_STEP;
      else if (e.key === 'Home') delta = -1;
      else if (e.key === 'End') delta = 1;
      else return;
      e.preventDefault();
      onResize(path, resizeRatios(committed, index, delta));
    },
    [isSplit, horizontal, committed, path, onResize],
  );

  if (node.kind === 'leaf') {
    const instance = instances.find((i) => i.id === node.instanceId);
    if (!instance) {
      return (
        <div className="flex h-full items-center justify-center text-[11px] text-ide-faint">
          This terminal session was closed.
        </div>
      );
    }
    return (
      <TerminalView
        instance={instance}
        profile={props.profilesById.get(instance.profileId)}
        settings={props.settings}
        cwd={props.cwd}
        active={props.activeId === instance.id}
        onReady={props.onReady}
        onSpawnFailed={props.onSpawnFailed}
        onFocus={props.onFocus}
        focusToken={props.focusToken}
        clearToken={props.clearToken}
        onScrollChange={props.onScrollChange}
        onSplit={props.onSplit}
        onKill={props.onKill}
        onClear={props.onClear}
        onOpenFile={props.onOpenFile}
        onNotice={props.onNotice}
      />
    );
  }

  const total = committed.reduce((a, b) => a + b, 0) || 1;

  return (
    <div
      ref={containerRef}
      className={`flex h-full min-h-0 w-full ${horizontal ? 'flex-row' : 'flex-col'}`}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {node.children.map((child, i) => (
        <React.Fragment key={i}>
          <div
            ref={(el) => {
              paneRefs.current[i] = el;
            }}
            className="min-h-0 min-w-0 overflow-hidden"
            style={
              horizontal
                ? { width: `${((committed[i] ?? 0) / total) * 100}%`, flexShrink: 0 }
                : { height: `${((committed[i] ?? 0) / total) * 100}%`, flexShrink: 0 }
            }
          >
            <SplitPane {...props} node={child} path={`${path}${path ? '/' : ''}${i}`} />
          </div>
          {i < node.children.length - 1 && (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation={horizontal ? 'vertical' : 'horizontal'}
              aria-label={`Resize terminal pane ${i + 1} of ${node.children.length}`}
              aria-valuenow={Math.round(((committed[i] ?? 0) / total) * 100)}
              aria-valuemin={Math.round(MIN_RATIO * 100)}
              aria-valuemax={100}
              title="Drag to resize · click the middle to reset"
              onPointerDown={(e) => onPointerDown(e, i)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onDoubleClick={() => onResize(path, evenRatios(node.children.length))}
              className={`group z-10 shrink-0 outline-none transition-colors focus-visible:bg-ide-accent ${
                dragging ? 'bg-ide-accent' : 'bg-ide-border hover:bg-ide-accent'
              } ${horizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'}`}
            >
              {/* Widen the grab target without widening the visible rule. */}
              <div
                className={`absolute ${horizontal ? '-inset-y-1 -left-1 -right-1' : '-inset-x-1 -top-1 -bottom-1'}`}
              />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/** How many panes the layout currently shows — used for header tooltips. */
export function paneCount(node: SplitNode | null): number {
  if (!node) return 0;
  if (node.kind === 'leaf') return 1;
  return node.children.reduce((sum, c) => sum + paneCount(c), 0);
}
