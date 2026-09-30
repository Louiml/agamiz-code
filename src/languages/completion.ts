import { getLanguage } from './registry';
import { getRegisteredSnippets, snippetRegistryVersion } from './snippets';
import { embeddedRegionAt } from './services/htmlRegions';
import { MARKUP_FETCH, markupSuggestions, rankMarkupSuggestions } from './services/markupCompletion';
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
export interface Suggestion {  label: string;
  kind: CompletionKind;
  /** Text inserted on accept; defaults to `label`. */
  body?: string;
  /** Secondary text shown to the right of the label. */
  detail?: string;
  /**
   * Absolute span this completion replaces, when the producer knows it.
   *
   * A language service returns a `TextEdit` with the exact range it judged to
   * be the token, and that is not always what a word-boundary scan would pick:
   * for `text-ali` a word scan is right, but for `<img al` the token is the
   * attribute name only, and for a CSS value it is the value only. When these
   * are set the editor replaces exactly this span instead of re-deriving one.
   */
  replaceStart?: number;
  replaceEnd?: number;
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

const wordCache = new Map<string, RegExp>();

/**
 * The pattern for "the word under the caret" in a language.
 *
 * Defaults to a plain identifier. A language that disagrees — CSS, where
 * `text-align` and `--brand` are single words — supplies `wordPattern`.
 *
 * This is deliberately *not* shared with the tokenizer: the tokenizer decides
 * how to colour a line, this decides what a completion replaces, and CSS
 * property names are one word for the second purpose and several tokens for the
 * first.
 */
function wordRegex(languageId: string | undefined): RegExp {
  const id = key(languageId);
  const cached = wordCache.get(id);
  if (cached) return cached;
  const source = config(languageId)?.wordPattern ?? IDENT;
  const compiled = new RegExp(`(?:${source})$`);
  wordCache.set(id, compiled);
  return compiled;
}

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
  if (wordAt(before, before.length, languageId)) return null;

  const word = before.trimEnd().match(wordRegex(languageId))?.[0]?.toLowerCase();
  if (!word) return null;

  const pick = (table: Record<string, BlockSnippet> | undefined): Suggestion | null => {
    const hit = table?.[word];
    if (!hit) return null;
    return { label: hit.label, kind: 'snippet', body: hit.body, detail: 'suggestion' };
  };

  return pick(conf.blocks) ?? pick(conf.bindings);
}

