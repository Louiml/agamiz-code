import { useShortcuts } from "./hooks/useShortcuts";
import { Titlebar } from "./components/layout/Titlebar";
import { Toolbar } from "./components/layout/Toolbar";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorCanvas } from "./components/layout/EditorCanvas";
import { InspectorPanel } from "./components/layout/InspectorPanel";
import { TerminalPanel } from "./components/layout/TerminalPanel";
import { RunConsole } from "./components/run/RunConsole";
import { ProblemsPanel } from "./components/layout/ProblemsPanel";
import { DebugPanel } from "./components/debug/DebugPanel";
import { SourceControlPanel } from "./components/source/SourceControlPanel";
import { ChatPanel } from "./components/ai/ChatPanel";
import { StatusBar } from "./components/layout/StatusBar";
import { CommandPalette } from "./components/palette/CommandPalette";
import { FileContextMenu } from "./components/layout/FileContextMenu";
import { useProblemsStore } from "./store";

export function App() {
  useShortcuts();
  const problemsVisible = useProblemsStore((s) => s.visible);

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-base)] text-[var(--color-text-primary)]">
      <Titlebar />
      <div className="flex flex-1 min-h-0">
        <Toolbar />
        <Sidebar />
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          <div className="flex flex-1 min-h-0">
            <EditorCanvas />
            <InspectorPanel />
          </div>
          <TerminalPanel />
          <RunConsole />
          <DebugPanel />
          <SourceControlPanel />
          <ChatPanel />
          {problemsVisible && (
            <div className="flex flex-col h-[160px] shrink-0 border-t border-[var(--color-border-glass)] glass-strong">
              <div className="flex items-center justify-between px-3 h-[28px] shrink-0 border-b border-[var(--color-border-glass)]">
                <span className="text-[11px] font-medium text-[var(--color-text-secondary)] tracking-wide">
                  PROBLEMS
                </span>
                <button
                  onClick={() => useProblemsStore.getState().toggle()}
                  className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                >
                  {"\u2715"}
                </button>
              </div>
              <ProblemsPanel />
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <FileContextMenu />
    </div>
  );
}