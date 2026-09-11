import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const edge = {
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
};
const bundle = {
  nodeControls: ["esm", "cjs"].flatMap((format) =>
    ["node-reexport", "node-bare-import", "node-run-used", "core-explicit-close"].flatMap((name) =>
      [false, true].map((ignoreAnnotations) => ({
        label: `${format}-${name}-${ignoreAnnotations ? "ignore-annotations" : "default"}`,
        format,
        ignoreAnnotations,
        status: 0,
        result: {
          dispatched: 1,
          registration: name === "core-explicit-close" ? "undefined" : "function",
          checks: 1,
          confirms: 1,
          ingested: 1,
        },
        warnings: [],
      })),
    ),
  ),
  edgeVm: edge,
  bundleSha256: "a".repeat(64),
  bundlePath: "/tmp/edge-browser-bundle.js",
  externalImports: [],
};
const google = {
  noLiveCalls: true,
  controls: [
    ...[
      { version: "0.3.1", metadata: "native", pending: 1, referenced: 1 },
      { version: "2.20.0", metadata: "native", pending: 0, referenced: 0 },
      { version: "2.20.0", metadata: "unknown", pending: 1, referenced: 0 },
    ].flatMap(({ version, metadata, pending, referenced }) =>
      ["buffered", "embeddings", "stream-return", "deadline", "caller-abort"].map((scenario) => {
        const aborted = ["deadline", "caller-abort"].includes(scenario);
        return {
          version,
          metadata,
          scenario,
          providerRequests: 1,
          observedSignal: true,
          outcome: aborted ? "rejected" : "fulfilled",
          transportAborted: aborted,
          nativeAbortedAtCallerAbort: scenario === "caller-abort" ? version !== "0.3.1" : null,
          pendingProviderTimersAfterClose: aborted ? 0 : pending,
          referencedProviderTimersAfterClose: aborted ? 0 : referenced,
          streamReaderReleased: scenario === "stream-return" ? true : null,
          pendingProviderTimersAfterNativeDeadline: 0,
        };
      }),
    ),
    {
      version: "2.20.0",
      metadata: "native",
      scenario: "completed-run-gc",
      retainedSettledPromise: true,
      clientStillOpenAtRetirement: true,
      leaseSurrendersBeforeClose: 1,
      leaseGrants: 1,
      spentTokens: 0,
      providerDeadlineSeconds: 600,
    },
  ],
};
const runtimes = [
  { binary: "/tmp/node20", version: "v20.10.0" },
  { binary: "/tmp/node22", version: "v22.23.1" },
  { binary: "/tmp/node24", version: "v24.11.1" },
];
const sdkVersion = "7.6.5";
const allSdkEntries = [
  "@solwyn/sdk",
  "@solwyn/sdk/node",
  "@solwyn/sdk/testing",
  "@solwyn/sdk/ai-sdk",
];
const artifactEntries = {
  "provider-free-runtime": allSdkEntries,
  "mixed-format-enforcement-identity": allSdkEntries,
  "native-anthropic-promise": ["@solwyn/sdk", "@solwyn/sdk/testing"],
  "native-foreign-aws": ["@solwyn/sdk"],
  "post-remediation-errors": allSdkEntries,
};
function observedIdentity(format: string, entries: string[], consumer: string) {
  const consumerRealpath = path.resolve(
    path.parse(process.cwd()).root,
    "runtime-identity",
    consumer,
  );
  const packageRoot = path.join(consumerRealpath, "node_modules/@solwyn/sdk");
  return {
    format,
    version: sdkVersion,
    manifestWithinConsumer: true,
    consumerRealpath,
    manifestRealpath: path.join(packageRoot, "package.json"),
    entries,
    entryRealpaths: Object.fromEntries(
      entries.map((entry, index) => [
        entry,
        path.join(packageRoot, "dist", `${index}.${format === "esm" ? "js" : "cjs"}`),
      ]),
    ),
    versions: Object.fromEntries(
      entries
        .filter((entry) => entry === "@solwyn/sdk" || entry === "@solwyn/sdk/node")
        .map((entry) => [entry, sdkVersion]),
    ),
  };
}
const runtime = {
  runtimes,
  artifactIdentity: observedIdentity("esm", allSdkEntries, "provider-free"),
  cells: runtimes.flatMap(({ binary, version }) =>
    ["esm", "cjs"].flatMap((format) =>
      [
        {
          name: "provider-free-runtime",
          result: {
            format,
            dispatched: 1,
            check: 1,
            confirm: 1,
            ingest: 1,
            attributed: true,
            aiRuntimeWithoutPeer: true,
          },
        },
        {
          name: "mixed-format-enforcement-identity",
          result: {
            firstFormat: format,
            denied: 6,
            dispatches: 0,
            checks: 6,
            ingested: 6,
            sharedBrands: true,
          },
        },
        {
          name: "native-anthropic-promise",
          result: { format, dispatches: 1, confirms: 1, ingested: 1, ordinaryPromise: true },
        },
        {
          name: "native-foreign-aws",
          result: {
            results: ["bedrock-control", "bedrock-control-subclass", "s3", "s3-subclass"].map(
              (family) => ({ format, family, rejected: true }),
            ),
            requests: 0,
            network: "none; constructors and synchronous detection only",
          },
        },
        {
          name: "post-remediation-errors",
          result: { families: 11, denied: 8, stopped: 8, middlewareDenied: 2 },
        },
      ].map((cell) => ({
        binary,
        version,
        format,
        status: 0,
        artifactIdentity: observedIdentity(
          format,
          artifactEntries[cell.name as keyof typeof artifactEntries],
          cell.name.startsWith("native-") ? "native" : "provider-free",
        ),
        ...cell,
      })),
    ),
  ),
};
const browser = {
  bundleSha256: "a".repeat(64),
  result: edge,
  execution: { browser: "/tmp/chrome", exit: { code: 0, signal: null } },
  supervisorCleanup: {
    method: "owned-supervisor-group",
    attempted: true,
    completed: null,
    cleanupTimedOut: false,
    error: null,
    detached: false,
  },
  stderr: { limitBytes: 1048576, receivedBytes: 10, retainedBytes: 10, truncated: false },
};

