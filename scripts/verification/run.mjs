/** Execute every installed-artifact proof; missing and skipped results fail the gate. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPackageArtifactIdentityChecks, assertRuntimeChecks } from "./artifact-identity.mjs";
import { runBoundedCommand } from "./process.mjs";
import {
  assertReport,
  cleanupTemporaryRoot,
  createReport,
  createTemporaryRoot,
  failureFor,
  finalizeReport,
  parseArguments,
  sha256,
  verificationEnv,
  writeReport,
} from "./support.mjs";

const directory = fileURLToPath(new URL("./", import.meta.url));
const probes = [
  "package-consumers",
  "native-type-consumer",
  "ai-type-consumer",
  "bundle-proofs",
  "browser-proof",
  "runtime-matrix",
  "google-native-compat",
];
const env = verificationEnv();

function version(value, label) {
  assert.ok(
    typeof value === "string" && /^v?\d+\.\d+\.\d+/.test(value),
    `Missing ${label} version`,
  );
}

function assertEdgeResult(result) {
  assert.deepEqual(
    result,
    {
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
    },
    "Incomplete edge execution and settlement proof",
  );
}

async function validateChecks(probe, report, out) {
  const { versions, checks } = report;
  version(versions.node, "Node");
  if (probe === "package-consumers") {
    version(versions.sdk, "SDK");
    assertPackageArtifactIdentityChecks(checks.artifactIdentity, versions.sdk);
    version(versions.typescript, "TypeScript");
    version(versions.providers?.ai, "AI SDK");
    version(versions.providers?.aiOpenai, "AI SDK OpenAI provider");
    assert.deepEqual(checks.typeScriptLibraries, {
      positive: ["ES2023", "DOM", "ESNext.Disposable"],
      missingDisposableRejected: true,
    });
    const { assertReadmeAiConsumerChecks } = await import("./readme-consumer.mjs");
    assertReadmeAiConsumerChecks(checks.readmeAiTypes);
    assert.equal(versions.providers.ai, checks.readmeAiTypes.installedPackages.ai);
    assert.equal(
      versions.providers.aiOpenai,
      checks.readmeAiTypes.installedPackages["@ai-sdk/openai"],
    );
    assert.equal(checks.inventory?.verified, true, "Missing package inventory proof");
    assert.equal(checks.inventory.actualCount, 88);
    for (const format of ["esm", "cjs"]) {
      const cell = checks.runtime?.find((cell) => cell.format === format);
      assert.ok(cell, `Missing ${format} package runtime`);
      for (const field of ["dispatches", "checks", "confirms", "ingested"])
        assert.equal(cell[field], 3);
      assert.equal(cell.aiBuffered, true);
      assert.equal(cell.aiStreaming, true);
    }
    for (const field of [
      "openaiCannotResolve",
      "missingExportRejected",
      "reviewedArtifactUnchanged",
    ])
      assert.equal(checks.negativeControls?.[field], true, `Missing ${field} control`);
    assert.equal(checks.aiDependencyLock?.unchanged, true);
    assert.equal(
      checks.aiDependencyLock?.exactTree,
      true,
      "Missing exact installed dependency-tree proof",
    );
    assert.equal(
      checks.aiDependencyLock.sha256,
      sha256(path.join(out, "ai-smoke-package-lock.json")),
    );
  } else if (probe === "native-type-consumer" || probe === "ai-type-consumer") {
    if (probe === "ai-type-consumer") {
      const diagnostic = checks.upstreamBaselineDiagnostic;
      assert.ok(diagnostic, "Missing upstream TypeScript 5.7 diagnostic proof");
      assert.deepEqual(diagnostic.compiler, { label: "diagnostic", version: "5.7.3" });
      assert.equal(versions.typescript?.diagnostic, diagnostic.compiler.version);
      assert.equal(diagnostic.format, "cjs");
      assert.equal(diagnostic.expected, "upstream-invalid");
      assert.equal(diagnostic.status, "upstream-invalid");
      const command = diagnostic.command;
      assert.ok(
        command && Number.isInteger(command.status) && command.status > 0,
        "Upstream diagnostic must have a nonzero compiler exit",
      );
      assert.ok(
        !command.error && !command.signal && !command.timedOut,
        "Upstream diagnostic runner did not complete normally",
      );
      assert.match(
        `${command.stdout}\n${command.stderr}`,
        /\bTS1479\b/,
        "Unexpected upstream diagnostic identity",
      );
    }
    const peers =
      probe === "native-type-consumer"
        ? ["openai", "anthropic", "zod"]
        : ["ai", "typesJsonSchema", "typesNode", "zod"];
    for (const peer of peers) version(versions[peer], peer);
    assert.equal(checks.strict, true);
    assert.equal(checks.skipLibCheck, false);
    assert.equal(
      checks.cells?.length,
      4,
      "Compiler matrix must include both formats at floor/current",
    );
    for (const label of ["floor", "current"]) {
      version(versions.typescript?.[label], `${label} TypeScript`);
      for (const format of ["esm", "cjs"]) {
        const cell = checks.cells.find(
          (cell) => cell.compiler?.label === label && cell.format === format,
        );
        assert.ok(cell, `Missing ${label} ${format} compiler cell`);
        assert.equal(cell.compiler.version, versions.typescript[label]);
        if (probe === "native-type-consumer") {
          const extension = format === "esm" ? "mts" : "cts";
          assert.deepEqual(
            cell.files,
            [`consumer.${extension}`, `responses-consumer.${extension}`],
            `Missing ${label} ${format} native/Responses fixture coverage`,
          );
        }
        if (probe === "ai-type-consumer") {
          assert.equal(cell.strict, true);
          assert.equal(cell.skipLibCheck, false);
        }
        assert.equal(cell.status, "pass");
        const commands =
          probe === "native-type-consumer"
            ? [cell.command]
            : [cell.baseline, cell.sdk, cell.inference];
        for (const command of commands)
          assert.equal(command?.status, 0, "Missing successful compiler evidence");
      }
    }
  } else if (probe === "bundle-proofs") {
    version(versions.esbuild, "esbuild");
    const expectedLabels = [];
    for (const format of ["esm", "cjs"])
      for (const usage of [
        "node-reexport",
        "node-bare-import",
        "node-run-used",
        "core-explicit-close",
      ])
        for (const ignoreAnnotations of [false, true]) {
          const label = `${format}-${usage}-${ignoreAnnotations ? "ignore-annotations" : "default"}`;
          expectedLabels.push(label);
          const cell = checks.nodeControls?.find((cell) => cell.label === label);
          assert.ok(cell, `Missing bundle control ${label}`);
          assert.equal(cell.format, format, `Wrong format for ${label}`);
          assert.equal(
            cell.ignoreAnnotations,
            ignoreAnnotations,
            `Wrong annotation mode for ${label}`,
          );
          assert.equal(cell.status, 0, `Failed bundle control ${label}`);
          assert.deepEqual(
            cell.result,
            {
              dispatched: 1,
              registration: usage === "core-explicit-close" ? "undefined" : "function",
              checks: 1,
              confirms: 1,
              ingested: 1,
            },
            `Incomplete registration/settlement proof for ${label}`,
          );
          assert.deepEqual(cell.warnings, [], `Unexpected warnings for ${label}`);
        }
    assert.deepEqual(
      checks.nodeControls.map((cell) => cell.label).sort(),
      expectedLabels.sort(),
      "Bundle controls must be the exact reviewed 16 labels",
    );
    assertEdgeResult(checks.edgeVm);
    assert.equal(checks.bundleSha256, sha256(path.join(out, "edge-browser-bundle.js")));
    assert.equal(checks.bundlePath, path.join(out, "edge-browser-bundle.js"));
    assert.deepEqual(checks.externalImports, []);
  } else if (probe === "browser-proof") {
    assert.ok(
      typeof versions.browser === "string" && versions.browser.length > 0,
      "Missing browser version",
    );
    assertEdgeResult(checks.result);
    assert.ok(path.isAbsolute(checks.execution?.browser ?? ""), "Missing browser executable");
    assert.deepEqual(
      checks.execution.exit,
      { code: 0, signal: null },
      "Browser did not exit cleanly",
    );
    const cleanup = checks.supervisorCleanup;
    assert.ok(
      cleanup && ["owned-supervisor-group", "taskkill-supervisor-tree"].includes(cleanup.method),
      "Missing owned browser teardown",
    );
    assert.equal(cleanup.attempted, true);
    assert.equal(cleanup.completed, cleanup.method === "taskkill-supervisor-tree" ? true : null);
    assert.equal(cleanup.cleanupTimedOut, false);
    assert.equal(cleanup.error, null);
    assert.equal(cleanup.detached, false);
    assert.equal(checks.stderr?.limitBytes, 1048576);
    assert.ok(
      Number.isInteger(checks.stderr.receivedBytes) &&
        checks.stderr.receivedBytes >= 0 &&
        checks.stderr.receivedBytes <= 1048576,
    );
    assert.equal(checks.stderr.retainedBytes, checks.stderr.receivedBytes);
    assert.equal(checks.stderr.truncated, false);
    assert.equal(checks.bundleSha256, sha256(path.join(out, "edge-browser-bundle.js")));
  } else if (probe === "runtime-matrix") {
    version(versions.sdk, "SDK");
    assertRuntimeChecks(checks, versions.sdk);
    version(versions.anthropic, "Anthropic");
    assert.deepEqual(
      versions.aws,
      { "client-bedrock": "3.1124.0", "client-s3": "3.1124.0" },
      "Missing reviewed foreign AWS versions",
    );
    const binaries = process.env.SOLWYN_VERIFICATION_NODE_BINARIES
      ? JSON.parse(process.env.SOLWYN_VERIFICATION_NODE_BINARIES)
      : [process.execPath];
    assert.ok(Array.isArray(checks.runtimes));
    assert.deepEqual(
      checks.runtimes.map((runtime) => runtime.binary),
      binaries,
      "Runtime evidence differs from configured Node executables",
    );
    for (const runtime of checks.runtimes) {
      version(runtime.version, "matrix Node");
      for (const name of [
        "provider-free-runtime",
        "mixed-format-enforcement-identity",
        "native-anthropic-promise",
        "native-foreign-aws",
        "post-remediation-errors",
      ])
        for (const format of ["esm", "cjs"]) {
          const cell = checks.cells?.find(
            (cell) =>
              cell.binary === runtime.binary && cell.name === name && cell.format === format,
          );
          assert.ok(cell, `Missing ${name} ${format} for ${runtime.binary}`);
          assert.equal(cell.version, runtime.version);
          assert.equal(cell.status, 0);
          if (name === "native-foreign-aws") {
            assert.equal(cell.result?.requests, 0, "Foreign AWS clients must dispatch no requests");
            assert.deepEqual(cell.result.results, [
              { format, family: "bedrock-control", rejected: true },
              { format, family: "bedrock-control-subclass", rejected: true },
              { format, family: "s3", rejected: true },
              { format, family: "s3-subclass", rejected: true },
            ]);
          } else if (name === "post-remediation-errors") {
            assert.deepEqual(cell.result, {
              families: 11,
              denied: 8,
              stopped: 8,
              middlewareDenied: 2,
            });
          }
        }
    }
  } else if (probe === "google-native-compat") {
    assert.deepEqual(versions.google, ["0.3.1", "2.20.0"]);
    assert.equal(checks.noLiveCalls, true);
    assert.equal(checks.controls?.length, 16, "Missing Google lifecycle controls");
    const expectedKeys = [];
    for (const [providerVersion, metadata] of [
      ["0.3.1", "native"],
      ["2.20.0", "native"],
      ["2.20.0", "unknown"],
    ])
      for (const scenario of [
        "buffered",
        "embeddings",
        "stream-return",
        "deadline",
        "caller-abort",
      ]) {
        const key = `${providerVersion}/${metadata}/${scenario}`;
        expectedKeys.push(key);
        const cell = checks.controls.find(
          (cell) =>
            cell.version === providerVersion &&
            cell.metadata === metadata &&
            cell.scenario === scenario,
        );
        const aborted = scenario === "deadline" || scenario === "caller-abort";
        assert.deepEqual(
          cell,
          {
            version: providerVersion,
            metadata,
            scenario,
            providerRequests: 1,
            observedSignal: true,
            outcome: aborted ? "rejected" : "fulfilled",
            transportAborted: aborted,
            pendingProviderTimersAfterClose:
              aborted || (providerVersion === "2.20.0" && metadata === "native") ? 0 : 1,
            referencedProviderTimersAfterClose: aborted || providerVersion === "2.20.0" ? 0 : 1,
            pendingProviderTimersAfterNativeDeadline: 0,
            nativeAbortedAtCallerAbort:
              scenario === "caller-abort" ? providerVersion !== "0.3.1" : null,
            streamReaderReleased: scenario === "stream-return" ? true : null,
          },
          `Incomplete Google lifecycle proof ${key}`,
        );
      }
    expectedKeys.push("2.20.0/native/completed-run-gc");
    assert.deepEqual(
      checks.controls.find((cell) => cell.scenario === "completed-run-gc"),
      {
        version: "2.20.0",
        metadata: "native",
        scenario: "completed-run-gc",
        retainedSettledPromise: true,
        clientStillOpenAtRetirement: true,
        leaseSurrendersBeforeClose: 1,
        providerDeadlineSeconds: 600,
        leaseGrants: 1,
        spentTokens: 0,
      },
      "Incomplete completed-run GC proof",
    );
    assert.deepEqual(
      checks.controls.map((cell) => `${cell.version}/${cell.metadata}/${cell.scenario}`).sort(),
      expectedKeys.sort(),
      "Google controls must be the exact reviewed lifecycle matrix",
    );
  } else {
    assert.fail(`Unknown probe: ${probe}`);
  }
}
try {
  const { tarball, out } = parseArguments(process.argv.slice(2));
  const result = createReport({
    probe: "verification",
    tarball,
    versions: { driverBinary: process.execPath },
    details: { probes: [] },
    env,
  });
  const resultFile = path.join(out, "results.json");
  const save = () => writeReport(resultFile, result);
  save();
  for (const probe of probes) {
    const output = path.join(out, `${probe}.json`);
    // A previous successful run must never hide a missing result from this invocation.
    if (fs.existsSync(output)) fs.unlinkSync(output);
    if (probe === "bundle-proofs") {
      const browserBundle = path.join(out, "edge-browser-bundle.js");
      if (fs.existsSync(browserBundle)) fs.unlinkSync(browserBundle);
    }
    const args = [
      ...(probe === "google-native-compat" ? ["--expose-gc"] : []),
      path.join(directory, `${probe}.mjs`),
      "--tarball",
      tarball,
      "--out",
      out,
    ];
    const temporaryRoot = createTemporaryRoot(`solwyn-verification-${probe}-`, result, {
      env: { ...env, SOLWYN_VERIFICATION_TEMP_ROOT: undefined },
    });
    save();
    process.stdout.write(`[consumers] ${probe}\n`);
    const child = await runBoundedCommand(process.execPath, args, {
      cwd: out,
      env: { ...env, SOLWYN_VERIFICATION_TEMP_ROOT: temporaryRoot },
      encoding: "utf8",
      timeout: 900_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const entry = {
      probe,
      status: "fail",
      command: {
        binary: process.execPath,
        args,
        status: child.status,
        signal: child.signal,
        error: child.error?.message,
        errorCode: child.error?.code,
        timedOut: child.timedOut,
        elapsedMs: child.elapsedMs,
        timeoutMs: child.timeoutMs,
        termination: child.termination,
      },
      stdout: child.stdout,
      stderr: child.stderr,
    };
    try {
      assert.ok(!child.error, child.error?.message);
      assert.equal(child.status, 0, `${probe} exited ${child.status}`);
      const report = JSON.parse(fs.readFileSync(output, "utf8"));
      assertReport(report, { probe, artifact: result.artifact });
      assert.equal(report.status, "pass", "Skipped or failed probe is not accepted");
      await validateChecks(probe, report, out);
      entry.status = "pass";
      entry.result = report;
    } catch (error) {
      entry.error = error.message;
      entry.failure = failureFor(error, { phase: "probe", kind: "invalid-evidence" });
      if (fs.existsSync(output)) {
        try {
          entry.result = JSON.parse(fs.readFileSync(output, "utf8"));
        } catch {
          /* Preserve the failed result diagnostic. */
        }
      }
    }
    entry.consumerCleanup = {
      ...cleanupTemporaryRoot(temporaryRoot),
      keepRequested: result.cleanup.keepRequested,
    };
    if (entry.consumerCleanup.state === "cleanup-failed") entry.status = "fail";
    let primaryFailure;
    try {
      assertReport(entry.result, { probe, artifact: result.artifact });
      result.versions[probe] = entry.result.versions;
      primaryFailure = entry.result.failure;
    } catch {
      /* Malformed reports cannot supply canonical failure classification. */
    }
    if (primaryFailure) entry.failure = primaryFailure;
    else if (child.timedOut)
      entry.failure = {
        phase: "probe",
        kind: "timeout",
        retryable: true,
        artifactFailure: false,
        errorCode: child.error?.code ?? null,
      };
    result.details.probes.push(entry);
    save();
    process.stdout.write(`[consumers] ${probe}: ${entry.status}\n`);
  }
  assert.equal(
    sha256(tarball),
    result.artifact.sha256,
    "Reviewed artifact changed during verification",
  );
  result.checks.probes = result.details.probes.map(({ probe, status }) => ({ probe, status }));
  result.status = result.details.probes.every((probe) => probe.status === "pass") ? "pass" : "fail";
  if (result.status === "fail")
    result.failure = {
      phase: "probe",
      kind: "aggregate-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: null,
    };
  finalizeReport(result, resultFile);
  if (result.status !== "pass") process.exitCode = 1;
  process.stdout.write(`[consumers] ${result.status}: ${path.join(out, "results.json")}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
