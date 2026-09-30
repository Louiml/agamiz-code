/**
 * Git source-control service. All operations run through the backend
 * `exec_result` tunnel (non-interactive). Provides repository discovery,
 * status parsing (staged / unstaged / untracked / conflicts), and common
 * porcelain operations (add, commit, stage-all, diff, log, branch).
 */

import { execResult, ExecResult } from './runner';

export interface GitStatusEntry {
  path: string;
  staged: boolean;
  kind: 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed' | 'conflicted';
  /** state for porcelain XY codes */
  x: string;
  y: string;
}

export interface GitRepoInfo {
  root: string;
  branch: string;
}

export class GitService {
  constructor(private cwd: string) {}

  private async git(args: string[]): Promise<ExecResult> {
    return execResult('git', args, this.cwd);
  }

  private isRepo(result: ExecResult): boolean {
    return result.code === 0;
  }

  async detect(): Promise<GitRepoInfo | null> {
    const r = await this.git(['rev-parse', '--show-toplevel']);
    if (!this.isRepo(r)) return null;
    const root = r.stdout.trim();
    const branchR = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchR.code === 0 ? branchR.stdout.trim() : 'HEAD';
    return { root, branch };
  }

  /**
   * Parse `git status --porcelain=v1 -z` (NUL-delimited) into typed entries.
   */
  private parsePorcelainZ(outStdout: string, outStderr: string): GitStatusEntry[] {
    const chunks = (outStdout + outStderr).split('\u0000').filter((s) => s.length > 0);
    const entries: GitStatusEntry[] = [];
    for (const chunk of chunks) {
      const x = chunk[0];
      const y = chunk[1];
      const path = chunk.slice(3);
      let kind: GitStatusEntry['kind'] = 'modified';
      if (x === '?' && y === '?') kind = 'untracked';
      else if (x === 'A') kind = 'added';
      else if (x === 'D') kind = 'deleted';
      else if (x === 'R') kind = 'renamed';
      else if (x === 'U' || y === 'U' || (x === 'D' && y === 'D')) kind = 'conflicted';
      entries.push({
        path,
        staged: x !== ' ' && x !== '?',
        kind,
        x,
        y,
      });
    }
    return entries;
  }

  async status(): Promise<GitStatusEntry[]> {
    const r = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (r.code !== 0) return [];
    return this.parsePorcelainZ(r.stdout, r.stderr);
  }

  async stage(path: string): Promise<void> {
    await this.git(['add', '--', path]);
  }

  async unstage(path: string): Promise<void> {
    await this.git(['reset', 'HEAD', '--', path]);
  }

  async stageAll(): Promise<void> {
    await this.git(['add', '-A']);
  }

  async commit(message: string): Promise<ExecResult> {
    return this.git(['commit', '-m', message]);
  }

  async diff(path?: string): Promise<string> {
    const r = path ? await this.git(['diff', '--', path]) : await this.git(['diff']);
    return (r.stdout || r.stderr).trim();
  }

  async diffStaged(path?: string): Promise<string> {
    const r = path ? await this.git(['diff', '--cached', '--', path]) : await this.git(['diff', '--cached']);
    return (r.stdout || r.stderr).trim();
  }

  async log(limit = 20): Promise<{ hash: string; message: string; date: string }[]> {
    const r = await this.git([
      'log', `-${limit}`,
      '--format=%H%x1e%h%x1f%cd%x1e%s',
      '--date=short',
    ]);
    return (r.stdout || r.stderr)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, rest] = line.split('\u001e');
        const [date, message] = (rest ?? '').split('\u001f');
        return { hash: hash || '', date: date || '', message: message || '' };
      });
  }

  async branches(): Promise<string[]> {
    const r = await this.git(['branch', '--format=%(refname:short)']);
    if (r.code !== 0) return [];
    return (r.stdout || r.stderr).split('\n').filter(Boolean).map((b) => b.replace(/^\*\s*/, ''));
  }
}

export const formatScopeCounts = (entries: GitStatusEntry[]) => {
  const staged = entries.filter((e) => e.staged && e.kind !== 'untracked').length;
  const unstagedChanges = entries.filter((e) => !e.staged && e.kind !== 'untracked').length;
  const untracked = entries.filter((e) => e.kind === 'untracked').length;
  return { staged, unstaged: unstagedChanges, untracked };
};