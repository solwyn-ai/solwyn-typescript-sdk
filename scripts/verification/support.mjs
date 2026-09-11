/** Canonical verification contract and exact-resource lifecycle; never imports a concrete probe. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shutdownSupervisors } from "./process.mjs";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownedRoots = new Map();
const reportFiles = new Map();
const interruptedRemovalRoots = new Set();
let signalStarted;
let signalsInstalled = false;
const signalHandlers = new Map();

export function verificationEnv(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => key.toUpperCase() !== "NODE_PATH"),
  );
}

export function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function parseArguments(args, { requireOut = true, requireTarball = true } = {}) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--") continue;
    const flag = args[index];
    assert.ok(flag === "--tarball" || flag === "--out", `Unknown argument: ${flag}`);
    const value = args[++index];
    assert.ok(value && path.isAbsolute(value), `${flag} requires an absolute path`);
    const key = flag.slice(2);
    assert.ok(!options[key], `Duplicate argument: ${flag}`);
    options[key] = value;
  }
  assert.ok(!requireTarball || options.tarball, "--tarball is required");
  assert.ok(!requireOut || options.out, "--out is required");
  if (options.tarball) {
    assert.ok(fs.statSync(options.tarball).isFile(), "Tarball must be a file");
    options.tarball = fs.realpathSync(options.tarball);
  }
  if (options.out) {
    fs.mkdirSync(options.out, { recursive: true });
    options.out = fs.realpathSync(options.out);
    const relative = path.relative(fs.realpathSync(repositoryRoot), options.out);
    assert.ok(
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
      "--out must be outside the repository",
    );
  }
  return options;
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function assertFailure(failure) {
  if (failure === null) return;
  assert.ok(object(failure), "Failure must be null or a structured object");
  for (const field of ["phase", "kind"])
    assert.ok(typeof failure[field] === "string" && failure[field], `Missing failure ${field}`);
  for (const field of ["retryable", "artifactFailure"])
    assert.equal(typeof failure[field], "boolean", `Missing failure ${field}`);
  assert.ok(
    failure.errorCode === null || typeof failure.errorCode === "string",
    "Missing failure errorCode",
  );
}

export function assertReport(report, { probe, artifact } = {}) {
  assert.ok(object(report), "Report must be an object");
  assert.equal(report.schemaVersion, 1, "Unknown or missing report schemaVersion");
  assert.ok(
    typeof report.probe === "string" && /^[a-z][a-z0-9-]*$/.test(report.probe),
    "Missing report probe",
  );
  if (probe !== undefined) assert.equal(report.probe, probe, "Probe name mismatch");
  assert.ok(report.status === "pass" || report.status === "fail", "Unknown report status");
  assert.ok(
    object(report.artifact) && path.isAbsolute(report.artifact.path ?? ""),
    "Artifact path must be absolute",
  );
  assert.match(report.artifact.sha256 ?? "", /^[a-f0-9]{64}$/, "Invalid artifact SHA-256");
  if (artifact !== undefined)
    assert.deepEqual(report.artifact, artifact, "Report identifies a different artifact");
  assert.ok(
    object(report.versions) && typeof report.versions.node === "string" && report.versions.node,
    "Missing Node version",
  );
  assert.ok(object(report.details), "Missing diagnostic details");
  assert.ok(object(report.checks), "Missing canonical checks");
  assertFailure(report.failure);
  assert.ok(object(report.cleanup), "Missing cleanup");
  assert.equal(typeof report.cleanup.keepRequested, "boolean", "Missing cleanup retention policy");
  assert.ok(Array.isArray(report.cleanup.roots), "Missing cleanup roots");
  assertFailure(report.cleanup.failure);
  for (const root of report.cleanup.roots) {
    assert.ok(object(root) && path.isAbsolute(root.path ?? ""), "Cleanup root must be absolute");
    assert.ok(
      ["created", "removed", "retained", "cleanup-failed"].includes(root.state),
      "Unknown cleanup root state",
    );
    assert.equal(typeof root.retained, "boolean", "Missing observed cleanup retention");
    if (root.state === "removed")
      assert.equal(root.retained, false, "Removed root cannot be retained");
    if (root.state === "retained")
      assert.ok(root.retained && report.cleanup.keepRequested, "Retention requires SMOKE_KEEP");
    if (report.status === "pass")
      assert.ok(
        root.state === "removed" || root.state === "retained",
        "Successful report has incomplete cleanup",
      );
  }
  if (report.status === "pass") {
    assert.equal(report.failure, null, "Successful report has a primary failure");
    assert.equal(report.cleanup.failure, null, "Successful report has a cleanup failure");
  }
  return report;
}

export function failureFor(error, { phase = "verification", kind } = {}) {
  if (error?.failure) return { ...error.failure, errorCode: error.failure.errorCode ?? null };
  return {
    phase,
    kind: kind ?? (error?.code === "ERR_ASSERTION" ? "assertion" : "runner-error"),
    retryable: false,
    artifactFailure: phase === "verification" && error?.code === "ERR_ASSERTION",
    errorCode: error?.code ?? null,
  };
}

export function createReport({ probe, tarball, versions = {}, details = {}, env = process.env }) {
  installSignalLifecycle();
  const report = {
    schemaVersion: 1,
    probe,
    status: "fail",
    artifact: { path: fs.realpathSync(tarball), sha256: sha256(tarball) },
    versions: { node: process.version, ...versions },
    checks: {},
    details,
    failure: null,
    cleanup: { keepRequested: env.SMOKE_KEEP === "1", roots: [], failure: null },
  };
  return assertReport(report);
}

export function writeReport(file, report) {
  assert.ok(path.isAbsolute(file), "Report filename must be absolute");
  file = canonicalDestination(file);
  if (signalStarted && reportDestinationWillBeRemoved(file)) {
    markReportInterrupted(report);
    reportFiles.delete(report);
    return;
  }
  assertReport(report);
  reportFiles.set(report, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

function canonicalDestination(file) {
  let directory = path.dirname(file);
  const suffix = [path.basename(file)];
  for (;;) {
    try {
      return path.join(fs.realpathSync(directory), ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(directory);
      assert.notEqual(parent, directory, "Report destination has no existing ancestor");
      suffix.push(path.basename(directory));
      directory = parent;
    }
  }
}

function reportDestinationWillBeRemoved(file) {
  return [...interruptedRemovalRoots].some((root) => {
    const relative = path.relative(root, file);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  });
}

export function createTemporaryRoot(prefix, report, { env = process.env } = {}) {
  installSignalLifecycle();
  assert.ok(!signalStarted, "Verification lifecycle is shutting down");
  assert.match(prefix, /^[a-z0-9-]+-$/, "Temporary prefix must be a simple directory prefix");
  const requested = env.SOLWYN_VERIFICATION_TEMP_ROOT ?? tmpdir();
  assert.ok(path.isAbsolute(requested), "SOLWYN_VERIFICATION_TEMP_ROOT must be absolute");
  const parent = fs.realpathSync(requested);
  assert.ok(fs.statSync(parent).isDirectory(), "Temporary parent must be a directory");
  const root = fs.mkdtempSync(path.join(parent, prefix));
  const record = { path: root, state: "created", retained: true };
  ownedRoots.set(root, {
    parent,
    report,
    record,
    keep: report?.cleanup.keepRequested ?? env.SMOKE_KEEP === "1",
    finished: false,
  });
  if (report) report.cleanup.roots.push(record);
  return root;
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function validateOwnedRoot(root, owned) {
  assert.ok(owned, "Cannot clean an unregistered temporary root");
  if (!exists(root)) return false;
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Owned temporary root was replaced");
  assert.equal(
    fs.realpathSync(root),
    path.join(owned.parent, path.basename(root)),
    "Owned temporary root moved outside its parent",
  );
  return true;
}

function finishCleanup(root, owned, error) {
  const retained = exists(root);
  if (!error && !owned.keep && retained) error = new Error("Temporary root survived cleanup");
  Object.assign(owned.record, {
    state: error ? "cleanup-failed" : owned.keep && retained ? "retained" : "removed",
    retained,
  });
  if (error) {
    const failure = failureFor(error, { phase: "cleanup" });
    Object.assign(owned.record, { error: error.message, failure });
    if (owned.report) {
      owned.report.status = "fail";
      owned.report.cleanup.failure ??= failure;
    }
  }
  owned.finished = !error;
  return owned.record;
}

export function cleanupTemporaryRoot(root) {
  const owned = ownedRoots.get(root);
  assert.ok(owned, "Cannot clean an unregistered temporary root");
  if (owned.finished) return owned.record;
  let failure;
  try {
    if (validateOwnedRoot(root, owned) && !owned.keep)
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    failure = error;
  }
  return finishCleanup(root, owned, failure);
}

export function finalizeReport(report, file) {
  try {
    assert.equal(
      sha256(report.artifact.path),
      report.artifact.sha256,
      "Reviewed artifact changed during verification",
    );
  } catch (error) {
    report.status = "fail";
    report.failure ??= failureFor(error);
    report.details.error ??= error.stack ?? String(error);
  }
  for (const [root, owned] of ownedRoots) if (owned.report === report) cleanupTemporaryRoot(root);
  if (report.failure || report.cleanup.failure) report.status = "fail";
  try {
    writeReport(file, report);
  } finally {
    // Final reports are no longer interruption writers: their containing scratch may be removed.
    reportFiles.delete(report);
  }
  return report;
}

function preserveSignal(signal) {
  for (const [name, handler] of signalHandlers) process.removeListener(name, handler);
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
}

function markReportInterrupted(report) {
  report.status = "fail";
  report.failure ??= {
    phase: "signal",
    kind: "interrupted",
    retryable: true,
    artifactFailure: false,
    errorCode: signalStarted,
  };
}

function persistInterruptedReports() {
  for (const [report, file] of reportFiles) {
    markReportInterrupted(report);
    try {
      writeReport(file, report);
    } catch {
      /* Preserve signal semantics if evidence cannot be written. */
    }
  }
}

