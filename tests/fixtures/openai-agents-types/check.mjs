import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const directory = fileURLToPath(new URL(".", import.meta.url));
const root = join(directory, "../../..");
const guide = readFileSync(join(root, "docs/integrations/openai-agents.md"), "utf8");
let recipe = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)][0]?.[1];
assert.ok(recipe, "missing OpenAI Agents recipe");
for (const [before, after] of [
  ['from "@solwyn/sdk/node"', 'from "../../../src/node"'],
  ['from "@solwyn/sdk/openai-agents"', 'from "../../../src/openai-agents/index"'],
]) {
  assert.equal(recipe.split(before).length, 2, `expected exactly one ${before}`);
  recipe = recipe.replace(before, after);
}

const recipePath = join(directory, `.docs-recipe-${randomUUID()}.ts`);
try {
  writeFileSync(recipePath, recipe);
  const config = ts.readConfigFile(join(directory, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  const program = ts.createProgram({
    rootNames: [join(directory, "fixture.ts"), recipePath],
    options: parsed.options,
  });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
  process.stdout.write("[openai-agents-types] PASS strict API and docs recipe declarations\n");
} finally {
  rmSync(recipePath, { force: true });
}
