/**
 * Embedded-language regions inside an HTML document.
 *
 * The VS Code HTML language service deliberately does not do this. The language
 * *server* that wraps it finds the `<style>` and `<script>` bodies, blanks out
 * everything else, and hands the result to the CSS or JavaScript service - that
 * splitting lives in the server, not in the service, so it has to be done here.
 *
 * The blanking is what makes the trick work: every character outside the region
 * is replaced by a space, newlines kept, so every offset in the extracted
 * document is also the offset in the original. No position arithmetic is needed
 * anywhere downstream, and no line/column conversion.
 */

export type EmbeddedLanguage = 'css' | 'javascript';

export interface EmbeddedRegion {
  language: EmbeddedLanguage;
  /** The region text on its own, starting at its own offset 0. */
  text: string;
  /** Offset of the region body in the original document. */
  start: number;
  end: number;
}

/**
 * Tags whose body is a different language. `type` is checked so that
 * `<script type="application/json">` or `type="text/x-template"` is left alone:
 * that content is not CSS or JavaScript, and offering completions for it would
 * be wrong rather than merely unhelpful.
 */
const EMBEDDED_TAGS: { tag: string; language: EmbeddedLanguage; accept?: RegExp }[] = [
  {
    tag: 'style',
    language: 'css',
    // `type="text/css"` is fine; anything else is not CSS.
    accept: /^\s*(?:text\/css\s*)?$/i,
  },
  {
    tag: 'script',
    language: 'javascript',
    // No `type` is the common case and means classic JavaScript. These are the
    // module and JSON-ish spellings that are still JavaScript to complete.
    accept: /^\s*(?:|text\/(?:javascript|ecmascript|babel|jsx|typescript|ts))\s*$/i,
  },
];

/** All embedded regions in a document, in source order. */
export function findEmbeddedRegions(source: string): EmbeddedRegion[] {
  const out: EmbeddedRegion[] = [];
  for (const { tag, language, accept } of EMBEDDED_TAGS) {
    // Both the open tag and the close tag have to be matched by hand, because
    // the body can contain anything - including something that looks like the
    // closing tag inside a CSS comment or a JS string.
    const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    for (let m = open.exec(source); m; m = open.exec(source)) {
      if (accept) {
        const typeAttr = /\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1] ?? '');
        const value = typeAttr ? (typeAttr[2] ?? typeAttr[3] ?? typeAttr[4] ?? '') : '';
        if (!accept.test(value)) continue;
      }
      const bodyStart = m.index + m[0].length;
      const closeTag = `</${tag}`;
      const closeAt = source.toLowerCase().indexOf(closeTag, bodyStart);
      const end = closeAt === -1 ? source.length : closeAt;
      out.push({ language, text: source.slice(bodyStart, end), start: bodyStart, end });
      // Continue after the close tag so a second `<style>` is still found.
      if (closeAt === -1) break;
      open.lastIndex = source.indexOf('>', closeAt) + 1;
      if (open.lastIndex <= 0) break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The region containing `offset`, or null. */
export function embeddedRegionAt(source: string, offset: number): EmbeddedRegion | null {
  for (const region of findEmbeddedRegions(source)) {
    if (offset >= region.start && offset <= region.end) return region;
  }
  return null;
}

/**
 * The document with everything outside `region` blanked to spaces.
 *
 * Newlines are preserved so line and character positions survive untouched;
 * only the characters outside the region change. The result is valid CSS or
 * JavaScript that happens to be surrounded by a lot of whitespace, which is
 * exactly what the language services want to parse.
 */
export function blankOutside(source: string, region: EmbeddedRegion): string {
  if (region.start === 0 && region.end === source.length) return region.text;
  const head = source.slice(0, region.start).replace(/[^\n]/g, ' ');
  const tail = source.slice(region.end).replace(/[^\n]/g, ' ');
  return head + region.text + tail;
}
