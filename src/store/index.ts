import { create } from "zustand";
import type {
  AiSearchResult,
  DapStackFrame,
  DapThread,
  DapVariable,
  Diagnostic,
  EditorTab,
  FileNode,
  GitBranches,
  GitStatus,
  ProjectIndexStats,
  RunConfig,
  RunOutputLine,
  Symbol,
  ThemeVariant,
} from "../types";
import { THEME_ORDER } from "../types";

interface SidebarState {
  visible: boolean;
  width: number;
  selectedFile: string | null;
  fileTree: FileNode[];
  toggle: () => void;
  setWidth: (w: number) => void;
  selectFile: (path: string | null) => void;
  setFileTree: (tree: FileNode[]) => void;
}

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  openTab: (tab: EditorTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  markDirty: (id: string, dirty: boolean) => void;
}

interface InspectorState {
  visible: boolean;
  width: number;
  toggle: () => void;
  setWidth: (w: number) => void;
}

interface PaletteState {
  isOpen: boolean;
  query: string;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  toggle: () => void;
}

interface ThemeState {
  variant: ThemeVariant;
  setTheme: (v: ThemeVariant) => void;
  toggleTheme: () => void;
}

const applyTheme = (v: ThemeVariant) => {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", v);
  }
};

interface IndexState {
  stats: ProjectIndexStats | null;
  symbols: Symbol[];
  setStats: (s: ProjectIndexStats) => void;
  setSymbols: (s: Symbol[]) => void;
}

interface StatusBarState {
  gitBranch: string;
  lspErrors: number;
  lspWarnings: number;
  nodeVersion: string;
  progress: { label: string; percent: number } | null;
  setGitBranch: (b: string) => void;
  setLspCounts: (errors: number, warnings: number) => void;
  setNodeVersion: (v: string) => void;
  setProgress: (p: { label: string; percent: number } | null) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  visible: true,
  width: 260,
  selectedFile: null,
  fileTree: [],
  toggle: () => set((s) => ({ visible: !s.visible })),
  setWidth: (w) => set({ width: w }),
  selectFile: (path) => set({ selectedFile: path }),
  setFileTree: (fileTree) => set({ fileTree }),
}));

export const useEditorStore = create<EditorState>((set) => ({
  tabs: [],
  activeTabId: null,
  openTab: (tab) =>
    set((s) => {
      const exists = s.tabs.find((t) => t.id === tab.id);
      if (exists) return { activeTabId: tab.id };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    }),
  closeTab: (id) =>
    set((s) => {
      const remaining = s.tabs.filter((t) => t.id !== id);
      const nextActive =
        s.activeTabId === id
          ? remaining[remaining.length - 1]?.id ?? null
          : s.activeTabId;
      return { tabs: remaining, activeTabId: nextActive };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
  markDirty: (id, dirty) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, isDirty: dirty } : t)),
    })),
}));

export const useInspectorStore = create<InspectorState>((set) => ({
  visible: false,
  width: 300,
  toggle: () => set((s) => ({ visible: !s.visible })),
  setWidth: (w) => set({ width: w }),
}));

export const usePaletteStore = create<PaletteState>((set) => ({
  isOpen: false,
  query: "",
  open: () => set({ isOpen: true, query: "" }),
  close: () => set({ isOpen: false, query: "" }),
  setQuery: (q) => set({ query: q }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen, query: "" })),
}));

export const useThemeStore = create<ThemeState>((set) => ({
  variant: "dark",
  setTheme: (v) => {
    applyTheme(v);
    set({ variant: v });
  },
  toggleTheme: () =>
    set((s) => {
      const i = THEME_ORDER.indexOf(s.variant);
      const next = THEME_ORDER[(i + 1) % THEME_ORDER.length];
      applyTheme(next);
      return { variant: next };
    }),
}));

export const useIndexStore = create<IndexState>((set) => ({
  stats: null,
  symbols: [],
  setStats: (stats) => set({ stats }),
  setSymbols: (symbols) => set({ symbols }),
}));

