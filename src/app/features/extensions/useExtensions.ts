'use client';

/**
 * React bindings for the extension host.
 *
 * The host is push-based: Rust emits `ext://extensions` and `ext://registry`
 * whenever anything changes, so the hooks here subscribe rather than poll.
 * That matters because contributions can arrive from three directions — a user
 * action, a background reload watcher, and a Lua `activate()` running on the
 * boot thread — and polling would miss the last two entirely.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri, errText, safeUnlisten } from '../../lib/tauri';
import {
  EXT_CHANNELS,
  ext,
  toPaletteCommand,
  toProjectTemplate,
  type EditorRequest,
  type ExtensionLogLine,
  type ExtensionNotice,
  type ExtensionRecord,
  type PanelRecord,
  type RegistrySnapshot,
} from './bridge';
import type { ProjectTemplate } from '../projectTemplates';

const EMPTY_REGISTRY: RegistrySnapshot = { commands: [], status: [], panels: [] };

export interface ExtensionsState {
  extensions: ExtensionRecord[];
  registry: RegistrySnapshot;
  /** True until the first `ext_list` resolves (or fails). */
  loading: boolean;
  /** Host-level failure, e.g. the extensions root could not be created. */
  error: string | null;
  root: string;
  refresh: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  reload: (id: string) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  runCommand: (id: string, args?: string[]) => Promise<void>;
  openFolder: (id: string) => Promise<void>;
  installFolder: (path: string, dev?: boolean) => Promise<void>;
  installZip: (path: string) => Promise<void>;
  installGit: (url: string, reference?: string) => Promise<void>;
  /** Palette-shaped commands contributed by extensions. */
  paletteCommands: ReturnType<typeof toPaletteCommand>[];
  /** Sidebar panels contributed by extensions. */
  panels: PanelRecord[];
  /**
   * "New Project" templates contributed by extensions, already merged into the
   * wizard's shape. Empty when no extension registers one, which is the normal
   * case — the wizard then shows only its built-ins.
   */
  projectTemplates: ProjectTemplate[];
}

/**
 * Subscribe to the host's extension list and contribution registry.
 *
 * Mount this exactly once, at the IDE root. It owns the shared state, so a
 * second instance in the Extensions panel would only add a duplicate listener.
 */
