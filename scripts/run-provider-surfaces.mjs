import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const include = JSON.parse(process.env.SURFACE_INTERVALS ?? "null");
const labelPattern = /^[a-z0-9][a-z0-9._-]*$/;
if (
  !Array.isArray(include) ||
  include.length === 0 ||
  include.some(
    (cell) =>
      !cell ||
      typeof cell.family !== "string" ||
      !labelPattern.test(cell.family) ||
      typeof cell.interval !== "string" ||
      !labelPattern.test(cell.interval) ||
      !Array.isArray(cell.packages) ||
      cell.packages.length === 0 ||
      cell.packages.some(
        (pin) => typeof pin !== "string" || pin.length === 0 || pin.startsWith("-"),
      ),
  )
) {
  throw new Error("SURFACE_INTERVALS must contain nonempty provider intervals");
}

// Copy tracked files from this checkout, including local edits, but never an existing
// node_modules, build output, untracked credentials, or a preceding interval's overlay.
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"));
const failed = [];

for (const cell of include) {
  const label = `${cell.family} / ${cell.interval}`;
  const failures = [];
  let workspace;
  console.log(`::group::${label}`);
  try {
    workspace = mkdtempSync(join(tmpdir(), "solwyn-provider-surface-"));
    for (const file of files) {
      const target = join(workspace, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(repositoryRoot, file), target);
    }
    function run(stage, args) {
      const result = spawnSync("pnpm", args, {
        cwd: workspace,
        env: { ...process.env, SOLWYN_SURFACE_CANARY_FAMILY: cell.family },
        stdio: "inherit",
      });
      if (result.status === 0) return true;
      console.error(
        `${label}: ${stage} failed (${result.error?.message ?? result.signal ?? result.status})`,
      );
      failures.push(stage);
      return false;
    }

    if (
      run("install", ["install", "--frozen-lockfile"]) &&
      run("overlay", ["add", "--no-lockfile", "-D", ...cell.packages])
    ) {
      if (!readFileSync(join(workspace, "pnpm-lock.yaml")).equals(lockfile)) {
        failures.push("lockfile");
      } else {
        run("capture", [
          "tsx",
          "scripts/capture-surface-inventory.ts",
          "--check",
          "--family",
          cell.family,
          "--interval",
          cell.interval,
          "--output-dir",
          join(
            repositoryRoot,
            "build",
            "provider-surface-inventory",
            `${cell.family}-${cell.interval}`,
          ),
        ]);
      }
    }
    // Match the former always() canary step even when installation or capture failed.
    run("canary", ["vitest", "run", "tests/unit/surface-canary.test.ts"]);
  } catch (error) {
    failures.push(`setup: ${error.message}`);
  } finally {
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
    console.log("::endgroup::");
  }
  if (failures.length > 0) failed.push(`${label}: ${failures.join(", ")}`);
}

if (failed.length > 0) {
  console.error(`Failed provider surface intervals:\n${failed.join("\n")}`);
  process.exitCode = 1;
}
