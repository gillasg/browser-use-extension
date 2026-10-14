import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["build/**", "build-test/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mjs,js}"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        console: "readonly",
        fetch: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: {
      complexity: ["error", 12],
      "max-lines": ["error", { max: 800 }],
      "max-lines-per-function": ["error", { max: 100, skipBlankLines: true, skipComments: true }],
      "no-warning-comments": ["error", { terms: ["TODO", "FIXME", "HACK"], location: "start" }],
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // TypeScript checks names, including the browser's and chrome.*.
      "no-undef": "off",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
);
