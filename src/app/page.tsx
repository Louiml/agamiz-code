'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { diagTauriBridge, errText, isTauri, safeUnlisten } from './lib/tauri';
import FileExplorer from './components/FileExplorer';
import CodeEditor from './components/CodeEditor';
import TitleBar from './components/TitleBar';
import TerminalPanel from './components/terminal/TerminalPanel';
import CommandPalette, { Command } from './components/CommandPalette';
import QuickOpen from './components/QuickOpen';
import { TabBarWithMenu } from './components/TabContextMenu';
import type { Eol, Tab } from './features/tabs';
import {
  appendIfAbsent,
  closeAll,
  closeOthers,
  closeRight,
  closeTab,
  markSaved,
  markSavedAs,
  othersToClose,
  pickActiveTab,
  remapPath,
  remapPrefix,
  removePathUnder,
  rightToClose,
  tabForFile,
  tabForScratch,
  tabsUnder,
  tabsWithUnsavedChanges,
} from './features/tabs';
import { detectEol, restoreEol } from './features/eol';
import { Icon, IconName } from './components/Icon';
import SettingsCenter from './components/settings/SettingsCenter';
import { useResolvedSettings, useSettingsRuntime, useSettingsState } from './components/settings/useSettings';
import { getResolved, getValue } from './features/settings/store';
import { buildSession, joinPath, loadSession, restoreSession, saveSession } from './features/settings/workspace';
import { formatChord, matchesChord, resolveKeymap } from './features/settings/keymap';
import type { SettingsSection } from './features/settings/schema';
import Tutorial, { TourStep } from './components/Tutorial';
import DocsBrowser from './components/DocsBrowser';
import ActivityBar, { ActivityPanelId, ActivityItem } from './components/ActivityBar';
import ProblemsPanel from './components/features/ProblemsPanel';
import SourceControlPanel from './components/features/SourceControlPanel';
import RunDebugPanel from './components/features/RunDebugPanel';
import AIPanel from './components/features/AIPanel';
import { diagnosticStore } from './features/diag';
import { analyzeSource } from './features/analyzers';
import { detectLanguage, getLanguageName } from '../languages/registry';
import { activateExtensions } from '../extensions';
import { RAK_DEFAULT_CODE, RAK_EXTENSION } from '../extensions/rak/defaults';
import {
  useEditorRequests,
  useExtensionLogs,
  useExtensionNotices,
  useExtensions,
} from './features/extensions/useExtensions';
import { ext, type EditorRequest, type WorkspaceSnapshot } from './features/extensions/bridge';
import ExtensionsPanel from './components/features/ExtensionsPanel';
import MenuBar, { MenuGroup } from './components/layout/MenuBar';
import Breadcrumb from './components/layout/Breadcrumb';
import BottomPanel, { BottomTabId } from './components/layout/BottomPanel';
import StatusBar from './components/layout/StatusBar';
import WelcomeScreen from './components/layout/WelcomeScreen';
import DiagnosticsPanel from './components/layout/DiagnosticsPanel';
import GlobalSearch, { SearchableFile } from './components/layout/GlobalSearch';
import ExecutionControls from './components/layout/ExecutionControls';
import InterpreterPicker from './components/layout/InterpreterPicker';
import { executionService, ExecutionState, OutputLine } from './features/execution';
import {
  detectInterpreters,
  invalidateScan,
  InterpreterInfo,
  loadWorkspaceSettings,
  WorkspaceSettings,
} from './features/interpreter';
import { loadLaunchFile, LaunchFile } from './features/runconfigs';
import NewProjectDialog, { CreateProjectRequest, ProjectPathStatus } from './components/NewProjectDialog';
import { allProjectTemplates, type ProjectTemplate } from './features/projectTemplates';

export type { Tab };

interface ConsoleOutput {
  type: 'output' | 'error';
  content: string;
  timestamp: Date;
  /** Which execution phase produced the line, for build/debug colouring. */
  role?: 'build' | 'run' | 'debug';
}

type RunMode = 'interp' | 'vm' | 'bench';

interface Toast { id: number; message: string; type: 'success' | 'error' | 'info'; }

const DEFAULT_CODE = RAK_DEFAULT_CODE;

/** Last path segment, for user-facing messages. Tolerant of both separators. */
const basename = (p: string): string => p.split(/[\\/]/).pop() || p;

