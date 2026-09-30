'use client';

/**
 * The settings registry.
 *
 * Every control in the Settings Center is described here as data — key, label,
 * description, control kind, options, bounds — and the panels, the search box
 * and the JSON editor are all generated from this list. Nothing in the UI
 * hard-codes a field name, which is what keeps the three views in sync and
 * makes search a plain filter over one array.
 *
 * `searchTerms` is the deliberate part: users search for what the setting
 * *does* ("don't autosave", "ligatures", "restore my project"), not for the
 * internal key. Each row therefore contributes its label, description, key and
 * an explicit synonym list.
 */

import type { IconName } from '../Icon';
import type { SettingsKey, SettingsSection } from '../../features/settings/schema';
import type { SettingsScope } from '../../features/settings/store';

export type ControlKind =
  | 'toggle'
  | 'number'
  | 'select'
  | 'text'
  | 'path'
  | 'color'
  | 'action'
  | 'keybinding'
  | 'env';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDescriptor {
  key: SettingsKey;
  label: string;
  description: string;
  control: ControlKind;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  /** Extra search vocabulary: synonyms, old names, feature words. */
  searchTerms?: string[];
  /** Scopes that may modify this key. Terminal keys are user-only because a
   *  project has no business redefining a developer's font. */
  scopes: SettingsScope[];
  /** Renders the row with accent text (destructive or irreversible). */
  emphasis?: 'default' | 'warning';
  /** Depends on another setting; the panel disables it while unmet. */
  requires?: SettingsKey;
}

export interface SettingGroup {
  id: string;
  title: string;
  hint?: string;
  items: SettingDescriptor[];
}