async function interrupt(signal) {
  if (signalStarted) {
    markUnfinishedCleanup("interrupted", signal, "Cleanup interrupted by a second signal");
    persistInterruptedReports();
    preserveSignal(signalStarted);
    return;
  }
  signalStarted = signal;
  // Mark destinations before stopping anchors: their awaiting callers may run finalizers then.
  for (const [root, owned] of ownedRoots) if (!owned.keep) interruptedRemovalRoots.add(root);
  for (const [report, file] of reportFiles)
    if (reportDestinationWillBeRemoved(file)) {
      markReportInterrupted(report);
      reportFiles.delete(report);
    }
  const deadline = setTimeout(() => {
    markUnfinishedCleanup(
      "timeout",
      "ETIMEDOUT",
      "Signal cleanup exceeded its 2000 ms total bound",
    );
    persistInterruptedReports();
    preserveSignal(signal);
  }, 2000);
  persistInterruptedReports();
  try {
    await shutdownSupervisors();
    await Promise.all(
      [...ownedRoots]
        .filter(([, owned]) => !owned.finished)
        .map(async ([root, owned]) => {
          let failure;
          try {
            if (validateOwnedRoot(root, owned) && !owned.keep)
              await fs.promises.rm(root, {
                recursive: true,
                force: true,
                maxRetries: 3,
                retryDelay: 100,
              });
          } catch (error) {
            failure = error;
          }
          finishCleanup(root, owned, failure);
        }),
    );
    persistInterruptedReports();
  } finally {
    clearTimeout(deadline);
    preserveSignal(signal);
  }
}

function markUnfinishedCleanup(kind, errorCode, message) {
  const error = Object.assign(new Error(message), {
    failure: { phase: "cleanup", kind, retryable: false, artifactFailure: false, errorCode },
  });
  for (const [root, owned] of ownedRoots) if (!owned.finished) finishCleanup(root, owned, error);
}

function installSignalLifecycle() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      void interrupt(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}