/** The identifier under the caret, i.e. the text a completion would replace. */
export function wordAt(source: string, offset: number, languageId?: string): string {
  return source.slice(0, offset).match(wordRegex(languageId))?.[0] ?? '';
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

/**
 * Drops later duplicates of a label so one row per insertable text.
 *
 * When a label appears twice — `def` is both a Python keyword and a snippet —
 * the one that carries a `body` wins, because it is the one that actually puts
 * something other than the bare word into the buffer. The keyword-only entry
 * would insert `def` and leave the user to type the signature.
 */
function dedupeByLabel(list: Suggestion[]): Suggestion[] {
  const index = new Map<string, number>();
  const out: Suggestion[] = [];
  for (const s of list) {
    const id = s.label.toLowerCase();
    const at = index.get(id);
    if (at === undefined) {
      index.set(id, out.length);
      out.push(s);
    } else if (!out[at].body && s.body) {
      out[at] = s;
    }
  }
  return out;
}

/**
 * Rank the pool against a typed prefix: exact, then prefix, then camelCase
 * abbreviation, then substring. The tiers keep `for` above `before` and
 * `getUser` above `getUsername`.
 *
 * Within a tier, a snippet sorts after everything else. Snippets are added to
 * the pool first, so without this they took the top slots on match quality
 * alone — typing `color: re` offered the `reset` snippet above the `revert` and
 * `red` values the user was looking for.
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
    // Substring matching on a one- or two-letter prefix is almost pure noise:
    // `cl` matched `article`, and `bo` matched `viewBox`. Real editors only
    // fall back to a substring once the prefix is long enough to be a choice
    // rather than a coincidence.
    else if (prefix.length >= 3 && label.includes(prefix)) contains.push(s);
  }
  const demoteSnippets = (xs: Suggestion[]) => [
    ...xs.filter((s) => s.kind !== 'snippet'),
    ...xs.filter((s) => s.kind === 'snippet'),
  ];
  return dedupeByLabel([
    ...demoteSnippets(exact),
    ...demoteSnippets(starts),
    ...demoteSnippets(camel),
    ...demoteSnippets(contains),
  ]);
}

/**
 * The trigger that fires at the caret, or `null`. Markup languages rely on
 * this: there is no word after `<` to prefix-match, so the trigger is the only
 * thing that can offer the tag list.
 */
function triggerAt(languageId: string | undefined, before: string): CompletionTrigger | null {
  const triggers = config(languageId)?.triggers ?? [];
  for (const t of triggers) {
    if (!before.endsWith(t.text)) continue;
    if (t.guard && !new RegExp(t.guard).test(before)) continue;
    return t;
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
  const prefix = wordAt(source, before.length, languageId).toLowerCase();
  const limit = req.limit ?? (force ? 16 : 8);
  const prediction = getPrediction(languageId, before);

  // The HTML and CSS language services answer from the same data VS Code uses.
  // They are consulted first and on their own terms: they know the caret's tag,
  // the property being completed, and the value expected, none of which the
  // word-prefix engine can see. Whatever they do not cover falls through to the
  // data-driven path below, so nothing is lost by asking them.
  const fromService = serviceSuggestions(languageId, source, offset, limit);
  // Not re-sliced to limit: shape has already applied the markup popup size, which is deliberately larger so valid-but-uncommon entries stay reachable by scrolling.
  if (fromService.length > 0) return dedupeByLabel(fromService);
  if (prefix) {
    const matches = rank(candidatePool(languageId, source, prediction), prefix).slice(0, limit);
    // Nothing to add and the typed word is already complete: stay out of the way.
    if (matches.length === 1 && matches[0].label.toLowerCase() === prefix) return [];
    return matches;
  }

  // A trigger outranks `force`. Ctrl+Space inside a tag or after a property
  // colon is asking "what goes here", and answering with the first sixteen
  // entries of the pool — nearly all of them snippets — was the old behaviour
  // regardless of where the caret was.
  const trigger = triggerAt(languageId, before);

  if (trigger) {
    const kinds = trigger.kinds;
    const pool = getCompletionPool(languageId)
      .filter((s) => (kinds ? kinds.includes(s.kind) : s.kind !== 'snippet'));
    // A property-aware list first, so `color: ` leads with colours rather than
    // with the display keywords that also happen to be values.
    const specific = propertySpecificValues(languageId, before);
    const fromBuffer = contextSymbols(languageId, source, before);
    return dedupeByLabel([...specific, ...fromBuffer, ...pool]).slice(0, limit);
  }

  if (force) {
    return interleave(candidatePool(languageId, source, prediction), limit);
  }

  return prediction ? [prediction] : [];
}

/**
 * Alternate between two groups so neither can crowd the other out.
 *
 * Used for explicit "show me everything" requests. Simply demoting snippets
 * replaced one failure with another: Python has enough keywords to fill the
 * whole limit on their own, so every snippet was pushed off the end. A user
 * pressing Ctrl+Space wants a spread, not sixteen near-identical rows.
 */
function interleave(pool: Suggestion[], limit: number): Suggestion[] {
  const items = dedupeByLabel(pool);
  const snippets = items.filter((s) => s.kind === 'snippet');
  const rest = items.filter((s) => s.kind !== 'snippet');
  const out: Suggestion[] = [];
  let a = 0;
  let b = 0;
  while (out.length < limit && (a < rest.length || b < snippets.length)) {
    if (a < rest.length) out.push(rest[a++]);
    if (out.length < limit && b < snippets.length) out.push(snippets[b++]);
  }
  return out;
}

/**
 * The values declared for the property the caret is currently inside.
 *
 * Matches `name:` immediately before the caret, so `.a { color: ` resolves
 * against `color` and `.a { grid-template-columns: ` against that longer name.
 * Returns nothing when the language has no such table or the property is not
 * in it, and the generic value list is used instead.
 */
function propertySpecificValues(
  languageId: string | undefined,
  before: string,
): Suggestion[] {
  const table = config(languageId)?.propertyValues;
  if (!table) return [];
  const prop = before.match(/([A-Za-z_-][\w-]*)\s*:\s*$/)?.[1]?.toLowerCase();
  if (!prop) return [];
  const words = table[prop];
  if (!words) return [];
  return words.map((w) => ({ label: w.label, kind: w.kind, body: w.body, detail: w.detail }));
}

/**
 * Buffer symbols that make sense for the trigger the caret just hit.
 *
 * After `.` in CSS the useful answers are the class names this stylesheet
 * already defines, not its properties; the declaration patterns find them, and
 * this filters the harvest down to the ones the trigger is asking about.
 */
function contextSymbols(
  languageId: string | undefined,
  source: string,
  before: string,
): Suggestion[] {
  const trigger = triggerAt(languageId, before);
  if (!trigger?.symbolPattern) return [];
  const re = new RegExp(trigger.symbolPattern, 'g');
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const m of source.matchAll(re)) {
    const name = m[1] ?? m[0];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ label: name, kind: 'symbol', detail: 'in this file' });
  }
  return out;
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

