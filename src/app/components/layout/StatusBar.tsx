'use client';

import React from 'react';
import { Icon } from '../Icon';
import type { StatusRecord } from '../../features/extensions/bridge';

export interface StatusBarInfo {
  gitBranch?: string | null;
  encoding?: string;
  indent?: string;
  language?: string;
  line: number;
  col: number;
  aiStatus?: 'idle' | 'thinking' | 'ready';
  aiModel?: string;
  /** Native Rak runtime mode, shown only while a Rak file is active. */
  runMode?: string;
  /** Active interpreter/compiler for the current file, e.g. `Python 3.12.1 (.venv)`. */
  interpreter?: string | null;
  /** False when no toolchain could be resolved for this file. */
  interpreterMissing?: boolean;
  dirty?: boolean;
  path?: string;
}

interface StatusBarProps {
  info: StatusBarInfo;
  /** Opens the interpreter quick pick. Optional so the badge degrades to a
   *  plain label when no picker is wired up. */
  onOpenInterpreter?: () => void;
  /**
   * Status-bar items contributed by Lua extensions via
   * `agamiz.statusbar.set_item`. Each carries its owning extension id as a
   * tooltip, so a badge's origin is never a mystery.
   */
  extensionItems?: StatusRecord[];
}

function AiState({ status, model }: { status?: string; model?: string }) {
  if (status === 'thinking' || status === 'ready') {
    return (
      <span className="inline-flex items-center gap-1.5 text-ide-accent-bright">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ide-accent-bright opacity-60" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-ide-accent" />
        </span>
        AI{model ? ` · ${model}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-ide-muted">
      <Icon name="sparkles" size={11} />
      AI
    </span>
  );
}

/**
 * One extension-contributed item.
 *
 * The icon is a single leading character rather than a lookup into the IDE's
 * icon set: extension authors pass strings like `"$(zap)"` or `"●"`, and
 * silently dropping an unrecognised name would make the item look broken.
 */
function ExtensionStatusItem({ item }: { item: StatusRecord }) {
  const icon = item.icon?.replace(/^\$\(|\)$/g, '').trim();
  return (
    <span
      className="px-2 py-0.5 hover:bg-ide-hover rounded-sm text-ide-accent-bright whitespace-nowrap"
      title={`${item.extension_id} · ${item.key}`}
    >
      {icon ? `${icon} ` : ''}
      {item.text}
    </span>
  );
}

/**
 * IDE status bar. Left group carries workspace context, the right group
 * carries document-level indicators, matching VS Code/Cursor conventions.
 */
export default function StatusBar({ info, extensionItems = [], onOpenInterpreter }: StatusBarProps) {
  const {
    gitBranch, encoding = 'UTF-8', indent = 'Spaces: 4', language = 'Plain Text',
    line, col, aiStatus = 'idle', aiModel = 'Ollama', runMode, dirty, path,
    interpreter, interpreterMissing,
  } = info;

  const leftItems = extensionItems.filter((i) => i.alignment === 'left');
  const rightItems = extensionItems.filter((i) => i.alignment !== 'left');

  return (
    <div className="flex items-center justify-between px-3 py-0.5 bg-ide-raised border-t border-ide-border text-[10px] text-ide-muted select-none">
      <div className="flex items-center gap-1 min-w-0">
        {gitBranch ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-ide-accent/15 text-ide-accent-bright rounded-sm shrink-0">
            <Icon name="git-branch" size={11} />
            {gitBranch}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-ide-faint shrink-0">
            <Icon name="git-branch" size={11} />
            No Repository
          </span>
        )}
        {path && (
          <span className="truncate max-w-[220px] text-ide-faint" title={path}>
            {path}
          </span>
        )}
        {dirty && (
          <span className="inline-flex items-center gap-1 text-yellow-400 shrink-0">
            <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
            Unsaved
          </span>
        )}
        {leftItems.map((item) => (
          <ExtensionStatusItem key={item.key} item={item} />
        ))}
      </div>

      <div className="flex items-center gap-1 min-w-0">
        <span className="px-2 py-0.5 hover:bg-ide-hover rounded-sm">Ln {line}, Col {col}</span>
        <span className="px-2 py-0.5 hover:bg-ide-hover rounded-sm">{encoding}</span>
        <span className="px-2 py-0.5 hover:bg-ide-hover rounded-sm">{indent}</span>
        <span className="px-2 py-0.5 hover:bg-ide-hover rounded-sm">{language}</span>
        {runMode && (
          <span className="px-2 py-0.5 text-ide-accent-bright hover:bg-ide-hover rounded-sm">
            {runMode}
          </span>
        )}
        {/* Interpreter badge: the polyglot equivalent of VS Code's language
            version item. Clicking it opens the same quick pick as the header
            badge, so one resolver backs both affordances. */}
        {interpreter && (
          <button
            onClick={onOpenInterpreter}
            title={              interpreterMissing
                ? `${interpreter} \u2014 click to select an interpreter`
                : `${interpreter} \u2014 click to change interpreter`
            }
            className={`px-2 py-0.5 rounded-sm hover:bg-ide-hover inline-flex items-center gap-1 ${
              interpreterMissing ? 'text-amber-400' : 'text-ide-accent-bright'
            }`}
          >
            <Icon name="terminal" size={10} />
            {interpreter}
          </button>
        )}
        <span className="px-2 py-0.5 hover:bg-ide-hover rounded-sm">
          <AiState status={aiStatus} model={aiModel} />
        </span>
        {rightItems.map((item) => (
          <ExtensionStatusItem key={item.key} item={item} />
        ))}
      </div>
    </div>
  );
}