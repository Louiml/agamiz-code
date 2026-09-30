/**
 * Run configurations: load/save VSCode-style `.vscode/launch.json`, provide a
 * registry of configurations for the current working directory, and drive
 * NG.EXEC execution / debugging of them via the backend process tunnel.
 */

export type ConfigType = 'node' | 'python' | 'command' | 'rak';

export interface RunConfiguration {
  name: string;
  type: ConfigType;
  /** executable or interpreter */
  program?: string;
  /** path of script to run */
  file?: string;
  /** arguments passed to program */
  args?: string[];
  /** working directory */
  cwd?: string;
  /** env vars */
  env?: Record<string, string>;
  /** launch debugger instead of running */
  request?: 'launch' | 'attach';
  /** stop at first line when debugging (node --inspect-brk) */
  stopOnEntry?: boolean;
  schematic: 'debug-run';
}

export interface LaunchFile {
  version: string;
  configurations: RunConfiguration[];
}

const tryParse = (s: string): LaunchFile | null => {
  try {
    const raw = JSON.parse(s);
    if (!raw || typeof raw !== 'object') return null;
    const cfg = raw.configurations;
    return {
      version: String(raw.version ?? '0.2.0'),
      configurations: Array.isArray(cfg) ? cfg : [],
    } as LaunchFile;
  } catch {
    return null;
  }
};

/** Load `.vscode/launch.json` from the cwd via the backend. */
export async function loadLaunchFile(cwd: string): Promise<LaunchFile> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = (await invoke('read_file', { path: `${cwd}\\.vscode\\launch.json` })) as string;
    return tryParse(raw) ?? { version: '0.2.0', configurations: [] };
  } catch {
    return { version: '0.2.0', configurations: [] };
  }
}

export async function saveLaunchFile(cwd: string, file: LaunchFile): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('create_dir', { path: `${cwd}\\.vscode` });
    } catch {
      /* already exists */
    }
    await invoke('save_file', { path: `${cwd}\\.vscode\\launch.json`, content: JSON.stringify(file, null, 2) });
    return true;
  } catch {
    return false;
  }
}

/** Suggest a sensible default configuration for a file by language. */
export function defaultConfigFor(file: string, languageId: string, cwd: string): RunConfiguration | null {
  const name = `Run ${file.split(/[\\/]/).pop()}`;
  switch (languageId) {
    case 'javascript':
    case 'typescript':
      return { name, type: 'node', program: 'node', file, args: [], cwd, request: 'launch', stopOnEntry: false, schematic: 'debug-run' };
    case 'python':
      return { name, type: 'python', program: 'python', file, args: [], cwd, request: 'launch', stopOnEntry: false, schematic: 'debug-run' };
    default:
      return null;
  }
}

export async function ensureDefaultConfig(config: RunConfiguration, cwd: string) {
  const file = await loadLaunchFile(cwd);
  if (!file.configurations.some((c) => c.name === config.name)) {
    file.configurations.push(config);
    await saveLaunchFile(cwd, file);
  }
}

/**
 * Assemble the CLI arguments for a config. For node/python debugging this
 * inserts the inspector flags so the process exposes a CDP endpoint.
 */
export function buildCommandLines(config: RunConfiguration, cwdOverride?: string): { program: string; args: string[]; cwd: string } {
  const cwd = cwdOverride ?? config.cwd ?? '';
  const args = [...(config.args ?? [])];
  if (config.type === 'node' && config.request === 'launch') {
    return { program: config.program ?? 'node', args: [...(config.stopOnEntry ? ['--inspect-brk'] : ['--inspect']), ...(config.file ? [config.file] : []), ...args], cwd };
  }
  if (config.type === 'python' && config.request === 'launch') {
    return { program: config.program ?? 'python', args: ['-m', 'debugpy', '--listen', '5678', ...(config.stopOnEntry ? ['--wait-for-client'] : []), ...(config.file ? [config.file] : []), ...args], cwd };
  }
  return { program: config.program ?? config.file ?? '', args, cwd };
}