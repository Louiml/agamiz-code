import type { BlockSnippet, DeclarationPattern, LanguageCompletion } from '../types';
import {
  C_SNIPPETS,
  CPP_SNIPPETS,
  CSS_SNIPPETS,
  CSHARP_SNIPPETS,
  GO_SNIPPETS,
  HTML_SNIPPETS,
  JAVA_SNIPPETS,
  JS_SNIPPETS,
  JSON_SNIPPETS,
  LUA_SNIPPETS,
  MARKDOWN_SNIPPETS,
  PYTHON_SNIPPETS,
  RUST_SNIPPETS,
  SHELL_SNIPPETS,
  TOML_SNIPPETS,
  TS_SNIPPETS,
  YAML_SNIPPETS,
} from './snippets';

/**
 * Autocomplete data for the bundled languages: which buffer patterns declare a
 * name, what to offer after a keyword, and the vocabulary that does not belong
 * to the keyword/type/builtin lists. A language is fully supported for
 * completion by filling this in — the engine needs nothing else.
 */

const BRACE: BlockSnippet = { label: '{ … }', body: '{\n    \n}' };
const COLON: BlockSnippet = { label: ': …', body: ':\n    ' };
const END: BlockSnippet = { label: '… end', body: '\n    \nend' };
const EQ_VALUE: BlockSnippet = { label: '= value', body: 'name = value' };
const BRACE_FN: BlockSnippet = { label: 'name(args) { … }', body: 'name(args) {\n    \n}' };

/** Give every listed keyword the same block body. */
const blocks = (body: BlockSnippet, words: string[]): Record<string, BlockSnippet> =>
  Object.fromEntries(words.map((w) => [w, body]));

/** Brace-delimited languages: a `{ … }` after a keyword, a signature after a callable. */
const braceBlocks = (extra: string[] = []): Record<string, BlockSnippet> => ({
  ...blocks(BRACE, BRACE_BLOCKS),
  ...blocks(BRACE_FN, CALLABLE_KEYWORDS),
  ...blocks(BRACE, extra),
});

const BRACE_BLOCKS = [
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'finally', 'do',
  'loop', 'match', 'class', 'struct', 'enum', 'interface', 'union', 'trait',
  'impl', 'namespace', 'record', 'lock', 'using', 'synchronized', 'unsafe',
  'unless', 'elif', 'begin', 'sub', 'select', 'case', 'when', 'mod',
];

/** Keywords that introduce a callable, which wants a full signature. */
const CALLABLE_KEYWORDS = ['fn', 'func', 'function', 'def'];

/* --------------------------------------------------------- JavaScript / TS */

