/**
 * OpenTelemetry trace correlation through the AI SDK middleware (`src/ai-sdk/index.ts`).
 *
 * A FAKE `@opentelemetry/api` 1.x registry is installed at the process-global symbol, so
 * these tests need no OpenTelemetry package. Its context manager keeps one synchronous
 * "active" context the test can switch at will, and every fake span counts how often its
 * `spanContext()` is read. That lets each test prove the middleware's contract:
 *
 *  - the trace is captured exactly ONCE, synchronously at call start (one `spanContext()`
 *    read per call), and every event of the call carries that call-start snapshot;
 *  - it is never re-read later: switching the active span before a stream is consumed,
 *    cancelled, abandoned, or settled at close does not change the event's trace and never
 *    touches the new span;
 *  - `traceCorrelation: false`, an absent registry, or a registry without a context manager
 *    yields no trace fields at all (omitted, never null) and no capture;
 *  - an unsampled span serializes `trace_sampled: false` on the wire.
 *
 * Wire events are recorded by the hermetic `FakeControlPlane`, which validates every ingest
 * batch against the strict metadata-event schema.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolwynMiddleware } from "../../src/ai-sdk";
import { noopLogger } from "../../src/logging";
import { currentRun, run } from "../../src/node";
import { markTerminated, resetRunControlForTest } from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing";
import type { FetchLike } from "../../src/transport";
import type { MetadataEvent } from "../../src/types";

const REGISTRY_KEY = Symbol.for("opentelemetry.js.api.1");
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

const TRACE_A = "0af7651916cd43dd8448eb211c80319c";
const SPAN_A = "b7ad6b7169203331";
const TRACE_B = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_B = "00f067aa0ba902b7";

// ---------------------------------------------------------------------------
// Fake OpenTelemetry registry.
// ---------------------------------------------------------------------------

/** Immutable context exposing only the members the API's `Context` interface defines. */
class FakeContext {
  readonly #values: ReadonlyMap<symbol, unknown>;

  constructor(values: ReadonlyMap<symbol, unknown> = new Map()) {
    this.#values = values;
  }

  getValue(key: symbol): unknown {
    return this.#values.get(key);
  }

  setValue(key: symbol, value: unknown): FakeContext {
    const next = new Map(this.#values);
    next.set(key, value);
    return new FakeContext(next);
  }

  deleteValue(key: symbol): FakeContext {
    const next = new Map(this.#values);
    next.delete(key);
    return new FakeContext(next);
  }
}

interface FakeSpan {
  /** How many times `spanContext()` was called. */
  reads: number;
  spanContext(): { traceId: string; spanId: string; traceFlags: number };
}

function fakeSpan(traceId: string, spanId: string, traceFlags = 1): FakeSpan {
  const span: FakeSpan = {
    reads: 0,
    spanContext() {
      span.reads += 1;
      return { traceId, spanId, traceFlags };
    },
  };
  return span;
}

/** Install a registry whose context manager holds one synchronously switchable context. */
function installRegistry(initial: FakeContext = new FakeContext()) {
  let active = initial;
  const manager = {
    active: vi.fn(() => active),
    with: vi.fn((context: FakeContext, fn: () => unknown) => {
      const previous = active;
      active = context;
      try {
        return fn();
      } finally {
        active = previous;
      }
    }),
  };
  Reflect.set(globalThis, REGISTRY_KEY, { version: "1.9.1", context: manager });
  return {
    manager,
    activate(span: FakeSpan | undefined): void {
      active = span === undefined ? new FakeContext() : new FakeContext().setValue(SPAN_KEY, span);
    },
  };
}

function activeSpan(span: FakeSpan): FakeContext {
  return new FakeContext().setValue(SPAN_KEY, span);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, REGISTRY_KEY);
  resetRunControlForTest();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Middleware harness (mirrors ai-sdk-lifecycle.test.ts).
// ---------------------------------------------------------------------------

type Handle = ReturnType<typeof createSolwynMiddleware>;
interface Params {
  prompt: unknown;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}
const model = { provider: "openai", modelId: "gpt-4o" };
const usage = { inputTokens: { total: 50 }, outputTokens: { total: 20 } };

function generate(handle: Handle, params: Params, doGenerate: () => Promise<unknown>) {
  const wrap = handle.middleware.wrapGenerate as unknown as (args: unknown) => Promise<unknown>;
  return wrap({ model, params, doGenerate });
}

function stream(
  handle: Handle,
  params: Params,
  doStream: () => Promise<{ stream: ReadableStream<unknown> }>,
) {
  const wrap = handle.middleware.wrapStream as unknown as (
    args: unknown,
  ) => Promise<{ stream: ReadableStream<unknown> }>;
  return wrap({ model, params, doStream });
}

function fixture(
  options: Parameters<typeof createSolwynMiddleware>[0] = {},
  plane = new FakeControlPlane(),
) {
  const bodies: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    if (new URL(input).pathname === "/api/v1/metadata/ingest" && typeof init?.body === "string") {
      bodies.push(init.body);
    }
    return plane.fetch(input, init);
  };
  const handle = createSolwynMiddleware({
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch,
    logger: noopLogger,
    breakerReportingEnabled: false,
    leaseEnabled: false,
    budgetCheckCacheTtl: 0,
    ...options,
  });
  return { plane, handle, bodies };
}

function streamOf(chunks: readonly unknown[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function streamThenError(chunks: readonly unknown[], error: Error): ReadableStream<unknown> {
  let index = 0;
  return new ReadableStream<unknown>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else {
        controller.error(error);
      }
    },
  });
}

