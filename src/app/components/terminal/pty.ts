/**
 * Tauri bridge for PTY sessions.
 *
 * # Why a channel registry instead of `listen()` inside the view
 *
 * A PTY must outlive the React tree that renders it. Splitting a pane or
 * collapsing the bottom panel unmounts the xterm view; the shell process must
 * keep running and its output must be buffered, or a long-running build would
 * be lost the moment the user rearranges the layout.
 *
 * So every session gets a `PtyChannel`: a subscriber list plus a replay
 * buffer, fed by a single pair of Tauri event listeners. `TerminalView`
 * subscribes on mount and drains the backlog; nothing else knows about the
 * event names.
 *
 * Output is base64 because PTY bytes are not necessarily UTF-8 (box drawing,
 * TUI escapes, split multi-byte sequences). Decoding with `atob` into a
 * `Uint8Array` keeps xterm.js byte-accurate.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { errText } from '../../lib/tauri';
import type { ShellProfile } from './types';

export interface PtyExitEvent {
  id: number;
  code: number;
}

type Listener = (bytes: Uint8Array) => void;

/** How many bytes of already-emitted output a detached view replays. */
const REPLAY_BYTES = 512 * 1024;

class PtyChannel {
  private listeners = new Set<Listener>();
  private backlog: Uint8Array[] = [];
  private backlogBytes = 0;

  constructor(readonly ptyId: number) {}

  push(bytes: Uint8Array): void {
    if (this.listeners.size === 0) {
      this.backlog.push(bytes);
      this.backlogBytes += bytes.length;
      // Drop the oldest chunks once the replay buffer is full, so a terminal
      // left detached for hours cannot grow without bound.
      while (this.backlogBytes > REPLAY_BYTES && this.backlog.length > 1) {
        this.backlogBytes -= this.backlog.shift()!.length;
      }
      return;
    }
    for (const fn of this.listeners) fn(bytes);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.backlog.length > 0) {
      const replay = this.backlog;
      this.backlog = [];
      this.backlogBytes = 0;
      for (const chunk of replay) fn(chunk);
    }
    return () => {
      this.listeners.delete(fn);
    };
  }
}

const channels = new Map<number, PtyChannel>();
let listenersReady: Promise<void> | null = null;
let exitHandler: ((e: PtyExitEvent) => void) | null = null;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Attach the single global `pty-output` / `pty-exit` listener pair. */
export function ensurePtyListeners(): Promise<void> {
  if (listenersReady) return listenersReady;
  listenersReady = (async () => {
    await listen<{ id: number; data: string }>('pty-output', (e) => {
      channels.get(e.payload.id)?.push(b64ToBytes(e.payload.data));
    });
    await listen<PtyExitEvent>('pty-exit', (e) => {
      channels.delete(e.payload.id);
      exitHandler?.(e.payload);
    });
  })();
  return listenersReady;
}

/** Subscribe to shell exits (used by the store to mark a session dead). */
export function onPtyExit(fn: (e: PtyExitEvent) => void): () => void {
  exitHandler = fn;
  return () => {
    if (exitHandler === fn) exitHandler = null;
  };
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  // Chunked to stay under the argument limit of String.fromCharCode spread.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export interface SpawnOptions {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** Start a PTY and register its channel. Returns the new backend id. */
export async function spawnPty(opts: SpawnOptions): Promise<number> {
  await ensurePtyListeners();
  const ptyId = await invoke<number>('pty_spawn', {
    program: opts.program,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env ?? {},
    cols: Math.max(1, Math.round(opts.cols)),
    rows: Math.max(1, Math.round(opts.rows)),
  });
  channels.set(ptyId, new PtyChannel(ptyId));
  return ptyId;
}

/** Feed keystrokes / paste / control sequences to a PTY. */
export function writePty(ptyId: number, data: string): Promise<void> {
  return invoke<void>('pty_write', { id: ptyId, data: bytesToB64(new TextEncoder().encode(data)) });
}

/** Feed raw bytes (xterm's `onBinary` path) to a PTY. */
export function writePtyBytes(ptyId: number, data: Uint8Array): Promise<void> {
  return invoke<void>('pty_write', { id: ptyId, data: bytesToB64(data) });
}

/** Tear the shell process down (the trash icon). */
export function killPty(ptyId: number): Promise<void> {
  channels.delete(ptyId);
  return invoke<void>('pty_kill', { id: ptyId });
}

/** Push a new viewport size so TUI programs redraw correctly. */
export function resizePty(ptyId: number, cols: number, rows: number): Promise<void> {
  if (cols < 1 || rows < 1) return Promise.resolve();
  return invoke<void>('pty_resize', {
    id: ptyId,
    cols: Math.round(cols),
    rows: Math.round(rows),
  }).catch(() => {
    /* a resize racing session teardown is expected, not an error */
  });
}

/** Subscribe to a session's output, replaying anything missed while detached. */
export function subscribeOutput(ptyId: number, fn: Listener): () => void {
  const channel = channels.get(ptyId);
  if (!channel) return () => {};
  return channel.subscribe(fn);
}

/** Ask the backend which shells can back a session. */
export async function fetchProfiles(custom: ShellProfile[]): Promise<ShellProfile[]> {
  return invoke<ShellProfile[]>('pty_profiles', { custom });
}

/** Human-readable failure text for a rejected invoke. */
export function ptyErrorText(e: unknown): string {
  return errText(e);
}