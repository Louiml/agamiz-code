/**
 * Built-in "New Project" templates.
 *
 * A template is pure data: a file tree plus the metadata the wizard needs to
 * render a card, preview the tree, and decide what to run afterwards. There is
 * no callback, because the wizard must be able to *show* what will be written
 * and *ask about collisions* before the user commits — a function could only
 * run at creation time, by which point both are impossible.
 *
 * Extensions contribute the same shape through `agamiz.projects.register`, so
 * `allProjectTemplates` merges the two. Anything added here must therefore
 * serialise cleanly to the wire form the extension host uses (plain strings and
 * an array of `{ path, content }`), and must not carry a React element.
 *
 * Paths are relative and always slash-separated. The Rust side resolves them
 * against the project root and refuses anything that escapes it, so a template
 * cannot reach outside the folder the user chose.
 */

import type { IconName } from '../components/Icon';

export interface ProjectTemplateFile {
  path: string;
  content: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  tags: string[];
  /**
   * Run in the new project root after the files are written, shown verbatim
   * next to the wizard's checkbox. `null` means there is nothing to install —
   * the checkbox still renders (so the row does not jump between templates) but
   * reports "nothing to install" instead of a command.
   */
  installCommand: string | null;
  /**
   * Relative path opened as the first tab once the project exists. Must name
   * either a `files` path or a `declaredOutputs` path, or the extension host
   * rejects the registration outright — a silent blank editor is a much worse
   * failure than a load-time error.
   */
  entryFile: string | null;
  files: ProjectTemplateFile[];
  /**
   * Paths a `createCommand` generator is expected to produce, so the wizard can
   * show them in its preview. Never written by the IDE — the generator does
   * that.
   *
   * Without this a template that shells out to a real CLI (`rakc package init`,
   * `cargo new`) would preview as an almost-empty folder, hiding the very files
   * the user is creating the project *for*. Always empty for built-ins, which
   * write their own output.
   */
  declaredOutputs: string[];
  /**
   * Extension-supplied hook, run in the new project root *after* the files are
   * written. This is how a template that needs a real generator works — the
   * bundled Rak example calls `rakc package init` from here. Always `null` for
   * built-ins, which is why it is optional rather than required.
   */
  createCommand?: string | null;
  /** `builtin` | an extension id, so the wizard can badge contributed cards. */
  source: string;
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/**
 * Serialise run configurations into a `.vscode/launch.json` body.
 *
 * Taking objects rather than pre-formatted JSON keeps the templates readable
 * *and* guarantees the output parses: a hand-written JSON string with a missing
 * comma would only surface when a user opened the file, whereas this throws at
 * module load.
 *
 * `cwd` is deliberately omitted rather than written as `${workspaceFolder}`:
 * nothing in the runner substitutes that token, so including it would bake a
 * literal, unresolvable string into every invocation.
 */
function launchFile(configs: Record<string, unknown>[]): string {
  return `${JSON.stringify({ version: '0.2.0', configurations: configs }, null, 2)}\n`;
}

const GITIGNORE_NODE = `# dependencies
node_modules/
.pnp
.pnp.js

# build output
dist/
dist-ssr/
build/
.next/
out/
.astro/

# environment
.env
.env.local
.env.*.local

# logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# editor / OS
.vscode/*
!.vscode/launch.json
.idea/
.DS_Store
Thumbs.db

# typescript
*.tsbuildinfo
`;

const GITIGNORE_RUST = `# rust
/target
**/*.rs.bk
Cargo.lock.orig

# node (only present for the tauri frontend)
node_modules/
dist/

# environment
.env
.env.local

# editor / OS
.vscode/*
!.vscode/launch.json
.idea/
.DS_Store
Thumbs.db
`;

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

const EMPTY: ProjectTemplate = {
  id: 'empty',
  name: 'Empty Project',
  description: 'A bare folder with a README and a .gitignore. Bring your own tooling.',
  icon: 'folder-plus',
  tags: ['blank', 'any language'],
  installCommand: null,
  entryFile: 'README.md',
  source: 'builtin',
  declaredOutputs: [],
  files: [
    {
      path: 'README.md',
      content: `# \${PROJECT_NAME}

A new Agamiz Code project.

## Layout

- \`src/\` — application source
- \`.vscode/launch.json\` — run and debug configurations

## Getting started

Open a file in \`src/\` and press F5 to run it.
`,
    },
    { path: '.gitignore', content: GITIGNORE_NODE },
    {
      // Explicitly empty rather than absent: the Run & Debug panel then reports
      // "no configurations" instead of falling back to auto-detection.
      path: '.vscode/launch.json',
      content: launchFile([]),
    },
  ],
};

// ---------------------------------------------------------------------------
// React (Vite)
// ---------------------------------------------------------------------------

const REACT_VITE: ProjectTemplate = {
  id: 'react-vite',
  name: 'React',
  description: 'React 19 + TypeScript on Vite, with HMR and a dev-server debug config.',
  icon: 'sparkles',
  tags: ['react', 'typescript', 'vite', 'web'],
  installCommand: 'npm install',
  entryFile: 'src/App.tsx',
  source: 'builtin',
  declaredOutputs: [],
  files: [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: 'react-app',
          private: true,
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'tsc -b && vite build',
            preview: 'vite preview',
          },
          dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
          devDependencies: {
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            '@vitejs/plugin-react': '^4.3.4',
            typescript: '^5.7.0',
            vite: '^6.0.0',
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'vite.config.ts',
      content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
`,
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            jsx: 'react-jsx',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            isolatedModules: true,
            resolveJsonModule: true,
          },
          include: ['src', 'vite.config.ts'],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: 'src/main.tsx',
      content: `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    },
    {
      path: 'src/App.tsx',
      content: `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="app">
      <h1>React App</h1>
      <p>Vite + React + TypeScript.</p>
      <button onClick={() => setCount((n) => n + 1)}>
        clicked {count} time{count === 1 ? '' : 's'}
      </button>
    </main>
  );
}
`,
    },
    {
      path: 'src/index.css',
      content: `:root {
  color-scheme: dark;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

body {
  margin: 0;
  background: #09090b;
  color: #e4e4e7;
}

.app {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  gap: 0.75rem;
}

button {
  padding: 0.5rem 1rem;
  border: 1px solid #3f6212;
  border-radius: 0.375rem;
  background: #14532d;
  color: #dcfce7;
  cursor: pointer;
  font: inherit;
}

button:hover {
  background: #166534;
}
`,
    },
    {
      path: 'src/vite-env.d.ts',
      content: `/// <reference types="vite/client" />
`,
    },
    { path: '.gitignore', content: GITIGNORE_NODE },
    {
      path: '.vscode/launch.json',
      content: launchFile([
        { name: 'Dev server', type: 'command', program: 'npm', args: ['run', 'dev'], schematic: 'debug-run' },
        {
          name: 'Debug dev server',
          type: 'node',
          program: 'node',
          args: ['node_modules/vite/bin/vite.js'],
          request: 'launch',
          stopOnEntry: false,
          schematic: 'debug-run',
        },
      ]),
    },
  ],
};

