/**
 * @lithis/eslint-config — flat config for the monorepo.
 *
 * Two custom rules carry the architecture:
 *  - lithis/no-bare-stub: TODO-shaped throws and hand-made NotImplementedError
 *    must be stub() from @lithis/stubkit (editor-time echo of stubscan).
 *  - lithis/server-module-boundaries: apps/server modules may import each other
 *    ONLY via the other module's index.ts (published interface).
 */

import path from "node:path";
import tsParser from "@typescript-eslint/parser";

const TODO_MESSAGE = /\b(todo|not implemented|unimplemented|wip|fixme)\b/i;

const noBareStub = {
  meta: {
    type: "problem",
    docs: { description: "Placeholders must be declared via @lithis/stubkit stub()" },
    schema: [],
    messages: {
      todoThrow:
        "TODO-shaped throw — declare the gap with stub()/stubValue()/stubService() from @lithis/stubkit so it is registered and searchable (LITHIS-STUB).",
      rawNie:
        "Do not construct NotImplementedError directly — only @lithis/stubkit may throw it (use stub()).",
    },
  },
  create(context) {
    return {
      ThrowStatement(node) {
        const arg = node.argument;
        if (!arg || arg.type !== "NewExpression" || arg.callee.type !== "Identifier") return;
        if (arg.callee.name === "NotImplementedError") {
          context.report({ node, messageId: "rawNie" });
          return;
        }
        if (arg.callee.name === "Error") {
          const first = arg.arguments[0];
          if (
            first &&
            first.type === "Literal" &&
            typeof first.value === "string" &&
            TODO_MESSAGE.test(first.value)
          ) {
            context.report({ node, messageId: "todoThrow" });
          }
        }
      },
    };
  },
};

const serverModuleBoundaries = {
  meta: {
    type: "problem",
    docs: { description: "apps/server modules import each other only via index.ts" },
    schema: [],
    messages: {
      deepImport:
        "Cross-module import into '{{target}}/{{rest}}' — modules expose their interface via '{{target}}/index' only.",
    },
  },
  create(context) {
    const filename = context.filename.split(path.sep).join("/");
    const match = filename.match(/apps\/server\/src\/([^/]+)\//);
    if (!match) return {};
    const ownModule = match[1];

    return {
      ImportDeclaration(node) {
        const spec = node.source.value;
        if (typeof spec !== "string" || !spec.startsWith(".")) return;
        const dir = path.posix.dirname(filename);
        const resolved = path.posix.normalize(path.posix.join(dir, spec));
        const target = resolved.match(/apps\/server\/src\/([^/]+)(?:\/(.+))?$/);
        if (!target) return;
        const targetModule = target[1];
        const rest = target[2] ?? "";
        if (
          targetModule !== ownModule &&
          rest !== "" &&
          rest !== "index" &&
          rest !== "index.ts"
        ) {
          context.report({
            node,
            messageId: "deepImport",
            data: { target: targetModule, rest },
          });
        }
      },
    };
  },
};

export const lithisPlugin = {
  meta: { name: "lithis" },
  rules: {
    "no-bare-stub": noBareStub,
    "server-module-boundaries": serverModuleBoundaries,
  },
};

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/*.d.ts"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { lithis: lithisPlugin },
    rules: {
      "lithis/no-bare-stub": "error",
      "lithis/server-module-boundaries": "error",
    },
  },
  {
    // Tests may hand-build errors and fixture data freely.
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**", "**/fixtures/**"],
    rules: {
      "lithis/no-bare-stub": "off",
    },
  },
  {
    // stubkit IS the machinery — the one legitimate NotImplementedError thrower.
    files: ["packages/stubkit/**"],
    rules: {
      "lithis/no-bare-stub": "off",
    },
  },
];