export const useStatusStore = create<StatusBarState>((set) => ({
  gitBranch: "main",
  lspErrors: 0,
  lspWarnings: 0,
  nodeVersion: "",
  progress: null,
  setGitBranch: (b) => set({ gitBranch: b }),
  setLspCounts: (errors, warnings) => set({ lspErrors: errors, lspWarnings: warnings }),
  setNodeVersion: (v) => set({ nodeVersion: v }),
  setProgress: (p) => set({ progress: p }),
}));

interface ProjectState {
  root: string | null;
  openProject: (path: string) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  root: null,
  openProject: (path) => set({ root: path }),
}));

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  path: string | null;
  isDir: boolean;
  showMenu: (x: number, y: number, path: string, isDir: boolean) => void;
  hideMenu: () => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  path: null,
  isDir: false,
  showMenu: (x, y, path, isDir) => set({ open: true, x, y, path, isDir }),
  hideMenu: () => set({ open: false }),
}));

interface TerminalState {
  visible: boolean;
  height: number;
  toggle: () => void;
  setVisible: (v: boolean) => void;
  setHeight: (h: number) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  visible: false,
  height: 220,
  toggle: () => set((s) => ({ visible: !s.visible })),
  setVisible: (visible) => set({ visible }),
  setHeight: (height) => set({ height }),
}));

interface RunConsoleState {
  visible: boolean;
  configs: RunConfig[];
  selectedConfig: string | null;
  running: boolean;
  runId: number | null;
  output: RunOutputLine[];
  exitCode: number | null;
  refresh: () => Promise<void>;
  setConfigs: (c: RunConfig[]) => void;
  select: (id: string) => void;
  setVisible: (v: boolean) => void;
  setRunning: (running: boolean, runId: number | null) => void;
  appendOutput: (stream: "stdout" | "stderr", text: string) => void;
  setExitCode: (code: number | null) => void;
  clear: () => void;
}

interface LspDiagnosticsState {
  byFile: Record<string, Diagnostic[]>;
  setFile: (file: string, diagnostics: Diagnostic[]) => void;
  clearFile: (file: string) => void;
  getForFile: (path: string) => Diagnostic[];
  totals: { errors: number; warnings: number };
}

export const useLspDiagnosticsStore = create<LspDiagnosticsState>((set, get) => ({
  byFile: {},
  setFile: (file, diagnostics) =>
    set((s) => {
      const byFile = { ...s.byFile, [file]: diagnostics };
      return { byFile, totals: computeTotals(byFile) };
    }),
  clearFile: (file) =>
    set((s) => {
      const byFile = { ...s.byFile };
      delete byFile[file];
      return { byFile, totals: computeTotals(byFile) };
    }),
  getForFile: (path) => {
    const key = normKey(path);
    return Object.entries(get().byFile)
      .filter(([k]) => normKey(k) === key)
      .flatMap(([, v]) => v);
  },
  totals: { errors: 0, warnings: 0 },
}));

function normKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/^\/+/, "");
}

function computeTotals(byFile: Record<string, Diagnostic[]>): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const list of Object.values(byFile)) {
    for (const d of list) {
      if (d.severity === "error") errors++;
      else if (d.severity === "warning") warnings++;
    }
  }
  return { errors, warnings };
}

interface ProblemsState {
  visible: boolean;
  toggle: () => void;
  setVisible: (v: boolean) => void;
}

export const useProblemsStore = create<ProblemsState>((set) => ({
  visible: false,
  toggle: () => set((s) => ({ visible: !s.visible })),
  setVisible: (visible) => set({ visible }),
}));

export const useRunStore = create<RunConsoleState>((set) => ({
  visible: false,
  configs: [],
  selectedConfig: null,
  running: false,
  runId: null,
  output: [],
  exitCode: null,
  refresh: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const configs = await invoke<RunConfig[]>("get_run_configs");
      set((s) => ({
        configs,
        selectedConfig: s.selectedConfig ?? configs[0]?.id ?? null,
      }));
    } catch {
      set({ configs: [], selectedConfig: null });
    }
  },
  setConfigs: (configs) =>
    set((s) => ({
      configs,
      selectedConfig: s.selectedConfig ?? configs[0]?.id ?? null,
    })),
  select: (id) => set({ selectedConfig: id }),
  setVisible: (visible) => set({ visible }),
  setRunning: (running, runId) => set({ running, runId }),
  appendOutput: (stream, text) =>
    set((s) => ({ output: [...s.output, { stream, text }] })),
  setExitCode: (exitCode) => set({ exitCode }),
  clear: () => set({ output: [], exitCode: null }),
}));

