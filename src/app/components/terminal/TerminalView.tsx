/**
 * One xterm.js terminal bound to one PTY session.
 *
 * Responsibilities, in order of importance:
 *   1. keep the PTY viewport size in sync with the DOM element (drives
 *      `SIGWINCH` so vim / less / htop redraw at the right size),
 *   2. forward keystrokes, pastes and control sequences to the PTY unmodified,
 *   3. replay output produced while the view was detached (splits, panel
 *      collapse) without losing a byte,
 *   4. offer OSC-8 hyperlinks and bare URLs as clickable links.
 *
 * The PTY itself is owned by the panel, not by this component: unmounting the
 * view leaves the shell running, with its output buffered in `pty.ts`.
 */

'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

import { killPty, ptyErrorText, resizePty, spawnPty, subscribeOutput, writePty, writePtyBytes } from './pty';
import { buildTerminalTheme } from './theme';
import TerminalContextMenu, { type TerminalMenuItem } from './TerminalContextMenu';
import {
  createFileRefProvider,
  fileUriToPath,
  isPlausibleFilePath,
  resolveFileRef,
  type FileRef,
} from './linkProviders';
import type { ShellProfile, TerminalInstance, TerminalViewSettings } from './types';

interface TerminalViewProps {
  instance: TerminalInstance;
  profile: ShellProfile | undefined;
  settings: TerminalViewSettings;
  /** Workspace root — the working directory for a newly spawned shell. */
  cwd: string;
  active: boolean;
  onReady: (id: string, ptyId: number) => void;
  onSpawnFailed: (id: string, error: string) => void;
  onFocus: (id: string) => void;
  /** Focus request counter — bumping it calls `term.focus()`. */
  focusToken: number;
  /** Bumped to clear the viewport without touching PTY state (Ctrl+K). */
  clearToken: number;
  onScrollChange: (id: string, atBottom: boolean) => void;
  /** Panel actions surfaced in the right-click menu. */
  onSplit?: () => void;
  onKill?: () => void;
  onClear?: () => void;
  /**
   * Open a file (optionally at a line) in the editor. Wired straight to the
   * IDE's file-open path so "Open File" behaves like every other open.
   */
  onOpenFile?: (path: string, line?: number) => void;
  /** Surfaced when a clipboard read is refused, so the UI can explain it. */
  onNotice?: (message: string) => void;
}

/**
 * `cursorSmoothAnimation` is a proposed xterm option, so it is absent from the
 * public `ITerminalOptions` type even though `allowProposedApi` enables it.
 */
type SmoothOptions = { cursorSmoothAnimation: boolean };
const smooth = (term: Terminal, value: boolean) =>
  (term.options as ITerminalOptions & SmoothOptions).cursorSmoothAnimation = value;

