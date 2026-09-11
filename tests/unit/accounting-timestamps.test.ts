import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolwynMiddleware } from "../../src/ai-sdk";
import { BudgetExceededError } from "../../src/errors";
import { createEventTimestampAllocator } from "../../src/event-timestamp";
import { noopLogger, Solwyn } from "../../src/index";
import { MetadataReporter } from "../../src/reporter";
import { FakeControlPlane } from "../../src/testing";
import type { MetadataEvent } from "../../src/types";

afterEach(() => vi.useRealTimers());

const fixedTime = new Date("2026-09-07T12:00:00.000Z");
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(fixedTime);
}

type Middleware = ReturnType<typeof createSolwynMiddleware>;
interface AiArgs {
  model: { provider: string; modelId: string };
  params: { prompt: never[]; maxOutputTokens: number };
  doGenerate: () => Promise<{
    content: never[];
    usage: { inputTokens: number; outputTokens: number };
  }>;
  doStream: () => Promise<{ stream: ReadableStream<unknown> }>;
}
function aiCall(handle: Middleware, streaming: boolean, failure: boolean): Promise<unknown> {
  const args: AiArgs = {
    model: { provider: "openai", modelId: "gpt-5-mini" },
    params: { prompt: [], maxOutputTokens: 1 },
    doGenerate: async () => {
      if (failure) throw new Error("synthetic provider failure");
      return { content: [], usage: { inputTokens: 2, outputTokens: 3 } };
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          if (failure) controller.error(new Error("synthetic stream failure"));
          else {
            controller.enqueue({ type: "finish", usage: { inputTokens: 2, outputTokens: 3 } });
            controller.close();
          }
        },
      }),
    }),
  };
  if (!streaming)
    return (handle.middleware.wrapGenerate as unknown as (args: AiArgs) => Promise<unknown>)(args);
  return (
    handle.middleware.wrapStream as unknown as (
      args: AiArgs,
    ) => Promise<{ stream: ReadableStream<unknown> }>
  )(args).then(async ({ stream }) => {
    const reader = stream.getReader();
    try {
      while (!(await reader.read()).done) {
        /* drain structural terminal events */
      }
    } finally {
      reader.releaseLock();
    }
  });
}

describe("remediation: timestamps survive legacy ingest identity", () => {
  for (const entry of ["core", "ai-sdk"] as const) {
    it(`${entry} retains distinct buffered, stream, error and denial events in one millisecond`, async () => {
      freezeClock();
      const plane = new FakeControlPlane();
      const options = {
        apiKey: plane.apiKey,
        apiUrl: plane.apiUrl,
        fetch: plane.fetch,
        leaseEnabled: false,
        budgetCheckCacheTtl: 0,
        logger: noopLogger,
      };
      let failure = false;
      const client = new Solwyn(
        {
          chat: {
            completions: {
              create: async (params: { stream?: boolean; model: string }) => {
                if (failure) throw new Error("synthetic provider failure");
                if (params.stream)
                  return (async function* () {
                    yield { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } };
                  })();
                return { usage: { prompt_tokens: 2, completion_tokens: 3 } };
              },
            },
          },
        },
        { ...options, reportUntrackedSurfaces: false },
      );
      const handle = createSolwynMiddleware(options);
      const call = async (streaming = false): Promise<void> => {
        if (entry === "ai-sdk") {
          await aiCall(handle, streaming, failure);
          return;
        }
        const result = await client.chat.completions.create({
          model: "gpt-5-mini",
          stream: streaming,
        });
        if (streaming)
          for await (const _ of result as AsyncIterable<unknown>) {
            /* drain */
          }
      };
      for (let repeat = 0; repeat < 2; repeat++) {
        await call();
        await call(true);
        failure = true;
        await expect(call()).rejects.toThrow("synthetic provider failure");
        failure = false;
        plane.denyNext();
        await expect(call()).rejects.toBeInstanceOf(BudgetExceededError);
      }
      await client.close();
      await handle.close();
      expect(plane.ingested).toHaveLength(8);
      expect(new Set(plane.ingested.map((event) => event.call_id)).size).toBe(8);
      expect(new Set(plane.ingested.map((event) => event.timestamp)).size).toBe(8);
      expect(new Set(plane.ingested.map((event) => event.sdk_instance_id)).size).toBe(1);
      expect(
        plane.ingested.every((event) => /^2026-09-07T12:00:00\.00000\dZ$/.test(event.timestamp)),
      ).toBe(true);
    });
  }

  it("allocates more than one millisecond of events and tolerates a backward wall clock", () => {
    freezeClock();
    const next = createEventTimestampAllocator();
    const stamps = Array.from({ length: 2001 }, next);
    expect(stamps[0]).toBe("2026-09-07T12:00:00.000000Z");
    expect(stamps[1000]).toBe("2026-09-07T12:00:00.001000Z");
    expect(new Set(stamps).size).toBe(2001);
    vi.setSystemTime(fixedTime.getTime() - 1000);
    expect(next()).toBe("2026-09-07T12:00:00.002001Z");
  });

  it("uses the same allocator for ordinary events and distinct overflow receipt replays", async () => {
    freezeClock();
    const plane = new FakeControlPlane();
    const reporter = new MetadataReporter(plane.apiUrl, plane.apiKey, {
      fetch: plane.fetch,
      maxQueueSize: 1,
      sdkInstanceId: "timestamp-replay",
      logger: noopLogger,
    });
    for (let index = 0; index < 3; index++) {
      const event: MetadataEvent = {
        model: `gpt-5-mini-${index}`,
        provider: "openai",
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        status: "budget_denied",
        is_model_fallback: false,
        is_provider_fallback: false,
        attempt_index: 0,
        sdk_instance_id: "timestamp-replay",
        call_id: crypto.randomUUID(),
        timestamp: reporter.nextEventTimestamp(),
      };
      reporter.report(event);
    }
    await reporter.close();
    expect(plane.ingested).toHaveLength(3);
    expect(new Set(plane.ingested.map((event) => event.timestamp)).size).toBe(3);
    expect(plane.ingested.filter((event) => event.deny_source === "aggregate_replay")).toHaveLength(
      2,
    );
  });

  it("retains timestamp, call and SDK identity when ingest retries", async () => {
    freezeClock();
    const plane = new FakeControlPlane();
    const attempts: MetadataEvent[][] = [];
    let now = 0;
    const reporter = new MetadataReporter(plane.apiUrl, plane.apiKey, {
      logger: noopLogger,
      retryBackoffBase: 1,
      retryBackoffCap: 1,
      monotonicClock: () => now,
      fetch: async (url, init) => {
        if (url.endsWith("/metadata/ingest")) {
          attempts.push(JSON.parse(String(init?.body)));
          if (attempts.length === 1) return new Response(null, { status: 503 });
        }
        return plane.fetch(url, init);
      },
    });
    reporter.report({
      model: "gpt-5-mini",
      provider: "openai",
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      status: "success",
      is_model_fallback: false,
      is_provider_fallback: false,
      attempt_index: 0,
      sdk_instance_id: "retry-instance",
      call_id: crypto.randomUUID(),
      timestamp: reporter.nextEventTimestamp(),
    });
    await reporter._flushRemaining();
    now = 2;
    await reporter._flushRemaining();
    await reporter.close();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(plane.ingested).toHaveLength(1);
  });
});
