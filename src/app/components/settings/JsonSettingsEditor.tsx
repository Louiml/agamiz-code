'use client';

/**
 * Raw `settings.json` editor with live schema validation.
 *
 * This is the escape hatch for anything the UI does not expose yet, and the
 * place a power user goes when they want to see exactly what the app stored.
 * Three behaviours make it safe to edit JSON by hand:
 *
 *  1. **Never lose work.** Edits live in a local draft. The draft is committed
 *     to the store on Save, and discarded on Cancel — no debounced write to
 *     the file on every keystroke, so a half-typed key can never reach disk.
 *  2. **Validate before writing.** Syntax errors and schema violations are
 *     listed with the offending path. Save is blocked on a syntax error; a
 *     schema violation only blocks when the value is actually wrong-typed,
 *     because an unknown key is a forward-compatibility warning, not a crash.
 *  3. **Show where it lives.** The resolved absolute path is displayed, since
 *     the whole point of the view is that the file is real and editable from
 *     an external editor.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from './controls';
import { parseSettingsJson, serializeSettings, type SchemaViolation } from '../../features/settings/schema';
import {
  getState,
  replaceScope,
  userSettingsPath,
  workspaceSettingsPath,
  type SettingsScope,
} from '../../features/settings/store';

export interface JsonSettingsEditorProps {
  scope: SettingsScope;
  onBack: () => void;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

function ViolationList({ violations }: { violations: SchemaViolation[] }) {
  if (violations.length === 0) return null;
  return (
    <div className="border-t border-[var(--ag-border)] max-h-32 overflow-y-auto ide-scrollbar">
      <div className="px-4 py-2 flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 sticky top-0 bg-[var(--ag-raised)]">
        <Icon name="warning" size={12} />
        {violations.length} schema {violations.length === 1 ? 'issue' : 'issues'}
      </div>
      <ul className="pb-2">
        {violations.map((v, i) => (
          <li key={`${v.path}-${i}`} className="px-4 py-0.5 text-[11px] font-mono flex gap-2">
            <span className="text-[var(--ag-accent-bright)] shrink-0">{v.path || '(root)'}</span>
            <span className="text-[var(--ag-muted)]">{v.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function JsonSettingsEditor({ scope, onBack, onToast }: JsonSettingsEditorProps) {
  // The baseline is what the store currently holds; the draft is what the user
  // has typed. `dirty` is their difference, so Discard is exact and Save is
  // only offered when there is something to write.
  //
  // Both are seeded from the layer's current text and never re-seeded: a
  // scope change remounts this component (the caller keys it on `scope`), and
  // a save from the form view is what moves the baseline forward. Re-deriving
  // from the store on every store change would silently discard the user's
  // in-progress edits.
  const [baseline, setBaseline] = useState<string>(() => currentLayerText(scope));
  const [draft, setDraft] = useState<string>(baseline);
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const p = scope === 'workspace' ? workspaceSettingsPath() : await userSettingsPath();
      if (!cancelled) setPath(p);
    })();
    return () => { cancelled = true; };
  }, [scope]);

  const outcome = useMemo(() => parseSettingsJson(draft), [draft]);
  const dirty = draft !== baseline;
  const canSave = !outcome.syntaxError;

  const save = () => {
    if (outcome.syntaxError || !outcome.settings) {
      onToast('Fix the JSON syntax error first', 'error');
      return;
    }
    if (outcome.violations.some((v) => v.message.startsWith('expected'))) {
      onToast('Fix the reported type errors first', 'error');
      return;
    }
    replaceScope(scope, outcome.settings);
    const text = serializeSettings(outcome.settings);
    setBaseline(text);
    setDraft(text);
    if (outcome.violations.length) {
      onToast(`Saved with ${outcome.violations.length} ignored key(s)`, 'info');
    } else {
      onToast(scope === 'user' ? 'settings.json updated' : 'Workspace settings updated', 'success');
    }
  };

  const format = () => {
    if (outcome.syntaxError || !outcome.settings) return;
    const text = serializeSettings(outcome.settings);
    setDraft(text);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="shrink-0 px-5 py-3 border-b border-[var(--ag-border)] flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-[var(--ag-fg)] flex items-center gap-2">
            <Icon name="file-code" size={15} className="text-[var(--ag-accent-bright)]" />
            {scope === 'user' ? 'User settings.json' : 'Workspace settings'}
          </h2>
          <p className="text-[11px] text-[var(--ag-faint)] mt-0.5 font-mono truncate" title={path ?? 'Local storage only (not running in Tauri)'}>
            {path ?? 'local storage mirror — settings.json needs the desktop runtime'}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button onClick={format} disabled={!!outcome.syntaxError} title="Reformat the document">Format</Button>
          <Button onClick={onBack} icon="chevron-right">Settings</Button>
        </div>
      </header>

      {outcome.syntaxError ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
          <Icon name="warning" size={20} className="text-red-400" />
          <p className="text-[13px] text-[var(--ag-fg)]">Invalid JSON</p>
          <p className="text-[11px] font-mono text-[var(--ag-muted)] max-w-[60ch] break-words">
            {outcome.syntaxError}
          </p>
        </div>
      ) : (
        <textarea
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="settings.json contents"
          className="flex-1 min-h-0 w-full resize-none bg-[var(--ag-editor-bg)] px-4 py-3 text-[12px] leading-[1.6] font-mono text-[var(--ag-fg)] outline-none ide-scrollbar"
        />
      )}

      <ViolationList violations={outcome.violations} />

      <footer className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-t border-[var(--ag-border)]">
        <span className="text-[11px] text-[var(--ag-faint)]">
          {outcome.syntaxError
            ? 'Save is blocked until the document parses.'
            : dirty
              ? 'Unsaved changes.'
              : 'Up to date.'}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            onClick={() => setDraft(baseline)}
            disabled={!dirty}
          >
            Discard
          </Button>
          <Button variant="primary" onClick={save} disabled={!canSave || !dirty}>
            Save to {scope === 'user' ? 'settings.json' : 'workspace'}
          </Button>
        </div>
      </footer>
    </div>
  );
}

/** The layer's current text, read straight from the store. */
function currentLayerText(scope: SettingsScope): string {
  return serializeSettings(scope === 'user' ? getState().user : getState().workspace);
}
