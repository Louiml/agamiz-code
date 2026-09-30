import type { Snippet } from './types';

/**
 * Runtime snippet registry.
 *
 * Snippets that ship with a language live on its `LanguageDef.completion`, but
 * an extension can contribute more for a language it does not own (that is what
 * `ctx.registerSnippets` does). Keeping them here means the editor can pull
 * every language's fragments without importing each language module.
 */

const byLanguage: Record<string, Snippet[]> = {};

/**
 * Bumped on every registration so consumers can key their caches on it and
 * still see later contributions without a direct dependency on this module.
 */
let version = 0;

export function snippetRegistryVersion(): number {
  return version;
}

/**
 * Add snippets for a language. A snippet replaces an existing one with the same
 * trigger prefix, so a later contribution wins over a bundled default.
 *
 * @returns a disposer that removes exactly the snippets that were added.
 */
export function registerLanguageSnippets(
  languageId: string,
  snippets: Snippet[],
): () => void {
  const id = languageId.toLowerCase();
  const list = (byLanguage[id] ??= []);
  for (const snippet of snippets) {
    if (!snippet?.prefix) continue;
    const at = list.findIndex((s) => s.prefix === snippet.prefix);
    if (at === -1) list.push(snippet);
    else list[at] = snippet;
  }
  version++;
  return () => {
    const current = byLanguage[id];
    if (!current) return;
    for (const snippet of snippets) {
      const at = current.indexOf(snippet);
      if (at !== -1) current.splice(at, 1);
    }
    version++;
  };
}

/** Snippets contributed at runtime for a language. */
export function getRegisteredSnippets(languageId: string | undefined): Snippet[] {
  if (!languageId) return [];
  return byLanguage[languageId.toLowerCase()] ?? [];
}
