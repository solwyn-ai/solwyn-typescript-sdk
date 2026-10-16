import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it.each([
  "esm",
  "cjs",
])("shares coverage and lazy run tracking when %s loads first", async (format) => {
  const harness = fileURLToPath(
    new URL("./fixtures/coverage-and-node-sharing.mjs", import.meta.url),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--expose-gc", harness, process.cwd(), format],
    { timeout: 30_000 },
  );
  expect(JSON.parse(stdout)).toEqual({ coverageShared: true, hookShared: true, idle: true });
});

it.each([
  "js",
  "cjs",
])("preserves Node protocols and keeps core entries builtin-free (%s)", async (extension) => {
  const node = await readFile(`dist/node.${extension}`, "utf8");
  expect(node).toMatch(/["']node:async_hooks["']/);
  for (const entry of ["index", "ai-sdk/index", "testing/index"]) {
    const bundle = await readFile(`dist/${entry}.${extension}`, "utf8");
    const imports = [
      ...bundle.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);
    expect(
      imports.filter(
        (specifier) => specifier?.startsWith("node:") || builtinModules.includes(specifier ?? ""),
      ),
    ).toEqual([]);
  }
});
