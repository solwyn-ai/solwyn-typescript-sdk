/** Shared isolated-consumer workflow for runtime probes; no concrete-probe imports. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { classifyCommandFailure, runBoundedCommand } from "./process.mjs";
import {
  createReport,
  createTemporaryRoot,
  failureFor,
  finalizeReport,
  parseArguments,
  verificationEnv,
  writeReport,
} from "./support.mjs";

export const consumerEnv = verificationEnv();
for (const key of Object.keys(process.env))
  if (key.toUpperCase() === "NODE_PATH") delete process.env[key];

export function environmentError(message, cause) {
  const error = new Error(message, { cause });
  error.failure = failureFor(cause ?? error, { phase: "environment", kind: "prerequisite" });
  return error;
}

export async function commandResult(
  binary,
  args,
  cwd,
  timeout = 120000,
  evidence,
  { prerequisite = false } = {},
) {
  const record = {
    binary,
    args,
    cwd,
    state: "running",
    status: null,
    startedAt: new Date().toISOString(),
  };
  const save = () => {
    if (evidence) writeReport(evidence.file, evidence.report);
  };
  if (evidence) {
    evidence.report.details.commands ??= [];
    evidence.report.details.commands.push(record);
    save();
  }
  const result = await runBoundedCommand(binary, args, { cwd, env: consumerEnv, timeout });
  Object.assign(record, result, {
    state: "finished",
    error: result.error?.message,
    errorCode: result.error?.code,
  });
  let failure = classifyCommandFailure(binary, result);
  if (failure && prerequisite)
    failure = {
      ...failure,
      phase: "environment",
      kind: "prerequisite",
      artifactFailure: false,
      retryable: false,
    };
  if (failure && evidence) evidence.report.failure = failureFor({ failure });
  save();
  if (failure) {
    const error = new Error(
      `${binary} ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
    error.failure = failure;
    throw error;
  }
  return result;
}

export async function command(...args) {
  return (await commandResult(...args)).stdout;
}

function inside(parent, child) {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function installConsumer(tarball, label, dependencies = [], evidence) {
  assert.match(label, /^[a-z0-9-]+$/);
  const app = createTemporaryRoot(`solwyn-consumer-${label}-`, evidence.report);
  writeReport(evidence.file, evidence.report);
  fs.writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({ name: `solwyn-verification-${label}`, version: "1.0.0", private: true }),
  );
  await command(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--cache",
      path.join(app, "npm-cache"),
      tarball,
      ...dependencies,
    ],
    app,
    120000,
    evidence,
  );
  const req = createRequire(path.join(app, "package.json"));
  const sdkRoot = fs.realpathSync(path.dirname(req.resolve("@solwyn/sdk/package.json")));
  assert.ok(inside(app, sdkRoot), "SDK must resolve inside the isolated consumer");
  for (const dependency of dependencies) {
    const name = dependency.slice(0, dependency.lastIndexOf("@"));
    assert.ok(inside(app, req.resolve(name)), `${name} must resolve inside the isolated consumer`);
  }
  if (dependencies.length === 0)
    await command(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import path from "node:path";
    const consumerRequire = createRequire(path.join(process.cwd(), "package.json"));
    assert.deepEqual(Object.keys(process.env).filter(key => key.toUpperCase() === "NODE_PATH"), []);
    const manifest = consumerRequire("@solwyn/sdk/package.json");
    for (const peer of new Set(["openai", ...Object.keys(manifest.peerDependencies)])) {
      assert.throws(() => consumerRequire.resolve(peer), { code: "MODULE_NOT_FOUND" }, "Unexpected provider peer " + peer);
    }
  `,
      ],
      app,
      120000,
      evidence,
    );
  return { app, req, sdkRoot };
}

export async function runProbe(probe, body) {
  const options = parseArguments(process.argv.slice(2));
  const report = createReport({ probe, tarball: options.tarball });
  const file = path.join(options.out, `${probe}.json`);
  const evidence = { out: options.out, file, report };
  writeReport(file, report);
  try {
    await body(options, report, evidence);
    report.status = "pass";
  } catch (error) {
    report.details.error = error.stack ?? String(error);
    report.failure ??= failureFor(error);
  } finally {
    finalizeReport(report, file);
    if (report.status !== "pass") process.exitCode = 1;
    process.stdout.write(`${probe}: ${report.status}\n`);
    if (report.details.error) process.stderr.write(`${report.details.error}\n`);
  }
  return report;
}

export function assertEdgeResult(result) {
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    providerCalls: 2,
    checks: 4,
    confirms: 4,
    transmittedEvents: 4,
    uniqueCalls: 4,
    ingested: 4,
    legacyDedupCollisions: 0,
    unexpectedFetch: 0,
    ambientRunAbsent: true,
    nodeGlobalAbsent: true,
    bufferAbsent: true,
    coreClosed: { checks: 2, confirms: 2, ingested: 2 },
    warnings: [],
  });
}
