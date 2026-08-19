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
    // Build output is not source. Without these, eslint lints server/dist and
    // reports every compiled artefact twice.
    "**/dist/**",
    "**/dist-netlify/**",
    "**/node_modules/**",
  ]),
]);

export default eslintConfig;