export default function TerminalView({
  instance,
  profile,
  settings,
  cwd,
  active,
  onReady,
  onSpawnFailed,
  onFocus,
  focusToken,
  clearToken,
  onScrollChange,
  onSplit,
  onKill,
  onClear,
  onOpenFile,
  onNotice,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError] = useState<string | null>(instance.error);
  /**
   * Where the right-click menu is, plus the items for it.
   *
   * The items are snapshotted when the menu opens rather than derived during
   * render: they read xterm's live selection and the hovered link, and a menu
   * that recomputed them mid-render could show "Copy" enabled over a selection
   * that no longer exists.
   */
  const [menu, setMenu] = useState<{ x: number; y: number; items: TerminalMenuItem[] } | null>(
    null,
  );
  /** URL the pointer is currently over, reported by WebLinksAddon. */
  const hoveredLink = useRef<string | null>(null);
  /** File reference the pointer is currently over, reported by xterm. */
  const hoveredFile = useRef<FileRef | null>(null);

  // Long-lived xterm listeners are registered once, so they read the current
  // callbacks through a ref instead of closing over a stale render. Syncing in
  // an effect (not during render) keeps the ref consistent with the commit.
  const latest = useRef({ onScrollChange, onScrollChangeId: instance.id, cwd, onOpenFile, onNotice });
  useEffect(() => {
    latest.current = { onScrollChange, onScrollChangeId: instance.id, cwd, onOpenFile, onNotice };
  }, [onScrollChange, instance.id, cwd, onOpenFile, onNotice]);

  // ---- create the terminal (once per session) -----------------------------
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: buildTerminalTheme(),
      minimumContrastRatio: settings.minimumContrastRatio,
      // Needed for `cursorSmoothAnimation`, which is a proposed option.
      allowProposedApi: true,
    });
    smooth(term, settings.cursorSmooth);
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    // Registered *before* WebLinksAddon so `hoveredFile` wins when both
    // providers claim the same cells (xterm calls providers in order and the
    // first hover wins). In practice they rarely overlap, because the file
    // regex refuses anything that looks like a URL.
    const openRef = (ref: FileRef) => {
      const { cwd: root, onOpenFile: open } = latest.current;
      if (!open) return;
      open(resolveFileRef(ref, root), ref.line);
    };
    const fileLinkDisposable = term.registerLinkProvider(
      createFileRefProvider({
        onOpen: openRef,
        getLine: (index) => term.buffer.active.getLine(index)?.translateToString(true) ?? '',
        // Remember the reference under the pointer so the context menu can
        // offer file actions without re-deriving it from mouse coordinates.
        // xterm owns the hit-testing, so this is exact.
        onHover: (ref) => {
          hoveredFile.current = ref;
        },
        onLeave: () => {
          hoveredFile.current = null;
        },
      }),
    );

    term.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          // Ctrl/Cmd+click opens in a browser; a plain click selects, so copy
          // never fights navigation.
          if (event.ctrlKey || event.metaKey) {
            window.open(uri, '_blank', 'noopener,noreferrer');
          }
        },
        {
          // The addon owns URL hit-testing, so it tells us what is hovered
          // rather than us guessing cell coordinates.
          hover: (_event, text) => {
            hoveredLink.current = text;
          },
          leave: () => {
            hoveredLink.current = null;
          },
        },
      ),
    );

    if (settings.webgl) {
      try {
        const webgl = new WebglAddon();
        // A lost GL context (GPU reset, tab backgrounded) must not wedge the
        // pane — fall back to the canvas renderer.
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* software rendering is an acceptable fallback */
      }
    }

    term.open(host);

    let disposed = false;
    /** Set once the panel owns this PTY and will be responsible for killing it. */
    let handedOff = false;
    const start = async () => {
      if (!profile?.program) {
        fail('No shell profile is available for this session.');
        return;
      }
      try {
        const ptyId = await spawnPty({
          program: profile.program,
          args: profile.args ?? [],
          cwd: profile.cwd || cwd || '.',
          env: profile.env ?? {},
          cols: term.cols,
          rows: term.rows,
        });
        // The panel kills sessions it knows about. One it was never told about
        // is ours to clean up — which is what happens when the effect is torn
        // down before this point, e.g. React's StrictMode double-invoke.
        if (disposed) {
          void killPty(ptyId).catch(() => {});
          return;
        }
        handedOff = true;
        ptyIdRef.current = ptyId;
        onReady(instance.id, ptyId);
        setPhase('running');
        // Replays any output produced while this view was unmounted, which
        // is also what triggers the shell's capability queries.
        subscribeOutput(ptyId, (bytes) => {
          // xterm accepts a Uint8Array, so multi-byte sequences and escape
          // codes split across chunk boundaries stay intact.
          term.write(bytes);
        });
        // Anything typed (or auto-answered) while the PTY was starting goes
        // out now.
        flushPending();
      } catch (e) {
        fail(ptyErrorText(e));
      }
    };

    const fail = (message: string) => {
      setError(message);
      setPhase('error');
      onSpawnFailed(instance.id, message);
      term.writeln(`\x1b[31m${message}\x1b[0m`);
    };

    void start();

    // ---- input ------------------------------------------------------------
    // PowerShell asks for the cursor position (`ESC[6n`) within milliseconds
    // of starting and will not draw its prompt until it is answered. xterm
    // answers internally, which routes the reply through `onData` — possibly
    // *before* `spawnPty` has resolved, when there is no PTY to write to yet.
    // Dropping that reply deadlocks the shell, so early input is queued and
    // flushed the moment the handle arrives.
    const pending: string[] = [];
    const flushPending = () => {
      const ptyId = ptyIdRef.current;
      if (ptyId == null) return;
      while (pending.length > 0) {
        const chunk = pending.shift()!;
        void writePty(ptyId, chunk);
      }
    };
    const dataSub = term.onData((d) => {
      if (ptyIdRef.current == null) {
        // Bounded so a mis-ordered burst cannot grow without limit.
        if (pending.length < 256) pending.push(d);
        return;
      }
      void writePty(ptyIdRef.current, d);
    });
    const binarySub = term.onBinary((d) => {
      if (ptyIdRef.current == null) return;
      void writePtyBytes(ptyIdRef.current, new TextEncoder().encode(d));
    });

    // Local key handling for shortcuts that must not reach the shell.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const mod = ev.ctrlKey || ev.metaKey;
      // Ctrl+K clears the viewport (VS Code), it must not reach the shell.
      if (mod && ev.key === 'k') {
        term.clear();
        return false;
      }
      // With a selection active, Ctrl/Cmd+C must copy rather than send ETX.
      if (ev.key === 'c' && mod && term.hasSelection()) return false;
      return true;
    });

    const scrollSub = term.onScroll(() => {
      const buffer = term.buffer.active;
      latest.current.onScrollChange(latest.current.onScrollChangeId, buffer.viewportY >= buffer.baseY);
    });

    // NOTE: no DSR/DA/XTWINOPTS handlers here on purpose. xterm.js answers
    // those itself — `deviceStatus` (CSI 6n), `sendDeviceAttributesPrimary` and
    // `sendWindowsOptions` all reply through `triggerDataEvent`, which lands
    // in `onData` below and goes straight to the PTY. Registering our own
    // handlers shadows the built-ins to no effect.
    //
    // What matters instead is that the reply is not dropped: PowerShell emits
    // CSI 6n within milliseconds of starting, often before `spawnPty` has
    // resolved and before we have subscribed, so the input path must queue
    // rather than discard anything that arrives early. See `ptyIdRef` below.

    // The first `fit()` needs a laid-out element; the ResizeObserver below
    // handles everything after that.
    const frame = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* hidden pane */
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      // A PTY that was never handed to the panel is orphaned by definition.
      if (ptyIdRef.current != null && !handedOff) {
        void killPty(ptyIdRef.current).catch(() => {});
        ptyIdRef.current = null;
      }
      dataSub.dispose();
      binarySub.dispose();
      scrollSub.dispose();
      fileLinkDisposable.dispose();
      fitRef.current = null;
      termRef.current = null;
      try {
        term.dispose();
      } catch {
        /* already disposed */
      }
    };
    // Built once per session. Later setting changes are applied by the effect
    // below, and a re-render must never spawn a second PTY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id]);

  // ---- apply live setting changes -----------------------------------------
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.lineHeight = settings.lineHeight;
    term.options.letterSpacing = settings.letterSpacing;
    term.options.cursorBlink = settings.cursorBlink;
    smooth(term, settings.cursorSmooth);
    term.options.scrollback = settings.scrollback;
    term.options.minimumContrastRatio = settings.minimumContrastRatio;
    term.options.theme = buildTerminalTheme();
    try {
      fitRef.current?.fit();
    } catch {
      /* hidden pane */
    }
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.lineHeight,
    settings.letterSpacing,
    settings.cursorBlink,
    settings.cursorSmooth,
    settings.scrollback,
    settings.minimumContrastRatio,
  ]);

  // ---- keep the PTY viewport in step with the element ----------------------
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const push = () => {
      const term = termRef.current;
      const ptyId = ptyIdRef.current;
      if (!term || ptyId == null) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      void resizePty(ptyId, term.cols, term.rows);
    };
    const observer = new ResizeObserver(() => {
      // A split drag fires a burst of callbacks; coalesce them into one
      // resize per animation frame so the PTY is not thrashed.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(push);
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (active && focusToken > 0) termRef.current?.focus();
  }, [active, focusToken]);

  useEffect(() => {
    if (clearToken > 0) termRef.current?.clear();
  }, [clearToken]);

  // ---- context menu --------------------------------------------------------
  const copySelection = useCallback(async () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    try {
      await navigator.clipboard.writeText(term.getSelection());
    } catch {
      latest.current.onNotice?.('Could not write to the clipboard.');
    }
  }, []);

  const pasteClipboard = useCallback(async () => {
    const ptyId = ptyIdRef.current;
    if (ptyId == null) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) await writePty(ptyId, text);
    } catch {
      // A refused read is a permission problem, not a bug worth a crash: the
      // user can still use Ctrl+V inside the terminal.
      latest.current.onNotice?.('Clipboard read was refused — use Ctrl+V inside the terminal.');
    }
  }, []);

  const runSelection = useCallback(() => {
    const term = termRef.current;
    const ptyId = ptyIdRef.current;
    if (!term?.hasSelection() || ptyId == null) return;
    // A literal newline would submit mid-selection in most shells; a carriage
    // return is what a real Enter keypress delivers.
    void writePty(ptyId, `${term.getSelection()}\r`);
    term.clearSelection();
  }, []);

  const openFile = useCallback((path: string, line?: number) => {
    latest.current.onOpenFile?.(path, line);
  }, []);

  const buildMenuItems = useCallback((): TerminalMenuItem[] => {
    const term = termRef.current;
    const hasSelection = !!term?.hasSelection();
    const link = hoveredLink.current;
    const file = hoveredFile.current;
    const items: TerminalMenuItem[] = [];

    if (link) {
      // A `file://` link is a local path wearing a URL costume; offer the
      // editor action for it rather than "open a browser".
      const local = fileUriToPath(link);
      if (local && isPlausibleFilePath(local)) {
        items.push(
          {
            label: 'Open File',
            icon: 'file-text',
            disabled: !onOpenFile,
            action: () => openFile(local),
          },
          { icon: 'copy', label: 'Copy File Path', action: () => void navigator.clipboard.writeText(local).catch(() => {}) },
        );
      } else {
        items.push(
          { label: 'Open Link in Browser', icon: 'zap', action: () => window.open(link, '_blank', 'noopener,noreferrer') },
          { label: 'Copy Link Address', icon: 'copy', action: () => void navigator.clipboard.writeText(link).catch(() => {}) },
        );
      }
      items.push({ separator: true });
    } else if (file) {
      const resolved = resolveFileRef(file, cwd);
      items.push(
        { label: 'Open File', icon: 'file-text', disabled: !onOpenFile, action: () => openFile(resolved) },
        {
          label: 'Open File at Line',
          icon: 'chevron-right',
          // Only meaningful when the reference actually carried a line.
          disabled: !onOpenFile || file.line === undefined,
          action: () => openFile(resolved, file.line),
        },
        { label: 'Copy File Path', icon: 'copy', action: () => void navigator.clipboard.writeText(resolved).catch(() => {}) },
      );
      items.push({ separator: true });
    }

    items.push(
      { label: 'Copy', icon: 'clipboard', shortcut: 'Ctrl+Shift+C', disabled: !hasSelection, action: () => void copySelection() },
      { label: 'Paste', icon: 'copy', shortcut: 'Ctrl+V', action: () => void pasteClipboard() },
      { label: 'Run Selected Text', icon: 'play', disabled: !hasSelection, action: runSelection },
      { separator: true },
      { label: 'Select All', icon: 'check', shortcut: 'Ctrl+A', action: () => term?.selectAll() },
      { label: 'Clear', icon: 'eraser', shortcut: 'Ctrl+K', action: () => (onClear ? onClear() : term?.clear()) },
    );

    if (onSplit || onKill) {
      items.push({ separator: true });
      if (onSplit) items.push({ label: 'Split Terminal', icon: 'split', action: onSplit });
      if (onKill) items.push({ label: 'Kill Terminal', icon: 'trash', danger: true, action: onKill });
    }
    return items;
  }, [cwd, onClear, onKill, onOpenFile, onSplit, copySelection, pasteClipboard, runSelection, openFile]);

  // Right-click focuses the terminal first (as VS Code does) so the menu acts
  // on the pane the user actually clicked, then snapshots the item list.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onFocus(instance.id);
      termRef.current?.focus();
      setMenu({ x: e.clientX, y: e.clientY, items: buildMenuItems() });
    },
    [instance.id, onFocus, buildMenuItems],
  );

  return (
    <div
      className="relative h-full w-full min-h-0 cursor-text"
      onMouseDown={() => {
        onFocus(instance.id);
        termRef.current?.focus();
      }}
      onContextMenu={onContextMenu}
    >
      <div
        ref={hostRef}
        data-terminal-view={instance.id}
        className="h-full w-full pl-2 pt-1 [&_.xterm-viewport::-webkit-scrollbar]:h-8 [&_.xterm-viewport::-webkit-scrollbar-thumb]:rounded [&_.xterm-viewport::-webkit-scrollbar-thumb]:bg-[#3a4149] [&_.xterm]:h-full"
      />
      {phase === 'starting' && (
        <div className="pointer-events-none absolute inset-x-0 top-2 text-center text-[11px] text-ide-faint">
          starting {profile?.short || 'shell'}…
        </div>
      )}
      {phase === 'error' && error && (
        <div className="absolute left-1/2 top-4 w-[min(420px,90%)] -translate-x-1/2 rounded border border-red-500/40 bg-ide-raised/95 px-3 py-2 text-[11px] text-red-300 shadow-lg">
          {error}
        </div>
      )}

      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => {
            // Hover state is only meaningful while no menu is up; clearing it
            // stops a stale link from leaking into the next right-click.
            hoveredLink.current = null;
            hoveredFile.current = null;
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}
