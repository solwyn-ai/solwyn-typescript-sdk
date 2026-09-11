/** Build a package when needed; a supplied tarball is always tested unchanged. */
import { join } from "node:path";
import { runPackageConsumers } from "./verification/package-consumers.mjs";
import { runBoundedCommand } from "./verification/process.mjs";
import {
  cleanupTemporaryRoot,
  createTemporaryRoot,
  parseArguments,
  repositoryRoot,
  verificationEnv,
} from "./verification/support.mjs";

const root = repositoryRoot;
const env = verificationEnv();
let scratch;
let result;
try {
  const options = parseArguments(process.argv.slice(2), {
    requireOut: false,
    requireTarball: false,
  });
  scratch = createTemporaryRoot("solwyn-pack-", undefined, { env });
  if (!options.tarball) {
    const build = await runBoundedCommand("pnpm", ["build"], { cwd: root, env });
    process.stdout.write(build.stdout);
    process.stderr.write(build.stderr);
    if (build.error || build.status !== 0)
      throw new Error(`Build failed: ${build.error?.message ?? build.status}`);
    const pack = await runBoundedCommand(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: root, env },
    );
    process.stderr.write(pack.stderr);
    if (pack.error || pack.status !== 0)
      throw new Error(`Pack failed: ${pack.error?.message ?? pack.status}\n${pack.stdout}`);
    const packed = JSON.parse(pack.stdout);
    options.tarball = join(scratch, packed[0].filename);
  }
  options.out ??= scratch;
  result = await runPackageConsumers(options);
  if (result.status !== "pass") throw new Error("Package consumer verification failed");
} catch (error) {
  process.stderr.write(`[pack-smoke] FAIL ${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  if (scratch) {
    const cleanup = cleanupTemporaryRoot(scratch);
    if (cleanup.state === "cleanup-failed") {
      process.stderr.write(`[pack-smoke] cleanup failed: ${cleanup.error}\n`);
      process.exitCode = 1;
    } else if (cleanup.retained) process.stdout.write(`[pack-smoke] retained ${scratch}\n`);
  }
}
if (result?.status === "pass" && !process.exitCode)
  process.stdout.write(
    `[pack-smoke] PASS ${result.artifact.sha256} — four entries, strict ESM/CJS declarations, AI dispatch/settlement, identity, and isolation controls\n`,
  );
