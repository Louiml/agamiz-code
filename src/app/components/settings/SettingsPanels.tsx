'use client';

/**
 * The right-hand pane of the Settings Center.
 *
 * Panels are generated from the registry rather than hand-written, so adding a
 * setting is a one-line change in `registry.ts` and it appears here — in
 * search, in the JSON file, and in the schema validator — automatically.
 *
 * A handful of rows need live data the registry cannot know statically (the
 * theme catalogue, the shells actually installed on this machine). Those are
 * resolved by `dynamicOptions` and the registry's empty `options` array marks
 * the row as dynamic.
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import {
  Button,
  ColorPicker,
  Group,
  NumberInput,
  PathInput,
  Select,
  SettingRow,
  SliderNumber,
  TextInput,
  Toggle,
} from './controls';
import { requirementMet, type SettingDescriptor, type SettingsCategory, type SettingOption } from './registry';
import { THEMES, effectiveAccent } from '../../features/settings/themes';
import {
  getValue,
  resetValue,
  setValue,
  sourceOf,
  type SettingsScope,
} from '../../features/settings/store';
import type { SettingValue } from '../../features/settings/schema';
import { useSettingsState } from './useSettings';
import type { ShellProfile } from '../terminal/types';

/* ------------------------------------------------------------------ */
/* Dynamic options                                                     */
/* ------------------------------------------------------------------ */

/** Theme catalogue for the theme dropdown. */
function themeOptions(): SettingOption[] {
  return THEMES.map((t) => ({ value: t.id, label: t.name }));
}

/** Shells the Rust `pty_profiles` command found, plus a "system default"
 *  entry. Probed once when the Terminal panel first renders. */
export function useShellProfiles(enabled: boolean): SettingOption[] {
  const [options, setOptions] = useState<SettingOption[]>([{ value: '', label: 'System default' }]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const { fetchProfiles } = await import('../terminal/pty');
        const profiles: ShellProfile[] = await fetchProfiles([]);
        if (cancelled) return;
        setOptions([
          { value: '', label: 'System default' },
          ...profiles.map((p) => ({
            value: p.id,
            // Detected-but-missing shells are still listed: a user may install
            // one after first run, and hiding the row would strand the setting.
            label: p.available ? `${p.name} — ${p.short}` : `${p.name} (not installed)`,
          })),
        ]);
      } catch {
        /* the dropdown degrades to "System default" */
      }
    })();
    return () => { cancelled = true; };
  }, [enabled]);

  return options;
}

function dynamicOptions(item: SettingDescriptor, shells: SettingOption[]): SettingOption[] | null {
  if (item.options && item.options.length > 0) return item.options;
  if (item.key === 'appearance.theme') return themeOptions();
  if (item.key === 'terminal.defaultProfileId') return shells;
  return null;
}

/* ------------------------------------------------------------------ */
/* One control                                                         */
/* ------------------------------------------------------------------ */