/**
 * Suggestions from the HTML and CSS language services, or an empty list.
 *
 * Import is deferred to the call site rather than the top of the module so that
 * a buffer which is not markup never pays for loading either service.
 */
/**
 * Rows the markup popup is given.
 *
 * Deliberately more than the eight the data-driven path returns. The popup is
 * a scrollable list, so a wider one costs nothing and is the difference
 * between order-radius being reachable by scrolling and not existing:
 * slicing the service's list to eight hid everything past the eighth
 * alphabetical entry.
 */
const MARKUP_POPUP = 60;

function serviceSuggestions(
  languageId: string,
  source: string,
  offset: number,
  limit: number,
): Suggestion[] {
  if (languageId !== 'html' && languageId !== 'css') return [];

  // Inside `<style>`/`<script>` the outer language does not apply at all:
  // offering HTML attributes in a stylesheet is worse than offering nothing.
  const region = embeddedRegionAt(source, offset);
  if (region) {
    if (region.language === 'css') {
      const all = markupSuggestions({
        language: 'html',
        source,
        offset,
        limit: MARKUP_FETCH,
        embedded: region,
      });
      // 'css', not the outer languageId: inside <style> the caret is in a
      // stylesheet, so the prefix has to be read with the CSS word pattern.
      // Using the outer language turned 	ext-al into l and offered
      // align-* instead.
      return shape(all, source, offset, limit, 'css');
    }
    // There is no JavaScript service in this project, so a `<script>` body is
    // completed as JavaScript by recursing with the region as the document.
    // Without this the popup offered HTML attributes inside a script tag.
    const regionText = source.slice(region.start, region.end);
    return getSuggestions({
      languageId: 'javascript',
      source: regionText,
      offset: offset - region.start,
      limit,
    });
  }

  const all = markupSuggestions({ language: languageId, source, offset, limit: MARKUP_FETCH });
  return shape(all, source, offset, limit, languageId);
}

/**
 * Turn the service's raw list into popup rows.
 *
 * The service returns every valid name for the position and expects the client
 * to match against what the user typed, so filtering happens here. Two things
 * would each be wrong on their own:
 *
 *  - promoting without filtering puts `div` and `span` above the `details` and
 *    `dialog` the user asked for by typing `<de`;
 *  - filtering without promoting puts `accesskey` and `autocapitalize` above
 *    the `id` and `class` that are on nearly every tag.
 *
 * So: match on the prefix first, then promote within the matches.
 *
 * The prefix has to be read with the language's own word pattern. Reading it
 * as a plain identifier turned `text-al` into `al`, and the popup then offered
 * `align-content` where the user wanted `text-align`.
 */
/**
 * The language's own snippets, for merging with the service's rows.
 *
 * The services know every valid name but know nothing about snippets, and
 * returning their rows exclusively pushed ours off the list entirely: `hov`
 * offered `:hover` from the CSS service and not the `hover` snippet, and `do`
 * put the `download` attribute above the `doctype` snippet. Merging them and
 * ranking together gets both, with `rank` putting a real vocabulary match ahead
 * of an equally-good snippet.
 */
function snippetsFor(languageId: string): Suggestion[] {
  return getCompletionPool(languageId).filter((s) => s.kind === 'snippet');
}

function shape(
  all: Suggestion[],
  source: string,
  offset: number,
  limit: number,
  languageId: string,
): Suggestion[] {
  const prefix = wordAt(source, offset, languageId).toLowerCase();
  const matched = prefix ? rank([...all, ...snippetsFor(languageId)], prefix) : all;
  return dedupeByLabel(rankMarkupSuggestions(matched)).slice(0, MARKUP_POPUP);
}

/**
 * The language a position should be completed as when it sits inside an
 * embedded region, or `undefined` at the top level.
 *
 * `<script>` bodies are completed as JavaScript using this project's own data,
 * since there is no JavaScript service dependency.
 */
export function embeddedLanguageAt(
  source: string,
  offset: number,
): { language: string; start: number; end: number } | undefined {
  const region = embeddedRegionAt(source, offset);
  return region ? { language: region.language, start: region.start, end: region.end } : undefined;
}

/** Drops cached pools/regexes; called when a language or snippets change. */
export function invalidateCompletionCache(): void {
  poolCache.clear();
  declCache.clear();
  wordCache.clear();
}