export interface SettingsCategory {
  id: SettingsSection;
  title: string;
  blurb: string;
  icon: IconName;
  groups: SettingGroup[];
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const BOTH: SettingsScope[] = ['user', 'workspace'];
const USER_ONLY: SettingsScope[] = ['user'];

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    title: 'General',
    blurb: 'Startup, window behaviour and workspace management',
    icon: 'gear',
    groups: [
      {
        id: 'startup',
        title: 'Startup Behaviour',
        hint: 'What Agamiz Code reopens when it launches',
        items: [
          {
            key: 'general.restoreLastWorkspace',
            label: 'Restore Last Workspace on Startup',
            description: 'Reopen the workspace folder that was active when the application was last closed.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['reopen', 'session', 'project', 'folder', 'boot', 'launch'],
          },
          {
            key: 'general.reopenClosedEditors',
            label: 'Reopen Closed Editors',
            description: 'Restore the file tabs that were open at shutdown. Requires "Restore Last Workspace".',
            control: 'toggle',
            scopes: BOTH,
            requires: 'general.restoreLastWorkspace',
            searchTerms: ['tabs', 'files', 'buffers', 'session', 'restore'],
          },
          {
            key: 'general.startupLayout',
            label: 'Startup Layout',
            description: 'How much of the previous window layout to bring back.',
            control: 'select',
            options: [
              { value: 'full', label: 'Full layout' },
              { value: 'editors', label: 'Editors only' },
              { value: 'empty', label: 'Empty — folder only' },
            ],
            scopes: USER_ONLY,
            requires: 'general.restoreLastWorkspace',
            searchTerms: ['window', 'chrome', 'sidebar', 'panel', 'boot'],
          },
          {
            key: 'general.launchInDevMode',
            label: 'Launch in Development Mode',
            description: 'Open the webview devtools on startup. Useful when building the IDE itself.',
            control: 'toggle',
            scopes: USER_ONLY,
            searchTerms: ['devtools', 'debug', 'console', 'inspector'],
          },
        ],
      },
      {
        id: 'window',
        title: 'Window',
        items: [
          {
            key: 'general.confirmBeforeExit',
            label: 'Confirm Before Exit',
            description: 'Ask for confirmation when closing the window with unsaved buffers.',
            control: 'toggle',
            scopes: USER_ONLY,
            searchTerms: ['quit', 'close', 'save', 'prompt', 'warning'],
          },
          {
            key: 'appearance.autoDimAfterMinutes',
            label: 'Auto-dim After Inactivity',
            description: 'Dim the whole interface after this many minutes without input. 0 disables the dimmer.',
            control: 'number',
            min: 0,
            max: 60,
            step: 1,
            unit: 'min',
            scopes: BOTH,
            searchTerms: ['idle', 'screen', 'dim', 'focus', 'night'],
          },
        ],
      },
      {
        id: 'workspace',
        title: 'Workspace',
        items: [
          {
            key: 'general.defaultWorkspaceFolder',
            label: 'Default Workspace Folder',
            description: 'Folder opened when a workspace is requested and nothing has been remembered yet.',
            control: 'path',
            placeholder: 'Ask every time',
            scopes: USER_ONLY,
            searchTerms: ['directory', 'root', 'project', 'browse', 'open'],
          },
          {
            key: 'general.recentProjectsLimit',
            label: 'Recent Projects History',
            description: 'How many folders the welcome screen keeps in its recent list.',
            control: 'select',
            options: [
              { value: '5', label: '5 projects' },
              { value: '10', label: '10 projects' },
              { value: '20', label: '20 projects' },
              { value: '50', label: '50 projects' },
            ],
            scopes: USER_ONLY,
            searchTerms: ['history', 'workspace', 'welcome', 'list', 'mr'],
          },
          {
            key: 'run.workingDirectory',
            label: 'Run Working Directory',
            description: 'Directory used for spawned programs. Empty means the workspace root.',
            control: 'path',
            placeholder: 'Workspace root',
            scopes: BOTH,
            searchTerms: ['cwd', 'terminal', 'spawn', 'process'],
          },
        ],
      },
      {
        id: 'telemetry',
        title: 'Telemetry',
        items: [
          {
            key: 'general.telemetryEnabled',
            label: 'Send Anonymous Usage Data',
            description: 'Report crashes and feature usage. Nothing is sent unless a backend endpoint is configured.',
            control: 'toggle',
            scopes: USER_ONLY,
            emphasis: 'warning',
            searchTerms: ['analytics', 'crash', 'privacy', 'tracking', 'reporting'],
          },
        ],
      },
    ],
  },

  {
    id: 'appearance',
    title: 'Appearance & Themes',
    blurb: 'Theme engine, accent colour, typography and panel placement',
    icon: 'sparkles',
    groups: [
      {
        id: 'theme',
        title: 'Colour Theme',
        items: [
          {
            key: 'appearance.theme',
            label: 'Theme',
            description: 'The built-in colour scheme. Changing it re-themes the editor, terminal and every panel immediately.',
            control: 'select',
            options: [], // populated from the theme catalogue at render time
            scopes: BOTH,
            searchTerms: ['colour', 'color', 'dark', 'light', 'dracula', 'nord', 'cyberpunk', 'one dark', 'github'],
          },
          {
            key: 'appearance.accent',
            label: 'UI Accent Colour',
            description: 'Overrides the primary highlight used for buttons, rails, focus rings and the caret. Empty follows the theme.',
            control: 'color',
            scopes: BOTH,
            searchTerms: ['green', 'highlight', 'primary', 'brand', 'colour', 'cyan', 'purple', 'orange', 'blue'],
          },
        ],
      },
      {
        id: 'typography',
        title: 'Font & Display',
        items: [
          {
            key: 'appearance.editorFontFamily',
            label: 'Editor Font Family',
            description: 'CSS font stack applied to the code editor. The first installed family wins.',
            control: 'text',
            placeholder: 'JetBrains Mono, Fira Code, Consolas, monospace',
            scopes: BOTH,
            searchTerms: ['typeface', 'monospace', 'ligature', 'jetbrains', 'fira', 'cascadia'],
          },
          {
            key: 'appearance.editorFontLigatures',
            label: 'Font Ligatures',
            description: 'Merge sequences such as => and !== into single glyphs. Requires a font that supports them.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['programming', 'typography', 'calt', 'arrows'],
          },
          {
            key: 'editor.fontSize',
            label: 'Editor Font Size',
            description: 'Point size of the code editor text.',
            control: 'number',
            min: 10,
            max: 28,
            step: 1,
            unit: 'px',
            scopes: BOTH,
            searchTerms: ['zoom', 'text', 'bigger', 'smaller'],
          },
          {
            key: 'editor.lineHeight',
            label: 'Editor Line Height',
            description: 'Line box as a multiple of the font size. Gutter numbers and the caret track this value.',
            control: 'number',
            min: 1,
            max: 2.5,
            step: 0.05,
            unit: '×',
            scopes: BOTH,
            searchTerms: ['leading', 'spacing', 'density', 'comfortable'],
          },
          {
            key: 'appearance.uiScale',
            label: 'UI Scale',
            description: 'Zoom for the whole interface — panels, menus and the editor chrome. The code font size is independent.',
            control: 'number',
            min: 0.8,
            max: 1.5,
            step: 0.05,
            unit: '%',
            scopes: BOTH,
            searchTerms: ['zoom', 'dpi', 'resolution', 'size', 'accessibility'],
          },
        ],
      },
      {
        id: 'layout',
        title: 'Layout',
        items: [
          {
            key: 'appearance.sidebarPosition',
            label: 'Sidebar Position',
            description: 'Which edge the activity bar and primary sidebar sit on.',
            control: 'select',
            options: [
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ],
            scopes: BOTH,
            searchTerms: ['activity bar', 'explorer', 'edge', 'position'],
          },
          {
            key: 'appearance.panelPosition',
            label: 'Panel Position',
            description: 'Where the terminal, output and problems panel docks.',
            control: 'select',
            options: [
              { value: 'bottom', label: 'Bottom' },
              { value: 'right', label: 'Right' },
            ],
            scopes: BOTH,
            searchTerms: ['terminal', 'output', 'problems', 'dock', 'position'],
          },
          {
            key: 'appearance.reducedMotion',
            label: 'Reduced Motion',
            description: 'Disable panel and dialog transitions. The operating system preference is honoured separately.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['animation', 'accessibility', 'vestibular', 'transition', 'performance'],
          },
        ],
      },
    ],
  },

  {
    id: 'editor',
    title: 'Editor',
    blurb: 'Indentation, line numbers, formatting, minimap and autosave',
    icon: 'file-code',
    groups: [
      {
        id: 'indentation',
        title: 'Indentation',
        items: [
          {
            key: 'editor.tabSize',
            label: 'Tab Size',
            description: 'Spaces per indentation level.',
            control: 'select',
            options: [
              { value: '2', label: '2 spaces' },
              { value: '4', label: '4 spaces' },
              { value: '8', label: '8 spaces' },
            ],
            scopes: BOTH,
            searchTerms: ['indent', 'spaces', 'width', 'soft tab'],
          },
          {
            key: 'editor.insertSpaces',
            label: 'Insert Spaces',
            description: 'Insert spaces when Tab or Enter is pressed, rather than a literal tab character.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['indent', 'tab', 'whitespace', 'soft'],
          },
          {
            key: 'editor.autoIndent',
            label: 'Auto Indent',
            description: 'Carry the current line\'s indentation onto the next line.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['smart indent', 'reindent', 'format'],
          },
          {
            key: 'editor.autoClose',
            label: 'Auto-close Brackets',
            description: 'Insert the matching pair as you type an opening bracket, quote or tag.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['braces', 'parenthesis', 'quotes', 'pair', 'surround'],
          },
          {
            key: 'editor.bracketPairColorization',
            label: 'Bracket Pair Colourisation',
            description: 'Highlight the bracket pair surrounding the caret so nested structure is readable at a glance.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['match', 'surround', 'colour', 'rainbow', 'nesting'],
          },
        ],
      },
      {
        id: 'display',
        title: 'Display',
        items: [
          {
            key: 'editor.lineNumbers',
            label: 'Line Numbers',
            description: 'Gutter numbering mode.',
            control: 'select',
            options: [
              { value: 'on', label: 'On' },
              { value: 'relative', label: 'Relative' },
              { value: 'off', label: 'Off' },
            ],
            scopes: BOTH,
            searchTerms: ['gutter', 'lineno', 'relative numbering'],
          },
          {
            key: 'editor.renderWhitespace',
            label: 'Render Whitespace',
            description: 'Draw whitespace markers for leading and trailing spaces.',
            control: 'select',
            options: [
              { value: 'none', label: 'None' },
              { value: 'boundary', label: 'Boundary' },
              { value: 'all', label: 'All' },
            ],
            scopes: BOTH,
            searchTerms: ['invisibles', 'spaces', 'tabs', 'control characters', 'dots'],
          },
          {
            key: 'editor.wordWrap',
            label: 'Word Wrap',
            description: 'Soft-wrap long lines instead of scrolling horizontally.',
            control: 'select',
            options: [
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
              { value: 'bounded', label: 'At Column' },
            ],
            scopes: BOTH,
            searchTerms: ['wrap', 'line', 'horizontal scroll', 'soft'],
          },
          {
            key: 'editor.wordWrapColumn',
            label: 'Word Wrap Column',
            description: 'Column that "At Column" wrapping breaks at.',
            control: 'number',
            min: 40,
            max: 200,
            step: 1,
            unit: 'col',
            scopes: BOTH,
            requires: 'editor.wordWrap',
            searchTerms: ['wrap', 'width', 'boundary', 'column'],
          },
          {
            key: 'editor.minimapEnabled',
            label: 'Show Minimap',
            description: 'Render a scrollbar-adjacent overview of the whole file.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['overview', 'scrollbar', 'preview', 'map'],
          },
          {
            key: 'editor.minimapScale',
            label: 'Minimap Scale',
            description: 'Vertical zoom of the minimap render.',
            control: 'number',
            min: 1,
            max: 3,
            step: 0.1,
            unit: '×',
            scopes: BOTH,
            requires: 'editor.minimapEnabled',
            searchTerms: ['overview', 'zoom', 'size'],
          },
          {
            key: 'editor.showBreadcrumb',
            label: 'Show Breadcrumb Bar',
            description: 'Display the file path strip above the tab bar.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['path', 'navigation', 'header'],
          },
        ],
      },
      {
        id: 'autosave',
        title: 'Code Formatting & Autosave',
        items: [
          {
            key: 'editor.autoSave',
            label: 'Auto Save',
            description: 'When dirty buffers are written to disk automatically.',
            control: 'select',
            options: [
              { value: 'off', label: 'Off' },
              { value: 'afterDelay', label: 'After Delay' },
              { value: 'onFocusChange', label: 'On Focus Change' },
              { value: 'onWindowChange', label: 'On Window Change' },
            ],
            scopes: BOTH,
            searchTerms: ['save', 'persist', 'write', 'delay', 'idle'],
          },
          {
            key: 'editor.autoSaveDelay',
            label: 'Auto Save Delay',
            description: 'Idle time before an "After Delay" auto-save fires.',
            control: 'number',
            min: 200,
            max: 30000,
            step: 100,
            unit: 'ms',
            scopes: BOTH,
            requires: 'editor.autoSave',
            searchTerms: ['save', 'debounce', 'timeout', 'ms'],
          },
          {
            key: 'editor.formatOnSave',
            label: 'Format on Save',
            description: 'Run the language formatter before writing a buffer to disk.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['prettier', 'beautify', 'formatter', 'organise'],
          },
          {
            key: 'editor.markDirtyInTitle',
            label: 'Show Unsaved Marker in Title',
            description: 'Append a dot to the window title while any buffer has unsaved changes.',
            control: 'toggle',
            scopes: USER_ONLY,
            searchTerms: ['title', 'window', 'dirty', 'asterisk'],
          },
        ],
      },
    ],
  },

  {
    id: 'terminal',
    title: 'Terminal & Shells',
    blurb: 'Default profiles, font, cursor and buffer size',
    icon: 'terminal',
    groups: [
      {
        id: 'profiles',
        title: 'Profiles',
        items: [
          {
            key: 'terminal.defaultProfileId',
            label: 'Default Profile',
            description: 'Shell started by the "+" button and on first open. Leave empty to use the detected system default.',
            control: 'select',
            options: [], // populated from the probed shell list
            scopes: USER_ONLY,
            searchTerms: ['shell', 'pwsh', 'powershell', 'bash', 'cmd', 'wsl', 'zsh'],
          },
          {
            key: 'terminal.profiles',
            label: 'Custom Shell Profiles',
            description:
              'Extra shells to offer alongside the detected ones. Each entry needs a program; args, working directory and environment variables are optional.',
            control: 'env',
            scopes: USER_ONLY,
            searchTerms: ['shell', 'custom', 'profile', 'add shell', 'executable', 'wsl', 'bash'],
          },
        ],
      },
      {
        id: 'font',
        title: 'Font',
        items: [
          {
            key: 'terminal.fontFamily',
            label: 'Terminal Font Family',
            description: 'CSS font stack for the terminal grid.',
            control: 'text',
            placeholder: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
            scopes: USER_ONLY,
            searchTerms: ['typeface', 'monospace', 'cascadia', 'jetbrains'],
          },
          {
            key: 'terminal.fontSize',
            label: 'Terminal Font Size',
            description: 'Point size of the terminal grid.',
            control: 'number',
            min: 8,
            max: 24,
            step: 0.5,
            unit: 'px',
            scopes: USER_ONLY,
            searchTerms: ['zoom', 'text', 'size'],
          },
          {
            key: 'terminal.lineHeight',
            label: 'Terminal Line Height',
            description: 'Line box as a multiple of the terminal font size.',
            control: 'number',
            min: 1,
            max: 2,
            step: 0.05,
            unit: '×',
            scopes: USER_ONLY,
            searchTerms: ['leading', 'spacing', 'density'],
          },
          {
            key: 'terminal.letterSpacing',
            label: 'Terminal Letter Spacing',
            description: 'Extra tracking between terminal cells, in pixels.',
            control: 'number',
            min: 0,
            max: 4,
            step: 0.1,
            unit: 'px',
            scopes: USER_ONLY,
            searchTerms: ['tracking', 'kerning', 'gap'],
          },
        ],
      },
      {
        id: 'cursor',
        title: 'Cursor',
        items: [
          {
            key: 'terminal.cursorStyle',
            label: 'Cursor Shape',
            description: 'How the shell cursor is drawn in the terminal grid.',
            control: 'select',
            options: [
              { value: 'block', label: 'Block' },
              { value: 'underline', label: 'Underline' },
              { value: 'bar', label: 'Bar' },
            ],
            scopes: USER_ONLY,
            searchTerms: ['caret', 'shape', 'beam', 'underline'],
          },
          {
            key: 'terminal.cursorBlink',
            label: 'Blinking Cursor',
            description: 'Flash the cursor instead of holding it solid.',
            control: 'toggle',
            scopes: USER_ONLY,
            searchTerms: ['caret', 'flash', 'pulse'],
          },
          {
            key: 'terminal.cursorSmooth',
            label: 'Smooth Cursor Animation',
            description: 'Ease the cursor between cells instead of jumping. Requires WebGL.',
            control: 'toggle',
            scopes: USER_ONLY,
            searchTerms: ['caret', 'animation', 'easing', 'motion'],
          },
        ],
      },
      {
        id: 'buffer',
        title: 'Buffer & Behaviour',
        items: [
          {
            key: 'terminal.scrollback',
            label: 'Scrollback Buffer',
            description: 'Lines of history retained per session. Larger buffers cost memory.',
            control: 'number',
            min: 1000,
            max: 200000,
            step: 1000,
            unit: 'lines',
            scopes: USER_ONLY,
            searchTerms: ['history', 'lines', 'memory', 'buffer', 'scroll'],
          },
          {
            key: 'terminal.webgl',
            label: 'Use WebGL Renderer',
            description: 'Hardware-accelerated rendering, with an automatic canvas fallback.',
            control: 'toggle',
            scopes: USER_ONLY,
            searchTerms: ['gpu', 'performance', 'render', 'acceleration'],
          },
          {
            key: 'terminal.minimumContrastRatio',
            label: 'Minimum Contrast Ratio',
            description: 'Boosts faint ANSI colours for low-vision readability. 1 disables the boost.',
            control: 'number',
            min: 1,
            max: 21,
            step: 0.5,
            unit: ':1',
            scopes: USER_ONLY,
            searchTerms: ['accessibility', 'wcag', 'legibility', 'contrast', 'a11y'],
          },
          {
            key: 'terminal.copyOnSelection',
            label: 'Copy on Selection',
            description: 'Put the selected text on the clipboard as soon as a selection is made.',
            control: 'toggle',
            scopes: USER_ONLY,
            searchTerms: ['clipboard', 'selection', 'yank'],
          },
          {
            key: 'terminal.confirmKill',
            label: 'Confirm Before Killing a Session',
            description: 'Ask before terminating a shell that is still running a command.',
            control: 'toggle',
            scopes: USER_ONLY,
            searchTerms: ['kill', 'terminate', 'prompt', 'safety'],
          },
        ],
      },
    ],
  },

  {
    id: 'run',
    title: 'Run, Build & Debug',
    blurb: 'Interpreters, default run mode and environment variables',
    icon: 'rocket',
    groups: [
      {
        id: 'runtime',
        title: 'Interpreter & Run Mode',
        items: [
          {
            key: 'run.interpreterPath',
            label: 'Interpreter Path',
            description: 'Explicit path to the Rak runtime binary. Empty uses the binary bundled with the application.',
            control: 'path',
            placeholder: 'Bundled runtime',
            scopes: USER_ONLY,
            searchTerms: ['rak', 'binary', 'executable', 'runtime', 'engine'],
          },
          {
            key: 'run.defaultRunMode',
            label: 'Default Run Mode',
            description: 'Execution strategy used by Run and F5 when the toolbar has not been changed.',
            control: 'select',
            options: [
              { value: 'interp', label: 'Interpreter (tree-walker)' },
              { value: 'vm', label: 'VM (bytecode)' },
              { value: 'bench', label: 'Bench (compare both)' },
            ],
            scopes: BOTH,
            searchTerms: ['interpreter', 'bytecode', 'vm', 'performance', 'bench'],
          },
        ],
      },
      {
        id: 'behaviour',
        title: 'Run Behaviour',
        items: [
          {
            key: 'run.killPreviousRun',
            label: 'Stop Previous Run First',
            description: 'Terminate a still-running process before starting a new one.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['kill', 'restart', 'single instance'],
          },
          {
            key: 'run.clearOutputOnRun',
            label: 'Clear Output on Run',
            description: 'Empty the output panel each time a run starts.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['console', 'clean', 'log', 'reset'],
          },
          {
            key: 'run.confirmRun',
            label: 'Confirm Run with Unsaved Buffer',
            description: 'Ask before running a buffer that has unsaved changes.',
            control: 'toggle',
            scopes: BOTH,
            searchTerms: ['prompt', 'dirty', 'save', 'warning'],
          },
        ],
      },
      {
        id: 'env',
        title: 'Environment Variables',
        items: [
          {
            key: 'run.env',
            label: 'Process Environment',
            description: 'Variables merged into every process Agamiz Code spawns. Stored verbatim in settings.json.',
            control: 'env',
            scopes: BOTH,
            searchTerms: ['env', 'variables', 'path', 'export', 'process', 'dotenv'],
          },
        ],
      },
    ],
  },

  {
    id: 'keymap',
    title: 'Keyboard Shortcuts',
    blurb: 'Custom key bindings for every command',
    icon: 'key',
    groups: [],
  },
];

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  category: SettingsCategory;
  group: SettingGroup;
  item: SettingDescriptor;
  /** Higher is a better match. Exact label and key hits outrank synonyms. */
  score: number;
}

