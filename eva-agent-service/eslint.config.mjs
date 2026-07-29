// Correctness-focused lint. tsc already enforces types and unused locals;
// what it cannot see are the async mistakes that silently swallow a failure —
// a forgotten `await`, a promise passed where a boolean is expected, a
// rejected promise with no handler. Those are what this config is for.
//
// Formatting is deliberately not linted: there is no formatter in this repo,
// and a style bot would only add noise to review.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "eslint.config.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A dedicated project so the tests are type-checked by the linter
        // too; tsconfig.json itself only compiles src/.
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Floating promises are the failure mode that matters here: this
      // service detaches work on purpose in a few places, and each one has
      // to say so with `void`.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // `return await` outside try/catch is harmless and this codebase uses
      // it consistently; flagging it would be pure style churn.
      "@typescript-eslint/return-await": "off",
      // Fastify hooks must be async even when the body has no await.
      "@typescript-eslint/require-await": "off",

      // The Letta SDK's surface is loosely typed and the code deliberately
      // narrows `unknown` by hand; these would fire on every such boundary
      // without pointing at a real defect.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      // `as never` on SDK calls is a deliberate escape hatch against
      // upstream type drift, not dead weight — the rule reads it as
      // redundant because today's typings happen to accept the value.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // Every hit is a guarded `String(unknown)` at a JSON/pg boundary,
      // where stringifying is the intent rather than an accident.
      "@typescript-eslint/no-base-to-string": "off",
      // The hits are pg-pool proxies that pass `this` explicitly through
      // Reflect.apply, which the rule cannot see.
      "@typescript-eslint/unbound-method": "off",

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests import the compiled output and assert on loose shapes.
    // `test()` from node:test returns a promise nobody awaits — that is the
    // documented idiom, not a bug.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
);
