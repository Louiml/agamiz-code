import { useInspectorStore, useStatusStore, useThemeStore, useTerminalStore } from "../../store";
import { useLspDiagnosticsStore } from "../../store";
import { useProblemsStore } from "../../store";
import { useDebugStore, useGitStore } from "../../store";
import { useAiStore } from "../../store";
import { SourceControlToggle } from "../source/SourceControlPanel";

export function StatusBar() {
  const gitBranch = useStatusStore((s) => s.gitBranch);
  const nodeVersion = useStatusStore((s) => s.nodeVersion);
  const progress = useStatusStore((s) => s.progress);
  const toggleInspector = useInspectorStore((s) => s.toggle);
  const visible = useInspectorStore((s) => s.visible);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const themeVariant = useThemeStore((s) => s.variant);
  const toggleTerminal = useTerminalStore((s) => s.toggle);
  const terminalVisible = useTerminalStore((s) => s.visible);
  const lspErrors = useLspDiagnosticsStore((s) => s.totals.errors);
  const lspWarnings = useLspDiagnosticsStore((s) => s.totals.warnings);
  const problemsOpen = useProblemsStore((s) => s.visible);
  const toggleProblems = useProblemsStore((s) => s.toggle);
  const toggleDebug = useDebugStore((s) => s.toggle);
  const debugVisible = useDebugStore((s) => s.visible);
  const debugSessionId = useDebugStore((s) => s.sessionId);
  const toggleChat = useAiStore((s) => s.toggleChat);
  const chatVisible = useAiStore((s) => s.chatVisible);
  const gitStatus = useGitStore((s) => s.status);

  const gitBranchLabel = gitStatus?.currentBranch ?? gitBranch;
  const gitDirty = gitStatus?.dirtyCount ?? 0;

  return (
    <footer className="flex items-center justify-center h-[var(--spacing-statusbar)] shrink-0 select-none">
      <div className="glass-pill flex items-center gap-1 px-3 h-[28px] mx-auto">
        {/* Git branch */}
        <span className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)] px-2">
          <svg
            className="size-2.5"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          >
            <circle cx="3.5" cy="3.5" r="2" />
            <circle cx="8.5" cy="8.5" r="2" />
            <path d="M3.5 5.5v2.5M8.5 6.5l-5 5" />
          </svg>
          {gitBranchLabel}
          {gitDirty > 0 && (
            <span className="text-[var(--color-accent-orange)]"> {gitDirty}</span>
          )}
        </span>

        <span className="w-px h-3 bg-[var(--color-border-glass)]" />

        {/* Source Control */}
        <SourceControlToggle />
        <button
          onClick={toggleProblems}
          title="Problems"
          className={`flex items-center gap-1.5 text-[11px] px-2 transition-colors ${
            problemsOpen ? "text-[var(--color-text-secondary)]" : ""
          }`}
        >
          <span className="flex items-center gap-0.5 text-[var(--color-accent-red)]">
            <span className="text-xs select-none">\u25CF</span>
            {lspErrors}
          </span>
          <span className="flex items-center gap-0.5 text-[var(--color-accent-orange)]">
            <span className="text-xs select-none">\u25B2</span>
            {lspWarnings}
          </span>
        </button>

        <span className="w-px h-3 bg-[var(--color-border-glass)]" />

        {/* Node version */}
        {nodeVersion && (
          <>
            <span className="text-[11px] text-[var(--color-text-tertiary)] px-2">
              \u2B22 {nodeVersion}
            </span>
            <span className="w-px h-3 bg-[var(--color-border-glass)]" />
          </>
        )}

        {/* Progress */}
        {progress && (
          <span className="text-[11px] text-[var(--color-accent-teal)] px-2">
            {progress.label} {progress.percent}%
          </span>
        )}

        {/* Toggles */}
        <button
          onClick={toggleDebug}
          title="Debug"
          className={`flex items-center gap-1 text-[11px] px-2 transition-colors ${
            debugVisible || debugSessionId != null
              ? "text-[var(--color-accent-red)]"
              : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          }`}
        >
          <svg className="size-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a2 2 0 0 1 2 2v.35A4 4 0 0 1 12 7v1a4 4 0 0 1-1.2 2.85l.95.95a.5.5 0 0 1-.7.7l-1.1-1.1c-.6.25-1.25.4-1.95.4s-1.35-.15-1.95-.4l-1.1 1.1a.5.5 0 0 1-.7-.7l.95-.95A4 4 0 0 1 4 8V7a4 4 0 0 1 2-3.5A2 2 0 0 1 8 1zm0-1a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />
          </svg>
          Debug
        </button>
        <button
          onClick={toggleChat}
          title="AI Chat"
          className={`flex items-center gap-1 text-[11px] px-2 transition-colors ${
            chatVisible
              ? "text-[var(--color-accent-purple)]"
              : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          }`}
        >
          <svg className="size-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414A2 2 0 0 0 3 11.586l-2 2V2a1 1 0 0 1 1-1h12zM2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 5.414 11H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H2z" />
            <path d="M3 3.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zM3 6a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9A.5.5 0 0 1 3 6zm0 2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5z" />
          </svg>
          Chat
        </button>
        <button
          onClick={toggleTerminal}
          className={`text-[11px] px-2 transition-colors ${
            terminalVisible
              ? "text-[var(--color-text-secondary)]"
              : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          }`}
        >
          {"\u25BE"} Terminal
        </button>
        <button
          onClick={toggleInspector}
          className={`text-[11px] px-2 transition-colors ${
            visible
              ? "text-[var(--color-text-secondary)]"
              : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          }`}
        >
          {visible ? "\u25B6" : "\u25C0"}
        </button>
        <button
          onClick={toggleTheme}
          title={`Theme: ${themeVariant}`}
          className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] px-2 transition-colors"
        >
          \u263E {themeVariant}
        </button>
      </div>
    </footer>
  );
}