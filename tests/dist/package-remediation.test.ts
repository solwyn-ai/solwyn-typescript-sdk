import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const identityHarness = fileURLToPath(
  new URL("./fixtures/package-identity-remediation.mjs", import.meta.url),
);

it.each([
  "esm",
  "cjs",
])("preserves run enforcement and wrapper identity when %s is loaded first", async (format) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [identityHarness, process.cwd(), format],
    { timeout: 30_000 },
  );
  expect(JSON.parse(stdout)).toMatchObject({
    firstFormat: format,
    denied: 6,
    dispatches: 0,
    checks: 6,
    ingested: 6,
    sharedBrands: true,
  });
});

it("preserves Node bare imports and exit drains in provider-free ESM and CJS bundles", async () => {
  const harness = fileURLToPath(new URL("./fixtures/node-bundle-remediation.mjs", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [harness, process.cwd()], {
    timeout: 90_000,
  });
  const results = JSON.parse(stdout) as Array<{ confirms: number; ingested: number }>;
  expect(results).toHaveLength(6);
  expect(results.every((result) => result.confirms === 1 && result.ingested === 1)).toBe(true);
}, 90_000);
