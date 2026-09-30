'use client';

/**
 * Key binding editor.
 *
 * Recording works by capturing the *next* `keydown` on the window while a row
 * is armed, then preventing the default so Ctrl+S does not also save the file
 * the user is trying to rebind. The recorder also swallows plain modifier-only
 * presses (`chordFromEvent` returns `''` for those) so holding Ctrl does not
 * wipe a binding before the real key arrives.
 *
 * Only *differences* from the built-in default are stored. A row that has not
 * been touched shows its default in a muted style and writes nothing, so
 * `keymap.bindings` stays a short, readable override list in settings.json.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { Button, TextInput } from './controls';
import {
  KEYMAP_COMMANDS,
  chordFromEvent,
  chordTokens,
  formatChord,
  normalizeChord,
  resolvedBindings,
} from '../../features/settings/keymap';
import { getValue, setValue } from '../../features/settings/store';
import type { Settings } from '../../features/settings/schema';
import { useResolvedSettings } from './useSettings';

type Bindings = Settings['keymap']['bindings'];

/**
 * Write a binding set. Keymap entries are always user-scoped: a chord is a
 * property of the person at the keyboard, not of the project.
 */
function commit(next: Bindings): void {
  // Drop empty entries so an unbound command does not persist `""`.
  const cleaned: Bindings = {};
  for (const [k, v] of Object.entries(next)) {
    if (v) cleaned[k] = v;
  }
  setValue('keymap.bindings', cleaned, 'user');
}

/** The user's stored overrides, read fresh on every mutation. */
function currentOverrides(): Bindings {
  return (getValue('keymap.bindings') ?? {}) as Bindings;
}

/** Which chord a command currently uses, and whether the user chose it. */
function useBindings() {
  // Reading the resolved view (rather than the raw store) means a workspace
  // keymap override is honoured, and the hook re-runs when any layer changes.
  const { keymap } = useResolvedSettings();
  return useMemo(() => resolvedBindings(keymap.bindings), [keymap.bindings]);
}

/* ------------------------------------------------------------------ */
/* Key chord display                                                   */
/* ------------------------------------------------------------------ */

