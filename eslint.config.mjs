import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  { ignores: [".next/**", ".worktrees/**", "apps/web/**", "node_modules/**", "generated/**", "playwright-report/**", "test-results/**"] },
  { files: ["**/*.{js,mjs}"], ...js.configs.recommended, languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } } },
  { files: ["**/*.{ts,tsx}"], languageOptions: { parser: tsParser, parserOptions: { sourceType: "module" } }, plugins: { "@typescript-eslint": tsPlugin }, rules: { ...tsPlugin.configs.recommended.rules, "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }] } },
];
