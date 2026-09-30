/**
 * Settings schema: the single source of truth for every user-visible setting.
 *
 * Shape rules
 * -----------
 * 1. Sections are nested objects (`editor.fontSize`), and every leaf is
 *    addressed by a dotted `SettingsKey` path. One flat key namespace means
 *    the settings UI registry, the JSON editor, workspace-override diffing and
 *    the "modified" badge all operate on the same primitive.
 * 2. `DEFAULT_SETTINGS` is the base of every read path. A missing key always
 *    resolves to its default, so adding a field here is backward compatible
 *    with every settings file already on disk.
 * 3. Values are JSON-native. A setting that needs structure (env vars, key
 *    overrides) is a plain object so it round-trips through `settings.json`
 *    without a custom codec.
 *
 * Two layers exist at runtime and this module owns only the *shape*:
 *   - user settings      → `~/.agamizcode/settings.json` (mirrored to
 *                          localStorage for a synchronous first paint)
 *   - workspace settings → `<root>/.agamiz/settings.json`
 * The merge/override logic lives in `./store`.
 */

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

export type ThemeId =
  | 'agamiz-dark'
  | 'one-dark-pro'
  | 'dracula'
  | 'github-dark'
  | 'nord'
  | 'cyberpunk'
  | 'light';

export type RunModeId = 'interp' | 'vm' | 'bench';
export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
export type WhitespaceRender = 'none' | 'boundary' | 'all';
export type WordWrapMode = 'off' | 'on' | 'bounded';
export type LineNumberMode = 'on' | 'off' | 'relative';
export type SidebarPosition = 'left' | 'right';
export type PanelPosition = 'bottom' | 'right';
export type CursorStyle = 'block' | 'underline' | 'bar';
export type StartupLayoutMode = 'full' | 'editors' | 'empty';

/** `window` — what the IDE does when it launches. */
export interface GeneralSettings {
  /** Reopen the last workspace folder on launch. */
  restoreLastWorkspace: boolean;
  /** Restore the editor tabs that were open at shutdown. */
  reopenClosedEditors: boolean;
  /** How much of the previous layout to restore. */
  startupLayout: StartupLayoutMode;
  /** Ask before closing the window when buffers are dirty. */
  confirmBeforeExit: boolean;
  /** Folder opened when a workspace is requested and nothing is remembered. */
  defaultWorkspaceFolder: string;
  /** How many folders the welcome screen's recent list keeps. */
  recentProjectsLimit: number;
  /** Anonymous crash/usage reporting. Off by default, and stays local until
   *  a backend is actually wired up. */
  telemetryEnabled: boolean;
  /** Open developer tools on launch. */
  launchInDevMode: boolean;
}

/** `appearance` — theme engine, typography, layout placement. */
export interface AppearanceSettings {
  theme: ThemeId;
  /** Hex override for the accent; `null` follows the theme's own accent. */
  accent: string | null;
  editorFontFamily: string;
  editorFontLigatures: boolean;
  /** Whole-UI zoom, 0.8–1.5. Applied as a root font-size multiplier. */
  uiScale: number;
  sidebarPosition: SidebarPosition;
  panelPosition: PanelPosition;
  /** Dim the whole chrome after N minutes without input. 0 disables. */
  autoDimAfterMinutes: number;
  /** Reduce motion for panel transitions. */
  reducedMotion: boolean;
}

/** `editor` — the buffer itself. */
export interface EditorSettings {
  fontSize: number;
  /** Multiplier applied to `fontSize`; the editor's pixel metrics derive
   *  from the product, so line numbers and the caret stay aligned. */
  lineHeight: number;
  tabSize: number;
  insertSpaces: boolean;
  /** Insert the matching pair as you type. */
  autoClose: boolean;
  /** Tint bracket pairs while the caret sits between them. */
  bracketPairColorization: boolean;
  /** Clamp the caret to leading whitespace when leaving a line. */
  autoIndent: boolean;
  renderWhitespace: WhitespaceRender;
  wordWrap: WordWrapMode;
  /** Column `wordWrap: 'bounded'` wraps at. */
  wordWrapColumn: number;
  lineNumbers: LineNumberMode;
  minimapEnabled: boolean;
  /** Minimap width multiplier. */
  minimapScale: number;
  autoSave: AutoSaveMode;
  /** Delay for `autoSave: 'afterDelay'`, milliseconds. */
  autoSaveDelay: number;
  formatOnSave: boolean;
  /** Toolbar row shown above the tab strip (breadcrumb / run controls). */
  showBreadcrumb: boolean;
  /** Per-tab dirty indicator in the title bar. */
  markDirtyInTitle: boolean;
}

