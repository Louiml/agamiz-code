// Runtime Tauri-bridge helpers.
//
// Purpose: surface *why* a Tauri IPC action fails, so "button does nothing"
// becomes a concrete error we can fix (missing bridge vs rejected invoke vs
// capability reject). The Tauri bridge (`window.__TAURI_INTERNALS__`) is
// injected by the Rust runtime at page load; if it is absent or its `invoke`
// helper throws, EVERY `invoke()`/plugin/window call in the app fails while
// plain React + localStorage still work.

/** Minimal shape of Tauri's injected IPC bridge (only what this file reads). */
interface TauriBridge {
  invoke: unknown;
  metadata?: {
    currentWindow?: { label?: string } | null;
    currentWindowLabel?: string | null;
  };
}

/** The injected bridge, or undefined when running outside a Tauri webview. */
function bridge(): TauriBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as { __TAURI_INTERNALS__?: TauriBridge };
  return w.__TAURI_INTERNALS__;
}

/** True when running inside a real Tauri webview with the IPC bridge present. */
export function isTauri(): boolean {
  return !!bridge();
}

/**
 * Label of the window this JS context belongs to: `"main"` for the window the
 * app launched in, `"editor-N"` for windows created by New Window.
 *
 * Multi-window correctness depends on this: per-window state (the session
 * snapshot) is keyed by label, so two windows that shared one file would
 * overwrite each other's tabs.
 */
export function currentWindowLabel(): string {
  const internals = bridge();
  return (
    internals?.metadata?.currentWindow?.label ??
    internals?.metadata?.currentWindowLabel ??
    'main'
  );
}

/** True when this window was created by New Window rather than at startup. */
export function isSecondaryWindow(): boolean {
  return currentWindowLabel() !== 'main';
}

let diagnosticsInstalled = false;

/**
 * Report unhandled rejections and uncaught errors, tagged with the window
 * label.
 *
 * Tauri reports a rejected IPC call as a rejected promise. In a secondary
 * window there is no DevTools open and usually no toast attached to the
 * call site, so the failure would otherwise be completely invisible — which is
 * exactly how "the new window is blank" stayed undiagnosed.
 */
export function installRuntimeDiagnostics(): void {
  if (diagnosticsInstalled || typeof window === 'undefined') return;
  diagnosticsInstalled = true;

  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as { message?: string; stack?: string } | undefined;
    console.error(
      `[agamiz/${currentWindowLabel()}] unhandled rejection: ` +
        `${r?.message ?? String(ev.reason)}\n${r?.stack ?? '(no stack)'}`,
    );
  });

  window.addEventListener('error', (ev) => {
    console.error(`[agamiz/${currentWindowLabel()}] error: ${ev.message}`);
  });
}

/** One-shot self check that logs the bridge state to the DevTools console. */
export function diagTauriBridge(): void {
  if (typeof window === 'undefined') return;
  installRuntimeDiagnostics();
  const internals = bridge();
  const hasInvoke = !!(internals && typeof internals.invoke === 'function');
  console.log(`[tauri-bridge] __TAURI_INTERNALS__ present=${!!internals} invoke=${hasInvoke}`);
  console.log(`[tauri-bridge] current window label=${currentWindowLabel()}`);
  if (internals && !hasInvoke) {
    console.warn('[tauri-bridge] Invoke helper missing:', Object.keys(internals));
  }
}

/** Normalize a rejection into a readable string for error toasts/logs. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Tear down a Tauri event subscription without ever rejecting.
 *
 * Tauri's unlisten path is fire-and-forget from JS, and internally it does
 * `listeners[eventId].handlerId` with no guard. If the matching
 * `listen` registration has not been evaluated in this webview yet — which
 * happens whenever the main thread stalls, e.g. while a New Window is being
 * built — that read throws a TypeError which surfaces as an unhandled
 * rejection. The listener is already gone in that case, so swallowing it is
 * correct: the alternative is noise that hides real failures.
 */
export function safeUnlisten(unlisten: (() => void) | null | undefined): void {
  if (!unlisten) return;
  try {
    const result = unlisten() as unknown;
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    /* listener already gone */
  }
}