// ---------------------------------------------------------------------------
// Debug (DAP)
// ---------------------------------------------------------------------------

interface DebugState {
  visible: boolean;
  sessionId: number | null;
  running: boolean;
  threads: DapThread[];
  stackFrames: DapStackFrame[];
  scopes: DapScopeRef[];
  variables: DapVariable[];
  breakpointFile: string | null;
  breakpoints: number[];
  stoppedReason: string | null;
  toggle: () => void;
  setVisible: (v: boolean) => void;
  setSession: (id: number | null, running: boolean) => void;
  setThreads: (t: DapThread[]) => void;
  setStack: (f: DapStackFrame[]) => void;
  setScopes: (s: DapScopeRef[]) => void;
  setVariables: (v: DapVariable[]) => void;
  setBreakpoints: (file: string, lines: number[]) => void;
  setStoppedReason: (r: string | null) => void;
  reset: () => void;
}

interface DapScopeRef {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export const useDebugStore = create<DebugState>((set) => ({
  visible: false,
  sessionId: null,
  running: false,
  threads: [],
  stackFrames: [],
  scopes: [],
  variables: [],
  breakpointFile: null,
  breakpoints: [],
  stoppedReason: null,
  toggle: () => set((s) => ({ visible: !s.visible })),
  setVisible: (visible) => set({ visible }),
  setSession: (sessionId, running) => set({ sessionId, running }),
  setThreads: (threads) => set({ threads }),
  setStack: (stackFrames) => set({ stackFrames }),
  setScopes: (scopes) => set({ scopes }),
  setVariables: (variables) => set({ variables }),
  setBreakpoints: (breakpointFile, breakpoints) => set({ breakpointFile, breakpoints }),
  setStoppedReason: (stoppedReason) => set({ stoppedReason }),
  reset: () =>
    set({
      sessionId: null,
      running: false,
      threads: [],
      stackFrames: [],
      scopes: [],
      variables: [],
      stoppedReason: null,
    }),
}));

// ---------------------------------------------------------------------------
// Git source control
// ---------------------------------------------------------------------------

interface GitState {
  status: GitStatus | null;
  branches: GitBranches | null;
  setStatus: (s: GitStatus) => void;
  setBranches: (b: GitBranches) => void;
  refresh: () => Promise<void>;
}

export const useGitStore = create<GitState>((set) => ({
  status: null,
  branches: null,
  setStatus: (status) => set({ status }),
  setBranches: (branches) => set({ branches }),
  refresh: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const status = await invoke<GitStatus>("git_status");
      const branches = await invoke<GitBranches>("git_branches");
      set({ status, branches });
    } catch {
      /* not a git repo */
    }
  },
}));

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

interface AiState {
  /** Whether the AI chat panel is open. */
  chatVisible: boolean;
  toggleChat: () => void;
  /** Last search result */
  searchResults: AiSearchResult[];
  setSearchResults: (r: AiSearchResult[]) => void;
  /** Index build progress */
  indexProgress: { filesScanned: number; chunksIndexed: number } | null;
  setIndexProgress: (p: AiState["indexProgress"]) => void;
  /** Ghost-text completion */
  ghostText: string | null;
  setGhostText: (t: string | null) => void;
  /** Chat messages */
  chatMessages: { role: string; content: string }[];
  addChatMessage: (msg: { role: string; content: string }) => void;
  clearChat: () => void;
}

export const useAiStore = create<AiState>((set) => ({
  chatVisible: false,
  toggleChat: () => set((s) => ({ chatVisible: !s.chatVisible })),
  searchResults: [],
  setSearchResults: (searchResults) => set({ searchResults }),
  indexProgress: null,
  setIndexProgress: (indexProgress) => set({ indexProgress }),
  ghostText: null,
  setGhostText: (ghostText) => set({ ghostText }),
  chatMessages: [],
  addChatMessage: (msg) => set((s) => ({ chatMessages: [...s.chatMessages, msg] })),
  clearChat: () => set({ chatMessages: [] }),
}));