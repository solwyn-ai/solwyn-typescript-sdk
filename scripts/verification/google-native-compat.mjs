import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { environmentError, installConsumer, runProbe } from "./runtime-support.mjs";

export function assertGoogleChecks(checks) {
  assert.equal(checks.noLiveCalls, true);
  const expected = [];
  for (const [version, metadata] of [
    ["0.3.1", "native"],
    ["2.20.0", "native"],
    ["2.20.0", "unknown"],
  ]) {
    for (const scenario of [
      "buffered",
      "embeddings",
      "stream-return",
      "deadline",
      "caller-abort",
    ]) {
      const aborted = scenario === "deadline" || scenario === "caller-abort";
      const residual = !aborted && (version === "0.3.1" || metadata === "unknown");
      expected.push({
        version,
        metadata,
        scenario,
        providerRequests: 1,
        observedSignal: true,
        outcome: aborted ? "rejected" : "fulfilled",
        transportAborted: aborted,
        nativeAbortedAtCallerAbort: scenario === "caller-abort" ? version !== "0.3.1" : null,
        pendingProviderTimersAfterClose: residual ? 1 : 0,
        referencedProviderTimersAfterClose: residual && version === "0.3.1" ? 1 : 0,
        streamReaderReleased: scenario === "stream-return" ? true : null,
        pendingProviderTimersAfterNativeDeadline: 0,
      });
    }
  }
  expected.push({
    version: "2.20.0",
    metadata: "native",
    scenario: "completed-run-gc",
    retainedSettledPromise: true,
    clientStillOpenAtRetirement: true,
    leaseSurrendersBeforeClose: 1,
    leaseGrants: 1,
    spentTokens: 0,
    providerDeadlineSeconds: 600,
  });
  assert.deepEqual(
    checks.controls,
    expected,
    "Google controls must prove exact native lifecycle outcomes",
  );
}

