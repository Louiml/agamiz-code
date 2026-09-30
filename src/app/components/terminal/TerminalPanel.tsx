/**
 * Terminal panel.
 *
 * Owns the shell sessions and their layout, and publishes its toolbar to the
 * host so it can render inline in the bottom panel's tab strip. The panel
 * *tabs* (Terminal / Output / Problems / Debug Console) plus the shared
 * maximize / collapse / close buttons live in `BottomPanel`.
 *
 * # Session lifetime
 *
 * The store is the source of truth and `TerminalView` is disposable: unmounting
 * a view (splitting, hiding the tab) leaves the PTY running with its output
 * buffered in `pty.ts`. Sessions are only really destroyed by an explicit
 * kill, a close, or the webview going away.
 *
 * # Working directory
 *
 * The PTY owns the shell, so the UI cannot observe the shell's own `cd`.
 * `cwd` is therefore the *spawn* directory only and is never rewritten.
 */

'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from '../Icon';
import TerminalLayout, { paneCount } from './TerminalLayout';
import SessionSidebar from './SessionSidebar';
import ShellProfileMenu from './ShellProfileMenu';
import TerminalToolbar from './TerminalToolbar';
import {
  useCustomProfiles,
  useDefaultProfileId,
  useFontSize,
  useTerminalSettings,
} from './settings';
import { ensurePtyListeners, fetchProfiles, killPty, onPtyExit, ptyErrorText, writePty } from './pty';
import { initialTerminalState, leafIds, terminalReducer } from './store';
import {
  type SessionIcon,
  type ShellProfile,
  type SplitDirection,
  type TerminalInstance,
} from './types';

const FONT_STEP = 1;
const FONT_MIN = 8;
const FONT_MAX = 28;

interface TerminalPanelProps {
  /** Workspace root — the spawn directory for new shells. */
  cwd: string;
  /** Bumped by the host to request a session with the default profile. */
  spawnToken: number;
  /** Bumped by the host to open the first session if the panel is empty. */
  ensureToken: number;
  /** Bumped by the host to request a split of the active pane. */
  splitToken: number;
  /** Cycle the focused pane. Bumping this applies `cycleDelta`. */
  cycleToken: number;
  cycleDelta: 1 | -1;
  /**
   * A command for the host to run in a fresh shell, e.g. the New Project
   * wizard's post-create `npm install`.
   *
   * Split into a token plus the text rather than one object prop, matching every
   * other host action here: a token lets the *same* command be requested twice
   * and run twice, while keeping this effect's dependencies primitive so it
   * cannot re-fire on an unrelated re-render.
   */
  runCommandToken: number;
  runCommandText: string;
  /** Spawn directory for the command's pane; normally the new project root. */
  runCommandCwd: string;
  /** Receives the toolbar element so the host can render it in its header. */
  onToolbar: (node: ReactNode) => void;
  /** Reports the live session count so the host can decide when to seed. */
  onSessionCountChange: (count: number) => void;
  /** Opens a file (optionally at a line) in the editor. */
  onOpenFile?: (path: string, line?: number) => void;
  /** Host-level notice channel, used for clipboard refusals. */
  onNotice?: (message: string) => void;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `term-${idSeq}-${Date.now().toString(36)}`;
}