async function drain(readable: ReadableStream<unknown>): Promise<unknown> {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return undefined;
    }
  } catch (error) {
    return error;
  }
}

function expectTrace(
  event: MetadataEvent | undefined,
  traceId: string,
  spanId: string,
  sampled = true,
): void {
  expect(event).toBeDefined();
  expect(event?.trace_id).toBe(traceId);
  expect(event?.span_id).toBe(spanId);
  expect(event?.trace_sampled).toBe(sampled);
}

function expectNoTraceFields(events: readonly MetadataEvent[], bodies: readonly string[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event).not.toHaveProperty("trace_id");
    expect(event).not.toHaveProperty("span_id");
    expect(event).not.toHaveProperty("trace_sampled");
  }
  for (const body of bodies) {
    expect(body).not.toContain("trace_id");
    expect(body).not.toContain("span_id");
    expect(body).not.toContain("trace_sampled");
  }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("AI SDK trace correlation: buffered calls", () => {
  it("stamps the call-start span on a wrapGenerate success read exactly once", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle, bodies } = fixture();

    await generate(handle, { prompt: [] }, async () => {
      // The provider runs after the capture; a span switch here must not leak in.
      registry.activate(spanB);
      return { content: [], usage };
    });
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.status).toBe("success");
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
    expect(bodies.join("")).toContain(`"trace_id":"${TRACE_A}"`);
  });

  it("stamps the call-start span on a wrapGenerate provider error", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();
    const failure = new Error("synthetic provider failure");

    await expect(
      generate(handle, { prompt: [] }, async () => {
        registry.activate(spanB);
        throw failure;
      }),
    ).rejects.toBe(failure);
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.status).toBe("error");
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });

  it("stamps the call-start span on a preflight budget denial receipt", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();
    plane.denyNext(1);
    const dispatch = vi.fn(async () => ({ content: [], usage }));

    await expect(generate(handle, { prompt: [] }, dispatch)).rejects.toMatchObject({
      name: "BudgetExceededError",
    });
    await handle.close();

    expect(dispatch).not.toHaveBeenCalled();
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.status).toBe("budget_denied");
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
  });

  it("stamps the call-start span on a server run-stopped preflight receipt", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();
    const dispatch = vi.fn(async () => ({ content: [], usage }));

    await run("trace-run-stopped", async () => {
      plane.stopRun(currentRun()?.agentRunId ?? "");
      await expect(generate(handle, { prompt: [] }, dispatch)).rejects.toMatchObject({
        name: "RunStoppedError",
      });
    });
    await handle.close();

    expect(dispatch).not.toHaveBeenCalled();
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.status).toBe("budget_denied");
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
  });

  it.each([
    false,
    true,
  ])("stamps the call-start span on a run stop raised after preflight (streaming=%s)", async (streaming) => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const plane = new FakeControlPlane();
    const { handle } = fixture(
      {
        fetch: async (input, init) => {
          if (new URL(input).pathname === "/api/v1/budgets/check") {
            // A concurrent stop lands while the preflight is in flight, and the caller's
            // active span changes before the dispatch gate reports the receipt.
            markTerminated(currentRun()?.agentRunId ?? "", {
              reason: "synthetic-stop",
              source: "local_velocity",
            });
            registry.activate(spanB);
          }
          return plane.fetch(input, init);
        },
      },
      plane,
    );
    const dispatch = vi.fn();

    await expect(
      run("trace-stop-after-preflight", () =>
        streaming
          ? stream(handle, { prompt: [] }, async () => {
              dispatch();
              return { stream: streamOf([]) };
            })
          : generate(handle, { prompt: [] }, async () => {
              dispatch();
              return { content: [], usage };
            }),
      ),
    ).rejects.toMatchObject({ name: "RunStoppedError" });
    await handle.close();

    expect(dispatch).not.toHaveBeenCalled();
    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.status).toBe("budget_denied");
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });
});

