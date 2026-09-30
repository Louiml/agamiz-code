/**
 * React binding for the terminal slice of the central settings tree.
 *
 * The settings store is a plain external store mutated from outside React
 * (Settings Center, JSON editor, workspace override), so `useSyncExternalStore`
 * is the correct way to subscribe. Splitting the read by key keeps a control
 * subscribed to only its own value — dragging the font-size slider must not
 * re-render the Settings Center.
 *
 * The panel needs several keys at once, so it uses `useResolvedSettings()` and
 * takes `settings.terminal` wholesale; the toolbar's font stepper uses the
 * per-key `useSetting` so it re-renders nothing else.
 */

'use client';

import { useMemo } from 'react';
import {
  useResolvedSettings,
  useSetting,
} from '../settings/useSettings';
import type { CustomShellProfile } from '../../features/settings/schema';
import { customProfileToShell, type ShellProfile, type TerminalViewSettings } from './types';

export type { CustomShellProfile };

/** The terminal's settings, resolved from default + user + workspace layers. */
export function useTerminalSettings(): TerminalViewSettings {
  const settings = useResolvedSettings();
  return useMemo(() => settings.terminal, [settings.terminal]);
}

/** The user's hand-written shells, converted for the backend probe. */
export function useCustomProfiles(): ShellProfile[] {
  const settings = useTerminalSettings();
  return useMemo(
    () => (settings.profiles ?? []).map(customProfileToShell),
    [settings.profiles],
  );
}

/** The profile id new shells should start with. */
export function useDefaultProfileId(): {
  value: string;
  set: (id: string) => void;
} {
  return useSetting<string>('terminal.defaultProfileId');
}

/** Font size stepper used by the terminal toolbar. */
export function useFontSize(): { value: number; set: (size: number) => void } {
  const { value, set } = useSetting<number>('terminal.fontSize');
  // Memoised on purpose. `useSetting` builds a fresh result object on every
  // call, and anything that puts this in a `useCallback`/`useMemo` dependency
  // list would then be rebuilt every render — which, for the toolbar, means an
  // infinite publish/re-render loop.
  return useMemo(() => ({ value, set }), [value, set]);
}
