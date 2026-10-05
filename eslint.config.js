import tseslint from "typescript-eslint";
export default [
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        Response: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: { "no-unused-vars": "error", "no-undef": "error" },
  },
];