/** Normalise for comparison: lowercase, strip anything but word characters. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Score one descriptor against the query terms.
 *
 * Returns 0 for no match. Matching is token-based rather than substring-based
 * so "restore" finds "Restore Last Workspace" and "workspace" finds it too,
 * without "rest" matching "restore" by accident.
 */
function scoreItem(item: SettingDescriptor, terms: string[]): number {
  if (terms.length === 0) return 1;
  const label = normalize(item.label);
  const description = normalize(item.description);
  const key = normalize(item.key.replace('.', ' '));
  const extra = normalize([...(item.searchTerms ?? []), ...(item.options ?? []).map((o) => o.label)].join(' '));

  let score = 0;
  for (const term of terms) {
    if (label === term) score += 12;
    else if (label.startsWith(term)) score += 9;
    else if (label.includes(term)) score += 7;

    if (key.includes(term)) score += 5;
    if (extra.includes(term)) score += 4;
    if (description.includes(term)) score += 2;

    // Every term must appear somewhere, so a two-word query narrows rather
    // than widening — matching only the first term is never enough.
    if (score === 0) return 0;
  }
  return score;
}

/**
 * Filter the registry.
 *
 * `query === ''` returns every group so the default view is the full list.
 * Categories whose every group is empty (Keyboard Shortcuts) are kept in the
 * result only when searching, since they have no searchable rows.
 */