export default function TerminalPanel({
  cwd,
  spawnToken,
  ensureToken,
  splitToken,
  cycleToken,
  cycleDelta,
  runCommandToken,
  runCommandText,
  runCommandCwd,
  onToolbar,
  onSessionCountChange,
  onOpenFile,
  onNotice,
}: TerminalPanelProps) {
  const [state, dispatch] = useReducer(terminalReducer, initialTerminalState);
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const [profileMenu, setProfileMenu] = useState<{ left: number; bottom: number } | null>(null);
  /** Split orientation; the toolbar's split button flips it on each click. */
  const [direction, setDirection] = useState<SplitDirection>('column');
  const [focusToken, setFocusToken] = useState(0);
  const [clearToken, setClearToken] = useState(0);
  const [atBottom, setAtBottom] = useState<Record<string, boolean>>({});
  const [bootError, setBootError] = useState<string | null>(null);

  const settings = useTerminalSettings();
  const customProfiles = useCustomProfiles();
  const defaultProfileId = useDefaultProfileId();

  const stateRef = useRef(state);
  /** Split orientation, readable from the stable callbacks below. */
  const directionRef = useRef(direction);
  /** Backend pty id -> instance id, needed to translate exit events. */
  const ptyToInstance = useRef(new Map<number, string>());
  const spawnSeen = useRef(0);
  const ensureSeen = useRef(0);
  const splitSeen = useRef(0);
  const cycleSeen = useRef(0);
  const profileAnchorRef = useRef<HTMLButtonElement>(null);
  /**
   * The host passes `onNotice` as an inline arrow, so its identity changes on
   * every render. The command-run effect below must not depend on it directly,
   * or it would re-run constantly — harmless today only because it early-returns
   * on an empty `pendingRun`.
   */
  const onNoticeRef = useRef(onNotice);
  useEffect(() => {
    onNoticeRef.current = onNotice;
  }, [onNotice]);

  // Callbacks below are memoised with narrow dependency lists, so they read the
  // current state and direction through these refs. Syncing in an effect keeps
  // them aligned with the committed render rather than the in-flight one.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    directionRef.current = direction;
  }, [direction]);

  // ---- shell discovery -----------------------------------------------------
  // Re-probed whenever the user edits `terminal.profiles` in the Settings
  // Center, so a newly added shell appears without restarting the IDE.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensurePtyListeners();
        const list = await fetchProfiles(customProfiles);
        if (cancelled) return;
        setProfiles(list);
        if (list.length === 0) setBootError('No shell was detected on this machine.');
      } catch (e) {
        if (!cancelled) setBootError(ptyErrorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customProfiles]);

  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  /** The profile the `+` button, the first session and splits use. */
  const defaultProfile = useMemo(() => {
    const configured = profilesById.get(defaultProfileId.value);
    if (configured?.available) return configured;
    return profiles.find((p) => p.available && p.is_default) ?? profiles.find((p) => p.available);
  }, [profiles, profilesById, defaultProfileId.value]);

  // ---- session lifecycle ---------------------------------------------------
  const makeInstance = useCallback(
    (profileId: string, cwdOverride?: string): TerminalInstance => {
      const profile = profilesById.get(profileId);
      const ordinal = stateRef.current.nextOrdinal;
      return {
        id: nextId(),
        ptyId: null,
        profileId,
        name: `${ordinal}: ${profile?.short || profile?.name || 'shell'}`,
        ordinal,
        color: null,
        icon: null,
        // `cwdOverride` outranks the profile so a host-driven command runs where
        // it was asked to. The wizard's install must land in the project it just
        // created, even for a user whose shell profile pins a fixed directory.
        cwd: cwdOverride || profile?.cwd || cwd || '.',
        createdAt: Date.now(),
        alive: true,
        exitCode: null,
        error: null,
      };
    },
    [profilesById, cwd],
  );

  const addSession = useCallback(
    (profile: ShellProfile | undefined, cwdOverride?: string) => {
      if (!profile?.program) {
        setBootError('No usable shell profile was found. Check the terminal settings.');
        return;
      }
      setBootError(null);
      const instance = makeInstance(profile.id, cwdOverride);
      // With a pane already open, a new shell joins the existing split — the
      // same thing VS Code does when you press `+` with two terminals running.
      const active = stateRef.current.activeId;
      if (active) dispatch({ type: 'split', id: active, direction: 'column', instance });
      else dispatch({ type: 'add', instance });
      setFocusToken((n) => n + 1);
    },
    [makeInstance],
  );

  const closeSession = useCallback((id: string) => {
    const instance = stateRef.current.instances.find((i) => i.id === id);
    if (instance?.ptyId != null) {
      ptyToInstance.current.delete(instance.ptyId);
      void killPty(instance.ptyId).catch(() => {});
    }
    dispatch({ type: 'remove', id });
  }, []);

  const splitSession = useCallback(
    (id?: string, dir: SplitDirection = 'column') => {
      const target = id ?? stateRef.current.activeId;
      if (!target || !defaultProfile) {
        addSession(defaultProfile);
        return;
      }
      dispatch({
        type: 'split',
        id: target,
        direction: dir,
        instance: makeInstance(defaultProfile.id),
      });
      setFocusToken((n) => n + 1);
    },
    [addSession, defaultProfile, makeInstance],
  );

  const retargetProfile = useCallback(
    (profileId: string) => {
      const active = stateRef.current.instances.find((i) => i.id === stateRef.current.activeId);
      if (!active) return;
      // A live shell cannot be swapped in place, so the process is killed and
      // a fresh session takes its place in the layout.
      if (active.ptyId != null) {
        ptyToInstance.current.delete(active.ptyId);
        void killPty(active.ptyId).catch(() => {});
      }
      dispatch({ type: 'remove', id: active.id });
      dispatch({ type: 'add', instance: makeInstance(profileId) });
      setFocusToken((n) => n + 1);
    },
    [makeInstance],
  );

  // ---- backend events ------------------------------------------------------
  useEffect(
    () =>
      onPtyExit((e) => {
        const instanceId = ptyToInstance.current.get(e.id);
        ptyToInstance.current.delete(e.id);
        if (instanceId) dispatch({ type: 'exited', id: instanceId, code: e.code });
      }),
    [],
  );

  const handleReady = useCallback((id: string, ptyId: number) => {
    ptyToInstance.current.set(ptyId, id);
    dispatch({ type: 'pty-ready', id, ptyId });
  }, []);

  // Kill every PTY when the webview goes away, so no shell is orphaned.
  useEffect(
    () => () => {
      for (const instance of stateRef.current.instances) {
        if (instance.ptyId != null) void killPty(instance.ptyId).catch(() => {});
      }
      ptyToInstance.current.clear();
    },
    [],
  );

  // ---- host-driven actions -------------------------------------------------
  // The host decides *when* the panel is revealed and bumps `ensureToken` if it
  // is empty, so the first shell is created on the first reveal — nothing is
  // spawned just because the IDE launched.
  useEffect(() => {
    if (ensureToken === ensureSeen.current) return;
    ensureSeen.current = ensureToken;
    if (stateRef.current.instances.length > 0) return;
    addSession(defaultProfile);
  }, [ensureToken, defaultProfile, addSession]);

  useEffect(() => {
    if (spawnToken === spawnSeen.current) return;
    spawnSeen.current = spawnToken;
    addSession(defaultProfile);
  }, [spawnToken, defaultProfile, addSession]);

  useEffect(() => {
    if (splitToken === splitSeen.current) return;
    splitSeen.current = splitToken;
    const active = stateRef.current.activeId;
    if (!active || !defaultProfile) {
      addSession(defaultProfile);
      return;
    }
    dispatch({
      type: 'split',
      id: active,
      direction: directionRef.current,
      instance: makeInstance(defaultProfile.id),
    });
    setFocusToken((n) => n + 1);
  }, [splitToken, defaultProfile, makeInstance, addSession]);

  useEffect(() => {
    if (cycleToken === cycleSeen.current) return;
    cycleSeen.current = cycleToken;
    dispatch({ type: 'focus-sibling', delta: cycleDelta });
    setFocusToken((n) => n + 1);
  }, [cycleToken, cycleDelta]);

  // ---- host-requested command ----------------------------------------------
  // A pending run, cleared once its text has been written. Held in a ref rather
  // than state because nothing renders it, and a state write here would fight
  // the reducer for the same render pass.
  const pendingRun = useRef<{ text: string; cwd: string | undefined } | null>(null);
  const runSeen = useRef(0);

  useEffect(() => {
    // Only the token is the trigger. It starts at 0 on both sides, so the first
    // render is already a no-op without a separate "is there a command" guard —
    // and keeping the shape identical to the `spawnToken` effect above is what
    // lets the compiler prove this one is idempotent too.
    if (runCommandToken === runSeen.current) return;
    runSeen.current = runCommandToken;
    if (!runCommandText) return;
    pendingRun.current = { text: runCommandText, cwd: runCommandCwd };
    // Always a *new* pane: reusing the focused one would run the command in
    // whatever directory the user had `cd`'d to, which is the opposite of what
    // "run this in the new project" means.
    //
    // The dispatch payload is derived from props, which is what this rule
    // objects to. The session *is* the external system being updated here — the
    // shell and its PTY live outside React entirely, and the host's request is
    // the input signal. That makes this the "update an external system from an
    // effect" case the rule documents as intended, not the cascading-render case
    // it warns about. The token guard above is what makes it fire at most once
    // per request, exactly like the `spawnToken` / `ensureToken` /
    // `splitToken` effects.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    addSession(defaultProfile, runCommandCwd);
  }, [runCommandToken, runCommandText, runCommandCwd, defaultProfile, addSession]);

  // `spawnPty` is async, so the session exists one render before its PTY does.
  // Re-running on `state` is what closes that gap — `pty-ready` dispatches, this
  // effect observes, and the write happens the moment there is something to
  // write to. No timer, no polling, and a session that fails to spawn simply
  // never matches.
  useEffect(() => {
    const pending = pendingRun.current;
    if (!pending) return;
    const target = state.instances.find(
      (i) => i.ptyId != null && (!pending.cwd || i.cwd === pending.cwd),
    );
    if (!target || target.ptyId == null) return;
    pendingRun.current = null;
    // `\r` because a PTY is a raw stream, not a line editor: the shell will not
    // execute a line that was never submitted.
    void writePty(target.ptyId, `${pending.text}\r`).catch((e) => {
      onNoticeRef.current?.(ptyErrorText(e));
    });
  }, [state.instances]);

  // ---- derived -------------------------------------------------------------
  const activeInstance = state.instances.find((i) => i.id === state.activeId) ?? null;
  const activeProfile = activeInstance ? profilesById.get(activeInstance.profileId) : undefined;
  const panes = paneCount(state.root);
  const order = leafIds(state.root);
  const activeIndex = activeInstance ? order.indexOf(activeInstance.id) : -1;

  // ---- toolbar (published to the host header) ------------------------------
  // The stepper writes through the central settings store, so the value
  // survives a restart and shows up in the Settings Center as "modified".
  const fontSize = useFontSize();
  const cycleFont = useCallback(
    (delta: 1 | -1) => {
      const next = Math.min(
        FONT_MAX,
        Math.max(FONT_MIN, Math.round((fontSize.value + delta * FONT_STEP) * 10) / 10),
      );
      fontSize.set(next);
    },
    [fontSize],
  );

  // The toolbar is published as *props*, not as an element, and only the
  // element is created in the effect. Every entry in this list must be a
  // primitive or a referentially stable callback: the effect below calls
  // `setState`, so a dep that changes identity each render spins the
  // publish/render loop until React bails out with "Maximum update depth".
  const toolbarProps = useMemo(
    () => ({
      defaultProfile,
      profileCount: profiles.length,
      activeProfileName: activeProfile?.name ?? null,
      hasActive: !!activeInstance,
      hasSessions: state.instances.length > 0,
      sidebarOpen: state.sidebarOpen,
      settings,
      anchorRef: profileAnchorRef,
      splitDirection: direction,
      onOpenProfileMenu: () =>
        setProfileMenu((m) => (m ? null : profileMenuFor(profileAnchorRef))),
      onNew: () => addSession(defaultProfile),
      onSplit: () => {
        // Repeated clicks flip the split orientation, as in VS Code.
        const next: SplitDirection = direction === 'column' ? 'row' : 'column';
        setDirection(next);
        splitSession(undefined, next);
      },
      onKill: () => activeInstance && closeSession(activeInstance.id),
      onClear: () => setClearToken((n) => n + 1),
      onToggleSidebar: () => dispatch({ type: 'toggle-sidebar' }),
      onCycleFont: cycleFont,
    }),
    [
      defaultProfile,
      profiles.length,
      activeProfile?.name,
      activeInstance,
      state.instances.length,
      state.sidebarOpen,
      settings,
      direction,
      addSession,
      splitSession,
      closeSession,
      cycleFont,
    ],
  );

  useEffect(() => {
    onToolbar(<TerminalToolbar {...toolbarProps} />);
  }, [toolbarProps, onToolbar]);

  // Report the live session count so the host can tell whether revealing an
  // empty panel needs to seed a shell. A primitive dep, so this settles.
  useEffect(() => {
    onSessionCountChange(state.instances.length);
  }, [state.instances.length, onSessionCountChange]);

  const scrollToBottom = useCallback((id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-terminal-view="${id}"] .xterm-viewport`);
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-ide-bg">
      {bootError && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
          {bootError}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <TerminalLayout
            node={state.root}
            instances={state.instances}
            profilesById={profilesById}
            settings={settings}
            cwd={cwd}
            activeId={state.activeId}
            focusToken={focusToken}
            clearToken={clearToken}
            onFocus={(id) => dispatch({ type: 'focus', id })}
            onReady={handleReady}
            onSpawnFailed={(id, error) => dispatch({ type: 'spawn-failed', id, error })}
            onScrollChange={(id, bottom) => setAtBottom((prev) => ({ ...prev, [id]: bottom }))}
            onResize={(path, sizes) =>
              dispatch({ type: 'set-sizes', path, sizes: normalize(sizes) })
            }
            onSplit={() => splitSession()}
            onKill={() => activeInstance && closeSession(activeInstance.id)}
            onClear={() => setClearToken((n) => n + 1)}
            onOpenFile={onOpenFile}
            onNotice={onNotice}
          />

          {activeInstance && atBottom[activeInstance.id] === false && (
            <button
              onClick={() => scrollToBottom(activeInstance.id)}
              title="Scroll to the bottom"
              className="absolute bottom-3 right-4 flex items-center gap-1 rounded-full border border-ide-border bg-ide-raised/95 px-2.5 py-1 text-[10px] text-ide-muted shadow-lg backdrop-blur hover:border-ide-accent hover:text-ide-fg"
            >
              <Icon name="arrow-down" size={11} />
              Scroll to bottom
            </button>
          )}
        </div>

        {state.sidebarOpen && (
          <SessionSidebar
            instances={state.instances}
            profilesById={profilesById}
            activeId={state.activeId}
            onFocus={(id) => {
              dispatch({ type: 'focus', id });
              setFocusToken((n) => n + 1);
            }}
            onClose={closeSession}
            onSplit={splitSession}
            onRename={(id, name) => dispatch({ type: 'rename', id, name })}
            onSetColor={(id, color) => dispatch({ type: 'set-color', id, color })}
            onSetIcon={(id, icon: SessionIcon | null) => dispatch({ type: 'set-icon', id, icon })}
          />
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-ide-border-soft px-2.5 text-[10px] text-ide-faint">
        {activeInstance ? (
          <>
            <span className="truncate" title={activeInstance.cwd}>
              {activeInstance.cwd}
            </span>
            {activeInstance.exitCode !== null && (
              <span className={activeInstance.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>
                exit {activeInstance.exitCode}
              </span>
            )}
            {panes > 1 && (
              <span className="ml-auto shrink-0">
                pane {activeIndex + 1} of {panes}
              </span>
            )}
          </>
        ) : (
          <span>no active session</span>
        )}
      </div>

      {profileMenu && (
        <ShellProfileMenu
          profiles={profiles}
          defaultProfileId={defaultProfile?.id ?? ''}
          activeProfileId={activeInstance?.profileId ?? null}
          anchor={profileMenu}
          onSpawn={(profile) => addSession(profile)}
          onRetarget={(profile) => retargetProfile(profile.id)}
          onSetDefault={(id) => defaultProfileId.set(id)}
          onClose={() => setProfileMenu(null)}
        />
      )}
    </div>
  );
}

/** Anchor the profile popup to the toolbar button that opened it. */
function profileMenuFor(ref: React.RefObject<HTMLButtonElement | null>) {
  const box = ref.current?.getBoundingClientRect();
  if (!box) return { left: 8, bottom: 8 };
  return { left: box.left, bottom: window.innerHeight - box.top + 4 };
}

/** Guarantee a size vector sums to 1 so the flex percentages stay sane. */
function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes;
  return sizes.map((s) => s / total);
}
