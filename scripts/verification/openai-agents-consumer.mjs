/** Docs recipe extraction and built-entry paths shared by installed OpenAI Agents proofs. */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function extractOpenaiAgentsRecipe(document, { commonjs = false } = {}) {
  const blocks = [...document.matchAll(/```ts\r?\n([\s\S]*?)```/g)];
  assert.equal(blocks.length, 1, "OpenAI Agents guide must have one complete TypeScript recipe");
  let source = blocks[0][1];
  if (commonjs) {
    const marker = "const client = new Solwyn(";
    assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, `async function recipe() {\n${marker}`);
    source += "\n}\nvoid recipe();\n";
  }
  return source;
}

export function openaiAgentsHarnessArguments(sdkPath, format) {
  return [
    "openai-agents-harness.mjs",
    pathToFileURL(path.join(sdkPath, `dist/openai-agents/index.${format === "esm" ? "js" : "cjs"}`))
      .href,
    pathToFileURL(path.join(sdkPath, `dist/node.${format === "esm" ? "js" : "cjs"}`)).href,
    pathToFileURL(path.join(sdkPath, `dist/testing/index.${format === "esm" ? "js" : "cjs"}`)).href,
  ];
}