export function useExtensions(): ExtensionsState {
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([]);
  const [registry, setRegistry] = useState<RegistrySnapshot>(EMPTY_REGISTRY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [root, setRoot] = useState('');

  // Kept in a ref so the callbacks below stay referentially stable and do not
  // re-subscribe their listeners on every state change.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    // No `isTauri()` guard here on purpose: the effect below already skips
    // this call outside a Tauri webview, and if it is reached anyway `call()`
    // rejects with a clear message that lands in `setError`. Keeping the
    // non-Tauri path out of this function also means it performs no state
    // write before its first `await`, which keeps the calling effect from
    // causing a cascading render.
    try {
      const [list, snapshot, dir] = await Promise.all([
        ext.list(),
        ext.registry(),
        ext.root(),
      ]);
      if (!aliveRef.current) return;
      setExtensions(list);
      setRegistry(snapshot);
      setRoot(dir);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(errText(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      // Running as a plain static export (browser preview): there is no host
      // to ask, so report "loaded" on the next tick rather than leaving the
      // panel spinning forever. Deferred so the effect body itself performs no
      // synchronous state write.
      const timer = setTimeout(() => setLoading(false), 0);
      return () => clearTimeout(timer);
    }
    // Scheduled on a microtask so the effect body itself does no synchronous
    // work. `refresh` only writes state after awaiting the host, so this is
    // semantically the same as calling it directly — it just keeps the mount
    // effect free of a cascading render.
    queueMicrotask(() => void refresh());

    let disposers: UnlistenFn[] = [];
    let disposed = false;

    // Both channels deliver a complete snapshot, so the handler is a plain
    // replace rather than a merge — no ordering concerns between them.
    const onExtensions = (payload: ExtensionRecord[]) => {
      if (!disposed) setExtensions(Array.isArray(payload) ? payload : []);
    };
    const onRegistry = (payload: RegistrySnapshot) => {
      if (!disposed && payload) setRegistry(payload);
    };

    Promise.all([
      listen<ExtensionRecord[]>(EXT_CHANNELS.extensions, (e) => onExtensions(e.payload)),
      listen<RegistrySnapshot>(EXT_CHANNELS.registry, (e) => onRegistry(e.payload)),
    ])
      .then((listeners) => {
        if (disposed) listeners.forEach((off) => off());
        else disposers = listeners;
      })
      .catch((e) => {
        if (!disposed) setError(errText(e));
      });

    return () => {
      disposed = true;
      disposers.forEach((off) => off());
    };
  }, [refresh]);

  /**
   * Wrap a mutating call so the panel's busy state clears even on failure, and
   * so a refusal from the host surfaces as an error the user can see.
   */
  const mutate = useCallback(
    async (action: () => Promise<unknown>, failure: string) => {
      try {
        await action();
        setError(null);
      } catch (e) {
        const message = errText(e);
        setError(message || failure);
        throw e;
      }
    },
    [],
  );

  const setEnabled = useCallback(
    (id: string, enabled: boolean) =>
      mutate(() => ext.setEnabled(id, enabled), `Could not update ${id}`),
    [mutate],
  );
  const reload = useCallback(
    (id: string) => mutate(() => ext.reload(id), `Could not reload ${id}`),
    [mutate],
  );
  const uninstall = useCallback(
    (id: string) => mutate(() => ext.uninstall(id), `Could not uninstall ${id}`),
    [mutate],
  );
  const openFolder = useCallback(
    (id: string) => mutate(() => ext.openFolder(id), `Could not open the folder for ${id}`),
    [mutate],
  );

  const runCommand = useCallback(
    async (id: string, args: string[] = []) => {
      await mutate(() => ext.runCommand(id, args), `Could not run ${id}`);
    },
    [mutate],
  );

  const installFolder = useCallback(
    (path: string, dev = false) =>
      mutate(
        () => (dev ? ext.installDev(path) : ext.installFolder(path)),
        'Could not install from that folder',
      ),
    [mutate],
  );
  const installZip = useCallback(
    (path: string) => mutate(() => ext.installZip(path), 'Could not install that archive'),
    [mutate],
  );
  const installGit = useCallback(
    (url: string, reference?: string) =>
      mutate(() => ext.installGit(url, reference), 'Could not clone that repository'),
    [mutate],
  );

  const paletteCommands = useMemo(
    () => registry.commands.map((c) => toPaletteCommand(c, (id) => void runCommand(id))),
    [registry.commands, runCommand],
  );

  // `project_templates` is optional on the wire so a frontend talking to an
  // older host reads an empty list instead of crashing on `.map`.
  const projectTemplates = useMemo(
    () => (registry.project_templates ?? []).map(toProjectTemplate),
    [registry.project_templates],
  );

  return {
    extensions,
    registry,
    loading,
    error,
    root,
    refresh,
    setEnabled,
    reload,
    uninstall,
    runCommand,
    openFolder,
    installFolder,
    installZip,
    installGit,
    paletteCommands,
    panels: registry.panels,
    projectTemplates,
  };
}

// ---------------------------------------------------------------------------
// One-shot channel subscriptions for the IDE shell
// ---------------------------------------------------------------------------

/**
 * Subscribe to a host channel, ignoring teardown races.
 *
 * The async `listen()` resolves after the effect has already been cleaned up in
 * React 18 StrictMode's double-invoke, so the `disposed` flag is what keeps a
 * late-resolving listener from leaking.
 */
function useHostChannel<T>(
  channel: string,
  handler: (payload: T) => void,
  enabled = true,
): void {
  // The handler is read through a ref so a caller can pass an inline closure
  // without re-subscribing on every render. The ref is updated in an effect
  // (declared first, so it settles before the subscription below) rather than
  // during render, which React forbids.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled || !isTauri()) return;

    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    listen<T>(channel, (e) => {
      if (!disposed) handlerRef.current(e.payload);
    })
      .then((off) => {
        if (disposed) safeUnlisten(off);
        else unlisten = off;
      })
      .catch(() => {
        /* the host may not be running (browser preview) — not fatal */
      });

    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  }, [channel, enabled]);
}

/** Route `agamiz.window.show_message` into the IDE's toast stack. */
export function useExtensionNotices(onNotice: (notice: ExtensionNotice) => void): void {
  useHostChannel<ExtensionNotice>(EXT_CHANNELS.notice, onNotice);
}

/** Route extension `print` / `agamiz.log` into the Output panel. */
export function useExtensionLogs(onLog: (line: ExtensionLogLine) => void): void {
  useHostChannel<ExtensionLogLine>(EXT_CHANNELS.log, onLog);
}

/** Observe `agamiz.editor.*` mutations the host wants applied. */
export function useEditorRequests(onRequest: (request: EditorRequest) => void): void {
  useHostChannel<EditorRequest>(EXT_CHANNELS.editor, onRequest);
}
