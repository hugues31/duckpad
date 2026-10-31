import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["playwright-report", "test-results"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Destructuring can drop properties by naming them before a rest element.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      // Dependency lists are checked, not maintained by hand.
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["e2e/**", "docs/**", "scripts/**", "*.config.ts"],
    languageOptions: { globals: globals.node },
  },
);