function Chord({ chord, muted }: { chord: string; muted?: boolean }) {
  if (!chord) return <span className="text-[11px] text-[var(--ag-faint)] italic">Unbound</span>;
  return (
    <span className="inline-flex items-center gap-0.5">
      {chordTokens(chord).map((token, i) => (
        <kbd
          key={`${token}-${i}`}
          className={`px-1.5 py-0.5 rounded border text-[10px] font-sans ${
            muted
              ? 'border-[var(--ag-border)] text-[var(--ag-faint)]'
              : 'border-[var(--ag-accent)]/50 text-[var(--ag-fg)] bg-[var(--ag-accent)]/10'
          }`}
        >
          {token}
        </kbd>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Row                                                                */
/* ------------------------------------------------------------------ */

function BindingRow({
  commandId, label, description, chord, defaultChord, group, isFirst,
}: {
  commandId: string;
  label: string;
  description: string;
  chord: string;
  defaultChord: string;
  group: string;
  isFirst: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState(chord);
  const inputRef = useRef<HTMLInputElement>(null);

  // Adjust the local draft when the binding changes underneath us — a reset, a
  // conflict resolution, or a store change from the JSON editor. React's
  // documented "derive state during render" pattern, which avoids both an
  // effect and a stale-draft frame.
  const [synced, setSynced] = useState({ chord, editing });
  if (chord !== synced.chord || editing !== synced.editing) {
    setSynced({ chord, editing });
    if (!editing) setTyped(chord);
  }

  // Window-level capture. `capture: true` so the editor's own key handler sees
  // the event too and we can stop it before Ctrl+S saves a file mid-recording.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecording(false); return; }
      const next = chordFromEvent(e);
      if (!next) return; // modifier-only press; keep listening
      setRecording(false);
      setEditing(false);
      setTyped(next);
      commit({ ...currentOverrides(), [commandId]: next } as Bindings);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [recording, commandId]);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const overridden = chord !== defaultChord;
  const conflicted = useMemo(() => {
    // Two commands on one chord is legal (the first match wins) but almost
    // always a mistake, so it is surfaced rather than blocked.
    return chord !== '' && KEYMAP_COMMANDS.some((c) => c.id !== commandId && c.defaultChord === chord && !overridden);
  }, [chord, commandId, overridden]);

  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 py-2 border-b border-[var(--ag-border-soft)] last:border-0">
      {!isFirst && <span className="sr-only">End of {group}</span>}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] text-[var(--ag-fg)] truncate">{label}</span>
          {overridden && (
            <span className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-[var(--ag-accent)]/15 text-[var(--ag-accent-bright)]">
              custom
            </span>
          )}
          {conflicted && (
            <span title="Another command uses this chord by default" className="text-amber-400">
              <Icon name="warning" size={11} />
            </span>
          )}
        </div>
        <span className="text-[10.5px] text-[var(--ag-faint)] truncate block">{description}</span>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {recording ? (
          <span className="px-2.5 py-1 text-[11px] text-[var(--ag-accent-bright)] border border-[var(--ag-accent)] rounded-md animate-pulse">
            Press keys…
          </span>
        ) : editing ? (
          <div className="flex items-center gap-1.5">
            <TextInput
              value={typed}
              onChange={(v) => { setTyped(v); const n = normalizeChord(v); commit({ ...currentOverrides(), [commandId]: n } as Bindings); }}
              placeholder="ctrl+shift+p"
            />
            <Button variant="ghost" onClick={() => { setEditing(false); setTyped(chord); }}>Done</Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setRecording(true)}
              title={`Record a new chord (default ${formatChord(defaultChord)})`}
              className="px-2 py-1 rounded-md border border-[var(--ag-border)] bg-[var(--ag-raised)] hover:border-[var(--ag-accent)] transition-colors"
            >
              <Chord chord={chord} muted={!overridden} />
            </button>
            <button
              type="button"
              aria-label={`Type a chord for ${label}`}
              title="Type a chord"
              onClick={() => { setTyped(chord); setEditing(true); }}
              className="p-1 text-[var(--ag-faint)] hover:text-[var(--ag-fg)]"
            >
              <Icon name="pencil" size={12} />
            </button>
            {overridden && (
              <button
                type="button"
                aria-label={`Reset ${label}`}
                title={`Reset to ${formatChord(defaultChord)}`}
                onClick={() => {
                  const next = { ...currentOverrides() } as Bindings;
                  delete next[commandId];
                  commit(next);
                }}
                className="p-1 text-[var(--ag-faint)] hover:text-[var(--ag-accent-bright)]"
              >
                <Icon name="rotate-cw" size={12} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor                                                             */
/* ------------------------------------------------------------------ */

export function KeymapEditor({ onOpenJson }: { onOpenJson: () => void }) {
  const bindings = useBindings();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof KEYMAP_COMMANDS>();
    for (const cmd of KEYMAP_COMMANDS) {
      const list = byGroup.get(cmd.group) ?? [];
      list.push(cmd);
      byGroup.set(cmd.group, list);
    }
    return Array.from(byGroup.entries());
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      KEYMAP_COMMANDS.filter(
        (c) => c.label.toLowerCase().includes(q)
          || c.id.toLowerCase().includes(q)
          || c.description.toLowerCase().includes(q)
          || formatChord(c.defaultChord).toLowerCase().includes(q),
      ).map((c) => c.id),
    );
  }, [query]);

  const overrideCount = bindings.filter((b) => b.overridden).length;

  return (
    <div className="max-w-[760px]">
      <header className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[17px] font-semibold text-[var(--ag-fg)] flex items-center gap-2">
              <Icon name="key" size={17} className="text-[var(--ag-accent-bright)]" />
              Keyboard Shortcuts
            </h2>
            <p className="text-[11.5px] text-[var(--ag-muted)] mt-1">
              Click a chord to record new keys, or use the pencil to type one. Only overrides are saved.
            </p>
          </div>
          <Button icon="file-code" onClick={onOpenJson}>settings.json</Button>
        </div>
      </header>

      <div className="relative mb-4">
        <Icon name="search" size={12} className="ide-field-icon" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter commands…"
          aria-label="Filter commands"
          className="w-full bg-[var(--ag-raised)] border border-[var(--ag-border)] rounded-md py-1.5 pl-7 pr-2 text-[12px] text-[var(--ag-fg)] outline-none focus:border-[var(--ag-accent)] placeholder:text-[var(--ag-faint)]"
        />
      </div>

      {overrideCount > 0 && (
        <div className="flex items-center justify-between mb-4 px-3 py-2 rounded-md bg-[var(--ag-accent)]/10 border border-[var(--ag-accent)]/30">
          <span className="text-[11px] text-[var(--ag-fg)]">
            {overrideCount} custom {overrideCount === 1 ? 'binding' : 'bindings'} override the defaults.
          </span>
          <Button
            variant="ghost"
            icon="rotate-cw"
            onClick={() => commit({})}
          >
            Reset all
          </Button>
        </div>
      )}

      {groups.map(([group, commands]) => {
        const visible = matches
          ? commands.filter((c) => matches.has(c.id))
          : commands;
        if (visible.length === 0) return null;
        return (
          <section key={group} className="mb-5 last:mb-0">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--ag-accent-bright)] mb-1">
              {group}
            </h3>
            {visible.map((cmd, i) => {
              const resolved = bindings.find((b) => b.commandId === cmd.id);
              return (
                <BindingRow
                  key={cmd.id}
                  commandId={cmd.id}
                  label={cmd.label}
                  description={cmd.description}
                  group={group}
                  isFirst={i === 0}
                  chord={resolved?.chord ?? cmd.defaultChord}
                  defaultChord={cmd.defaultChord}
                />
              );
            })}
          </section>
        );
      })}

      {matches && matches.size === 0 && (
        <p className="text-[12px] text-[var(--ag-muted)] py-8 text-center">No command matches “{query}”.</p>
      )}
    </div>
  );
}
