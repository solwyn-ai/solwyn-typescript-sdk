import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const verifier = pathToFileURL(
  fileURLToPath(new URL("../../scripts/verification/package-consumers.mjs", import.meta.url)),
).href;
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  "complete",
  "extra-root",
  "extra-nested",
  "missing-locked",
  "wrong-version",
])("rejects dependency trees which differ from the lock: %s", (scenario) => {
  const app = mkdtempSync(path.join(tmpdir(), "verification-pack-lock-"));
  temporary.push(app);
  const metadata = (relative: string, version: string) => {
    mkdirSync(path.join(app, relative), { recursive: true });
    writeFileSync(
      path.join(app, relative, "package.json"),
      JSON.stringify({ name: relative, version }),
    );
  };
  // Filesystem metadata only: this test never creates declarations or compiles fake dependencies.
  metadata("node_modules/@solwyn/sdk", "0.0.0");
  if (scenario !== "missing-locked")
    metadata("node_modules/pinned", scenario === "wrong-version" ? "2.0.0" : "1.0.0");
  if (scenario === "extra-root") metadata("node_modules/unpinned", "1.0.0");
  if (scenario === "extra-nested") metadata("node_modules/pinned/node_modules/unpinned", "1.0.0");
  const lock = {
    packages: {
      "": {},
      "node_modules/pinned": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/pinned/-/pinned-1.0.0.tgz",
        integrity: "sha512-test",
      },
    },
  };
  const program = `import {assertLockedDependencies} from ${JSON.stringify(verifier)};assertLockedDependencies(${JSON.stringify(app)},${JSON.stringify(lock)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(scenario === "complete" ? 0 : 1);
});
