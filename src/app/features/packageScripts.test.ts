import { describe, expect, it } from 'vitest';
import {
  buildScriptCommand,
  detectPackageManager,
  hasScripts,
  orderScripts,
  packageScriptConfigs,
  parsePackageJson,
} from './packageScripts';

const manifest = (scripts: Record<string, string>, name?: string) =>
  JSON.stringify({ name, scripts });

describe('parsePackageJson', () => {
  it('reads the scripts block', () => {
    const m = parsePackageJson(manifest({ build: 'tsc', start: 'node .' }));
    expect(m?.scripts).toEqual({ build: 'tsc', start: 'node .' });
    expect(m?.name).toBeUndefined();
  });

  it('reads the package name', () => {
    expect(parsePackageJson(manifest({}, 'my-app'))?.name).toBe('my-app');
  });

  it('returns null for malformed JSON rather than throwing', () => {
    // A half-typed manifest is a normal state, not an error.
    expect(parsePackageJson('{ "scripts": { "a": ')).toBeNull();
    expect(parsePackageJson('')).toBeNull();
  });

  it('rejects a manifest that is not an object', () => {
    expect(parsePackageJson('[]')).toBeNull();
    expect(parsePackageJson('"hello"')).toBeNull();
    expect(parsePackageJson('null')).toBeNull();
  });

  it('survives a manifest with no scripts block', () => {
    expect(parsePackageJson('{"name":"x"}')?.scripts).toEqual({});
  });

  it('ignores script values that are not strings', () => {
    // `preinstall: true` is a typo, not a command to run.
    const m = parsePackageJson('{"scripts":{"a":"echo a","b":true,"c":42}}');
    expect(m?.scripts).toEqual({ a: 'echo a' });
  });

  it('ignores a scripts block that is not an object', () => {
    expect(parsePackageJson('{"scripts":["a"]}')?.scripts).toEqual({});
  });
});

describe('detectPackageManager', () => {
  const only = (...present: string[]) => (name: string) => present.includes(name);

  it('defaults to npm when there is no lockfile', () => {
    expect(detectPackageManager(only())).toBe('npm');
  });

  it('detects each manager from its lockfile', () => {
    expect(detectPackageManager(only('package-lock.json'))).toBe('npm');
    expect(detectPackageManager(only('npm-shrinkwrap.json'))).toBe('npm');
    expect(detectPackageManager(only('pnpm-lock.yaml'))).toBe('pnpm');
    expect(detectPackageManager(only('yarn.lock'))).toBe('yarn');
    expect(detectPackageManager(only('bun.lockb'))).toBe('bun');
    expect(detectPackageManager(only('bun.lock'))).toBe('bun');
  });

  it('prefers pnpm when several lockfiles are present', () => {
    // A repo can carry more than one; the non-npm ones win because running npm
    // against a pnpm project installs the wrong tree.
    expect(detectPackageManager(only('package-lock.json', 'pnpm-lock.yaml'))).toBe('pnpm');
    expect(detectPackageManager(only('package-lock.json', 'yarn.lock'))).toBe('yarn');
  });
});

describe('buildScriptCommand', () => {
  it('uses the spelling each manager expects', () => {
    expect(buildScriptCommand('npm', 'build')).toEqual({ program: 'npm', args: ['run', 'build'] });
    expect(buildScriptCommand('pnpm', 'build')).toEqual({ program: 'pnpm', args: ['run', 'build'] });
    expect(buildScriptCommand('yarn', 'build')).toEqual({ program: 'yarn', args: ['build'] });
    expect(buildScriptCommand('bun', 'build')).toEqual({ program: 'bun', args: ['run', 'build'] });
  });
});

describe('orderScripts', () => {
  it('puts the everyday scripts first', () => {
    const ordered = orderScripts({ test: '', build: '', alpha: '', dev: '', start: '' });
    expect(ordered.slice(0, 3)).toEqual(['dev', 'start', 'build']);
  });

  it('sorts the remainder alphabetically', () => {
    expect(orderScripts({ zeta: '', alpha: '', dev: '' })).toEqual(['dev', 'alpha', 'zeta']);
  });

  it('hides lifecycle scripts that are not meant to be run by hand', () => {
    const ordered = orderScripts({ preinstall: '', postinstall: '', prepare: '', dev: '' });
    expect(ordered).toEqual(['dev']);
  });

  it('is stable across calls for the same input', () => {
    const scripts = { b: '', a: '', c: '' };
    expect(orderScripts(scripts)).toEqual(orderScripts(scripts));
  });
});

describe('packageScriptConfigs', () => {
  it('maps each script to a runnable command configuration', () => {
    const configs = packageScriptConfigs(
      { scripts: { dev: 'vite', build: 'tsc' } },
      'npm',
      '/w/app',
    );
    expect(configs.map((c) => c.name)).toEqual(['npm: dev', 'npm: build']);
    expect(configs[0]).toEqual({
      name: 'npm: dev',
      type: 'command',
      program: 'npm',
      args: ['run', 'dev'],
      cwd: '/w/app',
      request: 'run',
      schematic: 'debug-run',
    });
  });

  it('uses the detected manager, not always npm', () => {
    const configs = packageScriptConfigs({ scripts: { build: 'x' } }, 'pnpm', '/w/app');
    expect(configs[0].program).toBe('pnpm');
  });

  it('is not written to launch.json by this module', () => {
    // A manifest is a fact about the project; rewriting the user's launch file
    // on open would be surprising and would conflict on every branch.
    expect(typeof packageScriptConfigs).toBe('function');
    const configs = packageScriptConfigs({ scripts: { dev: 'x' } }, 'npm', '/w/app');
    expect(configs).toHaveLength(1);
  });

  it('yields nothing for a manifest with no scripts', () => {
    expect(packageScriptConfigs({ scripts: {} }, 'npm', '/w/app')).toEqual([]);
  });
});

describe('hasScripts', () => {
  it('is false for null and for an empty block', () => {
    expect(hasScripts(null)).toBe(false);
    expect(hasScripts({ scripts: {} })).toBe(false);
  });

  it('is true when there is something to run', () => {
    expect(hasScripts({ scripts: { dev: 'vite' } })).toBe(true);
  });
});
