import type { LanguageCompletion } from '../../languages/types';

/**
 * Autocomplete data for Rak, contributed by the bundled Rak extension.
 *
 * The engine in `src/languages/completion.ts` is language-agnostic; everything
 * Rak-specific about completion — which patterns declare a name, what follows
 * `let` or `tunnel` — lives here so the core stays free of Rak.
 */
export const RAK_COMPLETION: LanguageCompletion = {
  declarations: [
    { kind: 'function', pattern: String.raw`\bfn\s+([A-Za-z_]\w*)` },
    { kind: 'type', pattern: String.raw`\b(?:struct|enum|binstruct)\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\btunnel\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\buse\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\bmacro\s+([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\blet\s+(?:mut\s+)?([A-Za-z_]\w*)` },
    { kind: 'symbol', pattern: String.raw`\bconst\s+([A-Za-z_]\w*)` },
  ],
  blocks: {
    if: { label: '{ … }', body: '{\n    \n}' },
    else: { label: '{ … }', body: '{\n    \n}' },
    for: { label: '{ … }', body: '{\n    \n}' },
    while: { label: '{ … }', body: '{\n    \n}' },
    loop: { label: '{ … }', body: '{\n    \n}' },
    match: { label: '{ … }', body: '{\n    \n}' },
    try: { label: '{ … }', body: '{\n    \n}' },
    impl: { label: '{ … }', body: '{\n    \n}' },
    struct: { label: '{ … }', body: '{\n    \n}' },
    enum: { label: '{ … }', body: '{\n    \n}' },
    binstruct: { label: '{ … }', body: '{\n    \n}' },
    macro: { label: '{ … }', body: '{\n    \n}' },
    fn: { label: 'name(args) { … }', body: 'name(args) {\n    \n}' },
    extern: { label: '{ … }', body: '{\n    \n}' },
    // A tunnel is a linked block: it needs a name and a passphrase up front.
    tunnel: { label: '<name> "<pass>" { … }', body: 'link "passphrase" {\n    \n}' },
  },
  bindings: {
    let: { label: '= value', body: 'name = value' },
    mut: { label: '= value', body: 'name = value' },
    const: { label: '= value', body: 'name = value' },
  },
};