/**
 * A shell the user added by hand, on top of the ones detected on the host.
 * Mirrors VS Code's `terminal.integrated.profiles.*.linux/windows` entries.
 */
export interface CustomShellProfile {
  id: string;
  name: string;
  /** Executable; resolved against PATH when it is not an absolute path. */
  program: string;
  /** Default argv, e.g. `["-d", "Ubuntu"]` for WSL or `["--login", "-i"]`. */
  args: string[];
  /** Working directory; empty means "start in the workspace root". */
  cwd: string;
  /** Extra environment variables injected on top of the inherited set. */
  env: Record<string, string>;
  /** Hex accent used for the session tab and sidebar dot. */
  color: string;
}

/** `terminal` — shells, fonts, cursor, buffer. */
export interface TerminalSettings2 {
  defaultProfileId: string;
  /** User-authored shells, appended to the detected ones. */
  profiles: CustomShellProfile[];
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  cursorSmooth: boolean;
  /** Scrollback lines retained per session. */
  scrollback: number;
  webgl: boolean;
  /** xterm `minimumContrastRatio`; 1 disables the boost. */
  minimumContrastRatio: number;
  confirmKill: boolean;
  copyOnSelection: boolean;
}

/** `run` — interpreters, default run mode, environment. */
export interface RunSettings {
  interpreterPath: string;
  defaultRunMode: RunModeId;
  /** Working directory for spawned programs; empty = workspace root. */
  workingDirectory: string;
  /** Extra environment variables merged into every spawned process. */
  env: Record<string, string>;
  /** Stop the previous run before starting a new one. */
  killPreviousRun: boolean;
  /** Clear the output panel when a run starts. */
  clearOutputOnRun: boolean;
  /** Ask before running when the active buffer is dirty. */
  confirmRun: boolean;
}

/** `keymap` — user overrides only; the defaults come from `./keymap`. */
export interface KeymapSettings {
  /** commandId → chord, e.g. `{ 'file.save': 'ctrl+alt+s' }`. */
  bindings: Record<string, string>;
}

export interface Settings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
  editor: EditorSettings;
  terminal: TerminalSettings2;
  run: RunSettings;
  keymap: KeymapSettings;
}

export type SettingsSection = keyof Settings;

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export const EDITOR_FONT_STACK =
  '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, "SF Mono", "Liberation Mono", ui-monospace, monospace';

export const TERMINAL_FONT_STACK =
  '"Cascadia Code", "JetBrains Mono", "Fira Code", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace';

/** Frozen so a stray `setByPath` on `DEFAULT_SETTINGS` can never poison every
 *  later read. Callers always go through `cloneSettings`. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  general: Object.freeze({
    restoreLastWorkspace: true,
    reopenClosedEditors: true,
    startupLayout: 'full',
    confirmBeforeExit: false,
    defaultWorkspaceFolder: '',
    recentProjectsLimit: 10,
    telemetryEnabled: false,
    launchInDevMode: false,
  }),
  appearance: Object.freeze({
    theme: 'agamiz-dark',
    accent: null,
    editorFontFamily: EDITOR_FONT_STACK,
    editorFontLigatures: true,
    uiScale: 1,
    sidebarPosition: 'left',
    panelPosition: 'bottom',
    autoDimAfterMinutes: 0,
    reducedMotion: false,
  }),
  editor: Object.freeze({
    fontSize: 14,
    lineHeight: 1.45,
    tabSize: 4,
    insertSpaces: true,
    autoClose: true,
    bracketPairColorization: true,
    autoIndent: true,
    renderWhitespace: 'boundary',
    wordWrap: 'off',
    wordWrapColumn: 80,
    lineNumbers: 'on',
    minimapEnabled: true,
    minimapScale: 1,
    autoSave: 'off',
    autoSaveDelay: 1000,
    formatOnSave: false,
    showBreadcrumb: true,
    markDirtyInTitle: true,
  }),
  terminal: Object.freeze({
    defaultProfileId: '',
    profiles: Object.freeze([]) as readonly CustomShellProfile[],
    fontFamily: TERMINAL_FONT_STACK,
    fontSize: 12.5,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorStyle: 'block',
    cursorBlink: true,
    cursorSmooth: true,
    scrollback: 10000,
    webgl: true,
    minimumContrastRatio: 1,
    confirmKill: false,
    copyOnSelection: false,
  }),
  run: Object.freeze({
    interpreterPath: '',
    defaultRunMode: 'interp',
    workingDirectory: '',
    env: Object.freeze({}),
    killPreviousRun: true,
    clearOutputOnRun: true,
    confirmRun: false,
  }),
  keymap: Object.freeze({
    bindings: Object.freeze({}),
  }),
}) as Settings;

/** Anything a leaf may hold, used by the validator and the JSON editor. */
export type SettingValue = string | number | boolean | null | SettingValue[] | { [k: string]: SettingValue };

