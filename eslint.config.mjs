import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";

const eslintConfig = defineConfig([
  globalIgnores([
    "**/dist/**",
    "**/node_modules/**",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] } },
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
  },
]);

export default eslintConfig;
