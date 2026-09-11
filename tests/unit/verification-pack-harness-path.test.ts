import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const verifier = new URL("../../scripts/verification/package-consumers.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  "esm",
  "cjs",
])("loads the %s AI harness entry from URL-sensitive platform paths", (format) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-harness-path-"));
  temporary.push(scratch);
  const sdk = path.join(scratch, "installed sdk #100%", "sdk");
  mkdirSync(path.join(sdk, "dist/ai-sdk"), { recursive: true });
  writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ type: "module" }));
  const implementation =
    "function createSolwynMiddleware(){return {middleware:{wrapGenerate(){},wrapStream(){}},async close(){},[Symbol.asyncDispose](){}}}";
  writeFileSync(
    path.join(sdk, `dist/ai-sdk/index.${format === "esm" ? "js" : "cjs"}`),
    `${format === "esm" ? "export " : ""}${implementation}${format === "cjs" ? ";exports.createSolwynMiddleware=createSolwynMiddleware;" : ""}`,
  );
  copyFileSync(
    path.join(repository, "tests/dist/fixtures/ai-sdk-harness.mjs"),
    path.join(scratch, "ai-sdk-harness.mjs"),
  );
  const program = `import {spawnSync} from 'node:child_process';import {aiHarnessArguments} from ${JSON.stringify(verifier)};const args=aiHarnessArguments(${JSON.stringify(sdk)},${JSON.stringify(format)});const result=spawnSync(process.execPath,args,{cwd:${JSON.stringify(scratch)},encoding:'utf8'});process.stdout.write(JSON.stringify({args,...result}));`;
  const caller = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(caller.status, caller.stderr).toBe(0);
  const result = JSON.parse(caller.stdout);
  expect(result.status, result.stderr).toBe(0);
  expect(result.args[1]).toMatch(/^file:/);
  expect(result.args[1]).toContain("%23");
  expect(result.args[1]).toContain("%25");
  expect(JSON.parse(result.stdout)).toEqual({
    loaded: true,
    hasWrapGenerate: true,
    hasWrapStream: true,
    hasClose: true,
    hasDispose: true,
  });
});
