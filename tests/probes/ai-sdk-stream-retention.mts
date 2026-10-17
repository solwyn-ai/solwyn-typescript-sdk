import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createSolwynMiddleware } from "../../src/ai-sdk";
import { noopLogger } from "../../src/logging";
import { FakeControlPlane } from "../../src/testing";

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.ok(forceGc, "run with --expose-gc");
const plane = new FakeControlPlane();
const handle = createSolwynMiddleware({
  apiKey: plane.apiKey,
  apiUrl: plane.apiUrl,
  fetch: plane.fetch,
  logger: noopLogger,
  leaseEnabled: false,
  breakerReportingEnabled: false,
  budgetCheckCacheTtl: 0,
});
const wrap = handle.middleware.wrapStream as unknown as (
  args: unknown,
) => Promise<{ stream: ReadableStream<unknown> }>;

async function open(part: unknown) {
  return wrap({
    model: { provider: "openai", modelId: "gpt-4o" },
    params: { prompt: [] },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(part);
        },
      }),
    }),
  });
}

async function abandon(): Promise<WeakRef<object>> {
  const result = await open({ type: "text-delta", delta: "abcd" });
  return new WeakRef(result.stream);
}

const dropped: WeakRef<object>[] = [];
for (let index = 0; index < 32; index++) dropped.push(await abandon());
const held = await open({
  type: "finish",
  usage: { inputTokens: { total: 50 }, outputTokens: { total: 20 } },
});
for (let attempt = 0; attempt < 60; attempt++) {
  await setImmediate();
  forceGc();
  await setImmediate();
  if (dropped.every((reference) => reference.deref() === undefined)) break;
}
assert.ok(dropped.every((reference) => reference.deref() === undefined));
await handle.close();
await held.stream.cancel().catch(() => {});
assert.equal(
  plane.confirms.filter(
    (confirm) =>
      confirm.token_details.input_tokens === 50 && confirm.token_details.output_tokens === 20,
  ).length,
  1,
  "a reachable stream must keep its close settlement callback alive",
);
process.stdout.write(`${JSON.stringify({ collected: true, liveConfirmed: true })}\n`);
