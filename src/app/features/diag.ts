/**
 * Diagnostics: typed problem entries, a reactive per-file store, and severity
 * helpers shared by the analyzers, Problems panel, editor markers, and LSP.
 */

export type DiagSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface DiagSeverityCounts {
  error: number;
  warning: number;
  info: number;
  hint: number;
}

export interface Position {
  /** 0-based line */
  line: number;
  /** 0-based character offset within the line */
  character: number;
}

export interface Diagnostic {
  /** file path (workspace-relative or absolute) */
  path: string;
  /** 1-based line for display (kept in sync with `range.start.line`) */
  line: number;
  range: { start: Position; end: Position };
  severity: DiagSeverity;
  code?: string | number;
  source: string;
  message: string;
}

export interface DiagnosticListener {
  (path: string, diagnostics: Diagnostic[]): void;
}

/** Simple reactive store keyed by file path, with a global change listener. */
export class DiagnosticStore {
  private byPath = new Map<string, Diagnostic[]>();
  private listeners = new Set<DiagnosticListener>();
  private countListeners = new Set<() => void>();

  set(path: string, diagnostics: Diagnostic[]) {
    const sorted = [...diagnostics].sort(
      (a, b) => a.line - b.line || a.range.start.character - b.range.start.character,
    );
    this.byPath.set(path, sorted);
    const all = this.listeners.size;
    if (all) {
      for (const l of this.listeners) l(path, sorted);
    }
    if (this.countListeners.size) {
      for (const l of this.countListeners) l();
    }
  }

  remove(path: string) {
    if (this.byPath.delete(path)) {
      for (const l of this.listeners) l(path, []);
      for (const l of this.countListeners) l();
    }
  }

  clear() {
    this.byPath.clear();
    for (const l of this.listeners) l('', []);
    for (const l of this.countListeners) l();
  }

  get(path: string): Diagnostic[] {
    return this.byPath.get(path) ?? [];
  }

  all(): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const d of this.byPath.values()) out.push(...d);
    return out;
  }

  /** Total by severity across all files. */
  counts(): DiagSeverityCounts {
    const c: DiagSeverityCounts = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const list of this.byPath.values()) {
      for (const d of list) c[d.severity]++;
    }
    return c;
  }

  onDidChange(listener: DiagnosticListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDidChangeCounts(listener: () => void): () => void {
    this.countListeners.add(listener);
    return () => this.countListeners.delete(listener);
  }
}

/** Shared singleton most of the IDE reads/writes. */
export const diagnosticStore = new DiagnosticStore();

export const SEVERITY_ORDER: DiagSeverity[] = ['error', 'warning', 'info', 'hint'];

export const severityLabel = (s: DiagSeverity) => s.charAt(0).toUpperCase() + s.slice(1);

export const severityColor = (s: DiagSeverity) => {
  switch (s) {
    case 'error': return 'text-red-400';
    case 'warning': return 'text-amber-400';
    case 'info': return 'text-sky-400';
    default: return 'text-zinc-400';
  }
};

export const severityBadgeColor = (s: DiagSeverity) => {
  switch (s) {
    case 'error': return 'bg-red-500/20 text-red-400';
    case 'warning': return 'bg-amber-500/20 text-amber-400';
    case 'info': return 'bg-sky-500/20 text-sky-400';
    default: return 'bg-zinc-600/30 text-zinc-400';
  }
};

export const severityBarColor = (s: DiagSeverity) => {
  switch (s) {
    case 'error': return 'bg-red-500';
    case 'warning': return 'bg-amber-500';
    case 'info': return 'bg-sky-500';
    default: return 'bg-zinc-600';
  }
};