const contracts = [
  {
    probe: "bundle-proofs",
    validator: "assertBundleChecks",
    checks: bundle,
    mutations: [
      "checks.nodeControls.pop()",
      "checks.nodeControls[1]=checks.nodeControls[0]",
      "checks.nodeControls[0].result.checks=0",
      "checks.nodeControls[0].format='cjs'",
      "checks.edgeVm.providerCalls=0",
      "checks.edgeVm.coreClosed.confirms=0",
      "checks.edgeVm.ambientRunAbsent=false",
      "checks.externalImports.push('node:fs')",
      "checks.bundleSha256='missing'",
    ],
  },
  {
    probe: "google-native-compat",
    validator: "assertGoogleChecks",
    checks: google,
    mutations: [
      "checks.controls.pop()",
      "checks.controls[1]=checks.controls[0]",
      "checks.controls[0].providerRequests=0",
      "checks.controls[0].observedSignal=false",
      "checks.controls[0].outcome='rejected'",
      "checks.controls[3].transportAborted=false",
      "checks.controls[4].nativeAbortedAtCallerAbort=true",
      "checks.controls[2].streamReaderReleased=false",
      "checks.controls[0].pendingProviderTimersAfterClose=0",
      "checks.controls[10].referencedProviderTimersAfterClose=1",
      "checks.controls[3].pendingProviderTimersAfterNativeDeadline=1",
      "checks.controls[15].leaseGrants=0",
      "checks.controls[15].spentTokens=1",
      "checks.controls[15].clientStillOpenAtRetirement=false",
      "checks.noLiveCalls=false",
    ],
  },
  {
    probe: "runtime-matrix",
    owner: "artifact-identity",
    validator: "assertRuntimeChecks",
    checks: runtime,
    mutations: [
      "checks.cells.pop()",
      "checks.cells[1]=checks.cells[0]",
      "checks.cells[0].result.attributed=false",
      "checks.cells[1].result.dispatches=1",
      "checks.cells[2].result.ordinaryPromise=false",
      "checks.cells[3].result.results[0].rejected=false",
      "checks.cells[4].result.stopped=0",
      "checks.cells[0].status=1",
      "checks.cells[0].version='v99.0.0'",
      "checks.artifactIdentity.version='7.6.4'",
      "checks.cells[0].artifactIdentity.manifestWithinConsumer=false",
      "checks.cells[1].artifactIdentity.entries.pop()",
      "checks.cells[2].artifactIdentity.versions['@solwyn/sdk']='7.6.4'",
      "checks.cells[3].artifactIdentity.entryRealpaths['@solwyn/sdk']='/outside/index.cjs'",
    ],
  },
  {
    probe: "browser-proof",
    validator: "assertBrowserChecks",
    checks: browser,
    mutations: [
      "checks.execution.exit.code=1",
      "checks.execution.browser='relative'",
      "checks.result.nodeGlobalAbsent=false",
      "checks.supervisorCleanup.attempted=false",
      "checks.supervisorCleanup.detached=true",
      "checks.supervisorCleanup.method='unknown'",
      "checks.supervisorCleanup.method='taskkill-supervisor-tree';checks.supervisorCleanup.completed=false",
      "checks.supervisorCleanup.cleanupTimedOut=true",
      "checks.stderr.retainedBytes=1048577",
      "checks.stderr.truncated=true",
    ],
  },
];

for (const contract of contracts) {
  const cases = ["", ...contract.mutations];
  it.each(cases)(`${contract.probe} rejects semantic mutation %s`, (mutation) => {
    const module = new URL(
      `../../scripts/verification/${contract.owner ?? contract.probe}.mjs`,
      import.meta.url,
    ).href;
    const code = `import * as probe from ${JSON.stringify(module)};const checks=${JSON.stringify(contract.checks)};${mutation};probe.${contract.validator}(checks);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (mutation) expect(result.status, result.stderr).toBe(1);
    else expect(result.status, result.stderr).toBe(0);
  });
}
