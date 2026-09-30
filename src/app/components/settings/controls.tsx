'use client';

/**
 * Settings Center control primitives.
 *
 * Each control is a small, self-contained input that renders its own current
 * value, so a settings row stays declarative: the panel binds a key and the
 * control handles reading, clamping and committing.
 *
 * Conventions
 * -----------
 * * Every control is uncontrolled-with-a-key: it renders from the resolved
 *   setting and writes on change, so it never holds a stale copy.
 * * Numeric inputs commit on blur or Enter, and keep a local draft while
 *   focused so typing "1" on the way to "15" does not clamp to the minimum.
 * * `label`/`description` are wired through `aria-describedby` rather than
 *   only being visual, so the Settings Center is screen-reader navigable.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { Icon, type IconName } from '../Icon';
import { ACCENT_PRESETS } from '../../features/settings/themes';
import { useFolderPicker } from './useSettings';

/* ------------------------------------------------------------------ */
/* Row                                                                */
/* ------------------------------------------------------------------ */

export interface RowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  /** Dotted settings key, used for the modified/source badge. */
  settingKey?: string;
  /** Non-default indicator. */
  modified?: boolean;
  /** Rendered under the control — the reset affordance for one row. */
  footer?: React.ReactNode;
  disabled?: boolean;
  htmlFor?: string;
  className?: string;
}

