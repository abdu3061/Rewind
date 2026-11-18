import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { builtinModules } from "node:module";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.vite/**",
      "**/.generated/**",
      "**/dist/**",
      "**/out/**",
      "test-results/**",
      "playwright-report/**",
      "artifacts/**",
      "Rewind/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "node:*",
            ...builtinModules,
            "electron",
            "@rewind/engine",
            "@rewind/storage",
            "@rewind/collectors",
            "@rewind/assistant",
            "@rewind/documents",
            "@google/genai",
            "@google/genai/*",
          ],
        },
      ],
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "electron",
            "react",
            "@rewind/desktop",
            "@rewind/browser-extension",
          ],
        },
      ],
    },
  },
  {
    files: ["packages/contracts/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["@rewind/*", "node:*", "electron", "react"] },
      ],
    },
  },
  {
    files: ["apps/browser-extension/src/**/*.ts"],
    languageOptions: { globals: { chrome: "readonly" } },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["@rewind/assistant", "@google/genai", "@google/genai/*"] },
      ],
    },
  },
  {
    files: ["apps/desktop/src/preload/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["@rewind/assistant", "@google/genai", "@google/genai/*"] },
      ],
    },
  },
  prettier,
);
