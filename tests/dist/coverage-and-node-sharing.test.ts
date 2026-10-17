import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { gcProbeTimeout } from "../helpers/gc-probe";

const execFileAsync = promisify(execFile);

async function checkCoreBundles(root: string, extension: string): Promise<void> {
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries) {
    if (!entry.endsWith(`.${extension}`) || entry === `node.${extension}`) continue;
    const bundle = await readFile(join(root, entry), "utf8");
    const imports = [
      ...bundle.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g),
    ].map((match) => match[1]);
    expect(
      imports.filter(
        (specifier) => specifier?.startsWith("node:") || builtinModules.includes(specifier ?? ""),
      ),
      entry,
    ).toEqual([]);
  }
}

it.each(["esm", "cjs"])(
  "shares coverage and lazy run tracking when %s loads first",
  async (format) => {
    const harness = fileURLToPath(
      new URL("./fixtures/coverage-and-node-sharing.mjs", import.meta.url),
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--expose-gc", harness, process.cwd(), format],
      { timeout: 120_000 },
    );
    expect(JSON.parse(stdout)).toEqual({ coverageShared: true, hookShared: true, idle: true });
  },
  gcProbeTimeout,
);

it.each([
  ["esm", "legacy-first"],
  ["esm", "current-first"],
  ["cjs", "legacy-first"],
  ["cjs", "current-first"],
])("shares runs with a legacy owner registry (%s, %s)", async (format, order) => {
  const harness = fileURLToPath(new URL("./fixtures/node-legacy-sharing.mjs", import.meta.url));
  const { stdout } = await execFileAsync(
    process.execPath,
    [harness, process.cwd(), format, order],
    {
      timeout: 30_000,
    },
  );
  expect(JSON.parse(stdout)).toEqual({ compatible: true });
});

it.each([
  "js",
  "cjs",
])("preserves Node protocols and keeps core entries builtin-free (%s)", async (extension) => {
  const node = await readFile(`dist/node.${extension}`, "utf8");
  expect(node).toMatch(/["']node:async_hooks["']/);
  await checkCoreBundles("dist", extension);
});

it.each(["js", "cjs"])("rejects Node builtins hidden in a shared %s chunk", async (extension) => {
  const root = await mkdtemp(join(tmpdir(), "solwyn-built-imports-"));
  try {
    await mkdir(join(root, "ai-sdk"));
    await mkdir(join(root, "testing"));
    for (const entry of ["index", "ai-sdk/index", "testing/index"]) {
      await writeFile(join(root, `${entry}.${extension}`), "");
    }
    await writeFile(
      join(root, `chunk-shared.${extension}`),
      extension === "js" ? 'import { readFile } from "node:fs";' : 'require("fs");',
    );
    await expect(checkCoreBundles(root, extension)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