async function googleNativeCompat({ tarball, out }, report, evidence) {
  if (typeof globalThis.gc !== "function")
    throw environmentError("Run this probe with --expose-gc");
  const { app, req, sdkRoot } = await installConsumer(tarball, "google-sdk", [], evidence);
  const floorConsumer = await installConsumer(
    tarball,
    "google-floor",
    ["@google/genai@0.3.1"],
    evidence,
  );
  const currentConsumer = await installConsumer(
    tarball,
    "google-current",
    ["@google/genai@2.20.0"],
    evidence,
  );
  const floor = path.join(floorConsumer.app, "node_modules/@google/genai");
  const current = path.join(currentConsumer.app, "node_modules/@google/genai");
  report.versions.google = ["0.3.1", "2.20.0"];
  report.details.consumers = { sdk: app, floor: floorConsumer.app, current: currentConsumer.app };
  const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
  const testing = await import(pathToFileURL(path.join(sdkRoot, "dist/testing/index.js")).href);
  const nodeEntry = await import(pathToFileURL(path.join(sdkRoot, "dist/node.js")).href);
  const timeoutMs = 80;
  const saved = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const results = [];
  report.checks.controls = results;

  async function checkCase(nativePackage, expectedVersion, metadata, scenario) {
    const manifest = JSON.parse(fs.readFileSync(path.join(nativePackage, "package.json"), "utf8"));
    assert.equal(manifest.version, expectedVersion);
    const { GoogleGenAI } = await import(pathToFileURL(req.resolve(nativePackage)).href);
    const native = new GoogleGenAI({ apiKey: "offline-synthetic", httpOptions: { timeout: 250 } });
    if (metadata === "unknown") {
      const headers = native.models.apiClient.clientOptions.httpOptions.headers;
      headers["User-Agent"] = "custom-unknown";
      headers["x-goog-api-client"] = "custom-unknown";
    }
    const caller = new AbortController();
    const timers = new Map();
    let watchdog;
    let responseBody;
    let providerRequests = 0;
    let observedSignal = false;
    let transportAborted = false;
    let nativeAbortedAtCallerAbort;
    let outcome = "fulfilled";
    const plane = new testing.FakeControlPlane();
    const client = new sdk.Solwyn(native, {
      apiKey: plane.apiKey,
      apiUrl: plane.apiUrl,
      fetch: plane.fetch,
      failoverHopReadTimeout: timeoutMs / 1000,
      leaseEnabled: false,
      breakerReportingEnabled: false,
      reportUntrackedSurfaces: false,
      logger: sdk.noopLogger,
    });
    globalThis.setTimeout = (callback, delay, ...args) => {
      const entry = { delay, state: "pending" };
      const handle = saved.setTimeout(() => {
        entry.state = "fired";
        callback(...args);
      }, delay);
      timers.set(handle, entry);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      const entry = timers.get(handle);
      if (entry) entry.state = "cleared";
      saved.clearTimeout(handle);
    };
    globalThis.fetch = async (_url, init) => {
      providerRequests++;
      const signal = init?.signal;
      observedSignal = signal instanceof AbortSignal;
      if (scenario === "deadline" || scenario === "caller-abort") {
        return new Promise((_resolve, reject) => {
          const abort = () => {
            transportAborted = true;
            saved.clearTimeout(watchdog);
            reject(new DOMException("Synthetic native transport abort", "AbortError"));
          };
          watchdog = saved.setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            reject(new Error("Native deadline was not enforced"));
          }, timeoutMs * 8);
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          if (scenario === "caller-abort") {
            caller.abort();
            nativeAbortedAtCallerAbort = signal?.aborted;
          }
        });
      }
      if (scenario === "stream-return") {
        responseBody = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } })}\n\n`,
              ),
            );
            controller.close();
          },
        });
        return new Response(responseBody, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json(
        scenario === "embeddings"
          ? { embeddings: [{ values: [] }], usageMetadata: { promptTokenCount: 0 } }
          : { candidates: [], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } },
      );
    };
    try {
      const params = {
        model: scenario === "embeddings" ? "text-embedding-004" : "gemini-2.0-flash",
        contents: [{ role: "user", parts: [] }],
        config: { maxOutputTokens: 1, abortSignal: caller.signal },
      };
      try {
        if (scenario === "stream-return") {
          const stream = await client.models.generateContentStream(params);
          const iterator = stream[Symbol.asyncIterator]();
          assert.equal((await iterator.next()).done, false);
          await iterator.return();
        } else if (scenario === "embeddings") {
          delete params.config.maxOutputTokens;
          await client.models.embedContent(params);
        } else {
          await client.models.generateContent(params);
        }
      } catch (error) {
        if (scenario !== "deadline" && scenario !== "caller-abort") throw error;
        outcome = "rejected";
      }
      await client.close();
      assert.equal(providerRequests, 1);
      assert.equal(observedSignal, true);
      const pendingProviderTimers = [...timers].filter(
        ([, entry]) => entry.delay === timeoutMs && entry.state === "pending",
      );
      const expectedResidual = expectedVersion === "0.3.1" || metadata === "unknown";
      if (scenario === "deadline" || scenario === "caller-abort") {
        assert.equal(outcome, "rejected");
        assert.equal(transportAborted, true, "The native fetch must observe a real abort");
      } else {
        assert.equal(pendingProviderTimers.length, expectedResidual ? 1 : 0);
        if (scenario === "stream-return") assert.equal(responseBody.locked, false);
      }
      if (scenario === "caller-abort") {
        assert.equal(nativeAbortedAtCallerAbort, expectedVersion !== "0.3.1");
      }
      const record = {
        version: expectedVersion,
        metadata,
        scenario,
        providerRequests,
        observedSignal,
        outcome,
        transportAborted,
        nativeAbortedAtCallerAbort: nativeAbortedAtCallerAbort ?? null,
        pendingProviderTimersAfterClose: pendingProviderTimers.length,
        referencedProviderTimersAfterClose: pendingProviderTimers.filter(([handle]) =>
          handle.hasRef(),
        ).length,
        streamReaderReleased: responseBody === undefined ? null : !responseBody.locked,
      };
      await new Promise((resolve) => saved.setTimeout(resolve, timeoutMs + 15));
      assert.equal(
        [...timers.values()].filter(
          (entry) => entry.delay === timeoutMs && entry.state === "pending",
        ).length,
        0,
      );
      results.push({ ...record, pendingProviderTimersAfterNativeDeadline: 0 });
    } finally {
      saved.clearTimeout(watchdog);
      await client.close();
      for (const handle of timers.keys()) saved.clearTimeout(handle);
      globalThis.fetch = saved.fetch;
      globalThis.setTimeout = saved.setTimeout;
      globalThis.clearTimeout = saved.clearTimeout;
    }
  }

  for (const [nativePackage, version, metadata] of [
    [floor, "0.3.1", "native"],
    [current, "2.20.0", "native"],
    [current, "2.20.0", "unknown"],
  ]) {
    for (const scenario of [
      "buffered",
      "embeddings",
      "stream-return",
      "deadline",
      "caller-abort",
    ]) {
      await checkCase(nativePackage, version, metadata, scenario);
    }
  }

  // Retain the settled application promise while the client remains open. A completed
  // native Google call must not pin its Node run until the former provider deadline.
  const { GoogleGenAI } = await import(pathToFileURL(req.resolve(current)).href);
  const gcPlane = new testing.FakeControlPlane();
  const gcClient = new sdk.Solwyn(new GoogleGenAI({ apiKey: "offline-synthetic" }), {
    apiKey: gcPlane.apiKey,
    apiUrl: gcPlane.apiUrl,
    fetch: gcPlane.fetch,
    failoverHopReadTimeout: 600,
    breakerReportingEnabled: false,
    reportUntrackedSurfaces: false,
    logger: sdk.noopLogger,
  });
  try {
    globalThis.fetch = async () =>
      Response.json({
        candidates: [],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
      });
    const retained = nodeEntry.run("native-google-terminal-retirement", async () =>
      gcClient.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [{ role: "user", parts: [] }],
        config: { maxOutputTokens: 1 },
      }),
    );
    await retained;
    assert.equal(gcPlane.leaseGrants.length, 1);
    for (let index = 0; index < 60 && gcPlane.leaseSurrenders.length === 0; index++) {
      globalThis.gc();
      await new Promise((resolve) => saved.setTimeout(resolve, 20));
    }
    assert.equal(
      gcPlane.leaseSurrenders.length,
      1,
      "Completed native Google work must retire before the 600-second deadline",
    );
    assert.equal(gcPlane.leaseSurrenders[0].spent_tokens, 0);
    assert.ok(await retained);
    results.push({
      version: "2.20.0",
      metadata: "native",
      scenario: "completed-run-gc",
      retainedSettledPromise: true,
      clientStillOpenAtRetirement: true,
      leaseSurrendersBeforeClose: gcPlane.leaseSurrenders.length,
      leaseGrants: gcPlane.leaseGrants.length,
      spentTokens: gcPlane.leaseSurrenders[0].spent_tokens,
      providerDeadlineSeconds: 600,
    });
  } finally {
    globalThis.fetch = saved.fetch;
    await gcClient.close();
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, "google-native-compat-results.json"),
    JSON.stringify({ sdkRoot, noLiveCalls: true, results }, null, 2),
  );
  process.stdout.write(
    `Google native floor/current/unknown-metadata compatibility: ${results.length} controls passed.\n`,
  );

  report.checks.noLiveCalls = true;
  assertGoogleChecks(report.checks);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runProbe("google-native-compat", googleNativeCompat);
}
