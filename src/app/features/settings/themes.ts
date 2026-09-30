/**
 * Colour theme engine.
 *
 * A theme is a plain data record: surfaces, text, an accent pair, and a
 * partial syntax palette. Nothing here touches React, so the registry is
 * testable and the same data drives the settings preview swatch, the JSON
 * editor, and the live CSS-variable write.
 *
 * Applying a theme is a single pass over the CSS custom properties declared
 * in `globals.css` ("palette layer 1"). Because every Tailwind `ide-*` utility
 * forwards to those properties, one `setProperty` call per token re-themes the
 * entire IDE — editor, terminal (via `terminal/theme.ts`), status bar, and all
 * panels — with no component re-render and no remount.
 */

import type { ThemeId } from './schema';

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb` / `#rrggbb`. Returns null for anything else, which is why
 *  every caller keeps a literal fallback. */
export function parseHex(hex: string): Rgb | null {
  const h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    const [r, g, b] = h.split('');
    if (!r || !g || !b) return null;
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) };
  }
  if (h.length === 6) {
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  return null;
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** `#00e676` + `0.2` → `#00e67633`, an 8-digit hex. Both CSS and xterm.js
 *  accept 8-digit hex, so the selection tint needs no rgba() wrapping. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const a = Math.max(0, Math.min(1, alpha));
  const part = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}${part(Math.round(a * 255))}`;
}

/** Relative luminance (sRGB, WCAG). */
function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Mix towards white (`amount > 0`) or black (`amount < 0`). Used to derive a
 *  "bright" accent from a user-picked one without a second picker. */
export function shade(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const target = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  return toHex({
    r: rgb.r + (target - rgb.r) * t,
    g: rgb.g + (target - rgb.g) * t,
    b: rgb.b + (target - rgb.b) * t,
  });
}

/**
 * Pick black or white text for a filled accent button, whichever has more
 * contrast. Keeps custom accent colours readable without a manual override.
 */
export function contrastOn(hex: string): string {
  return luminance(hex) > 0.45 ? '#04140d' : '#f0f6fc';
}

/* ------------------------------------------------------------------ */
/* Palette shape                                                       */
/* ------------------------------------------------------------------ */

export interface ThemePalette {
  /** Primary editor/panel background. */
  bg: string;
  /** Raised surfaces: tab strip, headers, dialogs. */
  raised: string;
  hover: string;
  active: string;
  border: string;
  borderSoft: string;
  fg: string;
  muted: string;
  faint: string;
  /** The "on-accent" fill used by primary buttons; the bright variant is the
   *  highlight used for rails, carets and focus rings. */
  accent: string;
  accentBright: string;
  /** Translucent accent wash for selections. */
  selection: string;
  editorBg: string;
  gutterBg: string;
  gutterFg: string;
  gutterBorder: string;
  caret: string;
  activeLine: string;
  indentGuide: string;
  whitespace: string;
}

/** Partial override map over `BASE_SYNTAX`; unset keys inherit. */
export type SyntaxPalette = Partial<{
  keyword: string;
  type: string;
  number: string;
  numberEmph: string;
  string: string;
  regex: string;
  char: string;
  comment: string;
  operator: string;
  macro: string;
  macroInv: string;
  ident: string;
  fallback: string;
}>;

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  /** Drives `documentElement.classList.toggle('dark')` for Tailwind's
   *  `dark:` variants and the window chrome contrast. */
  dark: boolean;
  palette: ThemePalette;
  syntax: SyntaxPalette;
}

/** Syntax colours shared by every theme unless overridden. Values match the
 *  hard-coded Tailwind classes the editor used before theming existed, so
 *  Agamiz Dark renders identically to the previous build. */
const BASE_SYNTAX: Required<SyntaxPalette> = {
  keyword: '#c084fc',
  type: '#22d3ee',
  number: '#fdba74',
  numberEmph: '#fdba74',
  string: '#4ade80',
  regex: '#fb7185',
  char: '#fbbf24',
  comment: '#6b7280',
  operator: '#f472b6',
  macro: '#7dd3fc',
  macroInv: '#6ee7b7',
  ident: '#e4e4e7',
  fallback: '#d4d4d8',
};

/* ------------------------------------------------------------------ */
/* Theme catalogue                                                     */
/* ------------------------------------------------------------------ */

export const THEMES: ThemeDefinition[] = [
  {
    id: 'agamiz-dark',
    name: 'Agamiz Dark',
    dark: true,
    palette: {
      bg: '#0d1117',
      raised: '#161b22',
      hover: '#1c2128',
      active: '#262c36',
      border: '#21262d',
      borderSoft: '#1a1f24',
      fg: '#e6edf3',
      muted: '#8b949e',
      faint: '#484f58',
      accent: '#10b981',
      accentBright: '#00e676',
      selection: '#10b98126',
      editorBg: '#0d1117',
      gutterBg: '#0d1117',
      gutterFg: '#484f58',
      gutterBorder: '#21262d',
      caret: '#00e676',
      activeLine: '#ffffff08',
      indentGuide: '#30363d',
      whitespace: '#3d444d',
    },
    syntax: {},
  },
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    dark: true,
    palette: {
      bg: '#282c34',
      raised: '#21252b',
      hover: '#2c313c',
      active: '#373e47',
      border: '#3e4451',
      borderSoft: '#353a45',
      fg: '#abb2bf',
      muted: '#828997',
      faint: '#5c6370',
      accent: '#4d78cc',
      accentBright: '#61afef',
      selection: '#4d78cc40',
      editorBg: '#282c34',
      gutterBg: '#282c34',
      gutterFg: '#4b5263',
      gutterBorder: '#3e4451',
      caret: '#528bff',
      activeLine: '#2c313a',
      indentGuide: '#3b4048',
      whitespace: '#4b5263',
    },
    syntax: {
      keyword: '#c678dd',
      type: '#e5c07b',
      number: '#d19a66',
      numberEmph: '#d19a66',
      string: '#98c379',
      regex: '#e06c75',
      char: '#d19a66',
      comment: '#5c6370',
      operator: '#56b6c2',
      macro: '#61afef',
      macroInv: '#e5c07b',
      ident: '#abb2bf',
      fallback: '#abb2bf',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    palette: {
      bg: '#282a36',
      raised: '#21222c',
      hover: '#343746',
      active: '#44475a',
      border: '#3b3d4f',
      borderSoft: '#313340',
      fg: '#f8f8f2',
      muted: '#a4adc4',
      faint: '#6272a4',
      accent: '#bd93f9',
      accentBright: '#ff79c6',
      selection: '#bd93f933',
      editorBg: '#282a36',
      gutterBg: '#282a36',
      gutterFg: '#6272a4',
      gutterBorder: '#44475a',
      caret: '#f8f8f2',
      activeLine: '#ffffff0a',
      indentGuide: '#44475a',
      whitespace: '#6272a4',
    },
    syntax: {
      keyword: '#ff79c6',
      type: '#8be9fd',
      number: '#bd93f9',
      numberEmph: '#bd93f9',
      string: '#f1fa8c',
      regex: '#ffb86c',
      char: '#ffb86c',
      comment: '#6272a4',
      operator: '#ff79c6',
      macro: '#8be9fd',
      macroInv: '#50fa7b',
      ident: '#f8f8f2',
      fallback: '#f8f8f2',
    },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    dark: true,
    palette: {
      bg: '#0d1117',
      raised: '#161b22',
      hover: '#21262d',
      active: '#30363d',
      border: '#30363d',
      borderSoft: '#21262d',
      fg: '#c9d1d9',
      muted: '#8b949e',
      faint: '#6e7681',
      accent: '#238636',
      accentBright: '#2ea043',
      selection: '#388bfd33',
      editorBg: '#0d1117',
      gutterBg: '#0d1117',
      gutterFg: '#6e7681',
      gutterBorder: '#30363d',
      caret: '#58a6ff',
      activeLine: '#ffffff08',
      indentGuide: '#30363d',
      whitespace: '#6e7681',
    },
    syntax: {
      keyword: '#ff7b72',
      type: '#ffa657',
      number: '#79c0ff',
      numberEmph: '#79c0ff',
      string: '#a5d6ff',
      regex: '#7ee787',
      char: '#a5d6ff',
      comment: '#8b949e',
      operator: '#ff7b72',
      macro: '#d2a8ff',
      macroInv: '#ffa198',
      ident: '#c9d1d9',
      fallback: '#c9d1d9',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    palette: {
      bg: '#2e3440',
      raised: '#3b4252',
      hover: '#434c5e',
      active: '#4c566a',
      border: '#4c566a',
      borderSoft: '#3b4252',
      fg: '#eceff4',
      muted: '#d8dee9',
      faint: '#8f9aa8',
      accent: '#88c0d0',
      accentBright: '#8fbcbb',
      selection: '#88c0d040',
      editorBg: '#2e3440',
      gutterBg: '#2e3440',
      gutterFg: '#8f9aa8',
      gutterBorder: '#4c566a',
      caret: '#88c0d0',
      activeLine: '#ffffff0a',
      indentGuide: '#4c566a',
      whitespace: '#8f9aa8',
    },
    syntax: {
      keyword: '#81a1c1',
      type: '#8fbcbb',
      number: '#b48ead',
      numberEmph: '#b48ead',
      string: '#a3be8c',
      regex: '#ebcb8b',
      char: '#ebcb8b',
      comment: '#616e88',
      operator: '#81a1c1',
      macro: '#88c0d0',
      macroInv: '#8fbcbb',
      ident: '#d8dee9',
      fallback: '#eceff4',
    },
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    dark: true,
    palette: {
      bg: '#0a0a14',
      raised: '#12121f',
      hover: '#1c1c2e',
      active: '#2a2a44',
      border: '#2a2a44',
      borderSoft: '#1c1c2e',
      fg: '#e6e6f0',
      muted: '#9a9ab8',
      faint: '#5a5a7a',
      accent: '#ff2e97',
      accentBright: '#00f0ff',
      selection: '#ff2e9733',
      editorBg: '#0a0a14',
      gutterBg: '#0a0a14',
      gutterFg: '#5a5a7a',
      gutterBorder: '#2a2a44',
      caret: '#00f0ff',
      activeLine: '#00f0ff0a',
      indentGuide: '#2a2a44',
      whitespace: '#5a5a7a',
    },
    syntax: {
      keyword: '#ff2e97',
      type: '#00f0ff',
      number: '#ffe600',
      numberEmph: '#ffe600',
      string: '#00ff9f',
      regex: '#ff8b3d',
      char: '#ff8b3d',
      comment: '#4d4d6a',
      operator: '#00f0ff',
      macro: '#b967ff',
      macroInv: '#ffb86b',
      ident: '#e6e6f0',
      fallback: '#c9c9e0',
    },
  },
  {
    id: 'light',
    name: 'Light Mode',
    dark: false,
    palette: {
      bg: '#ffffff',
      raised: '#f6f8fa',
      hover: '#eaeef2',
      active: '#d0d7de',
      border: '#d0d7de',
      borderSoft: '#e4e8ed',
      fg: '#1f2328',
      muted: '#59636e',
      faint: '#8c959f',
      accent: '#0969da',
      accentBright: '#0550ae',
      selection: '#0969da26',
      editorBg: '#ffffff',
      gutterBg: '#ffffff',
      gutterFg: '#8c959f',
      gutterBorder: '#d0d7de',
      caret: '#0969da',
      activeLine: '#1f23280a',
      indentGuide: '#d8dee4',
      whitespace: '#afb8c1',
    },
    syntax: {
      keyword: '#cf222e',
      type: '#953800',
      number: '#0550ae',
      numberEmph: '#0550ae',
      string: '#0a3069',
      regex: '#116329',
      char: '#953800',
      comment: '#6e7781',
      operator: '#0550ae',
      macro: '#8250df',
      macroInv: '#1f2328',
      ident: '#1f2328',
      fallback: '#1f2328',
    },
  },
];

export const THEME_BY_ID: Record<ThemeId, ThemeDefinition> = THEMES.reduce((acc, t) => {
  acc[t.id] = t;
  return acc;
}, {} as Record<ThemeId, ThemeDefinition>);

export function getTheme(id: string): ThemeDefinition {
  return THEME_BY_ID[id as ThemeId] ?? THEMES[0];
}

/* ------------------------------------------------------------------ */
/* Accent presets                                                      */
/* ------------------------------------------------------------------ */

export interface AccentPreset {
  name: string;
  /** The bright variant — what the user sees on rails, carets and text. */
  value: string;
}

/** Preset accents offered next to the free colour input. `null` in the
 *  settings means "use the theme's own accent", rendered as the first entry. */
export const ACCENT_PRESETS: AccentPreset[] = [
  { name: 'Agamiz Green', value: '#00e676' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Cyan', value: '#22d3ee' },
  { name: 'Azure', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Magenta', value: '#ec4899' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Lime', value: '#84cc16' },
  { name: 'Rose', value: '#f43f5e' },
];

/* ------------------------------------------------------------------ */
/* Resolution + application                                            */
/* ------------------------------------------------------------------ */

/**
 * Turn a theme + optional accent override into the full `--ag-*` map.
 *
 * When the user picks an accent, the *bright* variant becomes their pick and
 * the fill variant is derived one step darker, so buttons stay readable and a
 * single colour input controls both.
 */
export function resolveThemeVars(themeId: string, accentOverride: string | null): Record<string, string> {
  const theme = getTheme(themeId);
  const p = theme.palette;

  const bright = accentOverride && parseHex(accentOverride) ? accentOverride : p.accentBright;
  const fill = accentOverride && parseHex(accentOverride) ? shade(accentOverride, -0.22) : p.accent;

  const syntax = { ...BASE_SYNTAX, ...theme.syntax };
  const selection = accentOverride && parseHex(accentOverride) ? withAlpha(bright, 0.18) : p.selection;

  return {
    '--ag-bg': p.bg,
    '--ag-raised': p.raised,
    '--ag-hover': p.hover,
    '--ag-active': p.active,
    '--ag-border': p.border,
    '--ag-border-soft': p.borderSoft,
    '--ag-fg': p.fg,
    '--ag-muted': p.muted,
    '--ag-faint': p.faint,
    '--ag-accent': fill,
    '--ag-accent-bright': bright,
    '--ag-accent-contrast': contrastOn(bright),
    '--ag-selection': selection,
    '--ag-editor-bg': p.editorBg,
    '--ag-gutter-bg': p.gutterBg,
    '--ag-gutter-fg': p.gutterFg,
    '--ag-gutter-border': p.gutterBorder,
    '--ag-caret': p.caret,
    '--ag-active-line': p.activeLine,
    '--ag-indent-guide': p.indentGuide,
    '--ag-whitespace': p.whitespace,
    '--ag-syn-keyword': syntax.keyword,
    '--ag-syn-type': syntax.type,
    '--ag-syn-number': syntax.number,
    '--ag-syn-number-emph': syntax.numberEmph,
    '--ag-syn-string': syntax.string,
    '--ag-syn-regex': syntax.regex,
    '--ag-syn-char': syntax.char,
    '--ag-syn-comment': syntax.comment,
    '--ag-syn-operator': syntax.operator,
    '--ag-syn-macro': syntax.macro,
    '--ag-syn-macro-inv': syntax.macroInv,
    '--ag-syn-ident': syntax.ident,
    '--ag-syn-default': syntax.fallback,
  };
}

/** Non-palette UI preferences that also land on `<html>`. */
export interface UiPreferences {
  /** Whole-UI zoom, 0.8–1.5, applied as a root font-size multiplier. */
  uiScale: number;
  /** Collapse every CSS transition. The OS-level
   *  `prefers-reduced-motion` is honoured separately in `globals.css`. */
  reducedMotion: boolean;
}

/**
 * Write the palette onto `<html>`.
 *
 * `setProperty` on the root is enough: every utility in the app resolves its
 * colour through these properties, so this re-themes all mounted React trees
 * at once. Returns the applied bright accent so callers can mirror it into the
 * terminal without re-reading the DOM.
 */
export function applyTheme(
  themeId: string,
  accentOverride: string | null,
  prefs: UiPreferences = { uiScale: 1, reducedMotion: false },
): string {
  if (typeof document === 'undefined') return accentOverride ?? getTheme(themeId).palette.accentBright;
  const root = document.documentElement;
  const vars = resolveThemeVars(themeId, accentOverride);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.setProperty('--ag-ui-scale', String(clampScale(prefs.uiScale)));

  const theme = getTheme(themeId);
  root.dataset.theme = theme.id;
  root.classList.toggle('dark', theme.dark);
  root.classList.toggle('ag-reduce-motion', prefs.reducedMotion);
  root.style.colorScheme = theme.dark ? 'dark' : 'light';

  return vars['--ag-accent-bright'];
}

/** Keep the root font size inside the 80%–150% band the UI advertises. */
export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1.5, Math.max(0.8, value));
}

/** Effective bright accent for a theme, honouring an override. */
export function effectiveAccent(themeId: string, accentOverride: string | null): string {
  if (accentOverride && parseHex(accentOverride)) return accentOverride;
  return getTheme(themeId).palette.accentBright;
}

/**
 * Read a resolved CSS custom property from the document. Mirrors the
 * `cssVar()` helper in `components/terminal/theme.ts` — kept local so this
 * module stays importable from non-DOM contexts (the JSON validator) where
 * `getComputedStyle` does not exist.
 */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
