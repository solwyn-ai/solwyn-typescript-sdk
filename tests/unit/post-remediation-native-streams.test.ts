import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { currentRun, run } from "../../src/node";
import { markTerminated, resetRunControlForTest } from "../../src/run-control";
import type { StreamWrapper } from "../../src/stream";
import type { FetchLike } from "../../src/transport";

afterEach(() => {
  vi.restoreAllMocks();
  resetRunControlForTest();
});

type NativeStream = AsyncIterable<unknown> & {
  controller: AbortController;
  tee(): [NativeStream, NativeStream];
  toReadableStream(): ReadableStream<Uint8Array>;
};

function fixture(provider: "openai" | "anthropic", open = false, crossDialect = false) {
  const confirms: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const cancelled = vi.fn();
  const pulled = vi.fn();
  const aborted = vi.fn();
  let requestSignal: AbortSignal | null | undefined;
  const items: Record<string, unknown>[] =
    provider === "openai"
      ? [{ choices: [], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } }]
      : [
          { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 0 } } },
          { type: "message_delta", delta: {}, usage: { output_tokens: 20 } },
          { type: "message_stop" },
        ];
  const marker = crypto.randomUUID();
  if (crossDialect) {
    items.splice(1, 0, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: marker },
    });
  }
  let index = 0;
  let readFailure: { error: unknown } | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled();
        if (readFailure !== undefined) {
          controller.error(readFailure.error);
          return;
        }
        const item = items[index++];
        if (item !== undefined) {
          const event = "type" in item ? `event: ${item["type"]}\n` : "";
          controller.enqueue(new TextEncoder().encode(`${event}data: ${JSON.stringify(item)}\n\n`));
        } else if (!open) controller.close();
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
    requestSignal = init?.signal;
    requestSignal?.addEventListener(
      "abort",
      () => {
        aborted();
        if (!body.locked) void body.cancel().catch(() => {});
      },
      { once: true },
    );
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const controlFetch: FetchLike = async (url, init) => {
    const data = JSON.parse(init?.body as string) as Record<string, unknown>;
    if (url.endsWith("/budgets/check")) {
      return Response.json({
        allowed: true,
        remaining_budget: 100,
        reservation_id: "reservation-stream",
        mode: "alert_only",
        budget_limit: 100,
        current_usage: 0,
        denied_by_period: null,
        project_id: `proj_${"0".repeat(24)}`,
        price_hints: null,
      });
    }
    if (url.endsWith("/budgets/confirm")) {
      confirms.push(data);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/ingest")) {
      events.push(...(data as unknown as Record<string, unknown>[]));
      return Response.json({ ingested: 1, rejected: [] }, { status: 202 });
    }
    return new Response(null, { status: 204 });
  };
  const options = {
    apiKey: `sk_proj_${"a".repeat(64)}`,
    fetch: controlFetch,
    leaseEnabled: false,
    breakerReportingEnabled: false,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerRecoveryTimeout: 0,
    circuitBreakerSuccessThreshold: 1,
    circuitBreakerRecoveryTimeoutJitter: 0,
    logger: noopLogger,
  };
  const anthropic = new Anthropic({ apiKey: "offline", maxRetries: 0, fetch: providerFetch });
  const wrapped = crossDialect
    ? new Solwyn(
        new OpenAI({
          apiKey: "offline",
          maxRetries: 0,
          fetch: async () =>
            Response.json({ error: { type: "rate_limit_error" } }, { status: 429 }),
        }),
        {
          ...options,
          fallback: [[anthropic, "claude-sonnet-4-5"]],
        },
      )
    : provider === "openai"
      ? new Solwyn(new OpenAI({ apiKey: "offline", maxRetries: 0, fetch: providerFetch }), options)
      : new Solwyn(anthropic, options);
  async function create(model?: string): Promise<NativeStream & StreamWrapper> {
    const result =
      "chat" in wrapped
        ? await wrapped.chat.completions.create({
            model: model ?? "gpt-4o",
            messages: [],
            max_tokens: 30,
            stream: true,
          })
        : await wrapped.messages.create({
            model: model ?? "claude-sonnet-4-5",
            messages: [],
            max_tokens: 30,
            stream: true,
          });
    return result as unknown as NativeStream & StreamWrapper;
  }
  return {
    wrapped,
    create,
    confirms,
    events,
    cancelled,
    pulled,
    aborted,
    providerFetch,
    isAborted: () => requestSignal?.aborted,
    count: items.length,
    preservesMarker: (value: unknown) => JSON.stringify(value).includes(marker),
    failNextRead(error: unknown) {
      readFailure = { error };
    },
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _item of stream) count++;
  return count;
}

