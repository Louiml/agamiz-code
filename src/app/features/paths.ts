/**
 * Path containment for renderer-supplied paths.
 *
 * The agent and the chat-mode tool loop both take a path from a language model
 * and act on it. `agent.ts` used to join a relative path onto the workspace root
 * with a bare `replace(/^[\\/]+/, '')` and pass absolute paths straight through,
 * so `../../../.ssh/authorized_keys` resolved to an attacker's target rather
 * than being rejected, and `delete_file` on an absolute path was worse.
 *
 * This module is the frontend half of the fix. The backend half is `confine()`
 * in `src-tauri/src/lib.rs`, which canonicalizes and checks against an
 * allow-list — this layer exists to reject the obvious cases *before* an IPC
 * round-trip and to give the user a readable reason in the tool card.
 *
 * Note what this cannot do: it is a lexical check, so a symlink inside the
 * workspace still points wherever it points. That is exactly why the backend
 * canonicalizes rather than trusting the string we send it.
 */

/** A drive-letter, UNC, or POSIX-absolute path. */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

/**
 * The separator a path is written in, inferred from the path itself.
 *
 * Deliberately string-based rather than platform-based: the model may emit
 * either style, and the workspace root's own style is the best guess at what
 * the filesystem expects. A drive letter or UNC prefix settles it as `\`,
 * because a model asked for `src\a.ts` against a `C:\work\app` root will
 * otherwise produce the mixed `C:\work\app\src\a.ts`, whose two separators
 * normalize to different prefixes and fail the containment check.
 */
export function separatorOf(p: string): '/' | '\\' {
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('\\\\')) return '\\';
  return p.includes('\\') ? '\\' : '/';
}

/** Collapse `.` and `..` segments and duplicate separators, lexically. */
export function normalizeSegments(p: string): string {
  const sep = separatorOf(p);
  const unc = p.startsWith('\\\\');
  const drive = /^[a-zA-Z]:[\\/]/.exec(p)?.[0] ?? '';
  const rest = p.slice(drive.length);

  const isAbsolute = unc || drive !== '' || p.startsWith('/');
  const parts: string[] = [];
  for (const segment of rest.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // An absolute path cannot climb above its root; popping nothing means we
      // are already at the top, so `..` is absorbed rather than escaping.
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!isAbsolute) parts.push('..');
      continue;
    }
    parts.push(segment);
  }

  const joined = parts.join(sep);
  if (unc) return `\\\\${joined}`;
  if (drive) return `${drive}${joined}`;
  if (isAbsolute) return `${sep}${joined}`;
  return joined;
}

/** True when `candidate` is `root` or lives underneath it. */
export function isWithinRoot(candidate: string, root: string): boolean {
  if (!root) return false;
  const c = normalizeSegments(candidate);
  const r = normalizeSegments(root).replace(/[\\/]+$/, '');
  if (c === r) return true;
  return c.startsWith(`${r}/`) || c.startsWith(`${r}\\`);
}

export class PathEscapeError extends Error {
  constructor(readonly requested: string, readonly root: string) {
    super(`path ${requested} resolves outside the workspace`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve a model-supplied path against the workspace root, refusing anything
 * that lands outside it.
 *
 * Throws [`PathEscapeError`] rather than returning a clamped path, so the
 * caller can surface the refusal instead of silently doing nothing — a silent
 * clamp would leave the model believing a write succeeded.
 *
 * With no root there is nothing to contain the path, so it is normalized and
 * returned unchanged. That is not a hole: with no workspace registered, the
 * backend's `confine()` only knows the config directory, so a write is refused
 * there with a clear error rather than landing at the process CWD.
 */
export function resolveWithin(root: string, requested: string): string {
  if (!requested) return '';
  if (!root) return normalizeSegments(requested);
  const resolved = isAbsolutePath(requested)
    ? normalizeSegments(requested)
    : normalizeSegments(`${root.replace(/[\\/]+$/, '')}${separatorOf(root)}${requested}`);
  if (!isWithinRoot(resolved, root)) throw new PathEscapeError(requested, root);
  return resolved;
}

/**
 * The folder name to show for an opened workspace root.
 *
 * Deliberately not a filesystem call: the root is already a string in app
 * state, and a display label should not depend on the disk still being there.
 * Both separators are accepted because a path can arrive from the OS picker
 * (native separators) or from a restored session (whatever was saved).
 *
 * Returns `''` when there is no workspace or the root is a filesystem root,
 * which is the "show nothing extra" case in the title bar.
 */
export function workspaceName(root: string): string {
  const trimmed = root.trim();
  if (trimmed === '') return '';
  // Trailing separators are stripped first so `C:\work\app\` is `app` and not
  // the empty segment after the last separator.
  const stripped = trimmed.replace(/[\\/]+$/, '');
  if (stripped === '') return ''; // `/` or `C:\`
  const cut = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  const name = stripped.slice(cut + 1);
  // A bare drive letter (`C:`) is a name, not an empty one.
  return name === '' ? stripped : name;
}
