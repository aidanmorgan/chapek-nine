import globals from "globals";

/**
 * Forward-only quality gates. All executable source and test modules share
 * Node's standard globals; stricter architectural rules apply at the domain
 * and application boundaries below.
 */
export default [
  {
    ignores: ["node_modules/**", "runtime/**", "logs/**", "models/**", "training/corpus/**"],
  },
  {
    files: ["scripts/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../application/**",
                "../infrastructure/**",
                "node:child_process",
                "node:fs",
                "node:fs/promises",
                "node:os",
                "node:path",
                "node:process",
              ],
              message:
                "Domain policies must not depend on application, infrastructure, or host I/O APIs.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../infrastructure/os/**"],
              message:
                "Application services use a platform port rather than an operating-system adapter.",
            },
          ],
        },
      ],
    },
  },
];
