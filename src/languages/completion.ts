import { getLanguage } from './registry';
import { getRegisteredSnippets, snippetRegistryVersion } from './snippets';
import type {
  BlockSnippet,
  CompletionKind,
  CompletionTrigger,
  DeclarationPattern,
  LanguageCompletion,
} from './types';

/**
 * The language-agnostic completion engine.
 *
 * A language contributes data (`LanguageDef.completion`); this module turns it
 * into the ranked suggestion list the editor renders. Nothing here knows about
 * any particular language — the editor calls `getSuggestions` and renders what
 * comes back.
 */

/** One row in the completion popup. */
export interface Suggestion {
  label: string;
  kind: CompletionKind;
  /** Text inserted on accept; defaults to `label`. */
  body?: string;
  /** Secondary text shown to the right of the label. */
  detail?: string;
}

export interface CompletionRequest {
  /** Language id of the open buffer; `undefined` disables completion. */
  languageId: string | undefined;
  /** Full buffer text. */
  source: string;
  /** Caret offset into `source`. */
  offset: number;
  /** Ctrl+Space: offer the whole pool even with nothing typed. */
  force?: boolean;
  /** Maximum rows to return. */
  limit?: number;
}

/** An identifier as the editor understands one. */
const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const RE_WORD_AT_END = new RegExp(`${IDENT}$`);

const poolCache = new Map<string, Suggestion[]>();
const declCache = new Map<string, RegExp[]>();
let poolCacheVersion = -1;

function key(languageId: string | undefined): string {
  return (languageId ?? '').toLowerCase();
}

function config(languageId: string | undefined): LanguageCompletion | undefined {
  if (!languageId) return undefined;
  return getLanguage(languageId)?.completion;
}

/**
 * Everything the language knows statically: its snippets, extra vocabulary and
 * keyword/type/builtin/constant lists, in that order of priority. Cached per
 * language; `invalidateCompletionCache` drops it when snippets are registered.
 */