function Control({
  item, scope, disabled, shells,
}: {
  item: SettingDescriptor;
  scope: SettingsScope;
  disabled: boolean;
  shells: SettingOption[];
}) {
  const value = getValue(item.key) as SettingValue;
  const id = `set-${item.key.replace(/\./g, '-')}`;
  const write = (next: SettingValue) => setValue(item.key, next, scope);

  const options = dynamicOptions(item, shells);

  switch (item.control) {
    case 'toggle':
      return <Toggle id={id} on={value === true} onChange={write} disabled={disabled} />;

    case 'select': {
      if (!options) return null;
      const v = String(value ?? '');
      // A stored value that no longer exists (a theme or profile removed since
      // the settings were written) must not blank the dropdown.
      const known = options.some((o) => o.value === v);
      return (
        <Select
          id={id}
          value={v}
          disabled={disabled}
          onChange={write}
          options={known ? options : [{ value: v, label: `${v} (unavailable)` }, ...options]}
        />
      );
    }

    case 'number': {
      const min = item.min ?? 0;
      const max = item.max ?? 100;
      const isSlider = max - min > 1 && item.unit !== 'lines';
      const format = (v: number) => {
        if (item.key === 'appearance.uiScale') return `${Math.round(v * 100)}%`;
        if (item.key === 'editor.lineHeight' || item.key === 'terminal.lineHeight' || item.key === 'editor.minimapScale') {
          return `${Number(v.toFixed(2))}×`;
        }
        return `${Number(v.toFixed(1))}${item.unit ?? ''}`;
      };
      return isSlider ? (
        <SliderNumber
          id={id} value={Number(value)} onChange={write} min={min} max={max}
          step={item.step ?? 1} unit={item.unit} disabled={disabled} format={format}
        />
      ) : (
        <NumberInput
          id={id} value={Number(value)} onChange={write} min={min} max={max}
          step={item.step ?? 1} unit={item.unit} disabled={disabled}
        />
      );
    }

    case 'text':
      return (
        <TextInput
          id={id} value={String(value ?? '')} onChange={write}
          placeholder={item.placeholder} disabled={disabled} icon="pencil"
        />
      );

    case 'path':
      return (
        <PathInput
          id={id} value={String(value ?? '')} onChange={write}
          placeholder={item.placeholder} title={item.label} disabled={disabled}
        />
      );

    case 'color': {
      const theme = String(getValue('appearance.theme'));
      return (
        <ColorPicker
          id={id}
          value={typeof value === 'string' ? value : null}
          effective={effectiveAccent(theme, typeof value === 'string' ? value : null)}
          onChange={write}
          disabled={disabled}
        />
      );
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Row wrapper                                                         */
/* ------------------------------------------------------------------ */

function RowFor({
  item, scope, shells, showModified,
}: {
  item: SettingDescriptor;
  scope: SettingsScope;
  shells: SettingOption[];
  showModified: boolean;
}) {
  const source = sourceOf(item.key);
  // `requires` is only ever satisfied by a primitive setting (a toggle or an
  // enum), so narrow the resolver's return type at the boundary.
  const enabled = requirementMet(item.requires, (k) => {
    const v = getValue(k);
    return v === null || typeof v === 'object' ? undefined : v;
  });
  // A user-only setting cannot be written to the workspace layer, so the
  // control is inert there rather than silently writing to the other scope.
  const editable = item.scopes.includes(scope);
  const disabled = !enabled || !editable;
  const id = `set-${item.key.replace(/\./g, '-')}`;
  const canReset = source !== 'default' && source === scope;
  const resetScope: SettingsScope = source === 'workspace' ? 'workspace' : 'user';

  return (
    <SettingRow
      settingKey={item.key}
      label={item.label}
      description={
        editable
          ? item.description
          : `${item.description} This setting is personal, so it can only be changed in the User scope.`
      }
      htmlFor={id}
      disabled={disabled}
      modified={showModified && source !== 'default'}
      className={item.emphasis === 'warning' ? 'text-amber-200/90' : ''}
      footer={
        canReset ? (
          <button
            type="button"
            onClick={() => resetValue(item.key, resetScope)}
            className="self-start mt-0.5 inline-flex items-center gap-1 text-[10px] text-[var(--ag-faint)] hover:text-[var(--ag-accent-bright)] transition-colors"
            title={`Reset ${item.key} to its default`}
          >
            <Icon name="rotate-cw" size={10} /> Reset
          </button>
        ) : null
      }
    >
      {item.control === 'env'
        ? <EnvEditor settingKey={item.key} scope={scope} disabled={disabled} />
        : <Control item={item} scope={scope} disabled={disabled} shells={shells} />}
    </SettingRow>
  );
}

/**
 * Free-form `NAME=value` editor for `run.env`.
 *
 * A hand-rolled table rather than a textarea: variable names are the thing
 * users get wrong, and per-row affordances (add, delete, duplicate) make the
 * mistake visible. Keys are sorted on commit so the JSON file diffs cleanly.
 */
function EnvEditor({ settingKey, scope, disabled }: { settingKey: string; scope: SettingsScope; disabled: boolean }) {
  const stored = (getValue(settingKey) ?? {}) as Record<string, string>;
  const entries = Object.entries(stored).sort(([a], [b]) => a.localeCompare(b));
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const commit = (next: Record<string, string>) => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      const key = k.trim();
      if (key) cleaned[key] = v;
    }
    setValue(settingKey, cleaned, scope);
  };

  return (
    <div className="w-[320px] max-w-full flex flex-col gap-1.5">
      {entries.length === 0 && (
        <p className="text-[11px] text-[var(--ag-faint)]">No variables. Inherited from the parent process.</p>
      )}
      {entries.map(([name, val]) => (
        <div key={name} className="flex items-center gap-1.5">
          <input
            aria-label={`Variable ${name}`}
            value={name}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => {
              const next = { ...stored };
              delete next[name];
              next[e.target.value] = val;
              commit(next);
            }}
            className="w-[40%] bg-[var(--ag-raised)] border border-[var(--ag-border)] rounded px-1.5 py-0.5 text-[11px] font-mono text-[var(--ag-fg)] outline-none focus:border-[var(--ag-accent)]"
          />
          <input
            aria-label={`Value of ${name}`}
            value={val}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => commit({ ...stored, [name]: e.target.value })}
            className="flex-1 bg-[var(--ag-raised)] border border-[var(--ag-border)] rounded px-1.5 py-0.5 text-[11px] font-mono text-[var(--ag-fg)] outline-none focus:border-[var(--ag-accent)]"
          />
          <button
            type="button"
            aria-label={`Remove ${name}`}
            disabled={disabled}
            onClick={() => {
              const next = { ...stored };
              delete next[name];
              commit(next);
            }}
            className="p-1 text-[var(--ag-faint)] hover:text-red-400 disabled:opacity-50"
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      ))}
      {adding ? (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={newName}
            placeholder="NAME"
            spellCheck={false}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const name = newName.trim();
              if (name) commit({ ...stored, [name]: '' });
              setNewName('');
              setAdding(false);
            }}
            className="w-[40%] bg-[var(--ag-raised)] border border-[var(--ag-accent)] rounded px-1.5 py-0.5 text-[11px] font-mono text-[var(--ag-fg)] outline-none"
          />
          <Button onClick={() => { const name = newName.trim(); if (name) commit({ ...stored, [name]: '' }); setNewName(''); setAdding(false); }}>
            Add
          </Button>
          <Button variant="ghost" onClick={() => { setNewName(''); setAdding(false); }}>Cancel</Button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding(true)}
          className="self-start inline-flex items-center gap-1 text-[11px] text-[var(--ag-muted)] hover:text-[var(--ag-accent-bright)] disabled:opacity-50"
        >
          <Icon name="plus" size={11} /> Add variable
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function CategoryPanel({
  category, groups, scope, query,
}: {
  category: SettingsCategory;
  groups: { id: string; title: string; hint?: string; items: SettingDescriptor[] }[];
  scope: SettingsScope;
  query: string;
}) {
  // Subscribing once here re-renders the whole panel on any settings change,
  // which is the right granularity: a settings panel is small, and this keeps
  // every row reading from one consistent snapshot instead of each row
  // subscribing independently.
  useSettingsState();

  const shells = useShellProfiles(category.id === 'terminal');
  const searching = query.trim().length > 0;

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="max-w-[760px]">
      <header className="mb-5">
        <h2 className="text-[17px] font-semibold text-[var(--ag-fg)] flex items-center gap-2">
          <Icon name={category.icon} size={17} className="text-[var(--ag-accent-bright)]" />
          {category.title}
        </h2>
        <p className="text-[11.5px] text-[var(--ag-muted)] mt-1">{category.blurb}</p>
      </header>

      {groups.map((group) => (
        <Group key={group.id} title={group.title} hint={group.hint}>
          {group.items.map((item) => (
            <RowFor key={item.key} item={item} scope={scope} shells={shells} showModified={!searching} />
          ))}
        </Group>
      ))}
    </div>
  );
}
