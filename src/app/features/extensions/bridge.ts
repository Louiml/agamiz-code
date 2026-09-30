/**
 * Typed bridge to the Rust extension host (`src-tauri/src/ext`).
 *
 * Every shape here mirrors a `serde` struct on the Rust side, so the field
 * names are snake_case — that is what serde emits for
 * `ExtensionRecord`/`WorkspaceSnapshot`, which declare no `rename_all`.
 * Renaming them to camelCase would be more idiomatic TypeScript but would mean
 * either a `rename_all` on the Rust structs or an adapter layer that silently
 * diverges; keeping the wire format honest means a mismatch is a compile error
 * in one place rather than a `undefined` at runtime.
 *
 * Every function degrades to a no-op when the Tauri bridge is absent, because
 * the app is also built as a static export (`output: 'export'`) and must render
 * in a plain browser.
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauri, errText } from '../../lib/tauri';
import type { ProjectTemplate } from '../projectTemplates';

// ---------------------------------------------------------------------------
// Channel names — must match `crate::ext::events`
// ---------------------------------------------------------------------------

export const EXT_CHANNELS = {
  /** Full extension list changed. */
  extensions: 'ext://extensions',
  /** Commands / status items / sidebar panels changed. */
  registry: 'ext://registry',
  /** A notification the extension asked to show. */
  notice: 'ext://notice',
  /** A line for the output panel. */
  log: 'ext://log',
  /** A request for the editor to act. */
  editor: 'ext://editor',
} as const;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** One installed extension, as rendered by the Extensions panel. */
export interface ExtensionRecord {
  id: string;
  display_name: string;
  version: string;
  description?: string;
  author?: string;
  repository?: string;
  /** Absolute install folder. */
  path: string;
  /** `installed` | `dev` (dev extensions hot-reload on save). */
  source: string;
  enabled: boolean;
  /** Whether `activate()` has run and not been torn down. */
  active: boolean;
  permissions: string[];
  activation_events: string[];
  error?: string;
  commands: string[];
  status_items: string[];
  panels: string[];
}

export interface CommandRecord {
  id: string;
  extension_id: string;
  title: string;
  shortcut?: string;
}

export interface StatusRecord {
  /** `"{extension_id}:{item_id}"`. */
  key: string;
  extension_id: string;
  text: string;
  icon?: string;
  alignment: 'left' | 'right';
  priority: number;
}

export interface PanelRecord {
  id: string;
  extension_id: string;
  title: string;
  icon?: string;
  /** Plain text. The host never evaluates extension-supplied markup. */
  body: string;
}

/** One file an extension's "New Project" template will write. */
export interface ProjectTemplateFileRecord {
  path: string;
  content: string;
}

/**
 * A "New Project" template contributed via `agamiz.projects.register`.
 *
 * Static data on purpose: the wizard previews the tree and asks about
 * collisions *before* the user commits, which a creation-time callback could
 * not support.
 */
export interface ProjectTemplateRecord {
  id: string;
  extension_id: string;
  name: string;
  description: string;
  icon?: string;
  tags: string[];
  /** Run in the new project root after the files are written. */
  create_command?: string;
  /** Shown in the terminal after creation, e.g. `npm install`. */
  install_command?: string;
  /** Relative path opened as the first tab. */
  entry_file?: string;
  files: ProjectTemplateFileRecord[];
  /**
   * Paths the `create_command` generator is expected to produce, shown in the
   * wizard's preview. Absent on an older host, hence the runtime guard.
   */
  declared_outputs?: string[];
}

export interface RegistrySnapshot {
  commands: CommandRecord[];
  status: StatusRecord[];
  panels: PanelRecord[];
  /** New Project templates. Absent on an older host, hence the runtime guard. */
  project_templates?: ProjectTemplateRecord[];
}