export function getCompletionPool(languageId: string | undefined): Suggestion[] {
  const id = key(languageId);
  const version = snippetRegistryVersion();
  if (version !== poolCacheVersion) {
    poolCache.clear();
    poolCacheVersion = version;
  }
  const cached = poolCache.get(id);
  if (cached) return cached;

  const def = languageId ? getLanguage(languageId) : undefined;
  const conf = def?.completion;
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (label: string, kind: CompletionKind, body?: string, detail?: string) => {
    if (!label) return;
    const dedupe = `${kind} ${label.toLowerCase()}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({ label, kind, body, detail });
  };

  for (const s of conf?.snippets ?? []) add(s.prefix, 'snippet', s.body, s.label);
  for (const s of getRegisteredSnippets(languageId)) add(s.prefix, 'snippet', s.body, s.label);
  for (const w of conf?.words ?? []) add(w.label, w.kind, w.body, w.detail);
  for (const k of def?.keywords ?? []) add(k, 'keyword');
  for (const t of def?.types ?? []) add(t, 'type');
  for (const b of def?.builtins ?? []) add(b, 'builtin');
  for (const c of def?.constants ?? []) add(c, 'constant');

  poolCache.set(id, out);
  return out;
}

/** Compiled (and cached) buffer-harvest patterns for a language. */
function declarationRegexes(languageId: string | undefined): RegExp[] {
  const id = key(languageId);
  const cached = declCache.get(id);
  if (cached) return cached;
  const patterns: DeclarationPattern[] = config(languageId)?.declarations ?? [];
  // `m` because declaration patterns anchor to the start of a line.
  const compiled = patterns.map((d) => new RegExp(d.pattern, 'gm'));
  declCache.set(id, compiled);
  return compiled;
}

/**
 * A name simple enough to offer as-is: an identifier, a dotted config key, or a
 * CSS custom property.
 */
const SIMPLE_NAME = /^(?:--)?[A-Za-z_$][A-Za-z0-9_$.\-]*$/;

/**
 * The names inside one capture. A capture is normally a single identifier, but
 * list-shaped ones (destructuring, `import { a, b }`) yield every name, taking
 * the binding side of a rename (`{ a: b }` offers `b`).
 */
function captureNames(raw: string): string[] {
  if (SIMPLE_NAME.test(raw)) return [raw];
  return raw
    .split(',')
    .map((part) => (part.includes(':') ? part.slice(part.lastIndexOf(':') + 1) : part))
    .map((part) => part.replace(/^\.\.\./, '').trim().match(/[A-Za-z_][A-Za-z0-9_$]*/)?.[0] ?? '')
    .filter(Boolean);
}

/**
 * Names declared in the open buffer, so a completion list offers the symbols
 * the user is actually working with and not just the language vocabulary.
 */
export function extractBufferSymbols(
  source: string,
  languageId: string | undefined,
): Suggestion[] {
  const patterns = config(languageId)?.declarations ?? [];
  const regexes = declarationRegexes(languageId);
  if (patterns.length === 0) return [];

  const def = languageId ? getLanguage(languageId) : undefined;
  const reserved = new Set(
    [...(def?.keywords ?? []), ...(def?.types ?? []), ...(def?.builtins ?? [])].map((w) =>
      w.toLowerCase(),
    ),
  );
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const add = (label: string, kind: CompletionKind) => {
    // A capture that landed on a keyword (`if (x) {` matching a function
    // pattern) is noise, not a declaration.
    if (!label || reserved.has(label.toLowerCase()) || seen.has(label)) return;
    seen.add(label);
    out.push({ label, kind, detail: 'in this file' });
  };

  for (let r = 0; r < regexes.length; r++) {
    for (const m of source.matchAll(regexes[r])) {
      if (!m[1]) continue;
      for (const name of captureNames(m[1])) add(name, patterns[r].kind);
    }
  }
  return out;
}

/**
 * The snippet to offer when the caret sits directly after a keyword, e.g. a
 * block after `if` or a binding after `let`. Returns `null` when the language
 * has no prediction for the preceding word, or when the caret is inside a word
 * (the prefix path already covers that case).
 */
export function getPrediction(
  languageId: string | undefined,
  before: string,
): Suggestion | null {
  const conf = config(languageId);
  if (!conf) return null;
  // Only predict directly after `keyword ` — mid-word the prefix path applies.
  if (RE_WORD_AT_END.test(before)) return null;

  const word = before.trimEnd().match(RE_WORD_AT_END)?.[0]?.toLowerCase();
  if (!word) return null;

  const pick = (table: Record<string, BlockSnippet> | undefined): Suggestion | null => {
    const hit = table?.[word];
    if (!hit) return null;
    return { label: hit.label, kind: 'snippet', body: hit.body, detail: 'suggestion' };
  };

  return pick(conf.blocks) ?? pick(conf.bindings);
}

/** The identifier under the caret, i.e. the text a completion would replace. */
export function wordAt(source: string, offset: number): string {
  return source.slice(0, offset).match(RE_WORD_AT_END)?.[0] ?? '';
}

/**
 * `getUser` -> `gu`. Lets a short prefix reach a long camelCase symbol, the way
 * every real editor behaves.
 */
function camelAbbreviation(label: string): string {
  let out = '';
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (i === 0 || (c >= 'A' && c <= 'Z')) out += c.toLowerCase();
  }
  return out;
}

/** Drops later duplicates of a label so one row per insertable text. */
function dedupeByLabel(list: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const s of list) {
    const id = s.label.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(s);
  }
  return out;
}

/**
 * Rank the pool against a typed prefix: exact, then prefix, then camelCase
 * abbreviation, then substring. The tiers keep `for` above `before` and
 * `getUser` above `getUsername`.
 */
function rank(pool: Suggestion[], prefix: string): Suggestion[] {
  const exact: Suggestion[] = [];
  const starts: Suggestion[] = [];
  const camel: Suggestion[] = [];
  const contains: Suggestion[] = [];
  for (const s of pool) {
    const label = s.label.toLowerCase();
    if (label === prefix) exact.push(s);
    else if (label.startsWith(prefix)) starts.push(s);
    else if (camelAbbreviation(s.label).startsWith(prefix)) camel.push(s);
    else if (label.includes(prefix)) contains.push(s);
  }
  return dedupeByLabel([...exact, ...starts, ...camel, ...contains]);
}

/**
 * The trigger that fires at the caret, or `null`. Markup languages rely on
 * this: there is no word after `<` to prefix-match, so the trigger is the only
 * thing that can offer the tag list.
 */
function triggerAt(languageId: string | undefined, before: string): CompletionTrigger | null {
  const triggers = config(languageId)?.triggers ?? [];
  for (const t of triggers) {
    if (before.endsWith(t.text)) return t;
  }
  return null;
}

/**
 * The ranked completion list for a caret position.
 *
 * With nothing typed the list is just the context prediction (a block after
 * `if`, a value list after `prop: `, a tag list after `<`), so completion stays
 * out of the way until there is a word to match or a reason to suggest.
 */
export function getSuggestions(req: CompletionRequest): Suggestion[] {
  const { languageId, source, offset, force = false } = req;
  if (!languageId || !getLanguage(languageId)) return [];

  const before = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const prefix = wordAt(source, before.length).toLowerCase();
  const limit = req.limit ?? (force ? 16 : 8);
  const prediction = getPrediction(languageId, before);

  if (prefix) {
    const matches = rank(candidatePool(languageId, source, prediction), prefix).slice(0, limit);
    // Nothing to add and the typed word is already complete: stay out of the way.
    if (matches.length === 1 && matches[0].label.toLowerCase() === prefix) return [];
    return matches;
  }

  if (force) return dedupeByLabel(candidatePool(languageId, source, prediction)).slice(0, limit);

  const trigger = triggerAt(languageId, before);
  if (trigger) {
    const kinds = trigger.kinds;
    return getCompletionPool(languageId)
      .filter((s) => (kinds ? kinds.includes(s.kind) : s.kind !== 'snippet'))
      .slice(0, limit);
  }

  return prediction ? [prediction] : [];
}

/**
 * Everything a prefix match may draw on, most specific first: the context
 * prediction, the symbols this buffer declares, then the language vocabulary.
 */
function candidatePool(
  languageId: string | undefined,
  source: string,
  prediction: Suggestion | null,
): Suggestion[] {
  return [
    ...(prediction ? [prediction] : []),
    ...extractBufferSymbols(source, languageId),
    ...getCompletionPool(languageId),
  ];
}

/** Drops cached pools/regexes; called when a language or snippets change. */
export function invalidateCompletionCache(): void {
  poolCache.clear();
  declCache.clear();
}