describe("AI SDK trace correlation: streams", () => {
  it("keeps the call-start span when the active span switches before the stream is consumed", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();

    const result = await stream(handle, { prompt: [] }, async () => ({
      stream: streamOf([
        { type: "text-delta", delta: "synthetic" },
        { type: "finish", usage },
      ]),
    }));
    registry.activate(spanB);
    expect(await drain(result.stream)).toBeUndefined();
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "success",
      input_tokens: 50,
      output_tokens: 20,
    });
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });

  it("stamps the call-start span on a mid-stream provider error", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();
    const failure = new Error("synthetic stream failure");

    const result = await stream(handle, { prompt: [] }, async () => ({
      stream: streamThenError([{ type: "text-delta", delta: "synthetic" }], failure),
    }));
    registry.activate(spanB);
    expect(await drain(result.stream)).toBe(failure);
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({ status: "error", possibly_succeeded: true });
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });

  it("stamps the call-start span on a stream establishment failure", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();
    const failure = new Error("synthetic establishment failure");

    await expect(
      stream(handle, { prompt: [] }, async () => {
        registry.activate(spanB);
        throw failure;
      }),
    ).rejects.toBe(failure);
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.status).toBe("error");
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });

  it("stamps the call-start span when the caller cancels the stream", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();

    const result = await stream(handle, { prompt: [] }, async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", delta: "abcd" });
        },
      }),
    }));
    registry.activate(spanB);
    const reader = result.stream.getReader();
    await reader.read();
    await reader.cancel();
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.status).toBe("success");
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });

  it("stamps the call-start span on a caller-abort interrupted settlement", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<unknown>;

    const result = await stream(handle, { prompt: [], abortSignal: abort.signal }, async () => ({
      stream: new ReadableStream({
        start(controller) {
          source = controller;
          controller.enqueue({ type: "text-delta", delta: "abcd" });
        },
      }),
    }));
    registry.activate(spanB);
    const reader = result.stream.getReader();
    await reader.read();
    const next = reader.read();
    abort.abort();
    source.enqueue({ type: "text-delta", delta: "late" });
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({ status: "success", output_tokens: 2 });
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });

  it("stamps the call-start span on a mid-stream run-stop interrupted settlement", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();
    let source!: ReadableStreamDefaultController<unknown>;

    await run("trace-mid-stream-stop", async () => {
      const runId = currentRun()?.agentRunId ?? "";
      const result = await stream(handle, { prompt: [] }, async () => ({
        stream: new ReadableStream({
          start(controller) {
            source = controller;
            controller.enqueue({ type: "text-delta", delta: "abcd" });
          },
        }),
      }));
      registry.activate(spanB);
      const reader = result.stream.getReader();
      await reader.read();
      const next = reader.read();
      markTerminated(runId, { reason: "synthetic-stop", source: "server" });
      source.enqueue({ type: "text-delta", delta: "late" });
      await expect(next).rejects.toMatchObject({ name: "RunStoppedError" });
    });
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]?.status).toBe("success");
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });

  it("stamps the call-start span on an abandoned stream settled at close", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();
    const cancel = vi.fn();

    const result = await stream(handle, { prompt: [] }, async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", delta: "abcd" });
        },
        cancel,
      }),
    }));
    // Never consumed: close() owns the interrupted settlement, under another span.
    registry.activate(spanB);
    await handle.close();
    await result.stream.cancel().catch(() => {});

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "success",
      token_details: { is_estimated: true },
    });
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(0);
  });

  it("keeps each concurrent call's own call-start span", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    const spanB = fakeSpan(TRACE_B, SPAN_B);
    const registry = installRegistry(activeSpan(spanA));
    const { plane, handle } = fixture();

    const streamed = await stream(handle, { prompt: [] }, async () => ({
      stream: streamOf([{ type: "finish", usage }]),
    }));
    registry.activate(spanB);
    await generate(handle, { prompt: [] }, async () => ({ content: [], usage }));
    registry.activate(undefined);
    expect(await drain(streamed.stream)).toBeUndefined();
    await handle.close();

    expect(plane.ingested).toHaveLength(2);
    const [buffered, settledStream] = plane.ingested;
    expectTrace(buffered, TRACE_B, SPAN_B);
    expectTrace(settledStream, TRACE_A, SPAN_A);
    expect(buffered?.call_id).not.toBe(settledStream?.call_id);
    expect(spanA.reads).toBe(1);
    expect(spanB.reads).toBe(1);
  });
});