/**
 * One override layer. A layer holds *only the keys that differ from the
 * defaults* — an empty object means "no overrides", which is what makes
 * "Reset to Defaults" an `{}` rather than sixty literals written back.
 */
export type SettingsLayer = {
  [S in SettingsSection]?: Partial<Settings[S]>;
};

/* ------------------------------------------------------------------ */
/* Key paths                                                           */
/* ------------------------------------------------------------------ */

type SettingLeaf = string | number | boolean | null | bigint | symbol | undefined;

/**
 * Flattens `Settings` into dotted leaf paths.
 *
 * The recursion test cannot be `T[K] extends Record<string, unknown>`: an
 * `interface` has no implicit index signature, so every section would collapse
 * to its bare name (`'terminal'` instead of `'terminal.fontSize'`). Testing
 * `object` instead handles interfaces, while two guards keep the result
 * addressable:
 *   - an index signature (`run.env: Record<string, string>`) stays a leaf, so
 *     `run.env` is a single settable key rather than `run.env.${string}`,
 *   - an array (`terminal.profiles`) stays a leaf, since the whole list is
 *     replaced at once rather than addressed element by element.
 */
type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: NonNullable<T[K]> extends SettingLeaf | unknown[]
    ? `${Prefix}${K}`
    : string extends keyof NonNullable<T[K]>
      ? `${Prefix}${K}`
      : NonNullable<T[K]> extends object
        ? Leaves<NonNullable<T[K]>, `${Prefix}${K}.`>
        : `${Prefix}${K}`;
}[keyof T & string];

/** Every addressable leaf, e.g. `editor.fontSize`. Compile-time checked
 *  against `Settings`, so renaming a field breaks the build rather than
 *  silently orphaning a persisted value. */
export type SettingsKey = Leaves<Settings>;

/** Sections, in the order the sidebar renders them. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  'general',
  'appearance',
  'editor',
  'terminal',
  'run',
  'keymap',
];

/* ------------------------------------------------------------------ */
/* Structural helpers                                                  */
/* ------------------------------------------------------------------ */

type Plain = { [k: string]: unknown };

function isPlainObject(v: unknown): v is Plain {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function cloneSettings<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneSettings) as unknown as T;
  if (isPlainObject(value)) {
    const out: Plain = {};
    for (const [k, v] of Object.entries(value)) out[k] = cloneSettings(v);
    return out as unknown as T;
  }
  return value;
}

/** Read a dotted path. Returns `undefined` for any missing hop. */
export function getByPath(root: unknown, path: string): SettingValue | undefined {
  let cursor: unknown = root;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[seg];
  }
  return cursor as SettingValue | undefined;
}

/**
 * Immutably set a dotted path, cloning only the nodes along the way.
 * Returns the original object when the value is unchanged so callers can
 * cheaply detect no-ops.
 */
export function setByPath<T>(root: T, path: string, value: SettingValue): T {
  const segs = path.split('.');
  const cloneNode = (node: unknown, i: number): unknown => {
    const base = isPlainObject(node) ? node : {};
    if (i === segs.length - 1) return { ...base, [segs[i]]: value };
    return { ...base, [segs[i]]: cloneNode(base[segs[i]], i + 1) };
  };
  return cloneNode(root, 0) as T;
}