async function drainReadable(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let count = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) return count;
    // Native conversion is newline-delimited JSON encoded as UTF-8 bytes.
    const lines = new TextDecoder().decode(item.value).trim().split("\n");
    expect(lines.every((line) => typeof JSON.parse(line) === "object")).toBe(true);
    count += lines.length;
  }
}

describe.each([
  "openai",
  "anthropic",
] as const)("native %s metered stream lifecycle", (provider) => {
  it.each(["iteration", "readable", "tee"] as const)("settles %s exactly once", async (mode) => {
    const f = fixture(provider);
    const stream = await f.create();
    expect(f.providerFetch).toHaveBeenCalledTimes(1);
    const count =
      mode === "iteration"
        ? await drain(stream)
        : mode === "readable"
          ? await drainReadable(stream.toReadableStream())
          : await (async () => {
              const [left, right] = stream.tee();
              const counts = await Promise.all([
                drain(left),
                drainReadable(right.toReadableStream()),
              ]);
              expect(counts[0]).toBe(counts[1]);
              return counts[0];
            })();
    expect(count).toBe(f.count);
    await f.wrapped.close();
    expect(f.confirms).toHaveLength(1);
    expect(f.confirms[0]?.["token_details"]).toMatchObject({ input_tokens: 30, output_tokens: 20 });
    expect(f.events).toHaveLength(1);
  });

  it.each([
    "close",
    "return",
    "dispose",
    "readable_cancel",
    "tee_cancel",
  ] as const)("cancels unread native request through %s without a pull", async (mode) => {
    const f = fixture(provider, true);
    const stream = await f.create();
    expect(f.pulled).not.toHaveBeenCalled();
    if (mode === "dispose") await stream[Symbol.asyncDispose]();
    else if (mode === "readable_cancel") await stream.toReadableStream().cancel();
    else if (mode === "tee_cancel") {
      const [left, right] = stream.tee();
      await Promise.all([
        left[Symbol.asyncIterator]().return?.(),
        right[Symbol.asyncIterator]().return?.(),
      ]);
    } else await stream[mode]();
    await stream.close();
    await stream.return();
    await f.wrapped.close();
    expect(f.isAborted()).toBe(true);
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.cancelled).toHaveBeenCalledTimes(1);
    expect(f.pulled).not.toHaveBeenCalled();
    expect(f.confirms).toHaveLength(1);
    expect(f.events).toHaveLength(1);
  });

  it.each([
    "readable",
    "tee",
  ] as const)("enforces a retained run stop through native %s", async (mode) => {
    const f = fixture(provider);
    await run("post-remediation-stream", async () => {
      const stream = await f.create();
      markTerminated(currentRun()?.agentRunId ?? "", { source: "server", reason: "run_stopped" });
      if (mode === "readable")
        await expect(drainReadable(stream.toReadableStream())).rejects.toMatchObject({
          name: "RunStoppedError",
        });
      else {
        const [left, right] = stream.tee();
        await expect(drain(left)).rejects.toMatchObject({ name: "RunStoppedError" });
        await expect(drain(right)).rejects.toMatchObject({ name: "RunStoppedError" });
      }
      await stream.close();
    });
    await f.wrapped.close();
    expect(f.isAborted()).toBe(true);
    expect(f.confirms).toHaveLength(1);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it("cancels a partially consumed native request once", async () => {
    const f = fixture(provider, true);
    const stream = await f.create();
    await stream.next();
    await stream.return();
    await stream.close();
    await f.wrapped.close();
    expect(f.isAborted()).toBe(true);
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.cancelled).toHaveBeenCalledTimes(1);
    expect(f.confirms).toHaveLength(1);
  });

  it.each([
    "readable",
    "tee",
  ] as const)("completes the actual HALF_OPEN provider admission through native %s", async (mode) => {
    const f = fixture(provider);
    const failures = vi.spyOn(CircuitBreaker.prototype, "recordFailure");
    f.providerFetch.mockResolvedValueOnce(
      Response.json({ error: { type: "rate_limit_error" } }, { status: 429 }),
    );
    await expect(f.create()).rejects.toBeInstanceOf(Error);
    const breaker = failures.mock.contexts[0];
    expect(breaker).toBeInstanceOf(CircuitBreaker);
    if (!(breaker instanceof CircuitBreaker)) throw new Error("provider breaker missing");
    expect(breaker.getState().state).toBe("open");
    // A distinct model requires fresh reservation authority instead of an allow-cache hit.
    const stream = await f.create(provider === "openai" ? "gpt-4.1" : "claude-opus-4-1");
    expect(breaker?.getState().state).toBe("half_open");
    expect(breaker?.admit().allowed).toBe(false);
    if (mode === "readable") await drainReadable(stream.toReadableStream());
    else {
      const [left, right] = stream.tee();
      await Promise.all([drain(left), drain(right)]);
    }
    expect(breaker?.getState().state).toBe("closed");
    expect(breaker?.admit().allowed).toBe(true);
    await f.wrapped.close();
    expect(f.confirms).toHaveLength(1);
    expect(f.events.filter((event) => event["status"] === "success")).toHaveLength(1);
  });

  it.each([
    "readable",
    "tee",
  ] as const)("preserves an established native first-read failure through %s", async (mode) => {
    const f = fixture(provider);
    const stream = await f.create();
    const failure = new TypeError();
    f.failNextRead(failure);
    if (mode === "readable")
      await expect(drainReadable(stream.toReadableStream())).rejects.toBe(failure);
    else {
      const [left, right] = stream.tee();
      await expect(drain(left)).rejects.toBe(failure);
      await expect(drain(right)).rejects.toBe(failure);
    }
    await stream.close();
    await f.wrapped.close();
    expect(f.providerFetch).toHaveBeenCalledTimes(1);
    expect(f.isAborted()).toBe(true);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.["status"]).toBe("error");
  });
});

