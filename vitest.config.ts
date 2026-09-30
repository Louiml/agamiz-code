import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These suites cover pure logic (tab bookkeeping, EOL math, terminal
    // ratios, link providers) and the Rust-side path confinement tests run
    // under `cargo test` — so a node environment is enough and keeps the
    // suite fast.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/app/features/**/*.ts', 'src/app/components/terminal/**/*.ts'],
      exclude: ['**/*.test.ts'],
    },
  },
});
