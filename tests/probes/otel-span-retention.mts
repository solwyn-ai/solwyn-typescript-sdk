import assert from "node:assert/strict";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { noopLogger } from "../../src/logging";
import { Solwyn } from "../../src/node";
import { FakeControlPlane } from "../../src/testing";
import { alive, collectUntil } from "./gc.mjs";

// A client that stays reachable must not keep alive the span of the call that happened to
// initialize it, nor the span of the caller that closed it.
assert.ok(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()));
const provider = new BasicTracerProvider();
assert.ok(trace.setGlobalTracerProvider(provider));
const tracer = trace.getTracer("solwyn-span-retention-probe");

const plane = new FakeControlPlane();
let creates = 0;
function makeClient() {
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>) => {
          creates++;
          return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    },
  };
  return new Solwyn(client, {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    logger: noopLogger,
    provider: "openai",
    onUnmetered: "allow",
    reporterFlushInterval: 0.01,
    budgetCheckCacheTtl: 0,
    velocityMode: "off",
  });
}

// Warm process-wide runtime state outside any span first. On Node 22, one-time runtime
// initialization outside the SDK (such as undici's lazily compiled HTTP parser) retains the
// async context of whichever work first triggers it, regardless of what the SDK does.
const warm = makeClient();
await warm.chat.completions.create({ model: "gpt-4o", messages: [] });
await warm.close();

const solwyn = makeClient();

async function underSpan(name: string, work: () => Promise<unknown>): Promise<WeakRef<object>> {
  let ref: WeakRef<object> | undefined;
  await tracer.startActiveSpan(name, async (span) => {
    ref = new WeakRef(span);
    try {
      await work();
    } finally {
      span.end();
    }
  });
  assert.ok(ref);
  return ref;
}

// The first call builds and memoizes the client's provider runtimes.
const initializing = await underSpan("initializing-call", () =>
  solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
);
await underSpan("later-call", () =>
  solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
);
await collectUntil(
  () => alive([initializing]) === 0,
  () => `initializing span alive=${alive([initializing])}`,
);
const initializingReleased = alive([initializing]) === 0;

// close() memoizes one shared promise for every later caller.
const closing = await underSpan("closing-call", () => solwyn.close());
await collectUntil(
  () => alive([closing]) === 0,
  () => `closing span alive=${alive([closing])}`,
);
const closingReleased = alive([closing]) === 0;

// Keep the client reachable until after both checks.
assert.ok(solwyn instanceof Solwyn);
await provider.shutdown();
process.stdout.write(
  `${JSON.stringify({ creates, initializingReleased, closingReleased, ingested: plane.ingested.length })}\n`,
);
process.exit(0);
