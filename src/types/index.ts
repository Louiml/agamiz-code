export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

export interface Location {
  file: string;
  row: number;
  col: number;
  endRow: number;
  endCol: number;
}

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "variable"
  | "const"
  | "interface"
  | "type_alias"
  | "enum"
  | "import"
  | "export"
  | "module"
  | "property"
  | "parameter"
  | "unknown";

export interface Symbol {
  id: number;
  name: string;
  kind: SymbolKind;
  location: Location;
  parentId?: number;
}

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string;
}

export interface ProjectIndexStats {
  filesScanned: number;
  symbolsFound: number;
  durationMs: number;
}

export interface Panel {
  id: string;
  type: "file-explorer" | "editor" | "inspector" | "ai-console";
  title: string;
  visible: boolean;
  width?: string;
  height?: string;
}

export type ThemeVariant =
  | "dark"
  | "light"
  | "purple"
  | "green"
  | "ocean"
  | "sunset"
  | "graphite";

export interface RunConfig {
  id: string;
  name: string;
  command: string;
  kind: string;
}

export interface RunOutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

export const THEME_ORDER: ThemeVariant[] = [
  "dark",
  "light",
  "purple",
  "green",
  "ocean",
  "sunset",
  "graphite",
];
export type GlassMaterial = "ultra-thin" | "thin" | "regular" | "thick";

export interface EditorTab {
  id: string;
  path: string;
  name: string;
  isDirty: boolean;
  language: string;
}

// --- Debug Adapter Protocol (client-side types) ---------------------------

export interface DebugConfig {
  name: string;
  adapter: string;
  args?: string[];
  mode?: "launch" | "attach";
  program: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface DapThread {
  id: number;
  name: string;
}

export interface DapSource {
  name?: string;
  path?: string;
  sourceReference?: number;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource | null;
  line: number;
  column: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
  evaluateName?: string;
}

export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  line?: number;
  source?: DapSource | null;
}

// --- Git client-side types --------------------------------------------------

export interface GitEntry {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitStatus {
  currentBranch: string;
  staged: GitEntry[];
  unstaged: GitEntry[];
  untracked: GitEntry[];
  dirtyCount: number;
}

export interface GitLineChange {
  line: number;
  kind: "added" | "modified" | "deleted";
  status: string;
}

export interface GitFileDiff {
  path: string;
  lines: GitLineChange[];
  patch: string;
}

export interface GitBranches {
  current: string;
  local: string[];
  remote: string[];
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export interface AiSearchResult {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  symbol: string;
  score: number;
  kind: string;
}

export interface AiIndexProgress {
  filesScanned: number;
  chunksIndexed: number;
  durationMs: number;
}

export interface AiContextBundle {
  file: string;
  symbols: string[];
  related: string[];
}

export interface ChatMessage {
  role: string;
  content: string;
}