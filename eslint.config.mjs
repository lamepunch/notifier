import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

// Style rules taken from Zipbot's conventions, not a full recommended preset.
export default tseslint.config(
  { ignores: ["worker-configuration.d.ts", "node_modules", ".wrangler"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      "@stylistic": stylistic,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // No braces around a single-statement body, unless another branch of the same if/else needs them.
      curly: ["error", "multi", "consistent"],
      eqeqeq: ["error", "always"],
      "@typescript-eslint/no-explicit-any": "error",
      // Keeps --fix output on its own lines with consistent indentation.
      "@stylistic/brace-style": ["error", "1tbs"],
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/no-multiple-empty-lines": ["error", { max: 1 }],
      "@stylistic/indent": ["error", 2, { offsetTernaryExpressions: true }],
      "@stylistic/padding-line-between-statements": [
        "error",
        // Blank line after declarations, but consecutive declarations stay grouped.
        { blankLine: "always", prev: ["const", "let"], next: "*" },
        { blankLine: "any", prev: ["const", "let"], next: ["const", "let"] },
        { blankLine: "always", prev: "*", next: "if" },
        { blankLine: "always", prev: "if", next: "*" },
        { blankLine: "always", prev: "block-like", next: "*" },
      ],
    },
  },
);
