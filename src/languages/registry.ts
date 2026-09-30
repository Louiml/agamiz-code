import { LanguageDef, LanguageDescription } from './types';

/**
 * Central registry of supported programming languages.
 *
 * Extensions can contribute additional languages through the extension API
 * (see `src/extensions/`) by calling `registerLanguage` with a LanguageDef.
 */

const defs: Record<string, LanguageDef> = {};
const byExtension: Record<string, string> = {};
const byFilename: Record<string, string> = {};

export function registerLanguage(def: LanguageDef) {
  defs[def.id] = def;
  for (const ext of def.extensions) {
    const key = ext.toLowerCase();
    if (!byExtension[key]) byExtension[key] = def.id;
  }
  for (const f of def.filenames ?? []) {
    const key = f.toLowerCase();
    if (!byFilename[key]) byFilename[key] = def.id;
  }
}

export function canOverrideLanguage(id: string): boolean {
  return false; // built-ins take precedence
}

/** Detect the language id for a filename/path. Returns undefined when unknown. */
export function detectLanguage(idOrPath: string | undefined): string | undefined {
  if (!idOrPath) return undefined;
  const lower = idOrPath.toLowerCase();
  if (defs[lower]) return lower;
  if (byFilename[lower]) return byFilename[lower];
  const dot = lower.lastIndexOf('.');
  if (dot !== -1) {
    const ext = lower.slice(dot + 1);
    if (byExtension[ext]) return byExtension[ext];
    // Files like "vite.config.ts" still detect as typescript via extension.
    if (byExtension[ext === 'tsx' ? 'tsx' : ext] === 'typescript') return 'typescript';
  }
  return undefined;
}

export function getLanguage(id: string | undefined): LanguageDef | undefined {
  if (!id) return undefined;
  return defs[id];
}

export function getLanguageName(id: string | undefined): string {
  return defs[id ?? '']?.name ?? id ?? 'Plain Text';
}

export function extractExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function getLanguageIdForExtension(ext: string): string | undefined {
  const key = ext.toLowerCase();
  return byExtension[key];
}

export function listLanguages(): LanguageDef[] {
  return Object.values(defs);
}

export function getDescription(): LanguageDescription {
  return {
    defs: { ...defs },
    byExtension: { ...byExtension },
    byFilename: { ...byFilename },
  };
}

export type { LanguageDef, LanguageDescription, Token, TokenType } from './types';