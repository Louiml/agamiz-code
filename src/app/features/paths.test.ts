import { describe, expect, it } from 'vitest';
import {
  PathEscapeError,
  isAbsolutePath,
  isWithinRoot,
  normalizeSegments,
  resolveWithin,
  separatorOf,
} from './paths';

describe('isAbsolutePath', () => {
  it('detects a drive-letter path', () => {
    expect(isAbsolutePath('C:\\work')).toBe(true);
    expect(isAbsolutePath('c:/work')).toBe(true);
  });
  it('detects UNC and POSIX paths', () => {
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('/etc/hosts')).toBe(true);
  });
  it('rejects relative paths', () => {
    expect(isAbsolutePath('src/a.ts')).toBe(false);
    expect(isAbsolutePath('./a.ts')).toBe(false);
    expect(isAbsolutePath('../a.ts')).toBe(false);
  });
});

describe('separatorOf', () => {
  it('infers the separator from the path', () => {
    expect(separatorOf('C:\\a\\b')).toBe('\\');
    expect(separatorOf('/a/b')).toBe('/');
    expect(separatorOf('')).toBe('/');
  });
});

describe('normalizeSegments', () => {
  it('collapses . and duplicate separators', () => {
    expect(normalizeSegments('a//b/./c')).toBe('a/b/c');
  });

  it('resolves .. lexically', () => {
    expect(normalizeSegments('a/b/../c')).toBe('a/c');
    expect(normalizeSegments('a/b/../../c')).toBe('c');
  });

  it('keeps a leading .. on a relative path', () => {
    expect(normalizeSegments('../a')).toBe('../a');
  });

  it('absorbs .. at the root of an absolute path', () => {
    expect(normalizeSegments('/../etc/passwd')).toBe('/etc/passwd');
    expect(normalizeSegments('/a/../../b')).toBe('/b');
  });

  it('preserves a drive prefix', () => {
    expect(normalizeSegments('C:\\a\\..\\b')).toBe('C:\\b');
  });

  it('preserves a UNC prefix', () => {
    expect(normalizeSegments('\\\\server\\share\\a\\..\\b')).toBe('\\\\server\\share\\b');
  });
});

describe('isWithinRoot', () => {
  const root = 'C:\\work\\app';

  it('accepts the root itself', () => {
    expect(isWithinRoot(root, root)).toBe(true);
  });
  it('accepts a descendant', () => {
    expect(isWithinRoot('C:\\work\\app\\src\\a.ts', root)).toBe(true);
  });
  it('rejects a sibling with a shared prefix', () => {
    expect(isWithinRoot('C:\\work\\app-2\\a.ts', root)).toBe(false);
  });
  it('rejects an unrelated path', () => {
    expect(isWithinRoot('C:\\Users\\me\\.ssh', root)).toBe(false);
  });
  it('rejects everything when there is no root', () => {
    expect(isWithinRoot('C:\\work', '')).toBe(false);
  });
});

describe('resolveWithin', () => {
  const root = 'C:\\work\\app';

  it('joins a relative path onto the root', () => {
    expect(resolveWithin(root, 'src/a.ts')).toBe('C:\\work\\app\\src\\a.ts');
  });

  // A leading `/` is absolute by the usual rule, so it is rejected rather than
  // quietly reinterpreted as workspace-relative. The old code stripped it, which
  // meant `isAbsolutePath` and the join disagreed about the same string. The
  // error names the reason, and a model that meant "the src folder" retries as
  // `src/a.ts`. Reinterpreting it instead would also mean that on a POSIX root
  // a request for `/etc/passwd` silently became `<workspace>/etc/passwd`.
  it('rejects a leading-slash path rather than reinterpreting it', () => {
    expect(() => resolveWithin(root, '/src/a.ts')).toThrow(PathEscapeError);
  });

  it('accepts an absolute path that is inside the root', () => {
    expect(resolveWithin(root, 'C:\\work\\app\\src\\a.ts')).toBe('C:\\work\\app\\src\\a.ts');
  });

  // The core of the finding: this used to resolve to the attacker's target.
  it('rejects a traversal out of the root', () => {
    expect(() => resolveWithin(root, '../../../.ssh/authorized_keys'))
      .toThrow(PathEscapeError);
  });

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveWithin(root, 'C:\\Users\\me\\.ssh\\id_rsa')).toThrow(PathEscapeError);
  });

  it('rejects a traversal that re-enters by a different spelling', () => {
    // `app/..` is inside the root, but the *destination* is not; the check is
    // applied after normalization, so this cannot sneak through.
    expect(() => resolveWithin(root, 'sub/../../etc/passwd')).toThrow(PathEscapeError);
  });

  it('allows a traversal that stays inside', () => {
    expect(resolveWithin(root, 'src/lib/../a.ts')).toBe('C:\\work\\app\\src\\a.ts');
  });

  it('returns empty for an empty request', () => {
    expect(resolveWithin(root, '')).toBe('');
  });

  it('normalizes but does not contain when there is no root', () => {
    expect(resolveWithin('', 'a/../b.ts')).toBe('b.ts');
  });

  it('works with a POSIX root', () => {
    expect(resolveWithin('/home/u/app', 'src/a.ts')).toBe('/home/u/app/src/a.ts');
    expect(() => resolveWithin('/home/u/app', '../../etc/passwd')).toThrow(PathEscapeError);
  });
});
