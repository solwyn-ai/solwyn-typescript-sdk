import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const harness = fileURLToPath(new URL("./fixtures/post-remediation-errors.mjs", import.meta.url));

it.each(["esm", "cjs"])("shares every error family with %s loaded first", async (first) => {
  const { stdout } = await execute(process.execPath, [harness, process.cwd(), first], {
    timeout: 30_000,
  });
  expect(JSON.parse(stdout)).toEqual({ families: 11, denied: 8, stopped: 8, middlewareDenied: 2 });
});

it("compiles strict native Responses helpers in ESM and CJS", async () => {
  // Keep package consumers out of the source gate, which runs before dist exists.
  // Materializing inside the package preserves actual package export resolution.
  const directory = await mkdtemp(join(process.cwd(), ".post-remediation-consumer-"));
  try {
    const esm = join(directory, "consumer.mts");
    const cjs = join(directory, "consumer.cts");
    await writeFile(
      esm,
      await readFile("tests/fixtures/post-remediation-responses-consumer.mts.fixture"),
    );
    await writeFile(
      cjs,
      await readFile("tests/fixtures/post-remediation-responses-consumer.cts.fixture"),
    );
    const { stdout } = await execute(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "--lib",
        "ES2022,DOM,ESNext.Disposable",
        esm,
        cjs,
      ],
      { timeout: 30_000 },
    );
    expect(stdout).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
