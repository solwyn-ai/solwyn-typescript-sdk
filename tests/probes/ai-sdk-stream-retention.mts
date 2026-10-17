import assert from "node:assert/strict";
import { createSolwynMiddleware } from "../../src/ai-sdk";
import { noopLogger } from "../../src/logging";
import { FakeControlPlane } from "../../src/testing";
import { alive, collectUntil } from "./gc.mjs";

const plane = new FakeControlPlane();
const handle = createSolwynMiddleware({
  apiKey: plane.apiKey,
  apiUrl: plane.apiUrl,
  fetch: plane.fetch,
  logger: noopLogger,
  leaseEnabled: false,
  breakerReportingEnabled: false,
  budgetCheckCacheTtl: 0,
  reporterFlushInterval: 0.01,
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
await collectUntil(
  () => alive(dropped) === 0 && plane.confirms.length === 32 && plane.ingested.length === 32,
  () =>
    `abandoned AI streams=${alive(dropped)}, confirms=${plane.confirms.length}/32, ingested=${plane.ingested.length}/32`,
);
assert.ok(dropped.every((reference) => reference.deref() === undefined));
assert.equal(plane.confirms.length, 32, "abandoned streams settle before handle close");
assert.equal(plane.ingested.length, 32, "each abandoned stream reports its observed usage");
assert.ok(
  plane.ingested.every(
    (event) =>
      event.status === "success" &&
      event.output_tokens === 1 &&
      event.token_details?.is_estimated === true,
  ),
);
await handle.close();
await held.stream.cancel().catch(() => {});
assert.equal(plane.confirms.length, 33, "close settles only the reachable stream");
assert.equal(plane.ingested.length, 33);
assert.equal(
  plane.confirms.filter(
    (confirm) =>
      confirm.token_details.input_tokens === 50 && confirm.token_details.output_tokens === 20,
  ).length,
  1,
  "a reachable stream must keep its close settlement callback alive",
);
process.stdout.write(`${JSON.stringify({ collected: true, liveConfirmed: true })}\n`);
