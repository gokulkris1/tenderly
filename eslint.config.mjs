import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// The Vite + React app and the Express API. Nothing here depends on Next.js:
// the eslint-config-next preset left with the rest of the Next scaffolding.
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "**/dist/**",
      "dist-netlify/**",
      "**/*.tsbuildinfo",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,mjs}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Deliberate throwaways are prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
