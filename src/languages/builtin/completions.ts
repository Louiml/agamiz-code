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
    { kind: 'symbol', pattern: String.raw`\bid\s*=\s*["']([^"']+)["']` },
    { kind: 'symbol', pattern: String.raw`\bclass\s*=\s*["']([^"']+)["']` },
    { kind: 'symbol', pattern: String.raw`\bfor\s*=\s*["']([^"']+)["']` },
    { kind: 'symbol', pattern: String.raw`\bname\s*=\s*["']([^"']+)["']` },
  ],
  // After `<` (or `</`) there is no word to match, so the tag list is opened
  // by the trigger instead.
  triggers: [
    { text: '</', kinds: ['keyword'] },
    { text: '<', kinds: ['keyword'] },
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

export const CSS_COMPLETION: LanguageCompletion = {
  snippets: CSS_SNIPPETS,
  declarations: [
    { kind: 'symbol', pattern: String.raw`(--[A-Za-z0-9_-]+)\s*:` },
    { kind: 'symbol', pattern: String.raw`\.(-?[A-Za-z_][\w-]*)` },
    { kind: 'symbol', pattern: String.raw`#(-?[A-Za-z_][\w-]*)` },
  ],
  words: [
    ...CSS_PROPERTY_WORDS,
    ...CSS_VALUE_WORDS,
    ...CSS_AT_RULES.map((label) => ({ label, kind: 'keyword' as const, body: `${label} ` })),
  ],
  // A declaration ends with `prop: `, which is not a word — the trigger is what
  // offers the value list there.
  triggers: [{ text: ': ', kinds: ['constant'] }],
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
