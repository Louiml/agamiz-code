'use client';

/**
 * React bindings for the settings store.
 *
 * `useSyncExternalStore` is the right primitive here: the store is mutated
 * outside React (the global keydown handler, `applyTheme` bootstrap, the
 * workspace restore), and this hook is the only place React learns about it.
 * Splitting reads by key — `useSetting(key)` — keeps a control subscribed to
 * just its own value, so dragging one slider does not re-render the whole
 * Settings Center.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  getState,
  getValue,
  hydrateUserLayer,
  initFromMirror,
  mergeSettings,
  setValue as setStoreValue,
  setWorkspaceRoot,
  sourceOf as storeSourceOf,
  subscribe,
  type SettingSource,
  type SettingsScope,
  type SettingsState,
} from '../../features/settings/store';
import { DEFAULT_SETTINGS, type SettingValue, type Settings } from '../../features/settings/schema';
import { applyTheme, clampScale } from '../../features/settings/themes';

/** Re-render the caller whenever any setting changes. */
export function useSettingsState(): SettingsState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/**
 * Fully-resolved settings (defaults + user + workspace).
 *
 * The memo keys on the snapshot's layer objects, which are replaced
 * immutably on every write — so identity is a sufficient dependency and the
 * resolved object is only rebuilt when something actually changed.
 */
export function useResolvedSettings(): Settings {
  const state = useSettingsState();
  const { user, workspace } = state;
  return useMemo(() => mergeSettings(mergeSettings(DEFAULT_SETTINGS, user), workspace), [user, workspace]);
}

/**
 * Subscribe to a single setting.
 *
 * `getSnapshot` is cached on `key` so `useSyncExternalStore` does not loop on
 * object identity: primitives compare by value, and only the two free-form
 * leaves (`run.env`, `keymap.bindings`) are objects, which are re-created on
 * write and therefore safe to compare by reference.
 */
export function useSetting<T extends SettingValue>(key: string, scope: SettingsScope = 'user'): {
  value: T;
  set: (next: T) => void;
  source: SettingSource;
  isDefault: boolean;
} {
  const state = useSettingsState();
  const value = getValue<T>(key);
  const source = storeSourceOf(key);
  const set = useCallback((next: T) => setStoreValue(key, next, scope), [key, scope]);
  // Reading `state` here is what subscribes this component to store changes;
  // the returned values below are all derived from it.
  void state;
  return { value, set, source, isDefault: source === 'default' };
}

/**
 * Boot the store and keep the DOM palette in sync.
 *
 * Mount this exactly once, as high in the tree as possible. Applying the theme
 * from an effect (rather than during render) keeps React's "no side effects
 * while rendering" rule intact while still landing the palette before the
 * first meaningful paint of any modal.
 */
export function useSettingsRuntime(workspaceRoot: string): void {
  // The theme must come from the *resolved* view so a project can override the
  // user theme via `.agamiz/settings.json`.
  const resolved = useResolvedSettings();
  const appearance = resolved.appearance;

  useEffect(() => {
    initFromMirror();
    void hydrateUserLayer();
  }, []);

  useEffect(() => {
    void setWorkspaceRoot(workspaceRoot);
  }, [workspaceRoot]);

  useEffect(() => {
    applyTheme(appearance.theme, appearance.accent, {
      uiScale: clampScale(appearance.uiScale),
      reducedMotion: appearance.reducedMotion,
    });
  }, [appearance]);
}

/**
 * Path picker helper shared by the settings controls and the run panel.
 * Kept here so `SettingsCenter` does not need to know that the dialog plugin
 * is a Tauri-only dependency.
 */
export function useFolderPicker() {
  const [picking, setPicking] = useState(false);
  const pick = useCallback(async (title: string, current?: string): Promise<string | null> => {
    setPicking(true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title,
        defaultPath: current || undefined,
      });
      return typeof selected === 'string' ? selected : null;
    } catch {
      return null;
    } finally {
      setPicking(false);
    }
  }, []);
  return { pick, picking };
}
