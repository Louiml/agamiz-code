import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cargo's build directory. It holds ~17 GB of generated JS alongside the
    // Rust artifacts, including per-build Tauri codegen output that ESLint
    // cannot parse — walking it makes a plain `eslint` run take minutes.
    "src-tauri/target/**",
    "src-tauri/gen/**",
    // Bundled toolchain binaries and lockfile churn.
    "coverage/**",
  ]),
]);

export default eslintConfig;
