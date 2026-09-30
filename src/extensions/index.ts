import { Disposable, ExtensionContext } from './types';
import { rakExtension } from './rak';
import { registerLanguage } from '../languages/registry';
import { registerBuiltinLanguages } from '../languages/builtin';
import { registerLanguageSnippets } from '../languages/snippets';
import { invalidateCompletionCache } from '../languages/completion';

/**
 * Minimal extension host for Agamiz Code. It registers the bundled (non-Rak)
 * built-in languages, then activates each bundled extension by supplying a
 * small `ExtensionContext`. `registerLanguage` and `registerSnippets` are wired
 * into the language registry and the snippet registry; the remaining
 * contribution points (status-bar items, commands, keybindings) are recorded as
 * (still-functional) no-ops so extensions can be activated without the UI
 * depending on them.
 */

const noopDisposable: Disposable = { dispose() {} };

function createContext(): ExtensionContext {
  const subscriptions: Disposable[] = [];
  const register = (dispose?: () => void) => {
    const d: Disposable = { dispose: dispose ?? (() => {}) };
    subscriptions.push(d);
    return d;
  };
  return {
    subscriptions,
    registerCommand: () => register(),
    registerSnippets: (languageId, snippets) =>
      register(registerLanguageSnippets(languageId, snippets)),
    registerStatusBarItem: () => register(),
    registerKeyBinding: () => register(),
    registerLanguage: (def) => {
      registerLanguage(def);
      invalidateCompletionCache();
      return register();
    },
    showNotification: () => {},
  };
}

let activated = false;

/** Register built-in languages and activate every bundled extension once. */
export function activateExtensions(): void {
  if (activated) return;
  activated = true;

  registerBuiltinLanguages();

  const ctx = createContext();
  const manifests = [rakExtension];
  for (const manifest of manifests) {
    for (const lang of manifest.languages ?? []) {
      ctx.registerLanguage(lang);
    }
    if (manifest.activate) {
      void Promise.resolve(manifest.activate(ctx));
    }
  }
}
