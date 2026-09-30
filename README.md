# Agamiz Code

A Tauri 2 + Next.js + React desktop IDE. The editor is a bespoke `<textarea>` over a syntax-highlighted `<pre>` overlay with a hand-rolled tokenizer (no CodeMirror/Monaco). The core is language-agnostic: language support, examples, documentation, and run toolchains are contributed by bundled **extensions**.

## The Rak extension

The bundled **Rak** extension (in `src/extensions/rak/`) contributes everything specific to the [Rak](https://github.com/Louiml/Rak) programming language:

- **Language definition** — `language.ts` registers the `rak` language (keywords, types, builtins, string/regex/char/number rules) with Agamiz Code's data-driven registry.
- **Snippets** — `snippets.ts` provides Rak autocomplete fragments (`fn`, `match`, `impl`, `import`, `tunnel`, `ffi`, `async`, …).
- **Examples** — `examples.ts` is the Rak example gallery (`ffi`, `mmap`, `async`, `net_raw`, `parsers`, `macros`, `batteries`, `osint`, …).
- **Docs** — `docs.ts` is the Rak reference (keywords, builtins, and VPN/OSINT guides).
- **Toolchain** — runs scripts/packages via the bundled `rakc`/`rakpkg` binaries (interp/vm/bench).

The core editor and status bar read the detected active language; nothing in the completion engine is hardcoded to Rak. Autocomplete is data-driven: every language in the registry contributes its own snippets, buffer-harvest patterns and context predictions through `LanguageDef.completion` (`src/languages/builtin/completions.ts` + `snippets.ts`), and `src/languages/completion.ts` turns that data into the ranked list the editor renders. A language gets completion support by adding data, not by touching the editor.

The one remaining Rak-specific piece of the editor core is the syntax-highlight tokenizer in `CodeEditor.tsx`, which is still written against Rak's lexical rules; `src/languages/tokenizer.ts` holds the generic, registry-driven tokenizer that replaces it.

Launching the app activates the bundled extensions once (`src/extensions/index.ts`), which registers the built-in (non-Rak) languages plus Rak.

## Getting Started

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