export function unsetByPath<T>(root: T, path: string): T {
  const segs = path.split('.');
  const cloneNode = (node: unknown, i: number): unknown => {
    if (!isPlainObject(node)) return node;
    if (i === segs.length - 1) {
      const next = { ...node };
      delete next[segs[i]];
      return next;
    }
    if (!(segs[i] in node)) return node;
    return { ...node, [segs[i]]: cloneNode(node[segs[i]], i + 1) };
  };
  return cloneNode(root, 0) as T;
}

/**
 * Deep-merge `override` over `base`, one level of recursion into plain
 * objects only. Arrays and scalars replace wholesale — merging a string over
 * an object is what a user means by "I set this", not "combine these".
 */
export function mergeSettings<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (cloneSettings(override) as unknown)) as T;
  }
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    out[k] = isPlainObject(existing) && isPlainObject(v)
      ? mergeSettings(existing, v)
      : cloneSettings(v);
  }
  return out as unknown as T;
}

/** Read `path` through an ordered list of layers; first defined value wins. */
export function resolvePath(path: string, layers: unknown[]): SettingValue | undefined {
  for (const layer of layers) {
    const v = getByPath(layer, path);
    if (v !== undefined) return v;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface SchemaViolation {
  /** Dotted path of the offending value, or `''` for the document root. */
  path: string;
  message: string;
}

export interface ParseResult<T> {
  value: T;
  violations: SchemaViolation[];
}

/** Coerce an arbitrary parsed value to the type of the default it shadows.
 *  Falls back to the default when the value is the wrong primitive, which is
 *  what makes a hand-edited settings.json safe to load. */
function coerce(raw: unknown, fallback: unknown): SettingValue {
  if (raw === undefined) return cloneSettings(fallback) as SettingValue;
  // `accent` is the one nullable setting: `null` means "follow the theme".
  if (fallback === null) return typeof raw === 'string' ? raw : null;
  if (Array.isArray(fallback)) return Array.isArray(raw) ? (raw as SettingValue[]) : (cloneSettings(fallback) as SettingValue);
  if (isPlainObject(fallback)) return isPlainObject(raw) ? (raw as SettingValue) : (cloneSettings(fallback) as SettingValue);
  if (typeof fallback === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : (fallback as SettingValue);
  }
  if (typeof fallback === 'boolean') return typeof raw === 'boolean' ? raw : (fallback as SettingValue);
  if (typeof fallback === 'string') return typeof raw === 'string' ? raw : (fallback as SettingValue);
  return raw as SettingValue;
}

/**
 * Keys whose values are user-authored maps rather than fixed fields. The
 * validator stops recursing at these: an arbitrary `AGAMIZ_*` variable name
 * or a custom binding is a legal key, not a typo.
 */
const FREE_FORM_KEYS = new Set(['env', 'bindings']);

/**
 * Validate `raw` against `DEFAULT_SETTINGS` and return a value that is
 * structurally identical to the defaults with every recognised key replaced.
 *
 * Unknown keys are reported (so the JSON editor can flag typos) and dropped
 * (so a downgrade cannot crash an older build).
 */
export function validateSettings(raw: unknown, prefix = ''): ParseResult<Settings> {
  const violations: SchemaViolation[] = [];
  return { value: walk(raw, DEFAULT_SETTINGS, prefix, violations), violations };
}

function walk(raw: unknown, template: unknown, prefix: string, violations: SchemaViolation[]): Settings {
  if (raw !== undefined && !isPlainObject(raw)) {
    violations.push({ path: prefix.replace(/\.$/, ''), message: 'expected an object' });
    raw = undefined;
  }
  const node = isPlainObject(raw) ? raw : {};
  const templateObj = template as Settings;
  const out: Plain = {};

  for (const section of Object.keys(templateObj) as SettingsSection[]) {
    const sectionTemplate = templateObj[section];
    const sectionPath = `${prefix}${section}`;

    const isBranch =
      typeof sectionTemplate === 'object'
      && sectionTemplate !== null
      && !Array.isArray(sectionTemplate)
      && !FREE_FORM_KEYS.has(section);

    if (isBranch) {
      out[section] = walk(node[section], sectionTemplate, `${sectionPath}.`, violations);
      continue;
    }

    const value = coerce(node[section], sectionTemplate);
    if (node[section] !== undefined && value === sectionTemplate && typeof sectionTemplate !== 'object') {
      // Only flag a type mismatch, not a legitimate value that happens to
      // equal the default.
      const raw_ = node[section];
      const mismatched = typeof sectionTemplate === 'number'
        ? typeof raw_ !== 'number' && !(typeof raw_ === 'string' && Number.isFinite(Number(raw_)))
        : typeof raw_ !== typeof sectionTemplate;
      if (mismatched) {
        violations.push({ path: sectionPath, message: `expected ${typeName(sectionTemplate)}` });
      }
    }
    out[section] = value;
  }

  for (const key of Object.keys(node)) {
    if (key in templateObj) continue;
    violations.push({ path: `${prefix}${key}`, message: 'unknown setting' });
  }

  return out as unknown as Settings;
}

function typeName(v: unknown): string {
  if (typeof v === 'number') return 'a number';
  if (typeof v === 'boolean') return 'a boolean';
  if (typeof v === 'string') return 'a string';
  return 'an object';
}

/* ------------------------------------------------------------------ */
/* JSON codec                                                          */
/* ------------------------------------------------------------------ */

/**
 * Pretty-print settings for `settings.json`. Key order follows the schema, so
 * the file diffs cleanly instead of reshuffling on every save.
 *
 * Accepts either a fully-resolved object or an override layer — a layer
 * serialises to `{}` when there is nothing to store, which is the honest
 * representation of "all defaults".
 */
export function serializeSettings(settings: Settings | SettingsLayer): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export interface JsonParseOutcome {
  /** Present only when the text is syntactically valid JSON. */
  settings?: Settings;
  violations: SchemaViolation[];
  /** Human-readable syntax error, when the text is not valid JSON at all. */
  syntaxError?: string;
}

/** Parse editor text into settings, reporting both syntax and schema errors. */
export function parseSettingsJson(text: string): JsonParseOutcome {
  if (text.trim() === '') {
    return { settings: cloneSettings(DEFAULT_SETTINGS), violations: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { violations: [], syntaxError: e instanceof Error ? e.message : String(e) };
  }
  const { value, violations } = validateSettings(parsed);
  return { settings: value, violations };
}

/* ------------------------------------------------------------------ */
/* Diffing / badges                                                    */
/* ------------------------------------------------------------------ */

/** Dotted keys whose values differ between two settings objects, using a
 *  deep structural comparison. Used for the "modified" dot in the sidebar and
 *  for Reset-to-Defaults scoping. */
export function diffSettings(a: unknown, b: unknown, prefix = ''): string[] {
  if (Object.is(a, b)) return [];
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix.replace(/\.$/, '')];
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: string[] = [];
    for (const k of keys) {
      out.push(...diffSettings(a[k], b[k], `${prefix}${k}.`));
    }
    return out;
  }
  return [prefix.replace(/\.$/, '')];
}

/**
 * Reduce a fully-resolved settings object to just its differences from the
 * defaults.
 *
 * This is the boundary between "a complete value" and "an override layer".
 * The JSON editor, the file reader and the user layer all need the second, and
 * a user who hand-writes a *complete* settings.json (as any editor would
 * suggest) must not accidentally pin every default forever — so anything equal
 * to the default is dropped on the way in.
 */
export function stripDefaults(full: Settings): SettingsLayer {
  const out: Record<string, Record<string, unknown>> = {};
  const fullObj = full as unknown as Record<string, Record<string, unknown>>;
  const defObj = DEFAULT_SETTINGS as unknown as Record<string, Record<string, unknown>>;

  for (const section of Object.keys(defObj) as SettingsSection[]) {
    for (const [key, defValue] of Object.entries(defObj[section])) {
      const value = fullObj[section]?.[key];
      if (value === undefined) continue;
      if (JSON.stringify(value) === JSON.stringify(defValue)) continue;
      (out[section] ??= {})[key] = cloneSettings(value);
    }
  }
  return out as SettingsLayer;
}

/** Resolve a value against the defaults → user → workspace layer stack. */
export function resolveSetting(key: string, layers: unknown[]): SettingValue {
  const found = resolvePath(key, layers);
  if (found !== undefined) return found;
  return getByPath(DEFAULT_SETTINGS, key) ?? null;
}
