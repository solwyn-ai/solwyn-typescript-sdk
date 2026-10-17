import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createSolwynMiddleware } from "../../src/ai-sdk";
import { noopLogger, run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import { getCurrentRun } from "../../src/run-context";
import { markTerminated } from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing";
import { alive, collectUntil, settle } from "./gc.mjs";

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.ok(forceGc, "run with --expose-gc");
type Handle = ReturnType<typeof createSolwynMiddleware>;
const usage = { inputTokens: { total: 50 }, outputTokens: { total: 20 } };
const refs: WeakRef<object>[] = [];
let settlements = 0;
let errors = 0;
const reportSettlement = MetadataReporter.prototype.reportSettlement;
const report = MetadataReporter.prototype.report;
MetadataReporter.prototype.reportSettlement = function (request, event) {
  settlements++;
  reportSettlement.call(this, request, event);
};
MetadataReporter.prototype.report = function (event) {
  if (event.status === "error") errors++;
  report.call(this, event);
};

function fixture() {
  const plane = new FakeControlPlane();
  const handle = createSolwynMiddleware({
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    logger: noopLogger,
    breakerReportingEnabled: false,
    budgetCheckCacheTtl: 0,
    reporterFlushInterval: 0.01,
  });
  return { plane, handle };
}

async function open(handle: Handle, part?: unknown) {
  const wrap = handle.middleware.wrapStream as unknown as (
    args: unknown,
  ) => Promise<{ stream: ReadableStream<unknown> }>;
  const abort = new AbortController();
  const lifetime = getCurrentRun()?.lifetime;
  if (lifetime !== undefined) refs.push(new WeakRef(lifetime));
  refs.push(new WeakRef(abort.signal));
  let controller!: ReadableStreamDefaultController<unknown>;
  const source = new ReadableStream({
    start(value) {
      controller = value;
      if (part !== undefined) value.enqueue(part);
    },
  });
  // A provider-owned getter and extra field must not enter finalizer state.
  if (part !== null && typeof part === "object" && Reflect.get(part, "type") === "finish") {
    const reportedUsage = Reflect.get(part, "usage") ?? usage;
    Object.defineProperty(part, "usage", {
      get: () => (source.locked ? reportedUsage : undefined),
    });
    Object.assign(part, { source });
  }
  if (part !== null && typeof part === "object") refs.push(new WeakRef(part));
  const result = await wrap({
    model: { provider: "openai", modelId: "gpt-4o" },
    params: { prompt: [], maxOutputTokens: 100, abortSignal: abort.signal },
    doStream: async () => ({ stream: source }),
  });
  refs.push(new WeakRef(source), new WeakRef(result.stream));
  return { ...result, controller, abort };
}

const allCollected = () => alive(refs) === 0;
const describe = (plane: FakeControlPlane): string =>
  `AI stream references=${alive(refs)}/${refs.length}, confirms=${plane.confirms.length}, ingested=${plane.ingested.length}, surrenders=${plane.leaseSurrenders.length}`;

async function leaseAccounting(): Promise<void> {
  const { plane, handle } = fixture();
  try {
    for (const kind of ["measured", "estimated", "unread", "partial", "malformed"] as const) {
      await run(`abandoned-${kind}`, async () => {
        const result = await open(
          handle,
          kind === "measured"
            ? { type: "finish" }
            : kind === "estimated"
              ? { type: "text-delta", delta: "abcd" }
              : kind === "partial"
                ? { type: "finish", usage: { inputTokens: { total: 50 } } }
                : kind === "malformed"
                  ? {
                      type: "finish",
                      usage: { inputTokens: { total: 50 }, outputTokens: { total: Number.NaN } },
                    }
                  : undefined,
        );
        if (kind !== "unread") {
          const reader = result.stream.getReader();
          await reader.read();
          reader.releaseLock();
        }
      });
    }
    await collectUntil(
      () =>
        allCollected() &&
        plane.confirms.length === 5 &&
        plane.ingested.length === 5 &&
        plane.leaseSurrenders.length === 5,
      () => describe(plane),
    );
    assert.deepEqual(
      plane.leaseSurrenders.map((request) => request.spent_tokens ?? -1).sort((a, b) => a - b),
      [70, 100, 100, 100, 100],
      "only measured usage can refund the unobserved reservation",
    );
    for (const confirm of plane.confirms) {
      const event = plane.ingested.find((value) => value.call_id === confirm.call_id);
      assert.equal(event?.status, "success");
      assert.equal(event?.lease_id, confirm.lease_id);
      assert.equal(confirm.reservation_id, undefined);
      assert.ok(confirm.lease_id);
      assert.deepEqual(event?.token_details, confirm.token_details);
    }
    assert.deepEqual(
      plane.ingested.map((event) => event.output_tokens).sort((a, b) => a - b),
      [0, 0, 0, 1, 20],
    );
    assert.equal(plane.ingested.filter((event) => event.token_details?.is_estimated).length, 4);
    await handle.close();
    assert.equal(plane.confirms.length, 5, "close cannot settle finalized streams again");
  } finally {
    await handle.close();
  }
}

async function terminalOnce(): Promise<void> {
  const { plane, handle } = fixture();
  const before = { settlements, errors };
  try {
    for (const kind of [
      "end",
      "cancel",
      "cancel-estimated",
      "source-error",
      "run-stop",
      "caller-abort",
      "close",
    ] as const) {
      await run(`terminal-${kind}`, async () => {
        const result = await open(
          handle,
          kind === "cancel-estimated" ? { type: "text-delta", delta: "abcd" } : { type: "finish" },
        );
        const reader = result.stream.getReader();
        await reader.read();
        if (kind === "end") {
          result.controller.close();
          assert.equal((await reader.read()).done, true);
        } else if (kind === "cancel" || kind === "cancel-estimated") {
          await reader.cancel();
        } else if (kind === "source-error") {
          const error = new Error("synthetic source failure");
          result.controller.error(error);
          await assert.rejects(reader.read(), (received) => received === error);
        } else if (kind === "close") {
          await handle.close();
          result.controller.enqueue({ type: "text-delta", delta: "abcd" });
          await assert.rejects(reader.read(), { name: "SolwynError", message: "client is closed" });
        } else {
          if (kind === "caller-abort") result.abort.abort();
          else {
            const runId = getCurrentRun()?.agentRunId;
            assert.ok(runId);
            markTerminated(runId, { reason: "synthetic-stop", source: "server" });
          }
          result.controller.enqueue({ type: "text-delta", delta: "abcd" });
          await assert.rejects(reader.read(), {
            name: kind === "caller-abort" ? "AbortError" : "RunStoppedError",
          });
        }
      });
    }
    await collectUntil(
      () =>
        allCollected() &&
        plane.confirms.length === 6 &&
        plane.ingested.length === 7 &&
        plane.leaseSurrenders.length === 7,
      () => describe(plane),
    );
    // Settled streams must stay settled when additional finalizer callbacks run.
    await settle(8);
    assert.equal(settlements - before.settlements, 6, "GC after close cannot enqueue again");
    assert.equal(errors - before.errors, 1);
    assert.equal(plane.confirms.length, 6);
    assert.equal(plane.ingested.length, 7);
    assert.equal(plane.leaseSurrenders.length, 7);
    assert.deepEqual(
      plane.leaseSurrenders.map((request) => request.spent_tokens ?? -1).sort((a, b) => a - b),
      [0, 70, 70, 70, 70, 70, 100],
    );
  } finally {
    await handle.close();
  }
}

async function abandonedError(): Promise<void> {
  const { plane, handle } = fixture();
  try {
    await run("abandoned-error", async () => {
      await open(handle, { type: "error", error: new Error("synthetic provider failure") });
    });
    await collectUntil(
      () => allCollected() && plane.ingested.length === 1 && plane.leaseSurrenders.length === 1,
      () => describe(plane),
    );
    assert.equal(plane.confirms.length, 0);
    assert.equal(plane.ingested[0]?.status, "error");
    assert.equal(plane.ingested[0]?.possibly_succeeded, true);
    assert.equal(plane.ingested[0]?.failover_error_class, undefined);
    await handle.close();
    assert.equal(plane.ingested.length, 1);
  } finally {
    await handle.close();
  }
}

async function closeBeforeFinalization(): Promise<void> {
  const { plane, handle } = fixture();
  const before = settlements;
  try {
    await run("close-before-finalization", async () => {
      await open(handle, { type: "finish" });
    });
    await setImmediate();
    forceGc?.();
    // Close's microtask runs before the GC callback; it still owns the detached record.
    await handle.close();
    await collectUntil(
      () =>
        allCollected() &&
        plane.confirms.length === 1 &&
        plane.ingested.length === 1 &&
        plane.leaseSurrenders.length === 1,
      () => describe(plane),
    );
    // Closing and later finalization must keep the settlement count unchanged.
    await settle(8);
    assert.equal(settlements - before, 1, "close and queued finalization share one settlement");
    assert.equal(plane.confirms.length, 1);
    assert.equal(plane.ingested.length, 1);
    assert.equal(plane.leaseSurrenders[0]?.spent_tokens, 70);
  } finally {
    await handle.close();
  }
}

async function unclosedHandle(): Promise<void> {
  const plane = await run("unclosed-middleware", async () => {
    const { plane, handle } = fixture();
    refs.push(new WeakRef(handle));
    await open(handle, { type: "finish" });
    return plane;
  });
  await collectUntil(
    () => allCollected() && plane.confirms.length === 1 && plane.ingested.length === 1,
    () => describe(plane),
  );
  assert.equal(plane.confirms[0]?.token_details.input_tokens, 50);
  assert.equal(plane.confirms[0]?.token_details.output_tokens, 20);
  assert.equal(plane.ingested[0]?.lease_id, plane.confirms[0]?.lease_id);
}

try {
  await leaseAccounting();
  await terminalOnce();
  await abandonedError();
  await closeBeforeFinalization();
  await unclosedHandle();
  process.stdout.write(
    `${JSON.stringify({ leases: true, exactlyOnce: true, unclosedCollected: true })}\n`,
  );
} finally {
  MetadataReporter.prototype.reportSettlement = reportSettlement;
  MetadataReporter.prototype.report = report;
}