describe("AI SDK trace correlation: absent or disabled", () => {
  it.each([
    false,
    true,
  ])("traceCorrelation: false never reads the span (streaming=%s)", async (streaming) => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    installRegistry(activeSpan(spanA));
    const { plane, handle, bodies } = fixture({ traceCorrelation: false });

    if (streaming) {
      const result = await stream(handle, { prompt: [] }, async () => ({
        stream: streamOf([{ type: "finish", usage }]),
      }));
      expect(await drain(result.stream)).toBeUndefined();
    } else {
      await generate(handle, { prompt: [] }, async () => ({ content: [], usage }));
    }
    plane.denyNext(1);
    await expect(
      generate(handle, { prompt: [] }, async () => ({ content: [], usage })),
    ).rejects.toMatchObject({ name: "BudgetExceededError" });
    await handle.close();

    expect(plane.ingested.map((event) => event.status).sort()).toEqual([
      "budget_denied",
      "success",
    ]);
    expectNoTraceFields(plane.ingested, bodies);
    expect(spanA.reads).toBe(0);
  });

  it("omits trace fields without an OpenTelemetry registry", async () => {
    expect(Reflect.get(globalThis, REGISTRY_KEY)).toBeUndefined();
    const { plane, handle, bodies } = fixture();

    await generate(handle, { prompt: [] }, async () => ({ content: [], usage }));
    const result = await stream(handle, { prompt: [] }, async () => ({
      stream: streamOf([{ type: "finish", usage }]),
    }));
    expect(await drain(result.stream)).toBeUndefined();
    await handle.close();

    expect(plane.ingested).toHaveLength(2);
    expectNoTraceFields(plane.ingested, bodies);
  });

  it("omits trace fields when the API is loaded without a context manager", async () => {
    const spanA = fakeSpan(TRACE_A, SPAN_A);
    // The API's own registry exists (for example, a tracer provider was registered) but no
    // context manager is, so nothing can be active.
    Reflect.set(globalThis, REGISTRY_KEY, { version: "1.9.1", trace: { span: spanA } });
    const { plane, handle, bodies } = fixture();

    await generate(handle, { prompt: [] }, async () => ({ content: [], usage }));
    await handle.close();

    expectNoTraceFields(plane.ingested, bodies);
    expect(spanA.reads).toBe(0);
  });

  it("omits trace fields when no span is active", async () => {
    const registry = installRegistry();
    const { plane, handle, bodies } = fixture();

    await generate(handle, { prompt: [] }, async () => ({ content: [], usage }));
    await handle.close();

    expectNoTraceFields(plane.ingested, bodies);
    expect(registry.manager.active).toHaveBeenCalled();
  });

  it("serializes an unsampled span as trace_sampled: false", async () => {
    const unsampled = fakeSpan(TRACE_A.toUpperCase(), SPAN_A.toUpperCase(), 0);
    installRegistry(activeSpan(unsampled));
    const { plane, handle, bodies } = fixture();

    const result = await stream(handle, { prompt: [] }, async () => ({
      stream: streamOf([{ type: "finish", usage }]),
    }));
    expect(await drain(result.stream)).toBeUndefined();
    await handle.close();

    expect(plane.ingested).toHaveLength(1);
    // Ids are normalized to lowercase hex; `false` is a value, not an absent field.
    expectTrace(plane.ingested[0], TRACE_A, SPAN_A, false);
    expect(bodies).toHaveLength(1);
    const wire = JSON.parse(bodies[0] ?? "[]") as Array<Record<string, unknown>>;
    expect(wire[0]).toMatchObject({ trace_id: TRACE_A, span_id: SPAN_A, trace_sampled: false });
    expect(bodies[0]).toContain('"trace_sampled":false');
    expect(unsampled.reads).toBe(1);
  });
});
