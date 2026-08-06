import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useGitStore } from "../../store";
import type { GitBranches, GitEntry, GitStatus } from "../../types";

// Shared visibility state so the StatusBar toggle drives this panel.
import { create } from "zustand";

export const useSourceControlStore = create<{ visible: boolean; toggle: () => void }>(
  (set) => ({
    visible: false,
    toggle: () => set((s) => ({ visible: !s.visible })),
  }),
);

export function SourceControlToggle() {
  const visible = useSourceControlStore((s) => s.visible);
  const toggle = useSourceControlStore((s) => s.toggle);
  const dirty = useGitStore((s) => s.status?.dirtyCount ?? 0);
  return (
    <button
      onClick={toggle}
      title="Source Control"
      className={`flex items-center gap-1 text-[11px] px-2 transition-colors ${
        visible
          ? "text-[var(--color-text-secondary)]"
          : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
      }`}
    >
      <span className="text-xs">
        {dirty > 0 ? "\u25CF" : "\u25CB"}
      </span>
      Source Control
    </button>
  );
}

export function SourceControlPanel() {
  const visible = useSourceControlStore((s) => s.visible);
  const setVisible = (_v: boolean) => useSourceControlStore.setState({ visible: _v });
  const status = useGitStore((s) => s.status);
  const branches = useGitStore((s) => s.branches);
  const setStatus = useGitStore((s) => s.setStatus);
  const setBranches = useGitStore((s) => s.setBranches);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>("");
  const [commitMessage, setCommitMessage] = useState("");

  // Listen to background git:status snapshots.
  useEffect(() => {
    const un = listen<GitStatus>("git:status", ({ payload }) => {
      useGitStore.getState().setStatus(payload);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([
        invoke<GitStatus>("git_status"),
        invoke<GitBranches>("git_branches"),
      ]);
      setStatus(s);
      setBranches(b);
    } catch {}
  }, [setStatus, setBranches]);

  useEffect(() => {
    if (visible) void refreshAll();
  }, [visible, refreshAll]);

  const selectFile = async (path: string) => {
    setSelectedPath(path);
    try {
      const diff = await invoke<{ patch: string }>("git_diff", { path });
      setDiffText(diff.patch || "No changes.");
    } catch {
      setDiffText("No diff available.");
    }
  };

  const toggleStage = async (entry: GitEntry) => {
    try {
      const s = await invoke<GitStatus>("git_stage", { path: entry.path, staged: !entry.staged });
      setStatus(s);
    } catch {}
  };

  const stageAll = async () => {
    try {
      const s = await invoke<GitStatus>("git_stage_all");
      setStatus(s);
    } catch {}
  };

  const doCommit = async () => {
    if (!commitMessage.trim()) return;
    try {
      await invoke<{ success: boolean; message: string }>("git_commit", {
        message: commitMessage,
      });
      setCommitMessage("");
      await refreshAll();
    } catch {}
  };

  const switchBranch = async (name: string) => {
    try {
      const s = await invoke<GitStatus>("git_checkout", { branch: name });
      setStatus(s);
      const b = await invoke<GitBranches>("git_branches");
      setBranches(b);
    } catch {}
  };

  if (!visible) return null;

  const renderEntries = (entries: GitEntry[], sectionLabel: string, staged: boolean) => {
    if (entries.length === 0) return null;
    return (
      <div className="mt-2">
        <div className="px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          {sectionLabel} ({entries.length})
        </div>
        {entries.map((e) => (
          <div
            key={e.path}
            className={`group flex items-center gap-2 px-3 py-0.5 text-[12px] cursor-pointer hover:bg-[var(--color-bg-glass)] transition-colors ${
              selectedPath === e.path ? "bg-[var(--color-bg-glass-strong)]" : ""
            }`}
            onClick={() => void selectFile(e.path)}
          >
            <span
              className={`w-3 text-center text-[10px] font-semibold ${
                staged ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-orange)]"
              }`}
            >
              {e.status}
            </span>
            <span className="flex-1 min-w-0 truncate font-mono">{e.path}</span>
            <button
              onClick={(ev) => {
                ev.stopPropagation();
                void toggleStage(e);
              }}
              className="opacity-0 group-hover:opacity-100 text-[10px] px-1 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            >
              {staged ? "Unstage" : "+"}
            </button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col shrink-0 border-t border-[var(--color-border-glass)] glass" style={{ height: 240 }}>
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--color-border-glass)]">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)]">
          Source Control
        </span>
        {status && (
          <span className="text-[11px] text-[var(--color-text-secondary)]">
            {status.currentBranch}
          </span>
        )}
        <div className="flex-1" />
        {branches && (
          <select
            value={branches.current}
            onChange={(e) => void switchBranch(e.target.value)}
            className="text-[11px] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] border border-[var(--color-border-glass)] rounded-md px-1.5 py-0.5 outline-none"
          >
            {branches.local.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            {branches.remote.map((b) => (
              <option key={b} value={b}>
                {b.replace(/^origin\//, "origin/")}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={stageAll}
          className="text-[11px] px-2 py-0.5 rounded bg-[var(--color-bg-glass-strong)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          Stage All
        </button>
        <button
          onClick={() => setVisible(false)}
          className="w-6 h-6 rounded flex items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-glass-hover)] hover:text-[var(--color-text-primary)]"
        >
          {"\u2715"}
        </button>
      </div>

      {!status ? (
        <div className="p-3 text-[11px] text-[var(--color-text-tertiary)]">
          Not a git repository.
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="w-1/2 min-w-0 overflow-y-auto scrollbar-apple">
            {renderEntries(status.staged, "Staged", true)}
            {renderEntries(status.unstaged, "Changes", false)}
            {renderEntries(status.untracked, "Untracked", false)}
            {status.staged.length + status.unstaged.length + status.untracked.length === 0 && (
              <div className="p-3 text-[11px] text-[var(--color-text-tertiary)]">
                Working tree clean.
              </div>
            )}
          </div>

          <div className="w-px bg-[var(--color-border-glass)] shrink-0" />

          <div className="w-1/2 min-w-0 flex flex-col">
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message"
              className="h-[44px] shrink-0 m-2 mb-0 px-2 py-1 text-[12px] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] border border-[var(--color-border-glass)] rounded-md outline-none resize-none focus:border-[var(--color-border-focus)]"
            />
            <button
              onClick={() => void doCommit()}
              disabled={!commitMessage.trim()}
              className="mx-3 mt-1 mb-2 px-2 py-1 text-[11px] text-center rounded-md bg-[var(--color-accent-blue)] text-white font-medium disabled:opacity-40"
            >
              Commit
            </button>
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-apple px-3 pb-3">
              <pre className="font-mono text-[11px] leading-5 text-[var(--color-text-primary)] whitespace-pre-wrap">
                {diffText || (selectedPath ? "Loading diff…" : "Select a file to view its diff.")}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}