import { LanguageDef, Snippet } from '../languages/types';

/** A handle that is also a token to unsubscribe/dispose a registration. */
export interface Disposable {
  dispose(): void;
}

export type CommandAction = () => void | Promise<void>;

/** A command contributed by an extension (palette + shortcuts). */
export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon?: string;
  action: CommandAction;
}

/**
 * An autocomplete snippet contributed for a specific language. Re-exported from
 * the language model so `registerSnippets` needs no translation layer.
 */
export type { Snippet };

/** A status bar contribution. */
export interface StatusBarItem {
  id: string;
  text: () => string;
  alignment?: 'left' | 'right';
  priority?: number;
  onClick?: () => void;
}

/** A keybinding that can be remapped / contributed. */
export interface KeyBinding {
  command: string;
  /** e.g. "ctrl+shift+f" (lowercase modifiers). */
  key: string;
  when?: string;
}

/**
 * The activation context handed to every extension (JS `activate(ctx)` or a
 * Lua `ide` global). All registration helpers return a Disposable.
 */
export interface ExtensionContext {
  subscriptions: Disposable[];

  registerCommand(
    id: string,
    label: string,
    action: CommandAction,
    opts?: { shortcut?: string; icon?: string },
  ): Disposable;

  registerSnippets(languageId: string, snippets: Snippet[]): Disposable;

  registerStatusBarItem(item: StatusBarItem): Disposable;

  registerKeyBinding(binding: KeyBinding): Disposable;

  registerLanguage(def: LanguageDef): Disposable;

  showNotification(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void;
}

/**
 * A full extension. Either `activate` (JS/TS module) or `lua` (LuaScript
 * source) provides the runtime body; `languages` are language definitions to
 * register immediately on activation.
 */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  activate?: (ctx: ExtensionContext) => void | Promise<void>;
  deactivate?: () => void;
  lua?: string;
  languages?: LanguageDef[];
}