export interface TextPosition {
  line: number;
  character: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

/** Mirror of the open buffer, pushed to the host so the Lua API can answer
 *  synchronously instead of blocking on an IPC round-trip. */
export interface WorkspaceSnapshot {
  root: string;
  active_path: string;
  active_text: string;
  selection?: TextRange;
  cursor: TextPosition;
  language_id: string;
}

export interface EditorRequest {
  extensionId: string;
  /**
   * `openBuffer` is the odd one out: it creates a new untitled tab instead of
   * mutating the active one, and it reads `name` rather than `line`/`character`.
   * Both fields are therefore optional here — the host omits them for the
   * positional actions and omits the position for this one.
   */
  action: 'insert' | 'setText' | 'replaceSelection' | 'openBuffer';
  line?: number;
  character?: number;
  text: string;
  /** Suggested filename for `openBuffer`. */
  name?: string;
}

export interface ExtensionNotice {
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  extensionId: string;
}

export interface ExtensionLogLine {
  extensionId: string;
  level: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Invoke wrappers
// ---------------------------------------------------------------------------

/** Run a Tauri command, turning a rejection into a readable message. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('The extension host is only available in the desktop app.');
  }
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw new Error(errText(e));
  }
}

export const ext = {
  list: () => call<ExtensionRecord[]>('ext_list'),
  registry: () => call<RegistrySnapshot>('ext_registry'),
  root: () => call<string>('ext_root'),

  setEnabled: (id: string, enabled: boolean) =>
    call<void>('ext_set_enabled', { id, enabled }),
  reload: (id: string) => call<void>('ext_reload', { id }),
  uninstall: (id: string) => call<void>('ext_uninstall', { id }),
  runCommand: (id: string, args: string[] = []) =>
    call<void>('ext_run_command', { id, args }),
  openFolder: (id: string) => call<void>('ext_open_folder', { id }),

  installFolder: (path: string) =>
    call<ExtensionRecord>('ext_install_folder', { path }),
  installZip: (path: string) => call<ExtensionRecord>('ext_install_zip', { path }),
  installGit: (url: string, reference?: string) =>
    call<ExtensionRecord>('ext_install_git', { url, reference: reference ?? null }),
  /** Install into the watched `dev/` folder so the extension hot-reloads. */
  installDev: (path: string) => call<ExtensionRecord>('ext_install_dev', { path }),

  /** Push the current buffer state. Called whenever the active tab changes. */
  syncWorkspace: (snapshot: WorkspaceSnapshot) =>
    call<void>('ext_sync_workspace', { snapshot }),
  /** Ask the host to activate anything whose `activationEvents` match. */
  activateFor: (event: string) => call<string[]>('ext_activate_for', { event }),
  /** Deliver an event to `agamiz.on` listeners in one extension. */
  emit: (extensionId: string, event: string, payload: unknown) =>
    call<void>('ext_emit_event', { extensionId, event, payload }),
  /** Tell extensions a file was saved. */
  notifySave: (path: string) => call<void>('ext_notify_save', { path }),
};

// ---------------------------------------------------------------------------
// A palette command, shaped to drop straight into `<CommandPalette commands>`.
// ---------------------------------------------------------------------------

/** Build the palette entry for an extension-contributed command. */
export function toPaletteCommand(
  record: CommandRecord,
  run: (id: string) => void,
): { id: string; label: string; shortcut?: string; action: () => void } {
  return {
    id: record.id,
    label: record.title,
    shortcut: record.shortcut,
    action: () => run(record.id),
  };
}

// ---------------------------------------------------------------------------
// Extension-contributed "New Project" templates
// ---------------------------------------------------------------------------

/** Icon names an extension may use. Anything else falls back rather than
 *  rendering a broken lookup, since `Icon` keys off a closed union. */
const KNOWN_ICONS = new Set([
  'save', 'play', 'file-plus', 'file-text', 'folder', 'folder-open', 'folder-plus',
  'folder-search', 'terminal', 'panel-left', 'monitor', 'search', 'zap', 'bar-chart',
  'eraser', 'trash', 'x', 'chevron-down', 'chevron-up', 'chevron-right', 'scissors',
  'clipboard', 'copy', 'pencil', 'rotate-cw', 'replace', 'arrow-up', 'arrow-down',
  'key', 'box', 'file-code', 'tab', 'ruler', 'message-square', 'gear', 'dot',
  'list', 'check', 'book', 'bug', 'sparkles', 'warning', 'git-branch', 'rocket',
  'split', 'plus', 'maximize', 'minimize', 'panel-bottom', 'sidebar', 'square',
  'extensions', 'package',
]);

/**
 * Adapt a host record to the shape the wizard renders.
 *
 * The registry key is `"{extension_id}:{id}"` so two extensions can both offer
 * a template called `"default"`. That namespaced form is what the wizard and
 * the host both key on, so it is preserved rather than stripped.
 */
export function toProjectTemplate(record: ProjectTemplateRecord): ProjectTemplate {
  const icon = record.icon && KNOWN_ICONS.has(record.icon) ? record.icon : 'package';
  return {
    id: `${record.extension_id}:${record.id}`,
    name: record.name,
    description: record.description,
    icon: icon as ProjectTemplate['icon'],
    tags: Array.isArray(record.tags) ? record.tags : [],
    installCommand: record.install_command ?? null,
    entryFile: record.entry_file ?? null,
    createCommand: record.create_command ?? null,
    // Only kept if it looks like a relative path. The host validates this, but
    // a record from a mismatched host version should not be able to inject an
    // absolute path into the preview tree.
    declaredOutputs: Array.isArray(record.declared_outputs)
      ? record.declared_outputs.filter(
          (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.startsWith('\\'),
        )
      : [],
    files: Array.isArray(record.files)
      ? record.files
          .filter((f) => typeof f?.path === 'string' && f.path.length > 0)
          .map((f) => ({ path: f.path, content: typeof f.content === 'string' ? f.content : '' }))
      : [],
    source: record.extension_id,
  };
}
