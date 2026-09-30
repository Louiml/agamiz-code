import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default to node: the suite is mostly pure logic (tab bookkeeping, EOL
    // math, path containment, terminal ratios, link providers) and jsdom is
    // markedly slower. Component tests opt in per-file with a
    // `@vitest-environment jsdom` docblock, which keeps the fast/slow split
    // visible in the test file itself rather than hidden in a glob here.
    environment: 'node',
    globals: true,
    setupFiles: ['./tools/vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/app/features/**/*.ts', 'src/app/components/terminal/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}'],
    },
  },
});
