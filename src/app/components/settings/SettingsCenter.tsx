'use client';

/**
 * Settings Center — the modal shell.
 *
 * Component hierarchy
 * -------------------
 *   SettingsCenter                 dialog chrome, scope switch, footer
 *   ├── CategorySidebar            search box + category list
 *   │   └── (row per category)     title, icon, modified badge
 *   └── content pane
 *       ├── CategoryPanel           generated from the registry
 *       │   └── Group / SettingRow  generated from the registry
 *       │       └── Control         toggle | select | number | slider |
 *       │                            text | path | color | env editor
 *       ├── KeymapEditor            command list + chord recorder
 *       └── JsonSettingsEditor      raw settings.json + schema validation
 *
 * Two behaviours are worth calling out:
 *
 * * **Search scopes to results.** Typing filters the registry; the category
 *   list narrows to categories that still have matches, and a category with
 *   no matching row is skipped entirely. Clearing the box restores the full
 *   list. The result count is always visible so an empty pane is never a
 *   mystery.
 * * **Scope is explicit.** User and Workspace settings are the same schema
 *   with a different destination. A switch in the header makes the current
 *   destination unmistakable, because a value entered into the wrong layer is
 *   the most confusing thing a layered settings model can do.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { Button, EmptyState, useFocusTrap } from './controls';
import { CategoryPanel } from './SettingsPanels';
import { KeymapEditor } from './KeymapEditor';
import { JsonSettingsEditor } from './JsonSettingsEditor';
import { SETTINGS_CATEGORIES, searchSettings, type SettingsCategory } from './registry';
import {
  modifiedKeys,
  resetScope,
  type SettingsScope,
} from '../../features/settings/store';
import type { SettingsSection } from '../../features/settings/schema';
import { useSettingsState } from './useSettings';

export interface SettingsCenterProps {
  onClose: () => void;
  onReplayTutorial: () => void;
  onToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Absolute workspace root, or `''` on the welcome screen. Workspace-scope
   *  settings are disabled without one. */
  workspaceRoot: string;
  /** Pre-select a category, e.g. when opened from "Configure Editor Font". */
  initialCategory?: SettingsSection;
}