describe("native converted cross-dialect streams", () => {
  it.each([
    "readable",
    "tee",
  ] as const)("translates the served Anthropic chunks through %s and settles its usage once", async (mode) => {
    const f = fixture("anthropic", false, true);
    const stream = await f.create();
    let delivered = 0;
    let preserved = false;
    const consume = async (iterable: AsyncIterable<unknown>) => {
      for await (const item of iterable) {
        delivered++;
        expect(Array.isArray((item as Record<string, unknown>)["choices"])).toBe(true);
        preserved ||= f.preservesMarker(item);
      }
    };
    if (mode === "readable") {
      const reader = stream.toReadableStream().getReader();
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        const value = JSON.parse(new TextDecoder().decode(item.value));
        expect(Array.isArray(value.choices)).toBe(true);
        preserved ||= f.preservesMarker(value);
        delivered++;
      }
    } else {
      const [left, right] = stream.tee();
      await consume(left);
      await consume(right);
    }
    expect(preserved).toBe(true);
    expect(delivered).toBe(mode === "tee" ? 2 : 1);
    await f.wrapped.close();
    expect(f.confirms).toHaveLength(1);
    expect(f.confirms[0]).toMatchObject({
      provider: "anthropic",
      token_details: { input_tokens: 30, output_tokens: 20 },
    });
    expect(f.events.filter((event) => event["status"] === "success")).toHaveLength(1);
  });

  it.each([
    "readable",
    "tee",
  ] as const)("enforces a retained stop before translated %s output", async (mode) => {
    const f = fixture("anthropic", false, true);
    await run("translated-stream-stop", async () => {
      const stream = await f.create();
      markTerminated(currentRun()?.agentRunId ?? "", { source: "server", reason: "run_stopped" });
      if (mode === "readable")
        await expect(drainReadable(stream.toReadableStream())).rejects.toMatchObject({
          name: "RunStoppedError",
        });
      else {
        const [left, right] = stream.tee();
        await expect(drain(left)).rejects.toMatchObject({ name: "RunStoppedError" });
        await expect(drain(right)).rejects.toMatchObject({ name: "RunStoppedError" });
      }
    });
    await f.wrapped.close();
    expect(f.isAborted()).toBe(true);
    expect(f.confirms).toHaveLength(1);
    expect(f.confirms[0]).toMatchObject({
      provider: "anthropic",
      token_details: { input_tokens: 0, output_tokens: 0 },
    });
  });
});