// ---------------------------------------------------------------------------
// Next.js
// ---------------------------------------------------------------------------

const NEXT: ProjectTemplate = {
  id: 'next',
  name: 'Next.js',
  description: 'App Router, TypeScript and Tailwind, wired for dev and a production build.',
  icon: 'rocket',
  tags: ['react', 'next', 'typescript', 'web'],
  installCommand: 'npm install',
  entryFile: 'app/page.tsx',
  source: 'builtin',
  declaredOutputs: [],
  files: [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: 'next-app',
          private: true,
          scripts: {
            dev: 'next dev',
            build: 'next build',
            start: 'next start',
            lint: 'next lint',
          },
          dependencies: { next: '^15.1.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
          devDependencies: {
            '@types/node': '^22.10.0',
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            typescript: '^5.7.0',
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'next.config.ts',
      content: `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {};

export default nextConfig;
`,
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['dom', 'dom.iterable', 'esnext'],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: 'preserve',
            incremental: true,
            plugins: [{ name: 'next' }],
            paths: { '@/*': ['./*'] },
          },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
          exclude: ['node_modules'],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'app/layout.tsx',
      content: `import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Next App',
  description: 'Created with Agamiz Code',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      path: 'app/page.tsx',
      content: `export default function Home() {
  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: '0.75rem',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      <h1>Next App</h1>
      <p>App Router + TypeScript.</p>
    </main>
  );
}
`,
    },
    {
      path: 'app/globals.css',
      content: `:root {
  color-scheme: dark;
}

body {
  margin: 0;
  background: #09090b;
  color: #e4e4e7;
}
`,
    },
    { path: '.gitignore', content: GITIGNORE_NODE },
    {
      path: '.vscode/launch.json',
      content: launchFile([
        { name: 'Dev server', type: 'command', program: 'npm', args: ['run', 'dev'], schematic: 'debug-run' },
        { name: 'Production build', type: 'command', program: 'npm', args: ['run', 'build'], schematic: 'debug-run' },
      ]),
    },
  ],
};

// ---------------------------------------------------------------------------
// Astro
// ---------------------------------------------------------------------------

const ASTRO: ProjectTemplate = {
  id: 'astro',
  name: 'Astro',
  description: 'Content-first site with one pre-rendered page and scoped component styles.',
  icon: 'box',
  tags: ['astro', 'typescript', 'web'],
  installCommand: 'npm install',
  entryFile: 'src/pages/index.astro',
  source: 'builtin',
  declaredOutputs: [],
  files: [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: 'astro-site',
          private: true,
          type: 'module',
          scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' },
          dependencies: { astro: '^5.0.0' },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'astro.config.mjs',
      content: `import { defineConfig } from 'astro/config';

export default defineConfig({
  server: {
    port: 4321,
  },
});
`,
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify({ extends: 'astro/tsconfigs/strict' }, null, 2)}\n`,
    },
    {
      path: 'src/pages/index.astro',
      content: `---
const title = 'Astro Site';
const features = ['Zero JS by default', 'Scoped component styles', 'Content collections'];
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
  </head>
  <body>
    <main>
      <h1>{title}</h1>
      <ul>
        {features.map((feature) => <li>{feature}</li>)}
      </ul>
    </main>
  </body>
</html>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    font-family: ui-monospace, monospace;
    background: #09090b;
    color: #e4e4e7;
  }
</style>
`,
    },
    { path: '.gitignore', content: GITIGNORE_NODE },
    {
      path: '.vscode/launch.json',
      content: launchFile([
        { name: 'Dev server', type: 'command', program: 'npm', args: ['run', 'dev'], schematic: 'debug-run' },
        { name: 'Build site', type: 'command', program: 'npm', args: ['run', 'build'], schematic: 'debug-run' },
      ]),
    },
  ],
};