type View = 'form' | 'json';

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function CategorySidebar({
  categories, active, onSelect, query, onQuery, modifiedCounts,
}: {
  categories: SettingsCategory[];
  active: SettingsSection;
  onSelect: (id: SettingsSection) => void;
  query: string;
  onQuery: (q: string) => void;
  modifiedCounts: Record<SettingsScope, Set<string>>;
}) {
  const searchRef = React.useRef<HTMLInputElement>(null);

  // `/` focuses the search box, the way every developer tool does it. Guarded
  // so it does not fire while the user is typing a path into a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <nav
      className="w-[228px] shrink-0 flex flex-col border-r border-[var(--ag-border)] bg-[var(--ag-raised)]/40 min-h-0"
      aria-label="Settings categories"
    >
      <div className="p-2.5 shrink-0">
        <div className="relative">
          <Icon name="search" size={12} className="ide-field-icon" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            spellCheck={false}
            className="w-full bg-[var(--ag-bg)] border border-[var(--ag-border)] rounded-md py-1.5 pl-7 pr-7 text-[12px] text-[var(--ag-fg)] outline-none focus:border-[var(--ag-accent)] placeholder:text-[var(--ag-faint)]"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-[var(--ag-faint)] hover:text-[var(--ag-fg)]"
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto ide-scrollbar px-1.5 pb-2 min-h-0">
        {categories.map((category) => {
          const isActive = category.id === active;
          const modified = category.groups
            .flatMap((g) => g.items)
            .filter((i) => modifiedCounts.user.has(i.key) || modifiedCounts.workspace.has(i.key)).length;
          return (
            <button
              key={category.id}
              type="button"
              onClick={() => onSelect(category.id)}
              aria-current={isActive}
              className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-[12.5px] transition-colors ${
                isActive
                  ? 'bg-[var(--ag-accent)]/12 text-[var(--ag-fg)]'
                  : 'text-[var(--ag-muted)] hover:bg-[var(--ag-hover)] hover:text-[var(--ag-fg)]'
              }`}
            >
              <Icon
                name={category.icon}
                size={14}
                className={isActive ? 'text-[var(--ag-accent-bright)]' : 'text-[var(--ag-faint)]'}
              />
              <span className="flex-1 truncate">{category.title}</span>
              {modified > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--ag-accent-bright)] shrink-0" title={`${modified} modified`} />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

export default function SettingsCenter({
  onClose, onReplayTutorial, onToast, workspaceRoot, initialCategory,
}: SettingsCenterProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<SettingsSection>(initialCategory ?? 'general');
  const [view, setView] = useState<View>('form');
  const [scope, setScope] = useState<SettingsScope>('user');

  const state = useSettingsState();

  const canUseWorkspaceScope = workspaceRoot.length > 0;
  // A workspace scope is meaningless without a folder; fall back rather than
  // showing a switch that silently does nothing.
  const effectiveScope: SettingsScope = scope === 'workspace' && !canUseWorkspaceScope ? 'user' : scope;

  const results = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim().length > 0;

  /**
   * A search can hide the selected category (typing "ligature" while on
   * General). Rather than an effect that re-selects after paint — which
   * renders an empty pane for one frame — the *effective* category is derived
   * during render and the selection follows the first match.
   */
  const firstMatch = results.categories[0]?.category.id;
  const activeVisible = !searching || results.categories.some((c) => c.category.id === active);
  const effectiveActive: SettingsSection = activeVisible || !firstMatch ? active : firstMatch;

  const modifiedCounts = useMemo(() => {
    void state;
    return {
      user: new Set(modifiedKeys('user')),
      workspace: new Set(modifiedKeys('workspace')),
    };
  }, [state]);

  const closeRef = useFocusTrap(true, onClose);

  // Ctrl+, opens Settings from anywhere in the IDE, and toggling the view with
  // Ctrl+Shift+P is left to the host command palette.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && view === 'json') { e.stopPropagation(); setView('form'); }
  }, [view]);

  const activeCategory = SETTINGS_CATEGORIES.find((c) => c.id === effectiveActive) ?? SETTINGS_CATEGORIES[0];
  const activeGroups = results.categories.find((c) => c.category.id === effectiveActive)?.groups ?? activeCategory.groups;
  const dirtyCount = effectiveScope === 'user' ? modifiedCounts.user.size : modifiedCounts.workspace.size;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="settings-scrim-enter absolute inset-0 bg-black/55" onClick={onClose} aria-hidden />

      <div
        ref={closeRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onKeyDown={onKeyDown}
        className="settings-center-enter relative flex flex-col w-[min(1080px,94vw)] h-[min(720px,90vh)] bg-[var(--ag-bg)] border border-[var(--ag-border)] rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <header className="shrink-0 h-11 flex items-center justify-between gap-3 px-3 border-b border-[var(--ag-border)] bg-[var(--ag-raised)]">
          <div className="flex items-center gap-2 min-w-0">
            <Icon name="gear" size={15} className="text-[var(--ag-accent-bright)]" />
            <span className="text-[13px] font-semibold text-[var(--ag-fg)]">Settings</span>

            {/* Scope switch. A segmented control rather than a dropdown so the
                active destination is always visible — this is the one thing a
                user must never misread. */}
            <div className="ml-2 flex items-center rounded-md border border-[var(--ag-border)] overflow-hidden" role="group" aria-label="Settings scope">
              {(['user', 'workspace'] as SettingsScope[]).map((s) => {
                const disabled = s === 'workspace' && !canUseWorkspaceScope;
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={disabled}
                    title={
                      disabled
                        ? 'Open a workspace folder to use project-scoped settings'
                        : s === 'user'
                          ? 'Applies to every window of Agamiz Code'
                          : 'Overrides the user settings for this project only'
                    }
                    onClick={() => setScope(s)}
                    className={`px-2.5 py-1 text-[11px] capitalize transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      effectiveScope === s
                        ? 'bg-[var(--ag-accent)] text-[var(--ag-accent-contrast)] font-semibold'
                        : 'text-[var(--ag-muted)] hover:bg-[var(--ag-hover)] hover:text-[var(--ag-fg)]'
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>

            {effectiveScope === 'workspace' && workspaceRoot && (
              <span className="text-[10.5px] text-[var(--ag-faint)] font-mono truncate max-w-[220px]" title={workspaceRoot}>
                {workspaceRoot.split(/[\\/]/).pop()}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              icon="file-code"
              onClick={() => setView((v) => (v === 'form' ? 'json' : 'form'))}
              title={`Edit ${effectiveScope === 'user' ? 'settings.json' : '.agamiz/settings.json'} as raw JSON`}
            >
              Open settings.json
            </Button>
            <Button variant="ghost" onClick={onReplayTutorial} icon="book" title="Replay the first-run tour">
              Tour
            </Button>
            <Button variant="ghost" onClick={onClose} icon="x" title="Close (Esc)" autoFocus />
          </div>
        </header>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {view === 'form' ? (
            <>
              <CategorySidebar
                categories={results.categories.map((c) => c.category)}
                active={effectiveActive}
                onSelect={(id) => { setActive(id); setQuery(''); }}
                query={query}
                onQuery={setQuery}
                modifiedCounts={modifiedCounts}
              />

              <main className="flex-1 min-w-0 overflow-y-auto ide-scrollbar px-6 py-5" key={`${effectiveActive}-${effectiveScope}`}>
                {effectiveActive === 'keymap' ? (
                  <KeymapEditor onOpenJson={() => setView('json')} />
                ) : activeGroups.length === 0 ? (
                  <EmptyState
                    title={searching ? 'No matching settings' : 'Nothing to configure here'}
                    body={
                      searching
                        ? `Nothing matches “${query}”. Try a feature word such as autosave, ligatures, terminal or restore.`
                        : 'This category has no settings yet.'
                    }
                  />
                ) : (
                  <>
                    {searching && (
                      <p className="mb-3 text-[11px] text-[var(--ag-muted)]">
                        {results.total} {results.total === 1 ? 'result' : 'results'} for “{query}”
                      </p>
                    )}
                    <CategoryPanel
                      category={activeCategory}
                      groups={activeGroups}
                      scope={effectiveScope}
                      query={query}
                    />
                  </>
                )}
              </main>
            </>
          ) : (
            <JsonSettingsEditor
              key={effectiveScope}
              scope={effectiveScope}
              onBack={() => setView('form')}
              onToast={onToast}
            />
          )}
        </div>

        {/* Footer */}
        <footer className="shrink-0 h-11 flex items-center justify-between gap-3 px-3 border-t border-[var(--ag-border)] bg-[var(--ag-raised)]">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[11px] text-[var(--ag-faint)] truncate">
              {effectiveScope === 'user'
                ? 'Stored in ~/.agamizcode/settings.json'
                : `Stored in ${workspaceRoot}\\.agamiz\\settings.json`}
            </span>
            {!state.hydrated && (
              <span className="text-[10.5px] text-[var(--ag-faint)] flex items-center gap-1">
                <Icon name="rotate-cw" size={10} className="animate-spin" /> syncing
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              icon="rotate-cw"
              disabled={dirtyCount === 0}
              onClick={() => {
                resetScope(effectiveScope);
                onToast(
                  effectiveScope === 'user'
                    ? 'All settings restored to defaults'
                    : 'Workspace overrides cleared',
                  'success',
                );
              }}
              title={`Reset the ${effectiveScope} scope to defaults`}
            >
              Reset to Defaults
            </Button>
            <Button variant="primary" onClick={onClose} icon="check">
              Done
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
