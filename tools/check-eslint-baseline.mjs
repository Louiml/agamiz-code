/**
 * Lint baseline gate.
 *
 * The repository carries 107 pre-existing ESLint errors — almost all
 * `no-explicit-any` in the TypeScript Lua interpreter, plus a handful of
 * `react-hooks` findings that are warnings in disguise under the flat config.
 * Deleting them is a separate cleanup; what matters today is that the count
 * cannot *grow* silently, which is what CI would otherwise fail to notice.
 *
 * So this records the current counts and fails when either is exceeded. When
 * you legitimately fix some, lower the numbers in `lint-baseline.json` in the
 * same commit — the file is the record of remaining debt, not a ratchet that
 * hides new work.
 *
 * Usage: `npm run lint:check` (what CI runs). For a human-facing report use
 * `npm run lint`.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'lint-baseline.json');

// Invoke eslint's entry point with the current Node binary rather than going
// through `npx`: `spawnSync('npx.cmd', …)` fails with EINVAL on Windows, and
// shelling out re-resolves the toolchain on every run.
const eslintEntry = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const { maxErrors, maxWarnings } = baseline;

// Lint `src` explicitly rather than `.`, so a stray build directory added to
// the tree later cannot turn this into a multi-minute walk of generated code.
const eslint = spawnSync(
  process.execPath,
  [eslintEntry, '-f', 'json', 'src', 'tools', 'next.config.ts', 'vitest.config.ts',
    'eslint.config.mjs', 'postcss.config.mjs'],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

if (eslint.error) {
  console.error(`could not run eslint: ${eslint.error.message}`);
  process.exit(2);
}

// eslint exits 1 when it finds problems, which is expected here. Anything
// above 1 is a real failure (bad config, crash).
if (eslint.status !== 0 && eslint.status !== 1) {
  console.error(eslint.stderr || `eslint exited ${eslint.status}`);
  process.exit(2);
}

let results;
try {
  results = JSON.parse(eslint.stdout);
} catch {
  console.error('eslint did not emit valid JSON:\n', eslint.stdout.slice(0, 2000));
  process.exit(2);
}

let errors = 0;
let warnings = 0;
/** Per-file totals for the failure message, worst first. */
const byFile = [];

for (const file of results) {
  errors += file.errorCount;
  warnings += file.warningCount;
  if (file.errorCount + file.warningCount > 0) {
    byFile.push({
      file: file.filePath.replace(root + '\\', '').replace(root + '/', ''),
      errors: file.errorCount,
      warnings: file.warningCount,
    });
  }
}

const pass = errors <= maxErrors && warnings <= maxWarnings;

console.log(`lint baseline: ${errors} errors / ${warnings} warnings`);
console.log(`allowed:       ${maxErrors} errors / ${maxWarnings} warnings`);

if (!pass) {
  const regressed = [];
  if (errors > maxErrors) regressed.push(`${errors - maxErrors} new error(s)`);
  if (warnings > maxWarnings) regressed.push(`${warnings - maxWarnings} new warning(s)`);
  console.error(`\nFAIL: ${regressed.join(', ')} above the recorded baseline.`);
  console.error('Either fix them, or — if the increase is a deliberate accepted ' +
    'trade — update lint-baseline.json in the same commit with a reason.\n');
  byFile
    .sort((a, b) => b.errors - a.errors || b.warnings - a.warnings)
    .slice(0, 15)
    .forEach((f) => console.error(`  ${f.file}: ${f.errors}e ${f.warnings}w`));
  process.exit(1);
}

const remaining = maxErrors - errors;
if (remaining > 0) {
  console.log(`\n${remaining} error(s) of headroom. Fix some and lower ` +
    'lint-baseline.json to shrink the debt.');
}
console.log('OK — no new lint problems.');
