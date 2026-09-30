import { describe, expect, it } from 'vitest';
import { THEMES, getTheme, resolveThemeVars } from './themes';

/**
 * The editor's token styles reference palette slots by CSS custom property, so
 * a slot that exists in the type but not in `resolveThemeVars` resolves to
 * `undefined` at runtime and the affected tokens render unstyled. Nothing else
 * caught that: `SyntaxPalette` is `Partial`, and `BASE_SYNTAX` is typed
 * `Required<SyntaxPalette>`, so adding a key to the type and the base palette
 * both typecheck while the variable list is silently missed.
 */
const EDITOR_TOKEN_VARS = [
  'keyword', 'type', 'builtin', 'constant', 'number', 'string', 'regex',
  'char', 'comment', 'operator', 'tag', 'attr', 'property', 'selector',
  'macro', 'ident', 'default',
] as const;

describe('resolveThemeVars', () => {
  it('defines a CSS variable for every token style the editor references', () => {
    const vars = resolveThemeVars(getTheme('dark').id, null);
    const missing = EDITOR_TOKEN_VARS
      .map((k) => `--ag-syn-${k}`)
      .filter((name) => !(name in vars));
    expect(missing).toEqual([]);
  });

  it('never emits an undefined variable for any built-in theme', () => {
    for (const theme of THEMES) {
      const vars = resolveThemeVars(theme.id, null);
      const undef = Object.entries(vars)
        .filter(([, value]) => value === undefined || value === null)
        .map(([name]) => name);
      expect({ theme: theme.id, undef }).toEqual({ theme: theme.id, undef: [] });
    }
  });
});