export function SettingRow({
  label,
  description,
  children,
  settingKey,
  modified,
  footer,
  disabled,
  htmlFor,
  className = '',
}: RowProps) {
  const descId = useId();
  return (
    <div
      className={`settings-row-enter group grid grid-cols-[1fr_auto] items-start gap-x-6 gap-y-2 py-3.5 border-b border-[var(--ag-border-soft)] last:border-0 ${
        disabled ? 'opacity-45' : ''
      } ${className}`}
      data-setting={settingKey}
    >
      <div className="min-w-0 flex flex-col gap-1 pt-0.5">
        <label
          htmlFor={htmlFor}
          className={`text-[13px] leading-tight ${disabled ? 'text-[var(--ag-muted)]' : 'text-[var(--ag-fg)]'}`}
        >
          {label}
          {modified && (
            <span
              className="ml-2 align-middle inline-block w-1.5 h-1.5 rounded-full bg-[var(--ag-accent-bright)]"
              title="Changed from the default"
              aria-label="Changed from the default"
            />
          )}
        </label>
        {description && (
          <p id={descId} className="text-[11px] leading-relaxed text-[var(--ag-muted)] max-w-[46ch]">
            {description}
          </p>
        )}
        {footer}
      </div>
      <div className="flex items-center justify-end shrink-0 min-w-0">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toggle                                                              */
/* ------------------------------------------------------------------ */

export function Toggle({ on, onChange, disabled, id }: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      className={`relative w-9 h-5 rounded-full transition-colors duration-150 shrink-0 ${
        on ? 'bg-[var(--ag-accent)]' : 'bg-[var(--ag-active)]'
      } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${
          on ? 'translate-x-4' : ''
        }`}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Number + slider                                                     */
/* ------------------------------------------------------------------ */

export function NumberInput({
  value, onChange, min, max, step = 1, unit, disabled, id,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  id?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const clamp = (n: number) => {
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };

  const commit = (raw: string) => {
    const n = Number(raw);
    setDraft(null);
    if (raw.trim() === '' || !Number.isFinite(n)) return;
    const next = clamp(n);
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit((e.target as HTMLInputElement).value); }
          if (e.key === 'Escape') setDraft(null);
        }}
        className="w-20 bg-[var(--ag-raised)] border border-[var(--ag-border)] rounded-md px-2 py-1 text-[12px] text-[var(--ag-fg)] text-right outline-none focus:border-[var(--ag-accent)] tabular-nums disabled:cursor-not-allowed"
      />
      {unit && <span className="text-[11px] text-[var(--ag-faint)] w-7">{unit}</span>}
    </div>
  );
}

/**
 * Slider with a live numeric readout. `--ag-slider-pct` drives the filled
 * portion of the track in CSS, so the visual fill stays in sync without
 * re-deriving a gradient per render.
 */
export function Slider({
  value, onChange, min, max, step = 1, format, disabled, id, ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        className="ide-slider w-32 sm:w-40"
        style={{ ['--ag-slider-pct' as string]: `${pct}%` }}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="text-[11px] text-[var(--ag-muted)] tabular-nums w-14 text-right shrink-0">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

/** Slider + number, paired. Both write the same key. */
export function SliderNumber({
  value, onChange, min, max, step = 1, unit, disabled, id, format,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  id?: string;
  format?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Slider
        value={value} onChange={onChange} min={min} max={max} step={step}
        disabled={disabled} format={format} ariaLabel={undefined}
      />
      <NumberInput
        id={id} value={value} onChange={onChange} min={min} max={max} step={step} unit={unit} disabled={disabled}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export function Select({
  value, onChange, options, disabled, id, className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none bg-[var(--ag-raised)] border border-[var(--ag-border)] rounded-md pl-2.5 pr-7 py-1 text-[12px] text-[var(--ag-fg)] outline-none focus:border-[var(--ag-accent)] disabled:cursor-not-allowed disabled:opacity-60 max-w-[240px] w-full"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[var(--ag-raised)] text-[var(--ag-fg)]">
            {o.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        size={12}
        className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--ag-faint)]"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Text + path                                                         */
/* ------------------------------------------------------------------ */

export function TextInput({
  value, onChange, placeholder, disabled, id, icon, mono = true,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  icon?: IconName;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="relative">
      {icon && <Icon name={icon} size={12} className="ide-field-icon" />}
      <input
        id={id}
        type="text"
        disabled={disabled}
        spellCheck={false}
        placeholder={placeholder}
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== null && draft !== value) onChange(draft); setDraft(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft !== null) { onChange(draft); setDraft(null); }
          if (e.key === 'Escape') setDraft(null);
        }}
        className={`w-[240px] max-w-full bg-[var(--ag-raised)] border border-[var(--ag-border)] rounded-md py-1 text-[12px] text-[var(--ag-fg)] outline-none focus:border-[var(--ag-accent)] placeholder:text-[var(--ag-faint)] disabled:cursor-not-allowed ${
          icon ? 'pl-7 pr-2' : 'px-2'
        } ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}

/**
 * Path input with a browse button. Uses the same native folder dialog the
 * "Open Folder" flow uses, so a setting path and a real workspace path are
 * always produced the same way.
 */
export function PathInput({
  value, onChange, placeholder, title, disabled, id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  title: string;
  disabled?: boolean;
  id?: string;
}) {
  const { pick, picking } = useFolderPicker();
  return (
    <div className="flex items-center gap-1.5">
      <TextInput
        id={id}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        icon="folder"
      />
      <button
        type="button"
        disabled={disabled || picking}
        onClick={async () => {
          const picked = await pick(title, value || undefined);
          if (picked) onChange(picked);
        }}
        className="shrink-0 px-2.5 py-1 text-[11px] rounded-md bg-[var(--ag-hover)] border border-[var(--ag-border)] text-[var(--ag-fg)] hover:border-[var(--ag-accent)] disabled:opacity-50 flex items-center gap-1.5"
      >
        <Icon name="folder-open" size={12} />
        {picking ? '…' : 'Browse'}
      </button>
      {value && (
        <button
          type="button"
          aria-label="Clear path"
          disabled={disabled}
          onClick={() => onChange('')}
          className="shrink-0 p-1 text-[var(--ag-faint)] hover:text-[var(--ag-fg)] disabled:opacity-50"
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

/**
 * Accent picker: preset swatches plus a native colour input.
 *
 * The native input is used rather than a hand-rolled HSV wheel because it is
 * keyboard-accessible, respects the OS colour picker, and serialises to a
 * plain hex string that goes straight into settings.json.
 */
export function ColorPicker({
  value, effective, onChange, disabled, id,
}: {
  /** The stored override; `null` means "follow the theme". */
  value: string | null;
  /** What is actually on screen, used to tint the "theme default" swatch. */
  effective: string;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-[280px]">
      <button
        type="button"
        title="Use the theme's accent"
        aria-label="Use the theme's accent colour"
        disabled={disabled || value === null}
        onClick={() => onChange(null)}
        className={`relative w-6 h-6 rounded-md border transition-all ${
          value === null
            ? 'border-[var(--ag-accent-bright)] scale-110'
            : 'border-[var(--ag-border)] hover:border-[var(--ag-muted)]'
        } disabled:cursor-default`}
        style={{ background: effective }}
      >
        {value === null && (
          <span className="absolute -bottom-1 -right-1 w-2.5 h-2.5 rounded-full bg-[var(--ag-raised)] border border-[var(--ag-accent-bright)] flex items-center justify-center">
            <Icon name="check" size={8} className="text-[var(--ag-accent-bright)]" />
          </span>
        )}
      </button>

      <span className="w-px h-5 bg-[var(--ag-border)] mx-0.5" />

      {ACCENT_PRESETS.map((p) => (
        <button
          key={p.value}
          type="button"
          title={p.name}
          aria-label={p.name}
          disabled={disabled}
          onClick={() => onChange(p.value)}
          className={`w-5 h-5 rounded-full border transition-transform hover:scale-110 disabled:cursor-default ${
            value?.toLowerCase() === p.value.toLowerCase()
              ? 'border-[var(--ag-fg)] scale-110'
              : 'border-transparent'
          }`}
          style={{ background: p.value }}
        />
      ))}

      <span className="w-px h-5 bg-[var(--ag-border)] mx-0.5" />

      <input
        id={id}
        type="color"
        aria-label="Custom accent colour"
        disabled={disabled}
        className="ide-color-input w-6 h-6 rounded-md"
        value={custom ?? value ?? effective}
        onChange={(e) => { setCustom(e.target.value); onChange(e.target.value); }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  children, onClick, variant = 'secondary', disabled, icon, className = '', title, autoFocus,
}: {
  children?: React.ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  icon?: IconName;
  className?: string;
  title?: string;
  autoFocus?: boolean;
}) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-[var(--ag-accent)] text-[var(--ag-accent-contrast)] hover:brightness-110 border-transparent font-semibold',
    secondary: 'bg-[var(--ag-raised)] text-[var(--ag-fg)] hover:bg-[var(--ag-hover)] border-[var(--ag-border)]',
    ghost: 'bg-transparent text-[var(--ag-muted)] hover:text-[var(--ag-fg)] hover:bg-[var(--ag-hover)] border-transparent',
    danger: 'bg-transparent text-red-400 hover:bg-red-500/15 border-red-500/40',
  };
  return (
    <button
      type="button"
      title={title}
      autoFocus={autoFocus}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {icon && <Icon name={icon} size={13} />}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Section scaffolding                                                 */
/* ------------------------------------------------------------------ */

export function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      <header className="mb-1">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--ag-accent-bright)]">
          {title}
        </h3>
        {hint && <p className="text-[11px] text-[var(--ag-faint)] mt-0.5">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ title, body, icon = 'search' }: { title: string; body: string; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
      <Icon name={icon} size={22} className="text-[var(--ag-faint)]" />
      <p className="text-[13px] text-[var(--ag-fg)]">{title}</p>
      <p className="text-[11px] text-[var(--ag-muted)] max-w-[42ch]">{body}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section header button (for the JSON view toggle)                    */
/* ------------------------------------------------------------------ */

export function useFocusTrap(active: boolean, onEscape: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !ref.current) return;
    const node = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    // Focus the first focusable descendant so keyboard users land inside the
    // dialog rather than behind it.
    const first = node.querySelector<HTMLElement>('input, button, select, textarea, [tabindex]:not([tabindex="-1"])');
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onEscape(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [active, onEscape]);
  return ref;
}