export default function IDE() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsSection | undefined>(undefined);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  // Default to `true` so the server-rendered and client first render match
  // (avoids hydration mismatch); reconcile to the real localStorage value
  // after mount.
  const [tutorialSeen, setTutorialSeen] = useState(true);
  useEffect(() => {
    setTutorialSeen(localStorage.getItem('agamiz.code.tutorialDone') === '1');
  }, []);
  const [tabs, setTabs] = useState<Tab[]>([]);
  /**
   * Always-current view of the tab set.
   *
   * Long-lived async callbacks (the agent's file-reload hook, the explorer's
   * delete handler) need to ask "is this buffer dirty *right now*?" without
   * being re-created on every keystroke, and a `useCallback` dep on `tabs`
   * would hand them a closure frozen at whatever the tab set was when the agent
   * run started. Reading the ref is the live answer.
   *
   * Synced in an effect rather than during render: writing `ref.current` while
   * rendering is a render-phase side effect, which concurrent rendering can
   * discard — leaking the discarded render's values into whatever reads the ref
   * next. An effect commits, so a cancelled render never reaches it.
   */
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [consoleOutput, setConsoleOutput] = useState<ConsoleOutput[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  // Settings live in a module-level layered store (defaults → user →
  // workspace) rather than in this component's state, so the theme bootstrap,
  // the global key handler, the terminal panel and the Settings Center all
  // read the same value. This hook boots the store, applies the palette to
  // `<html>`, and keeps the workspace layer pointed at the open folder.
  useSettingsRuntime(currentPath);
  // Subscribe, then read the *resolved* view (defaults ← user ← workspace) so
  // every consumer below sees workspace overrides applied.
  useSettingsState();
  const settingsState = useResolvedSettings();
  const [runMode, setRunMode] = useState<RunMode>(() => getValue<RunMode>('run.defaultRunMode'));
  /* --- Polyglot execution state -------------------------------------------
   * One execution store backs the header controls, the status-bar badge, the
   * editor gutter and the Run & Debug panel, so a single Run click updates
   * every surface instead of leaving them to disagree. */
  const [execution, setExecution] = useState<ExecutionState>(() => executionService.store.get());
  const [interpreters, setInterpreters] = useState<InterpreterInfo[]>([]);
  const [toolchainSettings, setToolchainSettings] = useState<WorkspaceSettings>({});
  const [interpreterPickerOpen, setInterpreterPickerOpen] = useState(false);
  const [launchFile, setLaunchFile] = useState<LaunchFile | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [bottomOpen, setBottomOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTabId>('terminal');
  const [terminalHeight, setTerminalHeight] = useState(220);
  /** Bumped by "New Terminal" so the terminal opens an extra session. */
  const [terminalSpawn, setTerminalSpawn] = useState(0);
  /** Bumped when the panel is revealed and the terminal list is empty. */
  const [terminalEnsure, setTerminalEnsure] = useState(0);
  /** Live session count, so revealing an empty panel seeds one shell. */
  const terminalCount = useRef(0);
  /** Mirror of `bottomOpen` for key handlers that must not close over state. */
  const bottomOpenRef = useRef(bottomOpen);
  useEffect(() => {
    bottomOpenRef.current = bottomOpen;
  }, [bottomOpen]);
  /** Bumped by Ctrl+Shift+5 / the toolbar to split the active pane. */
  const [terminalSplit, setTerminalSplit] = useState(0);
  /** Ctrl+PageUp / Ctrl+PageDown cycle the focused terminal session. */
  const [terminalCycle, setTerminalCycle] = useState<{ token: number; delta: 1 | -1 }>({
    token: 0,
    delta: 1,
  });
  /**
   * A command for the terminal to run in a fresh pane — the New Project wizard's
   * post-create `npm install`. Token-based like the other terminal actions so
   * running the same command twice is two runs, not one.
   */
  const [terminalCommand, setTerminalCommand] = useState<{
    token: number;
    text: string;
    cwd?: string;
  } | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  /** Height the panel returns to when it is un-maximized. */
  const panelRestoreHeight = useRef(220);
  const [panelMaximized, setPanelMaximized] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  /**
   * Toolbar published by `TerminalPanel` and rendered inside the bottom
   * panel's tab strip, so the terminal actions share one header row with the
   * panel tabs (the VS Code arrangement).
   */
  const [terminalToolbar, setTerminalToolbar] = useState<React.ReactNode>(null);
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [activity, setActivity] = useState<ActivityPanelId>('explorer');
  const [, forceDiag] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  /**
   * Line the editor should scroll to, driven by the terminal's "Open File at
   * Line". The token is what makes the request fire; the line alone would
   * re-trigger on unrelated re-renders.
   */
  const [revealLine, setRevealLine] = useState<{ line: number; token: number } | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const toastIdRef = useRef(0);
  const resizeRef = useRef<{ type: 'terminal' | 'sidebar'; startY: number; startH: number; startW: number; startX: number } | null>(null);

  // --- Recent projects (persisted in localStorage) ---
  // Initialize SSR-safe (empty) so the server-rendered HTML matches the first
  // client render (avoids the hydration mismatch/error at the count label);
  // reconcile to the real localStorage value after mount. The list is capped
  // on *read* by `general.recentProjectsLimit` so changing the limit prunes the
  // history immediately, without needing a rewrite of the stored array.
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const recentLimit = getValue<number>('general.recentProjectsLimit');
  useEffect(() => {
    try {
      const raw = localStorage.getItem('agamiz.code.recentProjects');
      if (raw) setRecentProjects(JSON.parse(raw));
    } catch { /* ignore corrupted data */ }
  }, []);

  /** The stored list, trimmed to the configured history limit. */
  const visibleRecentProjects = recentProjects.slice(0, Math.max(1, recentLimit));

  // Self-check the Tauri IPC bridge once on mount. Reports to console whether
  // __TAURI_INTERNALS__ exists — the key fact when EVERY invoke-based action
  // (title bar, New Window, Open Folder…) is dead but React still works.
  useEffect(() => {
    try {
      diagTauriBridge();
      if (!isTauri()) {
        console.warn('[tauri-bridge] Not running inside a Tauri webview — all Tauri IPC actions will be disabled.');
      }
    } catch { /* diagnostics are non-critical */ }
  }, []);

  const addRecentProject = useCallback((path: string) => {
    if (!path) return;
    const limit = Math.max(1, getValue<number>('general.recentProjectsLimit'));
    setRecentProjects(prev => {
      const next = [path, ...prev.filter(p => p !== path)].slice(0, limit);
      try { localStorage.setItem('agamiz.code.recentProjects', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const clearRecentProjects = useCallback(() => {
    setRecentProjects([]);
    try { localStorage.removeItem('agamiz.code.recentProjects'); } catch {}
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = toastIdRef.current++;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  // --- Lua extension host -------------------------------------------------
  // One instance, owned here: the Extensions panel, the command palette and
  // the status bar all read from this single subscription rather than each
  // opening their own listener to the host's push channels.
  const extHost = useExtensions();

  /** Apply an `agamiz.editor.*` mutation to the active tab. */
  const applyEditorRequest = useCallback((request: EditorRequest) => {
    // `openBuffer` is not a mutation of the active tab — it creates a new
    // untitled one — so it is handled before the active-tab lookup, which would
    // otherwise no-op whenever no editor is open.
    if (request.action === 'openBuffer') {
      // Mirrors `handleNewScratchFile`: `path: ''` marks the buffer as having no
      // file on disk, which is what keeps it out of the persisted session and
      // routes Ctrl+S to Save As.
      const id = `ext_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setTabs(prev => [...prev, {
        id,
        name: request.name || 'untitled',
        path: '',
        content: request.text,
        isDirty: false,
      }]);
      setActiveTabId(id);
      setWorkspaceOpen(true);
      return;
    }

    setTabs(prev => {
      if (!activeTabId) return prev;
      return prev.map(t => {
        if (t.id !== activeTabId) return t;

        if (request.action === 'setText') {
          return { ...t, content: request.text, isDirty: t.content !== request.text };
        }

        const lines = t.content.split('\n');
        if (request.action === 'insert') {
          const line = Math.min(request.line ?? 0, Math.max(0, lines.length - 1));
          const current = lines[line] ?? '';
          // Offsets are counted in characters, not UTF-16 units, so a line
          // with astral-plane characters is not split mid-surrogate.
          const chars = [...current];
          const at = Math.min(request.character ?? 0, chars.length);
          chars.splice(at, 0, ...request.text.split('\n'));
          const next = [...lines];
          next[line] = chars.join('');
          const content = next.join('\n');
          return { ...t, content, isDirty: t.content !== content };
        }

        // replaceSelection: fall back to appending when there is no selection,
        // which is friendlier than silently doing nothing.
        const content = t.content + request.text;
        return { ...t, content, isDirty: t.content !== content };
      });
    });
  }, [activeTabId]);

  useExtensionNotices(useCallback((notice) => {
    showToast(
      notice.extensionId ? `${notice.extensionId}: ${notice.message}` : notice.message,
      notice.level === 'success' ? 'success' : notice.level === 'error' ? 'error' : 'info',
    );
  }, [showToast]));

  useExtensionLogs(useCallback((line) => {
    const text = line.extensionId ? `[${line.extensionId}] ${line.text}` : line.text;
    setConsoleOutput(prev => [...prev, {
      type: line.level === 'error' ? 'error' : 'output',
      content: text,
      timestamp: new Date(),
    }]);
  }, []));

  useEditorRequests(applyEditorRequest);

  /**
   * Mirror the open buffer into the host.
   *
   * This is what makes `agamiz.editor.get_active_text()` a synchronous read in
   * Lua instead of a blocking IPC round-trip from inside a callback — see the
   * ownership note in `src-tauri/src/ext/mod.rs`.
   *
   * Debounced because the dependency is the buffer *text*, so an undebounced
   * version would fire an IPC round-trip on every keystroke. The trailing edge
   * is what matters: the mirror must be current when a command runs, not during
   * typing.
   */
  useEffect(() => {
    const push = () => {
      if (!activeTab) {
        void ext.syncWorkspace({
          root: currentPath,
          active_path: '',
          active_text: '',
          cursor: { line: 0, character: 0 },
          language_id: '',
        } satisfies WorkspaceSnapshot).catch(() => {});
        return;
      }
      const languageId = detectLanguage(activeTab.path || activeTab.name) ?? 'plaintext';
      void ext.syncWorkspace({
        root: currentPath,
        active_path: activeTab.path,
        active_text: activeTab.content,
        cursor: { line: cursorPos.line - 1, character: cursorPos.col - 1 },
        language_id: languageId,
      } satisfies WorkspaceSnapshot).catch(() => {});
    };

    const timer = setTimeout(push, 150);
    return () => clearTimeout(timer);
  }, [activeTab?.id, activeTab?.content, activeTab?.path, currentPath, cursorPos.line, cursorPos.col]);

  // --- Diagnostics: analyze the active buffer into the shared store ---
  useEffect(() => {
    if (!activeTab?.path) return;
    const path = activeTab.path;
    const lang = detectLanguage(path) ?? 'plaintext';
    diagnosticStore.set(path, analyzeSource({ path, text: activeTab.content, languageId: lang }));
    return () => { diagnosticStore.remove(path); };
  }, [activeTab?.id, activeTab?.content, activeTab?.path]);

  // Re-render badges when diagnostic counts change.
  useEffect(() => {
    return diagnosticStore.onDidChangeCounts(() => forceDiag(x => x + 1));
  }, []);

  const diagCounts = diagnosticStore.counts();
  const problemsBadge = (diagCounts.error + diagCounts.warning) || undefined;

  const selectActivity = useCallback((id: ActivityPanelId) => {
    setActivity(id);
    setSidebarOpen(id !== 'none');
  }, []);

  /** Open the Settings Center on a specific category. */
  const openSettings = useCallback((category?: SettingsSection) => {
    setSettingsCategory(category);
    setSettingsOpen(true);
  }, []);

  const activityItems: ActivityItem[] = [
    { id: 'explorer', icon: 'folder', title: 'Explorer (Ctrl+B)' },
    { id: 'search', icon: 'search', title: 'Search (Global)' },
    { id: 'scm', icon: 'git-branch', title: 'Source Control' },
    { id: 'run', icon: 'play', title: 'Run & Debug' },
    { id: 'ai', icon: 'sparkles', title: 'AI Assistant' },
    { id: 'extensions', icon: 'extensions', title: 'Extensions' },
  ];

  // The Rak output/done channels are subscribed by `executionService`, which
  // forwards them into the same `onOutput` hook as every other language. A
  // second listener here would append each line twice.

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [consoleOutput]);

  // Boot the bundled extensions (registers built-in + Rak languages) once.
  useEffect(() => { activateExtensions(); }, []);

  // Auto-start the first-run tutorial when the user enters the workspace.
  useEffect(() => {
    if (workspaceOpen && !tutorialSeen) {
      setTutorialOpen(true);
      localStorage.setItem('agamiz.code.tutorialDone', '1');
    }
  }, [workspaceOpen, tutorialSeen]);

  // Best-effort: push a path into the OS "Recent" list so it shows in the
  // Windows taskbar jump list. Non-critical, but we log failures because a
  // broken bridge here is a root-cause signal for the empty jump list.
  const addToOsRecent = useCallback((path: string) => {
    if (!path) return;
    invoke('add_recent', { path }).catch((e) => {
      console.error('[add_recent] invoke failed:', errText(e));
    });
  }, []);

  /**
   * Refuse to switch away from a workspace holding unsaved work.
   *
   * Anything that clears the tab set is fine for *saved* buffers — those files
   * are still on disk and reachable from the explorer — but a dirty buffer
   * exists nowhere else, so it asks first. `target` names the action in the
   * prompt so the message matches what the user actually clicked.
   */
  const confirmDiscardDirtyTabs = useCallback((target: string): boolean => {
    const dirty = tabsWithUnsavedChanges(tabs);
    if (dirty.length === 0) return true;
    const names = dirty.map((t) => t.name).join(', ');
    return confirm(
      `${target} will close the current workspace and discard unsaved changes in:\n\n${names}\n\nContinue?`,
    );
  }, [tabs]);

  /**
   * Point the shell at a workspace root. Every path into a workspace — the
   * folder dialog, a recent-project click, and the startup restore — funnels
   * through here so the folder, the tab set, the recents list and the
   * `.agamiz/settings.json` overlay stay consistent with one another.
   *
   * The unsaved-work guard lives *here* rather than at the individual call
   * sites: this function clears the tab set, so any route that reaches it with
   * a dirty buffer would destroy a buffer that exists nowhere else. It used to
   * be wired only into the New Project path, leaving File ▸ Open Folder and
   * every recent-project click unguarded.
   *
   * Returns false when the user declined, so callers can skip their success
   * toast instead of claiming a workspace opened that did not. New Project
   * passes `confirmDirty: false` because it has already asked *before* writing
   * any files to disk.
   */
  const applyWorkspace = useCallback((
    path: string,
    options: { trackRecent?: boolean; confirmDirty?: boolean } = {},
  ): boolean => {
    if (options.confirmDirty !== false && !confirmDiscardDirtyTabs('Opening a folder')) return false;
    setCurrentPath(path);
    // Tell the backend which folder the renderer is allowed to touch. Every
    // path-taking command is confined to this root (plus the config dir and
    // anything a native dialog returned), which is what stops a compromised or
    // buggy extension from reading or writing the rest of the disk.
    void invoke('register_workspace_root', { path }).catch((e) => {
      showToast(`Could not open ${basename(path)} as a workspace: ${errText(e)}`, 'error');
    });
    setWorkspaceOpen(true);
    setTabs([]);
    setActiveTabId(null);
    if (options.trackRecent !== false) {
      addRecentProject(path);
      addToOsRecent(path);
    }
    return true;
  }, [addRecentProject, addToOsRecent, confirmDiscardDirtyTabs, showToast]);

  const handleOpenFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Open Workspace Folder' });
      if (typeof selected === 'string' && selected) {
        // `applyWorkspace` returns false when the unsaved-work prompt is
        // declined, so the toast only fires for a workspace that really opened.
        if (applyWorkspace(selected)) showToast('Workspace opened', 'info');
      }
    } catch (e) {
      console.error('[open-dialog] failed:', e);
      showToast(`Could not open folder: ${errText(e)}`, 'error');
    }
  }, [applyWorkspace, showToast]);

  /**
   * Open another IDE window.
   *
   * The previous version toasted "Opened a new window" the moment `invoke`
   * resolved, and `invoke` resolves as soon as the *window* is created — long
   * before its webview has loaded anything. So every failure mode (ACL reject,
   * webview creation failure, dev server unreachable) produced a cheerful
   * success message sitting on top of a dead or blank window, which is exactly
   * why this feature was so hard to diagnose from the outside.
   *
   * Building a window also takes a noticeable moment (it spins up a whole new
   * webview), so the button says so rather than appearing to do nothing.
   */
  const [openingWindow, setOpeningWindow] = useState(false);
  const handleNewWindow = useCallback(() => {
    if (openingWindow) return;
    setOpeningWindow(true);
    showToast('Opening a new window…', 'info');
    invoke<string>('new_window')
      .then((label) => {
        console.log(`[new_window] created ${label}`);
        showToast(`Opened ${label}`, 'success');
      })
      .catch((e) => {
        console.error('[new_window] invoke failed:', e);
        showToast(`Could not open a new window: ${errText(e)}`, 'error');
      })
      .finally(() => setOpeningWindow(false));
  }, [openingWindow, showToast]);

  // Thumbnail-toolbar actions arrive from the Rust side (Win32 ITaskbarList3
  // buttons on the taskbar hover preview). "Open Folder" re-runs the exact
  // same flow as the in-app button; a latest-ref keeps the subscription to
  // exactly one, always-current handler.
  const openFolderRef = useRef(handleOpenFolder);
  useEffect(() => {
    openFolderRef.current = handleOpenFolder;
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    listen('thumbbar://open-folder', () => openFolderRef.current()).then((f) => {
      // `safeUnlisten` because Tauri's unlisten path throws if the matching
      // `listen` registration has not been evaluated in this webview yet,
      // which window creation's main-thread stall can cause.
      if (disposed) safeUnlisten(f);
      else unlisten = f;
    });
    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  }, []);

  const openProject = (p: string) => {
    applyWorkspace(p);
  };

  /* ---------------------------------------------------------------- */
  /* Workspace session — write a snapshot, and replay it on launch.     */
  /* ---------------------------------------------------------------- */

  /** Refs mirror the values the snapshot needs, so the debounced writer does
   *  not have to be re-created on every keystroke in the editor. */
  const sessionRefs = useRef({ tabs, currentPath, activeTabId, sidebarOpen, sidebarWidth, activity, bottomOpen, bottomTab, terminalHeight });
  sessionRefs.current = { tabs, currentPath, activeTabId, sidebarOpen, sidebarWidth, activity, bottomOpen, bottomTab, terminalHeight };

  // Persist the session whenever it meaningfully changes. The 400ms debounce
  // keeps a burst of typing or a sidebar drag from issuing a file write per
  // frame; `saveSession` swallows its own failures so this is safe to leave
  // unguarded.
  useEffect(() => {
    if (!currentPath) return;
    const t = setTimeout(() => {
      const s = sessionRefs.current;
      const active = s.tabs.find((tab) => tab.id === s.activeTabId);
      void saveSession(buildSession({
        folder: s.currentPath,
        // Paths only — buffer *content* is deliberately not persisted, so a
        // crash can never corrupt a file on disk.
        tabs: s.tabs.filter((tab) => tab.path).map((tab) => ({ path: tab.path, name: tab.name })),
        activeTabPath: active?.path ?? null,
        layout: {
          sidebarOpen: s.sidebarOpen,
          activity: s.activity,
          sidebarWidth: s.sidebarWidth,
          panelOpen: s.bottomOpen,
          bottomTab: s.bottomTab,
          panelHeight: s.terminalHeight,
        },
      }));
    }, 400);
    return () => clearTimeout(t);
  }, [tabs, currentPath, activeTabId, sidebarOpen, sidebarWidth, activity, bottomOpen, bottomTab, terminalHeight]);

  // Replay the last session once, after the settings store has hydrated — the
  // restore decision depends on `restoreLastWorkspace` / `reopenClosedEditors`,
  // and reading them before hydration would use whatever the localStorage
  // mirror happened to hold.
  const hydrated = useSettingsState().hydrated;
  const restoreAttempted = useRef(false);
  useEffect(() => {
    if (!hydrated || restoreAttempted.current) return;
    restoreAttempted.current = true;

    void (async () => {
      // With a remembered default folder and no explicit preference to restore,
      // the user asked for *that* folder to be the one that opens.
      const general = getResolved().general;
      if (!general.restoreLastWorkspace && general.defaultWorkspaceFolder) {
        applyWorkspace(general.defaultWorkspaceFolder, { trackRecent: false });
        return;
      }

      const session = await loadSession();
      if (!session) return;

      const outcome = await restoreSession(session, { general }, {
        openFolder: (folder) => applyWorkspace(folder, { trackRecent: false }),
        openFile: async (path, name) => {
          const content = await invoke('read_file', { path }) as string;
          setTabs((prev) => (prev.some((t) => t.path === path) ? prev : [...prev, { id: path, name, path, content, isDirty: false }]));
        },
        applyLayout: (layout) => {
          setSidebarOpen(layout.sidebarOpen);
          setSidebarWidth(layout.sidebarWidth);
          setActivity(layout.activity as ActivityPanelId);
          setBottomOpen(layout.panelOpen);
          setBottomTab(layout.bottomTab as BottomTabId);
          setTerminalHeight(layout.panelHeight);
        },
      });

      if (!outcome.restored) return;
      if (outcome.activeTabPath) setActiveTabId(outcome.activeTabPath);
      const skippedNote = outcome.skipped.length
        ? ` · ${outcome.skipped.length} file${outcome.skipped.length === 1 ? '' : 's'} could not be reopened`
        : '';
      showToast(`Restored ${outcome.folder.split(/[\\/]/).pop()} · ${outcome.tabsOpened}/${outcome.tabsRequested} editors${skippedNote}`, 'info');
    })();
  }, [hydrated, applyWorkspace, showToast]);

  const handleNewScratchFile = useCallback(() => {
    // The random suffix keeps two scratch files opened in the same millisecond
    // — a double-Enter in the palette, or a bundled extension calling
    // `openBuffer` alongside the user — from colliding on one tab id.
    const id = `scratch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setTabs(prev => [...prev, tabForScratch({ id, name: `untitled.${RAK_EXTENSION}`, content: DEFAULT_CODE })]);
    setActiveTabId(id);
    // Starting a scratch buffer from the welcome/landing page must enter the
    // editor view; without this the tab was created invisibly and the button
    // appeared dead.
    setWorkspaceOpen(true);
  }, []);

  /* New Project lives below `handleFileSelect`, which it opens the entry tab with. */

  const handleNewFile = useCallback(async () => {
    if (!currentPath) { handleNewScratchFile(); return; }
    const name = prompt('File name:', `untitled.${RAK_EXTENSION}`);
    if (!name) return;
    const path = joinPath(currentPath, name);
    try {
      await invoke('create_file', { path });
      // A brand-new file has no line endings of its own yet, so it inherits the
      // platform default and stays LF in memory.
      setTabs(prev => [...prev, tabForFile({ path, name, content: '', eol: '\n' })]);
      setActiveTabId(path);
      showToast(`Created ${name}`, 'success');
    } catch (e) { showToast(`Error: ${errText(e)}`, 'error'); }
  }, [currentPath, handleNewScratchFile, showToast]);

  const updateTabContent = (id: string, content: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, content, isDirty: t.content !== content } : t));
  };

  const handleFileSelect = async (path: string, name: string, line?: number) => {
    const existing = tabs.find(t => t.path === path);
    if (existing) {
      setActiveTabId(existing.id);
      // Re-reveal even for an already-open file, so "Open File at Line" lands
      // on the right line instead of leaving the viewport where it was.
      if (line !== undefined) setRevealLine((r) => ({ line, token: (r?.token ?? 0) + 1 }));
      return;
    }
    try {
      const content = await invoke('read_file', { path }) as string;
      // The existence test above reads the render-time `tabs`, and `read_file`
      // is a round-trip — so two rapid opens of the same file both saw "not
      // open" and both appended, producing duplicate ids, a React key warning,
      // and a close that removed both. Re-test against live state on commit.
      const tab = tabForFile({ path, name, content, eol: detectEol(content) });
      setTabs(prev => appendIfAbsent(prev, tab));
      // Safe to do unconditionally: if the dedupe dropped the append because
      // the file was already open, focusing and revealing it is still correct.
      setActiveTabId(path);
      if (line !== undefined) setRevealLine((r) => ({ line, token: (r?.token ?? 0) + 1 }));
    } catch (e) { showToast(`Error: ${errText(e)}`, 'error'); }
  };

  /* ---------------------------------------------------------------- */
  /* New Project — scaffold a template onto disk and open it.          */
  /* ---------------------------------------------------------------- */

  /** Built-ins first, then anything an extension registered. */
  const projectTemplates = useMemo(
    () => allProjectTemplates(extHost.projectTemplates),
    [extHost.projectTemplates],
  );

  /**
   * Where the wizard should pre-fill its Location field.
   *
   * The current workspace's *parent*, so a second project lands beside the first
   * rather than nested inside it. With no workspace open there is no useful
   * parent to infer, so it falls back to `~/AgamizCode`.
   */
  const defaultProjectLocation = useCallback(async (): Promise<string> => {
    if (currentPath) {
      const parent = currentPath.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join('\\');
      // A drive root (`C:\`) has no parent to speak of; the profile folder is a
      // better guess than the bare drive letter.
      if (parent && !/[A-Za-z]:$/.test(parent)) return parent;
    }
    try {
      const home = await invoke<string>('home_dir');
      return `${home}\\AgamizCode`;
    } catch {
      return '.';
    }
  }, [currentPath]);

  const [projectLocation, setProjectLocation] = useState('');

  const openNewProject = useCallback(async () => {
    if (newProjectOpen) return;
    // Resolve the default before showing the dialog so the field is populated on
    // first paint rather than popping in a frame later.
    setProjectLocation(await defaultProjectLocation());
    setNewProjectOpen(true);
  }, [defaultProjectLocation, newProjectOpen]);

  /**
   * Ask the host which of a template's paths already exist under `root`.
   *
   * Takes the *materialized* template, not the raw one: a template is free to
   * put `\${PROJECT_NAME}` in a path, and checking the unsubstituted literal
   * would inspect a path that is never written — reporting no collision for a
   * file that is about to be clobbered.
   */
  const inspectProject = useCallback(
    async (root: string, template: ProjectTemplate): Promise<ProjectPathStatus[]> => {
      try {
        return await invoke<ProjectPathStatus[]>('inspect_project', {
          root,
          files: template.files.map((f) => ({ path: f.path, content: '' })),
        });
      } catch (e) {
        // A failed inspection must not block creation — the worst case is that
        // the user is not warned and `create_project` reports the collision
        // itself.
        showToast(`Could not check for existing files: ${errText(e)}`, 'info');
        return [];
      }
    },
    [showToast],
  );

  const handleCreateProject = useCallback(
    async (request: CreateProjectRequest) => {
      const { template, root, projectName, runInstall, overwrite } = request;
      const install = runInstall ? template.installCommand : null;

      // Ask *before* anything is written to disk. `applyWorkspace` has its own
      // guard, but reaching it would mean the project already exists on disk
      // while the user is being asked whether they wanted to throw it away.
      if (!confirmDiscardDirtyTabs('Creating a project')) {
        throw new Error('Cancelled — the current workspace has unsaved changes.');
      }

      try {
        await invoke('create_project', {
          root,
          files: template.files.map((f) => ({ path: f.path, content: f.content })),
          overwrite,
        });
      } catch (e) {
        const message = errText(e);
        showToast(`Could not create the project: ${message}`, 'error');
        throw new Error(message);
      }

      // Point the shell at the new folder. `applyWorkspace` also adds it to the
      // recents list, so a project made here is reopenable from the welcome
      // screen exactly like one opened from disk. The dirty prompt already ran
      // above, before `create_project`, so don't ask a second time.
      applyWorkspace(root, { confirmDirty: false });
      setNewProjectOpen(false);

      // An extension template may need a real generator. It runs *after* the
      // files exist and *after* the workspace switch, because `createCommand` is
      // confined to the workspace root — which only points at the new project
      // once the switch has happened.
      let generatorFailed = false;
      if (template.createCommand) {
        try {
          await ext.runCommand(template.createCommand, [root, projectName]);
        } catch (e) {
          generatorFailed = true;
          showToast(
            `${template.name}: the project generator failed — ${errText(e)}. The files it declared were still written.`,
            'error',
          );
        }
      }

      if (template.entryFile) {
        const relative = template.entryFile.replace(/\//g, '\\');
        const entry = `${root}\\${relative}`;
        // A generator-owned `entryFile` only exists if the generator succeeded.
        // Opening it blindly would surface a raw "file not found" read error,
        // which says nothing about the cause, so the failure is reported in
        // terms the user can act on and the workspace is left as it is.
        const ownedByGenerator = template.declaredOutputs.includes(template.entryFile);
        if (ownedByGenerator && generatorFailed) {
          showToast(`${template.entryFile} was not created — the generator did not finish.`, 'error');
        } else {
          await handleFileSelect(entry, relative.split('\\').pop() || template.entryFile);
        }
      }

      showToast(`Created ${projectName}`, 'success');

      if (install) {
        // Reveal the terminal and hand the command over. Bumping `ensureToken`
        // when the panel is empty guarantees a session exists to receive it.
        setBottomTab('terminal');
        setBottomOpen(true);
        if (terminalCount.current === 0) setTerminalEnsure((n) => n + 1);
        setTerminalCommand((prev) => ({ token: (prev?.token ?? 0) + 1, text: install, cwd: root }));
      }
    },
    // `handleFileSelect` is a plain function, so it is re-created every render
    // and this callback inherits that churn. Harmless: the dialog only reads it
    // when the user clicks, and it is not a dependency of any memoised child.
    [tabs, confirmDiscardDirtyTabs, applyWorkspace, showToast, handleFileSelect],
  );

  /**
   * Open a path captured from the terminal, resolving it against the workspace
   * and resolving its basename for the tab title.
   */
  const handleOpenFromTerminal = useCallback(
    async (path: string, line?: number) => {
      const normalized = path.replace(/\//g, '\\');
      const name = normalized.split('\\').pop() || normalized;
      await handleFileSelect(normalized, name, line);
    },
    [handleFileSelect],
  );

  /**
   * Reload an agent-written file into its open (clean) tab so the editor
   * reflects on-disk changes made by the AI agent. Dirty buffers are kept and
   * the user is notified instead of overwritten.
   *
   * The dirty test has to happen against live state at *commit* time, not
   * against the `tabs` captured when the event fired. `read_file` is an async
   * round-trip and the agent loop can run for minutes, so a keystroke landing
   * during that window left the tab dirty while this closure still believed it
   * was clean — the resolution then replaced the buffer with the on-disk text
   * and marked it saved. The user's edit was gone, with no undo and no prompt.
   */
  const handleAgentFileChanged = useCallback((path: string) => {
    if (!tabsRef.current.some(t => t.path === path)) return;
    invoke<string>('read_file', { path })
      .then(content => {
        let kept = false;
        setTabs(prev => prev.map(t => {
          if (t.path !== path) return t;
          if (t.isDirty) { kept = true; return t; }
          return { ...t, content, isDirty: false, eol: t.eol ?? detectEol(content) };
        }));
        if (kept) {
          const name = path.split(/[\\/]/).pop() || path;
          showToast(`${name} changed on disk — your unsaved buffer was kept`, 'info');
        }
      })
      .catch(() => {});
  }, [showToast]);

  /**
   * A file or folder moved in the explorer.
   *
   * Tabs are keyed by path (`id === path`), so without this the tab keeps the
   * old location and Ctrl+S writes a *new* file there — the user sees the
   * rename appear to have been undone, and ends up with two copies. A
   * directory move has to remap every open tab underneath it.
   */
  const handleExplorerPathChanged = useCallback((from: string, to: string, isDir: boolean) => {
    setTabs(prev => (isDir ? remapPrefix(prev, from, to) : remapPath(prev, from, to)));
    setActiveTabId(prev => (prev === from ? to : prev));
  }, []);

  /**
   * A file or folder was deleted.
   *
   * A tab whose file is gone is not merely stale: saving it would recreate the
   * file, and closing it would prompt about content the user can no longer
   * reconcile with disk. Dirty buffers under a deleted tree are asked about
   * first, because their contents may exist nowhere else.
   */
  const handleExplorerPathRemoved = useCallback((path: string, isDir: boolean) => {
    const doomed = tabsUnder(tabsRef.current, path, isDir);
    if (doomed.length === 0) return;
    const dirty = tabsWithUnsavedChanges(doomed);
    if (dirty.length > 0) {
      const names = dirty.map(t => t.name).join(', ');
      if (!confirm(`${basename(path)} was deleted, but these tabs have unsaved changes:\n\n${names}\n\nClose them anyway?`)) return;
    }
    setTabs(prev => {
      const survivors = removePathUnder(prev, path, isDir);
      // Re-filter against live state rather than the snapshot the prompt used:
      // a tab opened while the confirm was up must not be silently closed.
      setActiveTabId(pickActiveTab(survivors, activeTabId));
      return survivors;
    });
  }, [activeTabId]);

  const handleTabClose = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id);
    if (tab?.isDirty && !confirm(`Close ${tab.name} without saving?`)) return;
    setTabs(prev => {
      const { tabs: next, activeTabId: nextActive } = closeTab(prev, activeTabId, id);
      setActiveTabId(nextActive);
      return next;
    });
  }, [tabs, activeTabId]);

  /**
   * Confirm before a bulk close destroys unsaved work.
   *
   * `othersToClose`/`rightToClose` report exactly the tabs the operation is
   * about to drop, so the prompt names them instead of counting blindly.
   */
  const confirmBulkClose = useCallback((doomed: Tab[], verb: string): boolean => {
    const dirty = tabsWithUnsavedChanges(doomed);
    if (dirty.length === 0) return true;
    const names = dirty.map(t => t.name).join(', ');
    return confirm(`${verb} will discard unsaved changes in:\n\n${names}\n\nContinue?`);
  }, []);

  const handleCloseOthers = useCallback((id: string) => {
    if (!confirmBulkClose(othersToClose(tabs, id), 'Closing the other tabs')) return;
    setTabs(prev => {
      const { tabs: next, activeTabId: nextActive } = closeOthers(prev, activeTabId, id);
      setActiveTabId(nextActive);
      return next;
    });
  }, [tabs, activeTabId, confirmBulkClose]);

  const handleCloseRight = useCallback((id: string) => {
    if (!confirmBulkClose(rightToClose(tabs, id), 'Closing the tabs to the right')) return;
    setTabs(prev => {
      const { tabs: next, activeTabId: nextActive } = closeRight(prev, activeTabId, id);
      setActiveTabId(nextActive);
      return next;
    });
  }, [tabs, activeTabId, confirmBulkClose]);

  const handleCloseAll = useCallback(() => {
    if (!confirmBulkClose(tabs, 'Closing every tab')) return;
    setTabs(closeAll().tabs);
    setActiveTabId(null);
  }, [tabs, confirmBulkClose]);

  /**
   * Write the active buffer.
   *
   * Two subtleties, both of which used to lose data:
   *
   *  - The buffer is LF-only in memory (the textarea normalizes CRLF, and
   *    `eol.ts` normalizes on load), so the file's own line ending is restored
   *    here. Otherwise a single-character edit rewrote every line ending and
   *    destroyed the whole-file diff.
   *  - `save_file` is an async round-trip. Anything typed while it is in flight
   *    made the tab dirty again, so the flag is only cleared when the tab still
   *    holds the exact bytes we wrote.
   */
  const handleSave = useCallback(async () => {
    if (!activeTab) return;
    const content = activeTab.content;
    const eol: Eol = activeTab.eol ?? '\n';

    if (!activeTab.path) {
      // A scratch buffer from the welcome screen has no workspace to save into.
      // Building `${currentPath}/${name}` there yields "/name", which the
      // backend resolves against the current drive — so ask for a location.
      if (!currentPath) {
        try {
          const selected = await open({
            directory: true, multiple: false, title: 'Save Scratch File As',
          });
          if (typeof selected !== 'string' || !selected) return;
          // A folder the user picked in a native dialog is a deliberate
          // destination, so it joins the backend's allow-list.
          void invoke('register_allowed_root', { path: selected }).catch(() => {});
          const name = prompt('File name:', activeTab.name);
          if (!name) return;
          const path = joinPath(selected, name);
          await invoke('save_file', { path, content: restoreEol(content, eol) });
          setTabs(prev => markSavedAs(prev, activeTab.id, { id: path, name, path, eol }));
          showToast('Saved', 'success');
        } catch (e) { showToast(`Save error: ${errText(e)}`, 'error'); }
        return;
      }
      const name = prompt('Save as:', activeTab.name);
      if (!name) return;
      const path = joinPath(currentPath, name);
      try {
        await invoke('save_file', { path, content: restoreEol(content, eol) });
        setTabs(prev => markSavedAs(prev, activeTab.id, { id: path, name, path, eol }));
        showToast('Saved', 'success');
      } catch (e) { showToast(`Save error: ${errText(e)}`, 'error'); }
      return;
    }
    try {
      await invoke('save_file', { path: activeTab.path, content: restoreEol(content, eol) });
      setTabs(prev => markSaved(prev, activeTab.id, content));
      // Extensions with `workspace:read` get `on_did_save_file`, and
      // `onLanguage:` activation is retried on open so a lazy extension that
      // only declares a language event still starts.
      void ext.notifySave(activeTab.path).catch(() => {});
      showToast('Saved', 'success');
    } catch (e) { showToast(`Save error: ${errText(e)}`, 'error'); }
  }, [activeTab, currentPath, showToast]);

  // Lazily activate extensions whose `activationEvents` name the active
  // language. The host owns the matching, so this only has to name the event.
  useEffect(() => {
    if (!activeTab) return;
    const languageId = detectLanguage(activeTab.path || activeTab.name);
    if (!languageId) return;
    void ext.activateFor(`onLanguage:${languageId}`).catch(() => {});
  }, [activeTab?.id, activeTab?.path, activeTab?.name]);

  /* --- Polyglot execution wiring --------------------------------------- */

  const activeLanguage = useMemo(
    () => detectLanguage(activeTab?.path || activeTab?.name) ?? '',
    [activeTab?.path, activeTab?.name],
  );

  /** True only for the native Rak runtime, which owns interp/VM/bench modes. */
  const isRakFile = activeTab?.name?.endsWith(RAK_EXTENSION) ?? false;

  // The executer pushes output and state outward rather than owning them, so
  // the bottom Output panel and the side panel stay in sync with one buffer.
  useEffect(() => {
    executionService.onOutput = (line: OutputLine) => {
      setConsoleOutput((prev) => [
        ...prev,
        {
          type: line.stream === 'stderr' || line.stream === 'error' ? 'error' : 'output',
          content: line.text,
          timestamp: new Date(),
          role: line.role,
        },
      ]);
    };
    executionService.onNotice = (text, kind) => showToast(text, kind);
    executionService.onFinished = () => {
      setIsRunning(false);
      // Reveal where the output landed, but only if the user is not already
      // looking at another panel they deliberately selected.
      if (sessionRefs.current.bottomTab !== 'output') {
        setBottomTab('output');
        setBottomOpen(true);
      }
    };
    executionService.onPaused = (location) => {
      if (!location?.file) return;
      // Bring the paused file forward so the highlighted line is on screen.
      if (sessionRefs.current.tabs.some((t) => t.path === location.file)) {
        setActiveTabId(location.file);
        return;
      }
      invoke<string>('read_file', { path: location.file })
        .then((content) => {
          const name = location.file.split(/[\\/]/).pop() ?? location.file;
          setTabs((prev) =>
            prev.some((t) => t.path === location.file)
              ? prev
              : [...prev, { id: location.file, name, path: location.file, content, isDirty: false }],
          );
          setActiveTabId(location.file);
        })
        .catch(() => {});
    };
    executionService.ensureListeners();
    const unsubscribe = executionService.store.subscribe(setExecution);
    return () => {
      unsubscribe();
      // Only drop the store subscription; the on* hooks stay because a later
      // remount re-assigns them and stale closures would double-append output.
    };
    // `showToast` is referentially stable (it reads a ref for its id), so
    // adding it here cannot cause a re-subscribe loop.
  }, [showToast]);

  // Load pinned toolchains and scan the machine whenever the workspace changes.
  useEffect(() => {
    let disposed = false;
    loadWorkspaceSettings(currentPath)
      .then((loaded) => { if (!disposed) setToolchainSettings(loaded); })
      .catch(() => {});
    detectInterpreters(currentPath)
      .then((found) => { if (!disposed) setInterpreters(found); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [currentPath]);

  // Refresh the interpreter + routing verdict whenever the active file changes.
  useEffect(() => {
    let disposed = false;
    (async () => {
      if (!activeTab?.path) {
        executionService.store.patch({ descriptor: null, interpreter: null });
        return;
      }
      await executionService.syncInterpreter(activeLanguage, interpreters, toolchainSettings);
      const descriptor = await executionService.describe(activeTab.path, toolchainSettings);
      if (disposed || !activeTab.path) return;
      executionService.store.patch({ descriptor });
    })();
    return () => { disposed = true; };
  }, [activeTab?.path, activeLanguage, interpreters, toolchainSettings]);

  // Run configurations live in `.vscode/launch.json`. Only the list is read
  // here — the argv for the active file is resolved by the backend router, so
  // this only drives the header dropdown's label and count.
  useEffect(() => {
    let disposed = false;
    loadLaunchFile(currentPath)
      .then((file) => { if (!disposed) setLaunchFile(file); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [currentPath]);

  const runConfigName = launchFile?.configurations[0]?.name ?? null;
  const runConfigCount = launchFile?.configurations.length ?? 0;

  const handleRun = useCallback(async () => {
    if (!activeTab?.path) {
      showToast('Save the file first — running needs a path on disk', 'info');
      return;
    }
    setConsoleOutput([]);
    setIsRunning(true);
    setBottomTab('output');
    setBottomOpen(true);
    await executionService.run({
      file: activeTab.path,
      cwd: currentPath,
      settings: toolchainSettings,
      detected: interpreters,
      rakMode: runMode,
      // Scratch buffers have no file; Rak runs from the buffer contents.
      source: activeTab.content,
    });
  }, [activeTab, currentPath, toolchainSettings, interpreters, runMode, showToast]);

  const handleDebug = useCallback(async () => {
    if (!activeTab?.path) {
      showToast('Save the file first — debugging needs a path on disk', 'info');
      return;
    }
    setConsoleOutput([]);
    setBottomTab('debug');
    setBottomOpen(true);
    await executionService.debug({
      file: activeTab.path,
      cwd: currentPath,
      settings: toolchainSettings,
      detected: interpreters,
      stopOnEntry: false,
    });
  }, [activeTab, currentPath, toolchainSettings, interpreters, showToast]);

  const handleStop = useCallback(async () => {
    await executionService.stop();
    // Rak runs through the dedicated native bridge, which has its own process.
    if (isRakFile) {
      try { await invoke('stop_rak'); } catch { /* already gone */ }
    }
    setIsRunning(false);
  }, [isRakFile]);

  const handleToggleBreakpoint = useCallback((line: number) => {
    if (!activeTab?.path) return;
    void executionService.toggleBreakpoint(activeTab.path, line);
    // Deps are the whole tab, not just its path: the React Compiler infers
    // `activeTab` from the read below and rejects a narrower spec.
  }, [activeTab]);

  const handleClearConsole = () => setConsoleOutput([]);

  const handleOpenInterpreter = useCallback(() => {
    // A rescan on open means a toolchain installed since the last visit shows
    // up without a manual refresh step.
    invalidateScan();
    setInterpreterPickerOpen(true);
  }, []);


  const handleCopyPath = (path: string) => {
    if (!path) return;
    navigator.clipboard.writeText(path).then(() => showToast('Path copied', 'success'));
  };

  const handleInsertDoc = (title: string) => {
    if (!activeTab) { showToast('Open a file to insert docs', 'info'); return; }
    const name = title.split(' ')[0].replace(/\W/g, '');
    if (!name) return;
    updateTabContent(activeTab.id, activeTab.content + (activeTab.content.endsWith('\n') ? '' : '\n') + `${name} `);
    showToast(`Inserted ${name}`, 'success');
  };

  const handleRevealInExplorer = (path: string) => {
    if (!path) return;
    const dir = path.includes('\\') ? path.split('\\').slice(0, -1).join('\\') : path.split('/').slice(0, -1).join('/');
    invoke('open_in_explorer', { path: dir || path }).catch(() => {});
  };

  const handleNextTab = useCallback(() => {
    if (tabs.length < 2) return;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    setActiveTabId(tabs[(idx + 1) % tabs.length].id);
  }, [tabs, activeTabId]);

  // --- Bottom panel / terminal panel state ---
  /** Reveal the panel on the Terminal tab before running `action`. */
  const showTerminal = useCallback((action: () => void) => {
    setBottomTab('terminal');
    setPanelCollapsed(false);
    setBottomOpen(true);
    // Revealing an empty terminal panel seeds the first shell, so Ctrl+`
    // always lands on a usable prompt rather than a blank pane.
    if (terminalCount.current === 0) setTerminalEnsure((n) => n + 1);
    action();
  }, []);

  const togglePanelMaximized = useCallback(() => {
    setBottomOpen(true);
    setPanelCollapsed(false);
    setPanelMaximized((max) => {
      if (max) {
        setTerminalHeight(panelRestoreHeight.current);
        return false;
      }
      panelRestoreHeight.current = terminalHeight;
      // Leave room for the tabs, editor and status bar so the panel reads as
      // "maximized" rather than "covering everything".
      setTerminalHeight(Math.max(240, window.innerHeight - 190));
      return true;
    });
  }, [terminalHeight]);

  // Dragging a maximized panel is meaningless, so drop the maximized flag.
  useEffect(() => {
    if (!panelMaximized) return;
    if (terminalHeight < window.innerHeight - 260) setPanelMaximized(false);
  }, [panelMaximized, terminalHeight]);

  // --- Global keyboard shortcuts ---
  // Bindings come from the keymap table (defaults + user overrides) rather
  // than an `if/else` chain, so the Settings ▸ Keyboard Shortcuts editor
  // actually changes behaviour. The table is rebuilt on every settings
  // change; `matchesChord` is the single matching rule.
  //
  // Hoisted to the component body (rather than living inside the effect below)
  // so the palette and the menus can render a *resolved* chord instead of a
  // hard-coded string that goes stale the moment a user remaps something.
  const binds = resolveKeymap(settingsState.keymap.bindings);
  const chordLabel = useCallback((id: string) => formatChord(binds[id] ?? ''), [binds]);

  useEffect(() => {
    const hit = (e: KeyboardEvent, id: string) => {
      if (!matchesChord(e, binds[id] ?? '')) return false;
      e.preventDefault();
      return true;
    };

    const handler = (e: KeyboardEvent) => {
      if (hit(e, 'file.save')) handleSave();
      else if (hit(e, 'file.openFolder')) handleOpenFolder();
      else if (hit(e, 'file.newFile')) handleNewFile();
      // Both new-project and new-window are Shift chords, and a chord's `e.key`
      // is the capital letter, so they must be matched as chords before any
      // single-key comparison can misread them. new-project is tested first
      // because the wizard is the more likely intent from the welcome screen;
      // that is a tie-break only, since their defaults do not collide.
      else if (hit(e, 'file.newProject')) void openNewProject();
      else if (hit(e, 'file.newWindow')) handleNewWindow();
      else if (hit(e, 'run.run')) handleRun();
      else if (hit(e, 'run.runAlternate')) handleRun();
      else if (hit(e, 'view.togglePanel')) { setBottomTab('output'); setBottomOpen(o => !o); }
      else if (hit(e, 'view.toggleTerminal')) { setBottomTab('terminal'); setBottomOpen(o => !o); }
      else if (hit(e, 'view.toggleSidebar')) setSidebarOpen(o => { const n = !o; if (n) setActivity('explorer'); return n; });
      else if (hit(e, 'view.toggleDocs')) setDocsOpen(o => !o);
      else if (hit(e, 'view.commandPalette')) setPaletteOpen(true);
      else if (hit(e, 'file.openFile')) setQuickOpen(true);
      else if (hit(e, 'file.closeEditor')) { if (activeTabId) handleTabClose(activeTabId); }
      // `run.stop` has no default chord on a bare key, so it is matched last
      // and only when the user has bound it.
      else if (binds['run.stop'] && hit(e, 'run.stop')) handleStop();
      // Ctrl+Tab is reserved by the webview for its own focus cycling, so it
      // stays out of the user-editable table.
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') { e.preventDefault(); handleNextTab(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // The shortcut handlers are recreated each render; listing them keeps the
    // listener always wired to fresh state (no stale-closure shortcuts).
  }, [activeTabId, handleSave, handleOpenFolder, handleNewFile, openNewProject, handleNewWindow, handleRun, handleStop, handleTabClose, handleNextTab, settingsState.keymap.bindings]);

  // --- Terminal shortcuts ---
  // Kept separate from the block above so the terminal's key map stays
  // readable. Ctrl+` is matched by physical key (`e.code`) because the
  // character that key produces depends on the user's keyboard layout, while
  // the physical key does not. The other two read their chords from the same
  // keymap table as everything else.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === 'Backquote' && !e.shiftKey) {
        e.preventDefault();
        // Toggle, but only seed a shell on the way *open* — revealing an
        // already-populated panel must not add a session to it.
        const opening = !bottomOpenRef.current;
        setBottomOpen(opening);
        if (opening) {
          setBottomTab('terminal');
          setPanelCollapsed(false);
          if (terminalCount.current === 0) setTerminalEnsure((n) => n + 1);
        }
        return;
      }
      if (matchesChord(e, binds['view.newTerminal'] ?? '')) {
        e.preventDefault();
        showTerminal(() => setTerminalSpawn((n) => n + 1));
        return;
      }
      if (matchesChord(e, binds['view.splitTerminal'] ?? '')) {
        e.preventDefault();
        showTerminal(() => setTerminalSplit((n) => n + 1));
        return;
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        showTerminal(() => setTerminalCycle((c) => ({ token: c.token + 1, delta: e.key === 'PageDown' ? 1 : -1 })));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showTerminal, settingsState.keymap.bindings]);

  // --- Resize handlers ---
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      if (resizeRef.current.type === 'terminal') {
        const dy = resizeRef.current.startY - e.clientY;
        setTerminalHeight(Math.max(80, Math.min(600, resizeRef.current.startH + dy)));
      } else {
        const dx = e.clientX - resizeRef.current.startX;
        setSidebarWidth(Math.max(160, Math.min(500, resizeRef.current.startW + dx)));
      }
    };    const onMouseUp = () => {
      resizeRef.current = null;
      document.body.classList.remove('drag-resizing-col', 'drag-resizing-row');
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.classList.remove('drag-resizing-col', 'drag-resizing-row');
    };
  }, []);

  const getLineClass = (content: string) => {
    if (content.startsWith('[SCAN]')) return 'text-cyan-400';
    if (content.startsWith('[FETCH]')) return 'text-blue-400';
    if (content.startsWith('[DUMP]')) return 'text-yellow-400';
    if (content.startsWith('[TRACE]')) return 'text-purple-400';
    if (content.startsWith('>')) return 'text-zinc-500';
    return 'text-zinc-300';
  };

  // --- Command palette ---
  const commands: Command[] = [
    { id: 'newwindow', label: 'New Window', shortcut: chordLabel('file.newWindow'), icon: 'monitor', action: handleNewWindow },
    { id: 'save', label: 'Save File', shortcut: 'Ctrl+S', icon: 'save', action: handleSave },
    { id: 'run', label: 'Run File', shortcut: 'Ctrl+R', icon: 'play', action: handleRun },
    { id: 'newproject', label: 'New Project', shortcut: chordLabel('file.newProject'), icon: 'folder-plus', action: () => void openNewProject() },
    { id: 'newfile', label: 'New File', shortcut: 'Ctrl+N', icon: 'file-plus', action: handleNewFile },
    { id: 'openfolder', label: 'Open Folder', shortcut: 'Ctrl+O', icon: 'folder-open', action: handleOpenFolder },
    { id: 'terminal', label: 'Toggle Terminal', shortcut: 'Ctrl+Shift+T', icon: 'terminal', action: () => { setBottomTab('terminal'); setBottomOpen(o => !o); } },
    { id: 'sidebar', label: 'Toggle Sidebar', shortcut: 'Ctrl+B', icon: 'panel-left', action: () => setSidebarOpen(o => { const n = !o; if (n) setActivity('explorer'); return n; }) },
    { id: 'console', label: 'Toggle Output', shortcut: 'Ctrl+J', icon: 'monitor', action: () => { setBottomTab('output'); setBottomOpen(o => !o); } },
    { id: 'docs', label: 'Toggle Documentation', shortcut: 'Ctrl+K', icon: 'book', action: () => setDocsOpen(o => !o) },
    { id: 'quickopen', label: 'Quick Open File', shortcut: 'Ctrl+P', icon: 'search', action: () => setQuickOpen(true) },
    { id: 'interp', label: 'Mode: Interpreter', icon: 'zap', action: () => { setRunMode('interp'); showToast('Interpreter mode', 'info'); } },
    { id: 'vm', label: 'Mode: VM', icon: 'zap', action: () => { setRunMode('vm'); showToast('VM mode', 'info'); } },
    { id: 'bench', label: 'Mode: Bench', icon: 'bar-chart', action: () => { setRunMode('bench'); showToast('Bench mode', 'info'); } },
    { id: 'clearconsole', label: 'Clear Console', icon: 'eraser', action: handleClearConsole },
    { id: 'closeall', label: 'Close All Tabs', icon: 'x', action: handleCloseAll },
    { id: 'settings', label: 'Settings', icon: 'gear', action: () => setSettingsOpen(true) },
    { id: 'settings-appearance', label: 'Settings: Appearance & Themes', icon: 'sparkles', action: () => openSettings('appearance') },
    { id: 'settings-editor', label: 'Settings: Editor', icon: 'file-code', action: () => openSettings('editor') },
    { id: 'settings-keymap', label: 'Settings: Keyboard Shortcuts', icon: 'key', action: () => openSettings('keymap') },
    { id: 'settings-json', label: 'Open settings.json', icon: 'file-code', action: () => { setSettingsOpen(true); setSettingsCategory('general'); } },
    { id: 'tutorial', label: 'Show Tutorial', icon: 'book', action: () => setTutorialOpen(true) },
  ];

  // Extension-contributed commands are appended after the built-ins. The
  // palette's own filter is a plain substring match, so a contributed title
  // like "My Extension: Run" is findable by typing either half.
  const allCommands: Command[] = [...commands, ...extHost.paletteCommands];

  // --- Menu bar (File / Edit / View / Help) ---
  const menus: MenuGroup[] = [
    {
      id: 'file', label: 'File', items: [
        { id: 'newproject', label: 'New Project…', shortcut: chordLabel('file.newProject'), action: () => void openNewProject() },
        { id: 'newwindow', label: 'New Window', shortcut: chordLabel('file.newWindow'), action: handleNewWindow },
        { id: 'separator', label: '' },
        { id: 'newfile', label: 'New File', shortcut: 'Ctrl+N', action: handleNewFile },
        { id: 'openfolder', label: 'Open Folder…', shortcut: 'Ctrl+O', action: handleOpenFolder },
        { id: 'separator', label: '' },
        { id: 'save', label: 'Save', shortcut: 'Ctrl+S', action: handleSave },
        { id: 'closetab', label: 'Close Tab', shortcut: 'Ctrl+W', action: () => { if (activeTabId) handleTabClose(activeTabId); }, disabled: !activeTabId },
        { id: 'closeall', label: 'Close All Tabs', action: handleCloseAll, disabled: tabs.length === 0 },
      ],
    },
    {
      id: 'edit', label: 'Edit', items: [
        { id: 'find', label: 'Quick Open File', shortcut: 'Ctrl+P', action: () => setQuickOpen(true) },
        { id: 'palette', label: 'Command Palette…', shortcut: 'Ctrl+Shift+P', action: () => setPaletteOpen(true) },
        { id: 'separator', label: '' },
        { id: 'clearoutput', label: 'Clear Output', action: handleClearConsole },
      ],
    },
    {
      id: 'view', label: 'View', items: [
        { id: 'explorer', label: 'Toggle Primary Sidebar', shortcut: 'Ctrl+B', action: () => setSidebarOpen(o => { const n = !o; if (n) setActivity('explorer'); return n; }) },
        { id: 'terminal', label: 'Toggle Terminal', shortcut: 'Ctrl+Shift+T', action: () => { setBottomTab('terminal'); setBottomOpen(o => !o); } },
        { id: 'output', label: 'Toggle Output', shortcut: 'Ctrl+J', action: () => { setBottomTab('output'); setBottomOpen(o => !o); } },
      ],
    },
    {
      id: 'help', label: 'Help', items: [
        { id: 'tutorial', label: 'Show Tutorial', action: () => setTutorialOpen(true) },
        { id: 'docs', label: 'Documentation', shortcut: 'Ctrl+K', action: () => setDocsOpen(o => !o) },
        { id: 'separator', label: '' },
        { id: 'settings', label: 'Settings…', action: () => setSettingsOpen(true) },
        { id: 'settings-appearance', label: 'Appearance & Themes…', action: () => openSettings('appearance') },
        { id: 'settings-keymap', label: 'Keyboard Shortcuts…', action: () => openSettings('keymap') },
      ],
    },
  ];

  // Workspace files available to Global Search. Today it indexes the open
  // tabs; a full tree walk arrives when the backend file-watcher index lands.
  // --- Extension install pickers -------------------------------------------
  // The panel stays platform-agnostic; resolving a native dialog needs the
  // Tauri plugin, so it lives here with the other dialog calls.
  const pickExtensionFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select an extension folder' });
      return typeof selected === 'string' && selected ? selected : null;
    } catch (e) {
      showToast(`Could not open folder picker: ${errText(e)}`, 'error');
      return null;
    }
  }, [showToast]);

  const pickExtensionZip = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        title: 'Select an extension archive',
        filters: [{ name: 'Extension archive', extensions: ['zip'] }],
      });
      return typeof selected === 'string' && selected ? selected : null;
    } catch (e) {
      showToast(`Could not open file picker: ${errText(e)}`, 'error');
      return null;
    }
  }, [showToast]);

  const searchableFiles: SearchableFile[] = tabs.map((t) => {
    const sep = t.path.includes('\\') ? '\\' : '/';
    const idx = t.path.lastIndexOf(sep);
    const dir = idx >= 0 ? t.path.slice(0, idx) : t.path;
    return { path: t.path || t.id, name: t.name, dir };
  });

  // Basename helper for file paths (avoids brittle regex in JSX).
  const nameFromPath = (p: string) => {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
  };

  // Shared renderer for the Output / Debug Console bottom-panel tabs.
  const renderOutput = (attachRef: boolean) => {
    if (consoleOutput.length === 0) {
      return <div className="h-full p-3 text-xs text-ide-faint italic">Ready to run code...</div>;
    }
    return (
      <div
        ref={attachRef ? consoleRef : undefined}
        onContextMenu={(e) => e.preventDefault()}
        className="h-full overflow-y-auto ide-scrollbar p-3 space-y-0.5 bg-ide-bg"
      >
        {consoleOutput.map((line, i) => (
          <div key={i} className={`text-xs font-mono ${line.type === 'error' ? 'text-red-400' : getLineClass(line.content)}`}>{line.content}</div>
        ))}
      </div>
    );
  };

  const tutorialSteps: TourStep[] = [
    { title: 'Welcome to Agamiz Code', body: 'A quick tour of the editor. Press Next to continue, or Skip.' },
    { target: 'editor', title: 'Editor', onEnter: () => { if (tabs.length === 0) handleNewScratchFile(); }, body: 'Write Rak code here. Try a pipeline: `5 |> inc |> dbl`. Regex literals like `/\\d+/g` and char literals like \'P\' are syntax-highlighted.' },
    { target: 'run', title: 'Run', body: 'Run the current file with Ctrl+R (or F5). Stop a running script with the Stop button.' },
    { target: 'mode', title: 'Run mode', body: 'Switch between Interpreter (tree-walker), VM (bytecode, ~6x faster), and Bench to compare both.' },
    { target: 'console', onEnter: () => { setBottomTab('output'); setBottomOpen(true); }, title: 'Console', body: 'Program output is printed here. Toggle it with Ctrl+J. Lines are colour-coded by [DUMP]/[SCAN]/[FETCH]/[TRACE].' },
    { target: 'terminal', onEnter: () => { setBottomTab('terminal'); setBottomOpen(true); }, title: 'Terminal', body: 'A built-in shell for running system commands and project toolchains. Toggle with Ctrl+Shift+T.' },
    { title: 'Examples', body: 'Starter scripts live in the Rak Examples extension. Install it and they appear in the Command Palette.' },
    { title: 'Commands', body: 'Ctrl+Shift+P opens the command palette. Ctrl+P is quick file open. Ctrl+B toggles the sidebar. Find Settings or Show Tutorial here any time.' },
    { title: "You're ready", body: 'That\u2019s the tour. Re-open it any time from the command palette (Show Tutorial) or Settings. Happy hacking.' },
  ];

  // Shared overlays rendered by BOTH the welcome/landing view and the main
  // workspace view. The welcome view previously omitted these, which made its
  // buttons (Command Palette, Replay tutorial, New Scratch File, …) appear
  // dead: state changed, but nothing was ever rendered in response. It also
  // broke the global Ctrl+P / Ctrl+Shift+P shortcuts and hid error toasts on
  // that screen. Keeping them in one fragment guarantees both views stay
  // in sync.
  const sharedOverlays = (
    <>
      {/* Command Palette */}
      <CommandPalette open={paletteOpen} commands={allCommands} onClose={() => setPaletteOpen(false)} />

      {/* Quick Open */}
      <QuickOpen open={quickOpen} workspacePath={currentPath} onOpen={handleFileSelect} onClose={() => setQuickOpen(false)} />

      {/*
        New Project lives in `sharedOverlays` so it is reachable from the welcome
        screen and from an open workspace alike. Mounted conditionally rather than
        kept alive behind an `open` flag, so every field starts fresh and no
        "reset on open" effect is needed.
      */}
      {newProjectOpen && (
        <NewProjectDialog
          templates={projectTemplates}
          defaultLocation={projectLocation}
          onClose={() => setNewProjectOpen(false)}
          inspect={inspectProject}
          onCreate={handleCreateProject}
        />
      )}

      {/* Settings */}
      {settingsOpen && (
        <SettingsCenter
          workspaceRoot={currentPath}
          initialCategory={settingsCategory}
          onClose={() => { setSettingsOpen(false); setSettingsCategory(undefined); }}
          onReplayTutorial={() => { setSettingsOpen(false); setTutorialOpen(true); }}
          onToast={showToast}
        />
      )}

      {/* First-run tutorial */}
      {tutorialOpen && (
        <Tutorial steps={tutorialSteps} onClose={() => setTutorialOpen(false)} />
      )}

      {/* Toasts */}
      <div className="fixed bottom-8 right-4 z-50 space-y-2">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2 rounded-lg shadow-xl text-sm font-mono ${
            t.type === 'success' ? 'bg-emerald-600 text-white' : t.type === 'error' ? 'bg-red-600 text-white' : 'bg-zinc-700 text-zinc-200'
          }`}>
            {t.message}
          </div>
        ))}
      </div>

      <DiagnosticsPanel />
    </>
  );

  if (!workspaceOpen) {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const mod = isMac ? '\u2318' : 'Ctrl';
    const startActions: { key: string; icon: IconName; label: string; sub: string; kbd: string; run: () => void }[] = [
      { key: 'new-project', icon: 'folder-plus', label: 'New Project', sub: 'Start from a template', kbd: chordLabel('file.newProject'), run: () => void openNewProject() },
      { key: 'new-window', icon: 'monitor', label: 'New Window', sub: 'Open a new instance', kbd: chordLabel('file.newWindow'), run: handleNewWindow },
      { key: 'open-folder', icon: 'folder-open', label: 'Open Folder', sub: 'Browse for a workspace folder', kbd: `${mod}O`, run: handleOpenFolder },
      { key: 'new-scratch', icon: 'file-plus', label: 'New Scratch File', sub: 'Start a clean untitled buffer', kbd: '', run: handleNewScratchFile },
      { key: 'palette', icon: 'zap', label: 'Command Palette', sub: 'Run any command instantly', kbd: `${mod}Shift+P`, run: () => setPaletteOpen(true) },
    ];
    return (
      <div className="relative flex flex-col h-screen bg-zinc-950 text-zinc-100 font-mono overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.14),transparent_55%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.07),transparent_45%)]" />
        <TitleBar />
        <div className="relative flex flex-1 flex-col lg:flex-row items-stretch justify-center gap-10 overflow-y-auto px-8 py-8 lg:py-10">
          <div className="flex flex-col justify-center w-full max-w-xl">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-900/50 ring-1 ring-emerald-400/30">
                <span className="text-black font-black text-2xl">A</span>
              </div>
              <div>
                <h1 className="text-4xl font-bold text-zinc-50 tracking-tight">Agamiz Code</h1>
                <p className="text-zinc-500 text-sm">A modern, extensible desktop IDE</p>
              </div>
            </div>
            <p className="text-zinc-400 text-sm mb-7 max-w-md leading-relaxed">English keywords, first-class hexadecimal, real networking, a bytecode VM, SQL server and self-hosting. Built for recon, security research, and general-purpose systems programming.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md">
              {startActions.map((a) => (
                <button key={a.key} onClick={a.run} className="group flex items-center gap-3 px-4 py-3 rounded-lg bg-zinc-900/70 border border-zinc-800 hover:border-emerald-500/60 hover:bg-zinc-900 hover:-translate-y-px transition-all text-left">
                  <Icon name={a.icon} size={18} className="text-emerald-500 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium text-zinc-100 group-hover:text-emerald-300">{a.label}</span>
                    <span className="block text-[10px] text-zinc-500 truncate">{a.sub}</span>
                  </span>
                  {a.kbd && <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 group-hover:text-emerald-400">{a.kbd}</kbd>}
                </button>
              ))}
            </div>
            <div className="mt-6 text-[11px] text-zinc-600">Tip: <kbd className="px-1 py-0.5 rounded bg-zinc-900 border border-zinc-800">{mod}Shift+P</kbd> opens the command palette.</div>
          </div>
          <div className="w-full max-w-md flex flex-col justify-center gap-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] text-zinc-400 font-semibold tracking-wide uppercase">Recent Projects{visibleRecentProjects.length > 0 ? ` (${visibleRecentProjects.length})` : ''}</span>
              {recentProjects.length > 0 && <button onClick={clearRecentProjects} className="text-[10px] text-zinc-600 hover:text-red-400" title="Clear recent projects">Clear</button>}
            </div>
              {visibleRecentProjects.length === 0 ? (
                <p className="text-xs text-zinc-600 py-4 text-center">Nothing here yet — open a folder to get started.</p>
              ) : (
                <div className="space-y-0.5 max-h-56 overflow-y-auto">
                  {visibleRecentProjects.map((p) => (
                    <button
                      key={p}
                      onClick={() => openProject(p)}
                      className="w-full text-left px-2 py-1.5 rounded text-xs text-zinc-300 hover:bg-zinc-800 hover:text-emerald-300 flex items-center gap-2 group"
                      title={p}
                    >
                      <Icon name="folder" size={13} className="text-zinc-500 group-hover:text-emerald-400 flex-shrink-0" />
                      <span className="truncate">{p}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={handleOpenFolder}
              className="group rounded-xl border-2 border-dashed border-zinc-800 hover:border-emerald-500/60 bg-zinc-900/30 hover:bg-zinc-900/60 p-5 text-center transition-colors"
              title="Open a workspace folder"
            >
              <Icon name="folder-plus" size={20} className="mx-auto mb-2 text-zinc-600 group-hover:text-emerald-400" />
              <span className="block text-xs text-zinc-400 group-hover:text-emerald-300">Open a workspace folder</span>
              <span className="block text-[10px] text-zinc-600 mt-1">or drag &amp; drop a folder here to start</span>
            </button>
            <div className="text-[11px] text-zinc-600">
              {!tutorialSeen ? (
                <span className="text-emerald-500/80">A quick tour will start when you open a folder.</span>
              ) : (
                <button onClick={() => setTutorialOpen(true)} className="hover:text-zinc-300 underline">Replay tutorial</button>
              )}
            </div>
          </div>
        </div>
      {sharedOverlays}
      </div>
  );
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-mono overflow-hidden">
      <TitleBar workspacePath={currentPath} />

      {/* Menu + Action toolbar */}
      <div className="flex items-center justify-between bg-ide-raised border-b border-ide-border h-8 shrink-0 select-none">
        <div className="flex items-center h-full">
          <MenuBar menus={menus} />
        </div>
        <ExecutionControls
          state={execution}
          configName={runConfigName}
          configCount={runConfigCount}
          rakMode={runMode}
          rakModeDisabled={!isRakFile}
          onRakModeChange={setRunMode}
          onRun={handleRun}
          onDebug={handleDebug}
          onStop={handleStop}
          onOpenInterpreter={handleOpenInterpreter}
          onOpenDebugConsole={() => { setBottomTab('debug'); setBottomOpen(true); }}
          onEditConfigurations={() => { setActivity('run'); setSidebarOpen(true); showToast('Edit .vscode/launch.json to add run and debug configurations', 'info'); }}
          interpreterLabel={execution.interpreter?.label ?? 'No interpreter'}
          canRun={!!activeTab?.path && (execution.descriptor?.runnable ?? false)}
          canDebug={!!activeTab?.path && (execution.descriptor?.debuggable ?? false)}
        />
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Activity Rail */}
        <ActivityBar active={activity} onSelect={selectActivity} items={activityItems} onSettings={() => setSettingsOpen(true)} />
        {sidebarOpen && (
          <>
            <div style={{ width: sidebarWidth }} className="flex-shrink-0 overflow-hidden flex flex-col min-h-0 bg-ide-bg border-r border-ide-border">
              {activity === 'explorer' && (
                <FileExplorer
                  onFileSelect={handleFileSelect}
                  currentPath={currentPath}
                  onPathChange={setCurrentPath}
                  activeFile={activeTab?.path || null}
                  onToast={showToast}
                  onPathChanged={handleExplorerPathChanged}
                  onPathRemoved={handleExplorerPathRemoved}
                  confirmOverwrite={(dest) => confirm(
                    `${basename(dest)} already exists there.\n\nReplace it?`,
                  )}
                />
              )}
              {activity === 'scm' && (
                <SourceControlPanel cwd={currentPath} onToast={showToast} />
              )}
              {activity === 'run' && (
                <RunDebugPanel
                  activeFile={activeTab?.path || null}
                  state={execution}
                  output={consoleOutput}
                  onClearOutput={handleClearConsole}
                  onRun={handleRun}
                  onDebug={handleDebug}
                  onStop={handleStop}
                  onToggleBreakpoint={handleToggleBreakpoint}
                  onClearBreakpoints={() => executionService.clearBreakpoints()}
                  onEvaluate={(expr) => executionService.evaluate(expr)}
                  onOpenInterpreter={handleOpenInterpreter}
                  onWriteInput={(text) => executionService.write(text)}
                />
              )}
              {activity === 'ai' && (
                <AIPanel
                  cwd={currentPath}
                  activeFile={activeTab?.path || null}
                  activeFileContent={activeTab?.content || ''}
                  onToast={showToast}
                  onOpenFile={(p) => handleFileSelect(p, nameFromPath(p))}
                  onFileChanged={handleAgentFileChanged}
                />
              )}
              {activity === 'search' && (
                <GlobalSearch files={searchableFiles} onOpen={handleFileSelect} />
              )}
              {activity === 'extensions' && (
                <ExtensionsPanel
                  host={extHost}
                  onToast={showToast}
                  onPickFolder={pickExtensionFolder}
                  onPickZip={pickExtensionZip}
                />
              )}
            </div>
            <div
              className="w-1 cursor-col-resize bg-ide-border-soft hover:bg-ide-accent transition-colors flex-shrink-0"
              onMouseDown={(e) => {
                // Prevent the webview from starting a text-selection drag that
                // competes with the resize drag.
                e.preventDefault();
                resizeRef.current = { type: 'sidebar' as const, startY: 0, startX: e.clientX, startH: 0, startW: sidebarWidth };
                document.body.classList.add('drag-resizing-col');
              }}
              onDragStart={(e) => e.preventDefault()}
            />
          </>
        )}

        {/* Editor + bottom panel */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          {/* Breadcrumb (dedicated sub-header) */}
          {activeTab && (
            <Breadcrumb path={activeTab.path} fileName={activeTab.name} dirty={activeTab.isDirty} />
          )}
          <TabBarWithMenu
            tabs={tabs}
            activeTabId={activeTabId || ''}
            onTabSelect={setActiveTabId}
            onTabClose={handleTabClose}
            onCloseOthers={handleCloseOthers}
            onCloseRight={handleCloseRight}
            onCloseAll={handleCloseAll}
            onCopyPath={handleCopyPath}
            onRevealInExplorer={handleRevealInExplorer}
          />
          <div data-tour="editor" className="flex-1 flex flex-col min-h-0">
            {activeTab ? (
            <CodeEditor
              value={activeTab.content}
              onChange={(content) => updateTabContent(activeTab.id, content)}
              onRun={handleRun}
              onDebug={handleDebug}
              onCursorChange={setCursorPos}
              revealLine={revealLine}
              languageId={activeLanguage || undefined}
              breakpoints={
                activeTab?.path
                  ? executionService.breakpointLines(activeTab.path)
                  : undefined
              }
              pausedLine={
                execution.current?.file === activeTab?.path ? execution.current.line : null
              }
              onToggleBreakpoint={handleToggleBreakpoint}
              fontSize={settingsState.editor.fontSize}
              lineHeight={settingsState.editor.lineHeight}
            tabSize={settingsState.editor.tabSize}
            autoClose={settingsState.editor.autoClose}
            insertSpaces={settingsState.editor.insertSpaces !== false}
              fontFamily={settingsState.appearance.editorFontFamily}
              ligatures={settingsState.appearance.editorFontLigatures}
              lineNumbers={settingsState.editor.lineNumbers}
              wordWrap={settingsState.editor.wordWrap}
              wordWrapColumn={settingsState.editor.wordWrapColumn}
              renderWhitespace={settingsState.editor.renderWhitespace}
              minimapEnabled={settingsState.editor.minimapEnabled}
              minimapScale={settingsState.editor.minimapScale}
            />
            ) : (
              <WelcomeScreen
                title="Welcome to Agamiz Code"
                subtitle="Start a new project from a template, open a workspace folder, or run the command palette to get going."
                actions={[
                  { id: 'new-project', label: 'New Project', sublabel: 'Start from a template', icon: 'folder-plus', shortcut: chordLabel('file.newProject'), run: () => void openNewProject() },
                  { id: 'new-window', label: 'New Window', sublabel: 'Open a new instance', icon: 'monitor', shortcut: chordLabel('file.newWindow'), run: handleNewWindow },
                  { id: 'open-folder', label: 'Open Folder', sublabel: 'Open a workspace folder', icon: 'folder-open', shortcut: 'Ctrl+O', run: handleOpenFolder },
                  { id: 'new-scratch', label: 'New Scratch File', sublabel: 'Start a clean untitled buffer', icon: 'file-plus', run: handleNewScratchFile },
                  { id: 'quick-open', label: 'Quick Open File', sublabel: 'Jump to a file by name', icon: 'search', shortcut: 'Ctrl+P', run: () => setQuickOpen(true) },
                  { id: 'palette', label: 'Command Palette', sublabel: 'Run any command', icon: 'zap', shortcut: 'Ctrl+Shift+P', run: () => setPaletteOpen(true) },
                ]}
                footerHint="Tip: Ctrl+B toggles the sidebar · Ctrl+Shift+P opens commands"
              />
            )}
          </div>

          {/* Consolidated bottom panel: Terminal | Output | Problems | Debug Console.
              It stays mounted while hidden so switching tabs (or pressing
              Ctrl+J) never tears down a running shell. */}
          <div hidden={!bottomOpen} className="flex flex-col">
            <BottomPanel
              height={panelCollapsed ? 33 : terminalHeight}
              active={bottomTab}
              onSelect={(id) => {
                setBottomTab(id);
                setPanelCollapsed(false);
                setBottomOpen(true);
                if (id === 'terminal' && terminalCount.current === 0) {
                  setTerminalEnsure((n) => n + 1);
                }
              }}
              onResizeStart={(e) => {
                e.preventDefault();
                if (panelCollapsed) setPanelCollapsed(false);
                resizeRef.current = { type: 'terminal' as const, startY: e.clientY, startX: 0, startH: terminalHeight, startW: 0 };
                document.body.classList.add('drag-resizing-row');
              }}
              onClose={() => setBottomOpen(false)}
              onSpawnTerminal={() => showTerminal(() => setTerminalSpawn(n => n + 1))}
              problemsBadge={problemsBadge}
              headerActions={bottomTab === 'terminal' ? terminalToolbar : null}
              maximized={panelMaximized}
              onToggleMaximized={togglePanelMaximized}
              collapsed={panelCollapsed}
              onToggleCollapsed={() => setPanelCollapsed((c) => !c)}
              terminalNode={
                <TerminalPanel
                  cwd={currentPath || '.'}
                  spawnToken={terminalSpawn}
                  ensureToken={terminalEnsure}
                  splitToken={terminalSplit}
                  cycleToken={terminalCycle.token}
                  cycleDelta={terminalCycle.delta}
                  runCommandToken={terminalCommand?.token ?? 0}
                  runCommandText={terminalCommand?.text ?? ''}
                  runCommandCwd={terminalCommand?.cwd ?? ''}
                  onToolbar={setTerminalToolbar}
                  onSessionCountChange={(n) => {
                    terminalCount.current = n;
                  }}
                  onOpenFile={(path, line) => void handleOpenFromTerminal(path, line)}
                  onNotice={(message) => showToast(message, 'info')}
                />
              }
              outputNode={renderOutput(true)}
              problemsNode={
                <ProblemsPanel store={diagnosticStore} activeFile={activeTab?.path || null} onOpenFile={(path) => handleFileSelect(path, nameFromPath(path))} />
              }
              debugNode={renderOutput(false)}
            />
          </div>
        </div>

        {/* Docs browser */}
        {docsOpen && (
          <DocsBrowser onClose={() => setDocsOpen(false)} onInsert={handleInsertDoc} />
        )}
      </div>

      {/* Status Bar */}
      <StatusBar
        info={{
          gitBranch: null,
          path: currentPath || undefined,
          dirty: activeTab?.isDirty,
          line: cursorPos.line,
          col: cursorPos.col,
          encoding: 'UTF-8',
          indent: `Spaces: ${settingsState.editor.tabSize}`,
          language: getLanguageName(detectLanguage(activeTab?.path || activeTab?.name)) || 'Plain Text',
          // Rak's runtime modes only apply to Rak; other languages show the
          // resolved interpreter and version instead.
          runMode: isRakFile
            ? runMode === 'vm' ? 'VM' : runMode === 'bench' ? 'Bench' : 'Interpreter'
            : undefined,
          interpreter: activeTab?.path
            ? execution.interpreter?.label ?? `${execution.descriptor?.language ?? 'No'} (not installed)`
            : null,
          interpreterMissing: !execution.interpreter && !!activeTab?.path,
          aiStatus: 'idle',
          aiModel: 'Ollama',
        }}
        extensionItems={extHost.registry.status}
      />

      {/* Interpreter Quick Pick — one resolver behind both the header badge and
          the status-bar item. Mounted only while open so it rescans on each
          invocation. */}
      {interpreterPickerOpen && (
        <InterpreterPicker
          cwd={currentPath}
          language={activeLanguage}
          settings={toolchainSettings}
          detected={interpreters}
          onSettingsChange={setToolchainSettings}
          onDetectedChange={setInterpreters}
          onClose={() => setInterpreterPickerOpen(false)}
          onNotice={showToast}
        />
      )}

      {/* Shared overlays: command palette, quick open, settings, tutorial, toasts, diagnostics */}
      {sharedOverlays}
    </div>
  );
}
