/**
 * xterm.js theme matching the IDE's dark surface palette.
 *
 * Colours are read from the same custom properties the editor uses
 * (`--color-ide-*`) so re-theming the shell also re-themes the terminal. The
 * literal fallbacks keep the palette usable when those properties are absent.
 *
 * xterm 6 flattens the 16 ANSI slots onto `ITheme` itself (no nested `colors`
 * object), so the palette is spread straight into the theme.
 */

import type { ITheme } from '@xterm/xterm';

/** The 16 ANSI colours, tuned to sit on the `#0d1117` surface. */
const ANSI = {
  black: '#2b3138',
  red: '#f97583',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
} satisfies ITheme;

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function buildTerminalTheme(): ITheme {
  return {
    ...ANSI,
    background: cssVar('--color-ide-bg', '#0d1117'),
    foreground: cssVar('--color-ide-fg', '#e6edf3'),
    cursor: cssVar('--color-ide-accent-bright', '#00e676'),
    cursorAccent: cssVar('--color-ide-bg', '#0d1117'),
    // `--color-ide-selection` is an 8-digit hex, which xterm accepts directly.
    selectionBackground: cssVar('--color-ide-selection', '#10b98126'),
    scrollbarSliderBackground: '#3a414980',
    scrollbarSliderHoverBackground: '#4d5560a0',
  };
}