export function searchSettings(query: string): {
  categories: { category: SettingsCategory; groups: SettingGroup[] }[];
  total: number;
} {
  const terms = normalize(query).split(' ').filter(Boolean);

  if (terms.length === 0) {
    return {
      categories: SETTINGS_CATEGORIES.map((category) => ({ category, groups: category.groups })),
      total: SETTINGS_CATEGORIES.reduce((n, c) => n + c.groups.reduce((m, g) => m + g.items.length, 0), 0),
    };
  }

  const categories: { category: SettingsCategory; groups: SettingGroup[] }[] = [];
  let total = 0;

  for (const category of SETTINGS_CATEGORIES) {
    const groups: SettingGroup[] = [];
    for (const group of category.groups) {
      const hits: { item: SettingDescriptor; score: number }[] = [];
      for (const item of group.items) {
        const score = scoreItem(item, terms);
        if (score > 0) hits.push({ item, score });
      }
      if (hits.length === 0) continue;
      hits.sort((a, b) => b.score - a.score);
      groups.push({ ...group, items: hits.map((h) => h.item) });
      total += hits.length;
    }

    if (groups.length === 0) {
      // Fall back to matching the category title itself, so "terminal" shows
      // the Terminal category and "shortcut" shows Keyboard Shortcuts.
      const title = normalize(`${category.title} ${category.blurb}`);
      if (!terms.some((t) => title.includes(t))) continue;
      categories.push({ category, groups: category.groups });
      total += category.groups.reduce((n, g) => n + g.items.length, 0);
      continue;
    }
    categories.push({ category, groups });
  }

  return { categories, total };
}

/** Categories that have at least one row, for the sidebar list. */
export const SEARCHABLE_CATEGORIES = SETTINGS_CATEGORIES.filter((c) => c.groups.length > 0);

/* ------------------------------------------------------------------ */
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

/** Values that mean "this setting is switched off", regardless of type. */
const DISABLED_VALUES = new Set(['off', 'none', 'false', '']);

/**
 * Should a row's control be interactive?
 *
 * Several settings only mean something while another is enabled — the
 * auto-save delay is meaningless when auto-save is `off`, the wrap column is
 * meaningless when wrapping is `off`. Checking for "off"-like values rather
 * than plain falsiness keeps `'bounded'` truthy while `'off'` is not, so a
 * `select` dependency works without a special case.
 */
export function requirementMet(
  requires: SettingsKey | undefined,
  resolve: (key: SettingsKey) => string | number | boolean | null | undefined,
): boolean {
  if (!requires) return true;
  const value = resolve(requires);
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return !DISABLED_VALUES.has(String(value).toLowerCase());
}
