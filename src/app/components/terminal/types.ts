/**
 * Terminal panel domain types.
 *
 * The panel manages three independent things and keeps them separate on
 * purpose:
 *   - `TerminalInstance` — one shell process (a PTY on the Rust side),
 *   - `SplitNode` — the layout tree that positions instances on screen,
 *   - `ShellProfile` — a shell the backend detected, or one the user added.
 *
 * Sessions outlive the React tree: splitting a pane unmounts and remounts an
 * xterm view while the PTY keeps running, which is why the PTY id lives on the
 * instance rather than in component state.
 *
 * User preferences are *not* defined here. They live in the central settings
 * schema (`features/settings`) and are read through `useTerminalSettings`, so
 * the terminal, the Settings Center and the JSON editor all agree.
 */

import type { CustomShellProfile } from '../../features/settings/schema';

export type { CustomShellProfile };

/** A shell the user can start, as probed by the Rust `pty_profiles` command. */
export interface ShellProfile {
  id: string;
  name: string;
  program: string;
  args: string[];
  available: boolean;
  is_default: boolean;
  cwd: string;
  env: Record<string, string>;
  /** Short label used in the session list, e.g. `pwsh`. */
  short: string;
  /** Accent colour for the session tab strip and sidebar dot. */
  color: string;
}

/** Glyphs a user can pin to a session instead of the default terminal icon. */
export type SessionIcon =
  | 'terminal'
  | 'powershell'
  | 'cmd'
  | 'wsl'
  | 'bash'
  | 'node'
  | 'server';

/** One running (or exited) shell. */
export interface TerminalInstance {
  /** Stable React/backend identity. */
  id: string;
  /** Backend PTY handle, or null before `pty_spawn` resolves. */
  ptyId: number | null;
  profileId: string;
  /** Display name in the tab strip, e.g. `1: pwsh` or a custom rename. */
  name: string;
  /** Monotonic ordinal (`1`, `2`, …) that survives a rename. */
  ordinal: number;
  /** User-picked tag colour; null falls back to the profile colour. */
  color: string | null;
  icon: SessionIcon | null;
  cwd: string;
  createdAt: number;
  alive: boolean;
  exitCode: number | null;
  /** Set when the PTY failed to start, shown in place of the shell. */
  error: string | null;
}

/** Layout tree. `row` splits left/right, `column` splits top/bottom. */
export type SplitDirection = 'row' | 'column';

export type SplitNode =
  | { kind: 'leaf'; instanceId: string }
  | { kind: 'split'; direction: SplitDirection; children: SplitNode[]; sizes: number[] };

/** The slice of the central settings tree that the terminal needs. */
export interface TerminalViewSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  cursorSmooth: boolean;
  scrollback: number;
  webgl: boolean;
  minimumContrastRatio: number;
  confirmKill: boolean;
  copyOnSelection: boolean;
  defaultProfileId: string;
  profiles: CustomShellProfile[];
}

/** Turn a stored custom profile into the shape the backend expects. */
export function customProfileToShell(p: CustomShellProfile): ShellProfile {
  const short = p.name.split(/[\s\\/]+/).pop()?.slice(0, 12) || p.name.slice(0, 12);
  return {
    id: p.id,
    name: p.name,
    program: p.program,
    args: p.args ?? [],
    available: true,
    is_default: false,
    cwd: p.cwd ?? '',
    env: p.env ?? {},
    short,
    color: p.color || '#94a3b8',
  };
}
