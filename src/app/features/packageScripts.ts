/**
 * npm/pnpm/yarn/bun script discovery for the run configuration list.
 *
 * A Node project already declares how it is meant to be run, in `package.json`.
 * That is the honest source of run targets: the author wrote them, they are the
 * commands the project's own README and CI use, and they cannot drift from the
 * project the way a guessed "run the entry point" can.
 *
 * Everything here is pure so the discovery rules can be tested without a
 * filesystem, a package manager, or a Tauri runtime.
 */

import type { RunConfiguration } from './runconfigs';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PackageManifest {
  /** `name` from the manifest, when present. */
  name?: string;
  /** Script name to the command it runs. */
  scripts: Record<string, string>;
}

/** Lockfile to package manager. First match wins, so the order is the priority. */
const LOCKFILES: [file: string, manager: PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/**
 * Parse a `package.json` without throwing.
 *
 * A malformed manifest is common enough mid-edit that it must not break the
 * editor, and a `scripts` block that is not an object of strings is skipped
 * rather than trusted.
 */
export function parsePackageJson(raw: string): PackageManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim() !== ''
    ? record.name.trim()
    : undefined;

  const scripts: Record<string, string> = {};
  const rawScripts = record.scripts;
  if (rawScripts && typeof rawScripts === 'object' && !Array.isArray(rawScripts)) {
    for (const [key, value] of Object.entries(rawScripts as Record<string, unknown>)) {
      if (typeof value === 'string') scripts[key] = value;
    }
  }
  return { name, scripts };
}

/**
 * Pick the package manager from the lockfiles present in the project root.
 *
 * `fileExists` is injected rather than a directory listing so this stays pure
 * and testable. npm is the fallback because it is what a project with no
 * lockfile uses.
 */
export function detectPackageManager(
  fileExists: (name: string) => boolean,
): PackageManager {
  for (const [file, manager] of LOCKFILES) {
    if (fileExists(file)) return manager;
  }
  return 'npm';
}

/**
 * The argv that runs one script.
 *
 * `npm run <s>` and `yarn <s>` differ, and pnpm/bun each have their own spelling.
 * Getting this wrong means the run button silently does nothing useful, so it
 * is one table rather than a conditional chain.
 */
export function buildScriptCommand(manager: PackageManager, script: string): { program: string; args: string[] } {
  switch (manager) {
    case 'pnpm':
      return { program: 'pnpm', args: ['run', script] };
    case 'yarn':
      // Yarn 1 takes the script name directly; `yarn run s` also works but the
      // bare form is what the docs use and what users expect to see.
      return { program: 'yarn', args: [script] };
    case 'bun':
      return { program: 'bun', args: ['run', script] };
    case 'npm':
    default:
      return { program: 'npm', args: ['run', script] };
  }
}

/**
 * Scripts worth surfacing first.
 *
 * Everything is offered, but this decides the order in the picker: `start` and
 * `dev` are what a developer reaches for first, and alphabetical order puts
 * `build` and `test` above both.
 */
const COMMON_FIRST = ['dev', 'start', 'build', 'test', 'lint', 'watch'];

/** Scripts that are plumbing rather than something a person runs. */
const HIDDEN = new Set([
  'prepublishOnly',
  'prepare',
  'prepublish',
  'postinstall',
  'preinstall',
  'version',
]);

/**
 * Script names in the order they should be offered.
 *
 * Known-useful scripts first, then the rest alphabetically, so the list is
 * stable between openings rather than depending on manifest key order.
 */
export function orderScripts(scripts: Record<string, string>): string[] {
  const names = Object.keys(scripts).filter((n) => !HIDDEN.has(n));
  const rank = (name: string) => {
    const at = COMMON_FIRST.indexOf(name);
    return at === -1 ? COMMON_FIRST.length : at;
  };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Run configurations for a project's scripts.
 *
 * These are `command` type so the existing runner handles them, and they are
 * *not* written to `.vscode/launch.json`: a manifest is a fact about the
 * project, not a user edit, and rewriting the user's launch file on open would
 * be both surprising and a source of merge conflicts.
 */
export function packageScriptConfigs(
  manifest: PackageManifest,
  manager: PackageManager,
  cwd: string,
): RunConfiguration[] {
  return orderScripts(manifest.scripts).map((script) => {
    const { program, args } = buildScriptCommand(manager, script);
    return {
      name: `npm: ${script}`,
      type: 'command' as const,
      program,
      args,
      cwd,
      request: 'run' as const,
      schematic: 'debug-run' as const,
    };
  });
}

/** True when the manifest declares something runnable. */
export function hasScripts(manifest: PackageManifest | null): boolean {
  return !!manifest && Object.keys(manifest.scripts).length > 0;
}

/**
 * Read a project's scripts and work out how to run them.
 *
 * Kept apart from the pure functions above because this one needs the backend:
 * `package.json` and the lockfiles have to be read from disk, and the manifest
 * has to be confined to the open workspace like every other path the editor
 * touches. Every failure resolves to `null` rather than throwing, because a
 * missing or malformed manifest is a normal state for a folder.
 */
export async function discoverProjectScripts(
  root: string,
): Promise<{ manager: PackageManager; configs: RunConfiguration[]; name?: string } | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ exists: boolean; is_file: boolean }>('path_info', {
      path: join(root, 'package.json'),
    });
    if (!info?.exists || !info.is_file) return null;

    const raw = (await invoke('read_file', { path: join(root, 'package.json') })) as string;
    const manifest = parsePackageJson(raw);
    if (!manifest || !hasScripts(manifest)) return null;

    // Lockfile presence is what decides the manager; asking the backend for each
    // candidate is cheaper than listing a large directory and simpler than
    // parsing one.
    const exists = async (name: string): Promise<boolean> => {
      try {
        const hit = await invoke<{ exists: boolean }>('path_info', { path: join(root, name) });
        return !!hit?.exists;
      } catch {
        return false;
      }
    };
    const manager = await detectPackageManagerAsync(exists);

    return { manager, configs: packageScriptConfigs(manifest, manager, root), name: manifest.name };
  } catch {
    return null;
  }
}

/** Join with a separator that works on both platforms, matching the backend's input. */
function join(root: string, name: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return root.endsWith(sep) || root.endsWith('/') || root.endsWith('\\')
    ? `${root}${name}`
    : `${root}${sep}${name}`;
}

/** Async form of {@link detectPackageManager}. */
async function detectPackageManagerAsync(
  fileExists: (name: string) => Promise<boolean>,
): Promise<PackageManager> {
  for (const [file, manager] of LOCKFILES) {
    if (await fileExists(file)) return manager;
  }
  return 'npm';
}