const JS_DECLARATIONS = [
  { kind: 'function' as const, pattern: String.raw`\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)` },
  { kind: 'function' as const, pattern: String.raw`\bclass\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+[A-Za-z_$][\w$]*)?\s*(?:implements[^{]*)?\{` },
  { kind: 'symbol' as const, pattern: String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)` },
  { kind: 'symbol' as const, pattern: String.raw`\b(?:const|let|var)\s*\{([^}]*)\}` },
  { kind: 'symbol' as const, pattern: String.raw`\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}` },
  { kind: 'symbol' as const, pattern: String.raw`\bimport\s+([A-Za-z_$][\w$]*)` },
  { kind: 'function' as const, pattern: String.raw`^\s*(?:static\s+|async\s+|get\s+|set\s+|public\s+|private\s+|protected\s+|readonly\s+|override\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{` },
  { kind: 'symbol' as const, pattern: String.raw`\bexport\s*\{([^}]*)\}` },
];

const TS_DECLARATIONS = [
  { kind: 'type' as const, pattern: String.raw`\b(?:interface|type|enum|namespace|declare\s+module)\s+([A-Za-z_$][\w$]*)` },
  { kind: 'type' as const, pattern: String.raw`\b(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)` },
];

export const JS_COMPLETION: LanguageCompletion = {
  snippets: JS_SNIPPETS,
  declarations: [...JS_DECLARATIONS, ...TS_DECLARATIONS],
  blocks: braceBlocks(),
  bindings: blocks(EQ_VALUE, ['let', 'const', 'var']),
};

export const TS_COMPLETION: LanguageCompletion = {
  ...JS_COMPLETION,
  snippets: TS_SNIPPETS,
};

/* ------------------------------------------------------------------ Python */

export const PYTHON_COMPLETION: LanguageCompletion = {
  snippets: PYTHON_SNIPPETS,
  declarations: [
    { kind: 'function', pattern: String.raw`^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)` },
    { kind: 'type', pattern: String.raw`^[ \t]*class[ \t]+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`^[ \t]*(?:self\.)?([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)` },
    { kind: 'symbol', pattern: String.raw`^[ \t]*(?:from\s+\S+\s+)?import\s+(.+)$` },
  ],
  blocks: {
    ...blocks(COLON, ['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'match', 'case', 'else']),
    def: { label: 'name(params): …', body: 'name(params):\n    ' },
    class: { label: 'Name: …', body: 'Name:\n    ' },
  },
};

/* --------------------------------------------------------------------- Lua */

export const LUA_COMPLETION: LanguageCompletion = {
  snippets: LUA_SNIPPETS,
  declarations: [
    { kind: 'function', pattern: String.raw`\blocal\s+function\s+([A-Za-z_][\w.:]*)` },
    { kind: 'function', pattern: String.raw`\bfunction\s+([A-Za-z_][\w.:]*)` },
    { kind: 'function', pattern: String.raw`\b([A-Za-z_][\w.:]*)\s*=\s*function` },
    { kind: 'symbol', pattern: String.raw`\blocal\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`^[ \t]*([A-Za-z_][\w.:]*)\s*=[^=]` },
  ],
  blocks: blocks(END, ['if', 'for', 'while', 'do', 'function', 'repeat']),
  bindings: blocks(EQ_VALUE, ['local']),
};

/* -------------------------------------------------------------------- Rust */

export const RUST_COMPLETION: LanguageCompletion = {
  snippets: RUST_SNIPPETS,
  declarations: [
    { kind: 'function', pattern: String.raw`\bfn\s+([A-Za-z_]\w*)` },
    { kind: 'type', pattern: String.raw`\b(?:struct|enum|trait|union|type)\s+([A-Za-z_]\w*)` },
    { kind: 'type', pattern: String.raw`\bimpl(?:<[^>]*>)?\s+[A-Za-z_]\w*\s+for\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\buse\s+(?:crate::)?([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\bmod\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\blet\s+(?:mut\s+)?([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\b(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)` },
  ],
  blocks: braceBlocks(),
  bindings: blocks(EQ_VALUE, ['let', 'mut', 'const', 'static']),
};

/* ---------------------------------------------------------------------- Go */

export const GO_COMPLETION: LanguageCompletion = {
  snippets: GO_SNIPPETS,
  declarations: [
    { kind: 'function', pattern: String.raw`^\s*func\s+([A-Za-z_]\w*)` },
    { kind: 'function', pattern: String.raw`\bfunc\s+\([^)]*\)\s*([A-Za-z_]\w*)` },
    { kind: 'type', pattern: String.raw`^\s*type\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`^\s*(?:var|const)\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\b([A-Za-z_]\w*)\s*:=[^=]` },
  ],
  blocks: braceBlocks(['select', 'switch', 'case']),
  bindings: blocks(EQ_VALUE, ['var', 'const']),
};

/* -------------------------------------------------------------------- Java */

const JAVA_MEMBER =
  String.raw`(?:[A-Za-z_$][\w$<>\[\].,?\s]*?[\s*])?([A-Za-z_$][\w$]*)[ \t]*(?=[({;=])`;

export const JAVA_COMPLETION: LanguageCompletion = {
  snippets: JAVA_SNIPPETS,
  declarations: [
    { kind: 'type', pattern: String.raw`\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)` },
    { kind: 'function', pattern: String.raw`^[ \t]*(?:public|private|protected|static|final|abstract|synchronized|native|default|\s)*${JAVA_MEMBER}[ \t]*\(` },
    { kind: 'symbol', pattern: String.raw`^[ \t]*(?:public|private|protected|static|final|\s)*${JAVA_MEMBER}[ \t]*(?:;|=)` },
  ],
  blocks: braceBlocks(['try', 'do', 'synchronized']),
  bindings: blocks(EQ_VALUE, ['var']),
};

/* ------------------------------------------------------------- C / C++ / C# */

/** `std::vector<int>`, `const char *`, `struct Foo` — a C-family type. */
const C_TYPE = String.raw`(?:[A-Za-z_]\w*::)*(?:struct|enum|union|class|const|volatile|unsigned|signed|static|extern|register|long|short|auto)[ \t]*|(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*(?:<[^;={}]*>)?`;

const C_DECLARATIONS: DeclarationPattern[] = [
  { kind: 'constant', pattern: String.raw`^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)` },
  { kind: 'type', pattern: String.raw`\b(?:struct|union|enum)\s+([A-Za-z_]\w*)` },
  { kind: 'type', pattern: String.raw`\btypedef\s+(?:struct|enum|union)?\s*([A-Za-z_]\w*)\s*;` },
  {
    kind: 'function',
    pattern: String.raw`^[ \t]*(?:static|inline|extern|virtual|explicit|constexpr|_Atomic|friend)[ \t]*${C_TYPE}[ \t]*\*?[ \t]*([A-Za-z_]\w*)[ \t]*\([^;]*\)[ \t]*(?:const[ \t]*)?\{`,
  },
  {
    kind: 'symbol',
    pattern: String.raw`^[ \t]*(?:static|const|volatile|unsigned|signed|register|auto|struct|enum|class|typedef)[ \t]*${C_TYPE}[ \t]*\*?[ \t]*([A-Za-z_]\w*)[ \t]*(?==|;|,|\)|\[)`,
  },
];

export const C_COMPLETION: LanguageCompletion = {
  snippets: C_SNIPPETS,
  declarations: C_DECLARATIONS,
  blocks: blocks(BRACE, ['if', 'else', 'for', 'while', 'switch', 'do', 'struct', 'union', 'enum']),
};

export const CPP_COMPLETION: LanguageCompletion = {
  snippets: CPP_SNIPPETS,
  declarations: [
    { kind: 'type', pattern: String.raw`\b(?:class|namespace|template|using)\s+([A-Za-z_]\w*)` },
    {
      kind: 'function',
      pattern: String.raw`^[ \t]*(?:[A-Za-z_]\w*::)+[A-Za-z_]\w*::([A-Za-z_]\w*)[ \t]*\([^;]*\)[ \t]*(?:const[ \t]*)?\{`,
    },
    ...C_DECLARATIONS,
  ],
  blocks: braceBlocks(['struct', 'union', 'enum', 'template', 'namespace', 'class', 'try', 'catch', 'do', 'noexcept']),
};

export const CSHARP_COMPLETION: LanguageCompletion = {
  snippets: CSHARP_SNIPPETS,
  declarations: [
    { kind: 'type', pattern: String.raw`\b(?:class|interface|struct|enum|record|namespace)\s+([A-Za-z_]\w*)` },
    {
      kind: 'function',
      pattern: String.raw`^[ \t]*(?:public|private|protected|internal|static|readonly|virtual|override|async|sealed|partial|extern|unsafe|\s)*${JAVA_MEMBER}[ \t]*\(`,
    },
    {
      kind: 'symbol',
      pattern: String.raw`^[ \t]*(?:public|private|protected|internal|static|readonly|const|\s)*${JAVA_MEMBER}[ \t]*(?:;|=|\{|=>)`,
    },
  ],
  blocks: {
    ...braceBlocks(['lock', 'try', 'using', 'do', 'unsafe', 'fixed']),
    // `using` is a namespace directive before a block is meaningful.
    using: { label: 'System;', body: 'System;\n' },
  },
  bindings: blocks(EQ_VALUE, ['var']),
};

/* ------------------------------------------------------------------ Web */

const HTML_ATTRIBUTES = [
  'id', 'class', 'style', 'title', 'lang', 'dir', 'role', 'hidden', 'tabindex',
  'href', 'src', 'alt', 'target', 'rel', 'download', 'type', 'name', 'value',
  'placeholder', 'required', 'disabled', 'readonly', 'checked', 'selected',
  'min', 'max', 'step', 'pattern', 'autocomplete', 'for', 'method', 'action',
  'enctype', 'rows', 'cols', 'colspan', 'rowspan', 'width', 'height', 'srcset',
  'sizes', 'loading', 'controls', 'autoplay', 'loop', 'muted', 'poster',
  'viewBox', 'fill', 'stroke', 'stroke-width', 'xmlns', 'd', 'cx', 'cy', 'r',
];

const HTML_ATTR_WORDS = HTML_ATTRIBUTES.map((label) => ({
  label,
  kind: 'builtin' as const,
  body: `${label}="`,
  detail: 'attribute',
}));

export const HTML_COMPLETION: LanguageCompletion = {
  snippets: HTML_SNIPPETS,
  declarations: [
    // The closing quote is deliberately optional. Requiring it meant an
    // attribute value could only be harvested once its tag was finished, so the
    // names most worth completing - the ones inside `class="..."` - were exactly
    // the ones unavailable while the user was typing them.
    { kind: 'symbol', pattern: String.raw`\bid\s*=\s*["']([^"']*)` },
    { kind: 'symbol', pattern: String.raw`\bclass\s*=\s*["']([^"']*)` },
    { kind: 'symbol', pattern: String.raw`\bfor\s*=\s*["']([^"']*)` },
    { kind: 'symbol', pattern: String.raw`\bname\s*=\s*["']([^"']*)` },
  ],
  // After `<` (or `</`) there is no word to match, so the tag list is opened
  // by the trigger instead.
  triggers: [
    { text: '</', kinds: ['keyword'] },
    { text: '<', kinds: ['keyword'] },
    // Inside an open tag, after a space: the attribute list, led by the ids and
    // classes this document already uses. Without this trigger a bare `<div `
    // had no word to prefix-match and no trigger to open, so attribute
    // completion only ever appeared once the user had already typed a letter.
    { text: ' ', kinds: ['builtin'], guard: String.raw`<[A-Za-z][^<>]*$`, symbolPattern: String.raw`\b(?:id|class)\s*=\s*["']([^"']+)["']` },
  ],
  words: HTML_ATTR_WORDS,
};

const CSS_PROPERTY_WORDS = [
  'color', 'background', 'background-color', 'background-image', 'margin', 'padding',
  'border', 'border-radius', 'font', 'font-size', 'font-family', 'font-weight',
  'text-align', 'text-decoration', 'display', 'position', 'top', 'right', 'bottom',
  'left', 'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
  'overflow', 'overflow-x', 'overflow-y', 'z-index', 'opacity', 'flex', 'flex-grow',
  'flex-shrink', 'flex-wrap', 'justify-content', 'align-items', 'align-self',
  'gap', 'grid', 'grid-template', 'grid-template-columns', 'grid-template-rows',
  'transform', 'transition', 'animation', 'cursor', 'pointer-events', 'box-sizing',
  'box-shadow', 'line-height', 'letter-spacing', 'white-space', 'word-break',
  'text-transform', 'vertical-align', 'float', 'clear', 'list-style', 'content',
  'visibility', 'filter', 'mix-blend-mode', 'user-select', 'outline', 'object-fit',
  'aspect-ratio', 'inset', 'gap', 'order', 'flex-basis', 'place-items', 'aspect-ratio',
  // The sub-properties of the four-sided shorthands. `margin` alone was in the
  // list but `margin-top` was not, so typing `margin-` matched nothing at all.
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block',
  'margin-block-start', 'margin-block-end', 'margin-inline', 'margin-inline-start',
  'margin-inline-end',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block',
  'padding-block-start', 'padding-block-end', 'padding-inline', 'padding-inline-start',
  'padding-inline-end',
  'border-top', 'border-right', 'border-bottom', 'border-left', 'border-width',
  'border-style', 'border-color', 'border-top-width', 'border-right-width',
  'border-bottom-width', 'border-left-width', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'border-top-style', 'border-right-style',
  'border-bottom-style', 'border-left-style',
  'font-size', 'font-family', 'font-variant', 'font-stretch',
  'inset-top', 'inset-right', 'inset-bottom', 'inset-left',
  'grid-area', 'grid-column', 'grid-row', 'grid-auto-flow', 'grid-auto-rows',
  'grid-auto-columns', 'place-content', 'place-self',
  'outline-width', 'outline-style', 'outline-color', 'outline-offset',
  'text-overflow', 'text-shadow', 'text-indent', 'text-justify',
  'background-repeat', 'background-position', 'background-attachment', 'background-size',
  'flex-direction', 'align-content', 'align-items', 'align-self', 'justify-content',
  'justify-items', 'justify-self', 'flex-flow', 'flex-basis',
  'transition-property', 'transition-duration', 'transition-timing-function',
  'animation-name', 'animation-duration', 'animation-timing-function',
  'white-space', 'line-height', 'letter-spacing', 'word-spacing', 'word-break',
  'overflow-wrap', 'list-style', 'list-style-position', 'text-transform',
].map((label) => ({
  label,
  kind: 'builtin' as const,
  body: `${label}: `,
  detail: 'property',
}));

const CSS_AT_RULES = [
  '@media', '@import', '@keyframes', '@font-face', '@supports', '@charset',
  '@layer', '@container', '@page', '@property', '@scope', '@starting-style',
];

/** Values that follow `prop: `, where there is no word to prefix-match. */
const CSS_VALUES = [
  'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid',
  'contents', 'flow-root', 'none', 'auto', 'inherit', 'initial', 'unset', 'revert',
  'absolute', 'relative', 'fixed', 'sticky', 'static',
  'row', 'column', 'row-reverse', 'column-reverse', 'wrap', 'nowrap', 'wrap-reverse',
  'space-between', 'space-around', 'space-evenly', 'flex-start', 'flex-end',
  'center', 'start', 'end', 'stretch', 'baseline', 'normal', 'bold', 'bolder',
  'lighter', 'italic', 'uppercase', 'lowercase', 'capitalize', 'underline',
  'line-through', 'none', 'pointer', 'default', 'grab', 'move', 'not-allowed',
  'hidden', 'visible', 'scroll', 'clip', 'overlay', 'ellipsis', 'pre', 'pre-wrap',
  'pre-line', 'break-word', 'nowrap', 'solid', 'dashed', 'dotted', 'double',
  'border-box', 'content-box', 'cover', 'contain', 'red', 'blue', 'green',
  'black', 'white', 'gray', 'grey', 'orange', 'yellow', 'purple', 'pink',
  'currentColor', 'transparent',
  '0', '1', '2', '3', '100%', '50%', 'auto',
  'px', 'rem', 'em', 'vh', 'vw', 'vmin', 'vmax', 'ch', 'ex', 'fr', 'deg',
  's', 'ms',
];

const CSS_VALUE_WORDS = CSS_VALUES.map((label) => ({
  label,
  kind: 'constant' as const,
  detail: 'value',
}));

const v = (label: string) => ({ label, kind: 'constant' as const, detail: 'value' });

const COLOR_KEYWORDS = [
  'black', 'silver', 'gray', 'white', 'maroon', 'red', 'purple', 'fuchsia', 'green',
  'lime', 'olive', 'yellow', 'navy', 'blue', 'teal', 'aqua', 'orange', 'currentColor',
  'transparent',
];

/**
 * Values for the properties where the generic list is actively misleading.
 *
 * Without this, `color: ` offered `block` and `display: ` offered `red`, because
 * both drew on one flat pool. Keys are matched lowercase against the property
 * immediately before the caret.
 */
const CSS_PROPERTY_VALUES: Record<string, { label: string; kind: 'constant'; detail: string }[]> = {
  color: COLOR_KEYWORDS.map(v),
  'background-color': COLOR_KEYWORDS.map(v),
  'border-color': COLOR_KEYWORDS.map(v),
  outline: [...COLOR_KEYWORDS.map(v), v('none'), v('dashed'), v('dotted'), v('solid')],
  display: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid',
    'contents', 'flow-root', 'none', 'table', 'table-row', 'list-item'].map(v),
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'].map(v),
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'].map(v),
  'justify-content': ['flex-start', 'flex-end', 'center', 'space-between', 'space-around',
    'space-evenly', 'start', 'end', 'left', 'right', 'stretch'].map(v),
  'align-items': ['flex-start', 'flex-end', 'center', 'baseline', 'stretch', 'start',
    'end', 'normal'].map(v),
  overflow: ['visible', 'hidden', 'clip', 'scroll', 'auto'].map(v),
  visibility: ['visible', 'hidden', 'collapse'].map(v),
  'text-align': ['left', 'right', 'center', 'justify', 'start', 'end', 'match-parent'].map(v),
  'font-weight': ['100', '200', '300', '400', '500', '600', '700', '800', '900',
    'normal', 'bold', 'bolder', 'lighter'].map(v),
  'font-style': ['normal', 'italic', 'oblique'].map(v),
  'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'].map(v),
  'box-sizing': ['content-box', 'border-box'].map(v),
  cursor: ['auto', 'default', 'pointer', 'grab', 'grabbing', 'move', 'text', 'wait',
    'not-allowed', 'crosshair', 'help', 'zoom-in', 'zoom-out'].map(v),
  'list-style-type': ['none', 'disc', 'circle', 'square', 'decimal', 'lower-alpha',
    'upper-alpha', 'lower-roman', 'upper-roman'].map(v),
  'mix-blend-mode': ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'difference', 'exclusion'].map(v),
  'object-fit': ['fill', 'contain', 'cover', 'none', 'scale-down'].map(v),
  'aspect-ratio': ['auto', '1 / 1', '16 / 9', '4 / 3'].map(v),
};

export const CSS_COMPLETION: LanguageCompletion = {
  snippets: CSS_SNIPPETS,
  declarations: [
    { kind: 'symbol', pattern: String.raw`(--[A-Za-z0-9_-]+)\s*:` },
    { kind: 'symbol', pattern: String.raw`\.(-?[A-Za-z_][\w-]*)` },
    { kind: 'symbol', pattern: String.raw`#(-?[A-Za-z_][\w-]*)` },
  ],
  // A CSS property name is one word even though it is hyphenated, and a custom
  // property starts with `--`. The default identifier pattern turned `text-ali`
  // into the prefix `ali`, which matched nothing — no hyphenated property was
  // completable at all.
  wordPattern: String.raw`(?:-+|@)?[A-Za-z_][A-Za-z0-9_-]*`,
  words: [
    ...CSS_PROPERTY_WORDS,
    ...CSS_VALUE_WORDS,
    ...CSS_AT_RULES.map((label) => ({ label, kind: 'keyword' as const, body: `${label} ` })),
  ],
  // A declaration ends with `prop: `, which is not a word — the trigger is what
  // offers the value list there.
  triggers: [
    { text: ': ', kinds: ['constant'] },
    // Inside a selector, the answers are the names this stylesheet already uses.
    // The guard keeps them out of a declaration body, where a `.` is a decimal
    // point and a `#` is a colour.
    { text: '.', kinds: [], guard: String.raw`[^{}]*$`, symbolPattern: String.raw`\.(-?[A-Za-z_][\w-]*)` },
    { text: '#', kinds: [], guard: String.raw`[^{};]*$`, symbolPattern: String.raw`#(-?[A-Za-z_][\w-]*)` },
  ],
  propertyValues: CSS_PROPERTY_VALUES,
  blocks: blocks(BRACE, ['@media', '@supports', '@container', '@layer', '@font-face', '@page', '@scope']),
};

/* ------------------------------------------------ JSON / YAML / TOML / MD */

export const JSON_COMPLETION: LanguageCompletion = {
  snippets: JSON_SNIPPETS,
  declarations: [
    { kind: 'symbol', pattern: String.raw`"([A-Za-z_$][\w$.\-]*)"\s*:` },
  ],
};

export const YAML_COMPLETION: LanguageCompletion = {
  snippets: YAML_SNIPPETS,
  declarations: [
    { kind: 'symbol', pattern: String.raw`^[ \t]*([A-Za-z_][\w.\-]*)[ \t]*:(?:[ \t]|$)` },
    { kind: 'symbol', pattern: String.raw`^[ \t]*-\s+([A-Za-z_][\w.\-]*)[ \t]*:(?:[ \t]|$)` },
  ],
};

export const TOML_COMPLETION: LanguageCompletion = {
  snippets: TOML_SNIPPETS,
  declarations: [
    { kind: 'symbol', pattern: String.raw`^[ \t]*([A-Za-z_][\w.\-]*)[ \t]*(?==|\[)` },
    { kind: 'type', pattern: String.raw`^[ \t]*\[+([A-Za-z_][\w.\-]*)[^\]]*\]` },
  ],
};

export const MARKDOWN_COMPLETION: LanguageCompletion = {
  snippets: MARKDOWN_SNIPPETS,
  declarations: [
    { kind: 'symbol', pattern: String.raw`^#{1,6}[ \t]+(.+?)[ \t]*$` },
  ],
};

/* ------------------------------------------------------------------ Shell */

export const SHELL_COMPLETION: LanguageCompletion = {
  snippets: SHELL_SNIPPETS,
  declarations: [
    { kind: 'function', pattern: String.raw`^[ \t]*(?:function[ \t]+)?([A-Za-z_]\w*)[ \t]*\([ \t]*\)[ \t]*\{?` },
    { kind: 'symbol', pattern: String.raw`^[ \t]*(?:export|local|readonly|declare[ \t]+-?\w+)?[ \t]*([A-Za-z_]\w*)=` },
  ],
  blocks: {
    if: { label: '… fi', body: 'then\n    \nfi' },
    elif: { label: '… fi', body: 'then\n    \nfi' },
    else: { label: '… fi', body: 'then\n    \nfi' },
    for: { label: '… done', body: 'in "$@"\n    \ndone' },
    while: { label: '… done', body: 'do\n    \ndone' },
    until: { label: '… done', body: 'do\n    \ndone' },
    do: { label: '… done', body: '\n    \ndone' },
    case: { label: '… esac', body: 'in)\n    ;;\nesac' },
    select: { label: '… esac', body: 'in)\n    ;;\nesac' },
    function: { label: '() { … }', body: '() {\n    \n}' },
  },
  bindings: blocks({ label: 'NAME="value"', body: 'NAME="value"' }, ['local', 'export', 'declare', 'readonly']),
};