// ---------------------------------------------------------------------------
// Rust + Tauri
// ---------------------------------------------------------------------------

const RUST_TAURI: ProjectTemplate = {
  id: 'rust-tauri',
  name: 'Rust + Tauri',
  description: 'A Tauri 2 desktop shell with a Rust command exposed to the frontend.',
  icon: 'package',
  tags: ['rust', 'tauri', 'desktop'],
  installCommand: 'npm install && cargo fetch',
  entryFile: 'src-tauri/src/main.rs',
  source: 'builtin',
  declaredOutputs: [],
  files: [
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: 'tauri-app',
          private: true,
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'vite build',
            tauri: 'tauri',
          },
          dependencies: { '@tauri-apps/api': '^2.0.0' },
          devDependencies: { '@tauri-apps/cli': '^2.0.0', vite: '^6.0.0' },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tauri App</title>
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    },
    {
      path: 'src/main.ts',
      content: `import { invoke } from '@tauri-apps/api/core';

async function greet(): Promise<string> {
  // \`greet\` is the #[tauri::command] in src-tauri/src/main.rs.
  return await invoke<string>('greet', { name: 'Agamiz' });
}

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  greet().then(
    (message) => {
      app.innerHTML = \`<h1>Tauri + Rust</h1><p>\${message}</p>\`;
    },
    (error) => {
      app.innerHTML = \`<h1>Tauri + Rust</h1><p style="color:#f87171">\${error}</p>\`;
    },
  );
}
`,
    },
    {
      path: 'src-tauri/Cargo.toml',
      content: `[package]
name = "tauri-app"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`,
    },
    {
      path: 'src-tauri/build.rs',
      content: `fn main() {
    tauri_build::build()
}
`,
    },
    {
      path: 'src-tauri/tauri.conf.json',
      content: `${JSON.stringify(
        {
          productName: 'Tauri App',
          version: '0.1.0',
          identifier: 'com.example.tauri-app',
          build: {
            beforeDevCommand: 'npm run dev',
            beforeBuildCommand: 'npm run build',
            devUrl: 'http://localhost:5173',
            frontendDist: '../dist',
          },
          app: { windows: [{ title: 'Tauri App', width: 1000, height: 700 }], security: { csp: null } },
          bundle: { active: true, targets: 'all', icon: ['icons/icon.png'] },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'src-tauri/src/main.rs',
      content: `// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;

#[derive(Serialize)]
struct Greeting {
    message: String,
}

#[tauri::command]
fn greet(name: &str) -> Greeting {
    Greeting {
        message: format!("Hello, {name}!"),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`,
    },
    { path: '.gitignore', content: GITIGNORE_RUST },
    {
      path: '.vscode/launch.json',
      content: launchFile([
        { name: 'Tauri dev', type: 'command', program: 'cargo', args: ['tauri', 'dev'], schematic: 'debug-run' },
        { name: 'Tauri build', type: 'command', program: 'cargo', args: ['tauri', 'build'], schematic: 'debug-run' },
      ]),
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The templates that ship with the IDE, in the order the wizard lists them. */
export const BUILTIN_PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  EMPTY,
  REACT_VITE,
  NEXT,
  ASTRO,
  RUST_TAURI,
];

/** The token a template can use to refer to the project it is creating. */
const PROJECT_NAME_TOKEN = /\$\{PROJECT_NAME\}/g;

/**
 * Substitute `\${PROJECT_NAME}` throughout a template.
 *
 * Applied on the frontend rather than in Rust so an extension template gets the
 * same treatment for free — a template author writes one literal and does not
 * have to know the project name at registration time.
 *
 * Paths are substituted as well as bodies, so a template can put the project
 * name in a path (`${PROJECT_NAME}/src/main.rak`) instead of a fixed layout.
 * That is safe because the wizard rejects any project name containing a path
 * separator before it ever reaches here, so the token can only ever expand to a
 * single path segment.
 */
export function materialize(template: ProjectTemplate, projectName: string): ProjectTemplate {
  const files = template.files.map((f) => ({
    path: f.path.replace(PROJECT_NAME_TOKEN, projectName),
    content: f.content.replace(PROJECT_NAME_TOKEN, projectName),
  }));
  return { ...template, files, entryFile: template.entryFile?.replace(PROJECT_NAME_TOKEN, projectName) ?? null };
}

/** Every file path a template writes, in declaration order. */
export function templatePaths(template: ProjectTemplate): string[] {
  return template.files.map((f) => f.path);
}

/** One row in the wizard's file-tree preview. */
export interface ProjectTemplatePreviewEntry {
  path: string;
  /** True for paths the generator creates rather than the IDE writing them. */
  generated: boolean;
}

/**
 * Everything the wizard should show in its preview: the files the IDE writes,
 * plus the paths a generator is expected to produce.
 *
 * `templatePaths` alone would under-report a generator template, which is the
 * bug this function exists to prevent — a `cargo new` template that previews as
 * an empty folder tells the user nothing about what they are about to get.
 */
export function templatePreviewPaths(template: ProjectTemplate): ProjectTemplatePreviewEntry[] {
  const written = new Set(template.files.map((f) => f.path));
  return [
    ...template.files.map((f) => ({ path: f.path, generated: false })),
    // A declared output that the template *also* writes is not generated, and
    // showing it twice would be worse than hiding the marker.
    ...template.declaredOutputs
      .filter((p) => !written.has(p))
      .map((path) => ({ path, generated: true })),
  ];
}

/**
 * The wizard's full list: built-ins first, then anything extensions registered.
 *
 * Built-ins lead deliberately — they are the ones that work with no extension
 * installed, so a user who has never opened the Extensions panel still finds
 * them first. Contributed templates are appended and badged by `source`.
 */
export function allProjectTemplates(contributed: readonly ProjectTemplate[]): ProjectTemplate[] {
  return [...BUILTIN_PROJECT_TEMPLATES, ...contributed];
}

/**
 * Guard for the wizard's Create button.
 *
 * A template with no files still has to create the root folder, so this is
 * about the *workspace* succeeding, not the template. Kept separate from
 * `templatePaths` so the file-tree preview can be skipped for a
 * generator-only extension template.
 */
export function isCreatable(template: ProjectTemplate): boolean {
  return template.files.length > 0 || Boolean(template.createCommand);
}
