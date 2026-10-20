/**
 * Trace correlation against the REAL OpenTelemetry JS API.
 *
 * `src/trace-context.ts` reads `@opentelemetry/api`'s process-global registry structurally,
 * without importing OpenTelemetry. These tests register the real API with an
 * `AsyncLocalStorageContextManager` and a `BasicTracerProvider` (devDependencies only) and
 * prove, end to end:
 *
 *  1. `captureTrace()` returns exactly the active span's ids and sampled flag (root, nested
 *     child, across `await` / timer continuations, an unsampled remote parent), and nothing
 *     outside a span, for the invalid span context, or without a context manager;
 *  2. privacy: the only member read on the span is `spanContext`, and only `traceId`,
 *     `spanId`, and `traceFlags` are read from the returned span context;
 *  3. `withoutTraceContext(fn)` removes the active span and baggage (but keeps other context
 *     keys) for work `fn` launches, leaves the caller's context intact, runs `fn` once, and
 *     passes its value or error through unchanged;
 *  4. background control-plane I/O (reporter ingest and breaker reports, lease renewal,
 *     lease surrender, untracked-surface advisories) carries no span or baggage, while the
 *     budget preflight (check / lease grant) intentionally stays in the caller's context —
 *     the analogue of the Python SDK's
 *     `test_background_http_has_empty_context_while_preflight_keeps_caller_context`;
 *  5. a stream created under span A but consumed, cancelled, or abandoned under span B
 *     still reports span A.
 *
 * Every test unregisters the API's globals and deletes the registry symbol afterwards so
 * other test files sharing this worker never observe OpenTelemetry.
 */

import {
  type Context,
  context,
  createContextKey,
  INVALID_SPAN_CONTEXT,
  propagation,
  type Span,
  type SpanContext,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AlwaysOffSampler, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolwynMiddleware } from "../../src/ai-sdk";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { run } from "../../src/node";
import { resetRunControlForTest } from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing";
import { captureTrace, withoutTraceContext } from "../../src/trace-context";
import type { FetchLike } from "../../src/transport";
import type { MetadataEvent } from "../../src/types";

const REGISTRY_KEY = Symbol.for("opentelemetry.js.api.1");
const CUSTOM_KEY = createContextKey("solwyn-test-application-key");

const REMOTE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const REMOTE_SPAN_ID = "00f067aa0ba902b7";

let provider: BasicTracerProvider | undefined;

function registerContextManager(): void {
  expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(
    true,
  );
}

function registerTracerProvider(config?: ConstructorParameters<typeof BasicTracerProvider>[0]) {
  provider = new BasicTracerProvider(config);
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  return trace.getTracer("solwyn-trace-correlation-test");
}

function registerOtel() {
  registerContextManager();
  return registerTracerProvider();
}

beforeEach(() => {
  // Nothing in this worker may have left an OpenTelemetry registry behind.
  expect(Reflect.get(globalThis, REGISTRY_KEY)).toBeUndefined();
});

afterEach(async () => {
  context.disable();
  trace.disable();
  propagation.disable();
  await provider?.shutdown();
  provider = undefined;
  Reflect.deleteProperty(globalThis, REGISTRY_KEY);
  resetRunControlForTest();
  vi.restoreAllMocks();
});

function expected(spanContext: SpanContext) {
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    sampled: (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED,
  };
}

function remoteUnsampledContext(): Context {
  return trace.setSpan(
    context.active(),
    trace.wrapSpanContext({
      traceId: REMOTE_TRACE_ID,
      spanId: REMOTE_SPAN_ID,
      traceFlags: TraceFlags.NONE,
      isRemote: true,
    }),
  );
}

function callerContext(): Context {
  return propagation
    .setBaggage(
      context.active(),
      propagation.createBaggage({ "synthetic-key": { value: "synthetic-value" } }),
    )
    .setValue(CUSTOM_KEY, "caller");
}

interface ContextObservation {
  readonly spanId: string | undefined;
  readonly baggage: boolean;
  readonly custom: unknown;
}

function observeContext(): ContextObservation {
  return {
    spanId: trace.getActiveSpan()?.spanContext().spanId,
    baggage: propagation.getBaggage(context.active()) !== undefined,
    custom: context.active().getValue(CUSTOM_KEY),
  };
}

function nextTimer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// 1. captureTrace() reads exactly the active span.
// ---------------------------------------------------------------------------

describe("captureTrace with the real OpenTelemetry API", () => {
  it("returns the active span's ids inside startActiveSpan and nested children", () => {
    const tracer = registerOtel();
    tracer.startActiveSpan("parent", (parent) => {
      expect(captureTrace()).toEqual(expected(parent.spanContext()));
      expect(captureTrace()?.sampled).toBe(true);
      tracer.startActiveSpan("child", (child) => {
        const captured = captureTrace();
        expect(captured).toEqual(expected(child.spanContext()));
        expect(captured?.traceId).toBe(parent.spanContext().traceId);
        expect(captured?.spanId).not.toBe(parent.spanContext().spanId);
        child.end();
      });
      // Leaving the child restores the parent.
      expect(captureTrace()).toEqual(expected(parent.spanContext()));
      parent.end();
    });
  });

  it("follows await, microtask, and timer continuations inside the span", async () => {
    const tracer = registerOtel();
    await tracer.startActiveSpan("async-parent", async (span) => {
      const want = expected(span.spanContext());
      await Promise.resolve();
      expect(captureTrace()).toEqual(want);
      await nextTimer();
      expect(captureTrace()).toEqual(want);
      const fromTimer = await new Promise((resolve) =>
        setTimeout(() => resolve(captureTrace()), 1),
      );
      expect(fromTimer).toEqual(want);
      const fromMicrotask = await new Promise((resolve) =>
        queueMicrotask(() => resolve(captureTrace())),
      );
      expect(fromMicrotask).toEqual(want);
      span.end();
    });
    expect(captureTrace()).toBeUndefined();
  });

  it("reports an unsampled remote parent as sampled: false", () => {
    registerOtel();
    expect(context.with(remoteUnsampledContext(), () => captureTrace())).toEqual({
      traceId: REMOTE_TRACE_ID,
      spanId: REMOTE_SPAN_ID,
      sampled: false,
    });
  });

  it("reports a span dropped by the sampler as sampled: false", () => {
    registerContextManager();
    const tracer = registerTracerProvider({ sampler: new AlwaysOffSampler() });
    tracer.startActiveSpan("unsampled", (span) => {
      expect(span.isRecording()).toBe(false);
      expect(captureTrace()).toEqual({ ...expected(span.spanContext()), sampled: false });
      span.end();
    });
  });

  it("returns undefined outside spans and for the invalid span context", () => {
    registerOtel();
    expect(captureTrace()).toBeUndefined();
    expect(
      context.with(trace.setSpanContext(context.active(), INVALID_SPAN_CONTEXT), () =>
        captureTrace(),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when a tracer provider is registered without a context manager", () => {
    const tracer = registerTracerProvider();
    const registry = Reflect.get(globalThis, REGISTRY_KEY) as Record<string, unknown>;
    expect(registry).toBeDefined();
    expect(registry["context"]).toBeUndefined();
    tracer.startActiveSpan("no-context-manager", (span) => {
      expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(captureTrace()).toBeUndefined();
      span.end();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Privacy: only spanContext() and three span-context fields are read.
// ---------------------------------------------------------------------------

describe("captureTrace privacy with real spans", () => {
  function recordingProxy<T extends object>(target: T, accessed: PropertyKey[]): T {
    return new Proxy(target, {
      get(inner, key) {
        accessed.push(key);
        return Reflect.get(inner, key, inner);
      },
      has(inner, key) {
        accessed.push(`has:${String(key)}`);
        return Reflect.has(inner, key);
      },
      ownKeys(inner) {
        accessed.push("ownKeys");
        return Reflect.ownKeys(inner);
      },
      getOwnPropertyDescriptor(inner, key) {
        accessed.push(`descriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(inner, key);
      },
      getPrototypeOf(inner) {
        accessed.push("getPrototypeOf");
        return Reflect.getPrototypeOf(inner);
      },
    });
  }

  it.each([
    "recording",
    "remote",
  ])("reads only spanContext and traceId/spanId/traceFlags (%s span)", (kind) => {
    const tracer = registerOtel();
    let real: Span;
    if (kind === "recording") {
      real = tracer.startSpan("synthetic-operation-name", {
        attributes: { "synthetic.attribute": "synthetic-attribute-value" },
      });
      real.addEvent("synthetic-event", { "synthetic.event": "value" });
      real.setStatus({ code: 2, message: "synthetic status" });
    } else {
      real = trace.wrapSpanContext({
        traceId: REMOTE_TRACE_ID,
        spanId: REMOTE_SPAN_ID,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
    }
    const spanAccess: PropertyKey[] = [];
    const contextAccess: PropertyKey[] = [];
    const realContext = real.spanContext();
    const recordedSpanContext = recordingProxy(
      { ...realContext, traceState: realContext.traceState },
      contextAccess,
    );
    // Calls are forwarded to the real span with the real receiver, so the span's own
    // implementation details are not mistaken for SDK reads.
    const spanProxy = new Proxy(real, {
      get(target, key) {
        spanAccess.push(key);
        const value = Reflect.get(target, key, target);
        if (key === "spanContext") return () => recordedSpanContext;
        return typeof value === "function" ? value.bind(target) : value;
      },
      has(target, key) {
        spanAccess.push(`has:${String(key)}`);
        return Reflect.has(target, key);
      },
      ownKeys(target) {
        spanAccess.push("ownKeys");
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        spanAccess.push(`descriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const captured = context.with(trace.setSpan(context.active(), spanProxy), () => captureTrace());

    expect(captured).toEqual(expected(realContext));
    expect(spanAccess).toEqual(["spanContext"]);
    expect([...contextAccess].sort()).toEqual(["spanId", "traceFlags", "traceId"]);
    expect(contextAccess).not.toContain("traceState");
    expect(contextAccess).not.toContain("isRemote");
    real.end();
  });
});

// ---------------------------------------------------------------------------
// 3. withoutTraceContext with the real context manager.
// ---------------------------------------------------------------------------

describe("withoutTraceContext with the real OpenTelemetry API", () => {
  it("detaches span and baggage for launched work but keeps other context keys", async () => {
    const tracer = registerOtel();
    await tracer.startActiveSpan("caller", async (span) => {
      await context.with(callerContext(), async () => {
        const callerView = observeContext();
        expect(callerView).toEqual({
          spanId: span.spanContext().spanId,
          baggage: true,
          custom: "caller",
        });

        const inside: ContextObservation[] = [];
        const fn = vi.fn(() => {
          inside.push(observeContext());
          const fromTimer = new Promise<ContextObservation>((resolve) =>
            setTimeout(() => resolve(observeContext()), 1),
          );
          const fromPromise = Promise.resolve().then(() => observeContext());
          const fromChain = nextTimer()
            .then(() => Promise.resolve())
            .then(() => observeContext());
          return { fromTimer, fromPromise, fromChain, marker: "returned" };
        });

        const result = withoutTraceContext(fn);

        // The caller's context is unchanged once fn returns.
        expect(observeContext()).toEqual(callerView);
        expect(fn).toHaveBeenCalledOnce();
        expect(result.marker).toBe("returned");
        const detached = { spanId: undefined, baggage: false, custom: "caller" };
        expect(inside).toEqual([detached]);
        expect(await result.fromTimer).toEqual(detached);
        expect(await result.fromPromise).toEqual(detached);
        expect(await result.fromChain).toEqual(detached);
        // ...and still unchanged after the launched work ran.
        expect(observeContext()).toEqual(callerView);
      });
      span.end();
    });
  });

  it("detaches baggage even when no span is active", () => {
    registerOtel();
    const ctx = callerContext();
    context.with(ctx, () => {
      expect(withoutTraceContext(() => observeContext())).toEqual({
        spanId: undefined,
        baggage: false,
        custom: "caller",
      });
      expect(observeContext()).toEqual({ spanId: undefined, baggage: true, custom: "caller" });
    });
  });

  it("propagates fn's error unchanged and runs fn exactly once", () => {
    const tracer = registerOtel();
    tracer.startActiveSpan("caller", (span) => {
      const failure = new Error("synthetic failure");
      const fn = vi.fn(() => {
        expect(trace.getActiveSpan()).toBeUndefined();
        throw failure;
      });
      expect(() => withoutTraceContext(fn)).toThrow(failure);
      expect(fn).toHaveBeenCalledOnce();
      expect(trace.getActiveSpan()).toBe(span);

      const thrownValue = { synthetic: true };
      const throwsValue = vi.fn(() => {
        throw thrownValue;
      });
      let caught: unknown;
      try {
        withoutTraceContext(throwsValue);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(thrownValue);
      expect(throwsValue).toHaveBeenCalledOnce();
      span.end();
    });
  });

  it("passes a returned promise through and keeps it detached", async () => {
    const tracer = registerOtel();
    await tracer.startActiveSpan("caller", async (span) => {
      const value = { synthetic: "value" };
      const promise = withoutTraceContext(async () => {
        await nextTimer();
        expect(trace.getActiveSpan()).toBeUndefined();
        return value;
      });
      expect(trace.getActiveSpan()).toBe(span);
      expect(await promise).toBe(value);
      span.end();
    });
  });

  it("runs fn directly without a registered context manager", () => {
    const tracer = registerTracerProvider();
    const fn = vi.fn(() => "direct");
    tracer.startActiveSpan("no-context-manager", (span) => {
      expect(withoutTraceContext(fn)).toBe("direct");
      span.end();
    });
    expect(withoutTraceContext(fn)).toBe("direct");
    expect(fn).toHaveBeenCalledTimes(2);
    const failure = new Error("synthetic failure");
    expect(() =>
      withoutTraceContext(() => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});

// ---------------------------------------------------------------------------
// 4. Background control-plane I/O runs outside the caller's trace.
// ---------------------------------------------------------------------------

describe("background control-plane I/O with a real context manager", () => {
  type Phase = "call" | "close";
  type Seen = ContextObservation & { readonly path: string; readonly phase: Phase };

  /**
   * Construct, use, and close a client entirely inside the caller's span and context, so
   * every background loop (the reporter's tick chain included) is launched from it.
   */
  async function driveUnderCallerSpan() {
    const tracer = registerOtel();
    // A 4096-token default output bound against a 5000-token grant crosses the 75%
    // depletion threshold on the first leased call, so a renewal launches from it.
    const plane = new FakeControlPlane({ grantedTokens: 5_000 });
    let phase: Phase = "call";
    const seen: Seen[] = [];
    const fetch: FetchLike = (input, init) => {
      seen.push({ path: new URL(input).pathname, phase, ...observeContext() });
      return plane.fetch(input, init);
    };
    const create = vi.fn(async (_request: Record<string, unknown>) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const client = {
      chat: { completions: { create } },
      futureSyntheticSurface: () => "untracked",
    };
    const tail = (path: string) => path.split("/").at(-1);
    let callerSpanId = "";
    let solwyn: ReturnType<typeof makeClient> | undefined;
    const makeClient = () =>
      new Solwyn(client, {
        apiKey: plane.apiKey,
        apiUrl: plane.apiUrl,
        fetch,
        logger: noopLogger,
        provider: "openai",
        onUnmetered: "allow",
        reporterFlushInterval: 0.01,
        budgetCheckCacheTtl: 0,
        velocityMode: "off",
      });
    try {
      await tracer.startActiveSpan("caller", async (span) => {
        callerSpanId = span.spanContext().spanId;
        await context.with(callerContext(), async () => {
          const wrapped = makeClient();
          solwyn = wrapped;
          // (a) an unscoped per-call budget check, then a run-scoped lease grant whose
          // admission launches (c) a renewal.
          await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
          await run("otel-background-context", async () => {
            await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });
          });
          // (e) an untracked-surface advisory from an unknown provider surface.
          expect(Reflect.get(wrapped, "futureSyntheticSurface")).toBeTypeOf("function");
          // (b) confirms, ingest, and breaker reports arrive through the reporter's tick chain.
          await waitFor(
            () =>
              ["confirm", "ingest", "renew", "untracked-surfaces", "breaker-reports"].every(
                (path) => seen.some((entry) => tail(entry.path) === path),
              ),
            "background control-plane requests",
          );
          expect(observeContext()).toEqual({
            spanId: callerSpanId,
            baggage: true,
            custom: "caller",
          });
          // (d) closing from the caller's span surrenders the run's lease.
          phase = "close";
          await wrapped.close();
        });
        span.end();
      });
    } finally {
      await solwyn?.close();
    }
    expect(create).toHaveBeenCalledTimes(2);
    return { plane, seen, callerSpanId, tail };
  }

  it("keeps preflight in the caller's context while background requests see no span or baggage", async () => {
    const { plane, seen, callerSpanId, tail } = await driveUnderCallerSpan();

    expect(plane.leaseGrants).toHaveLength(1);
    expect(plane.leaseRenewals.length).toBeGreaterThan(0);
    expect(plane.leaseSurrenders).toHaveLength(1);
    expect(plane.untrackedReports.length).toBeGreaterThan(0);
    expect(plane.breakerReports.length).toBeGreaterThan(0);
    expect(plane.confirms).toHaveLength(2);
    expect(plane.ingested).toHaveLength(2);

    // The budget preflight intentionally runs in the caller's context.
    const callerView = { spanId: callerSpanId, baggage: true, custom: "caller" };
    const preflight = seen.filter(
      ({ path }) => path === "/api/v1/budgets/check" || path === "/api/v1/budgets/lease",
    );
    expect(preflight.map(({ path }) => path)).toEqual([
      "/api/v1/budgets/check",
      "/api/v1/budgets/lease",
    ]);
    for (const { spanId, baggage, custom } of preflight) {
      expect({ spanId, baggage, custom }).toEqual(callerView);
    }

    // Every background request launched while the caller's span was active, plus the
    // lease surrender close() dispatches from inside it.
    const background = seen.filter(
      (entry) =>
        !preflight.includes(entry) &&
        (entry.phase === "call" || entry.path === "/api/v1/budgets/lease/surrender"),
    );
    expect(new Set(background.map(({ path }) => tail(path)))).toEqual(
      new Set(["confirm", "ingest", "renew", "surrender", "untracked-surfaces", "breaker-reports"]),
    );
    for (const { path, spanId, baggage, custom } of background) {
      // Only the span and baggage are removed; other application context survives.
      expect({ path, spanId, baggage, custom }).toEqual({
        path,
        spanId: undefined,
        baggage: false,
        custom: "caller",
      });
    }
    expect(seen.filter(({ path }) => tail(path) === "surrender")).toHaveLength(1);
  });

  // MetadataReporter.close() runs its final flush and forced breaker-report cycle as the
  // reporter's own work, so closing from inside a span sends neither the span nor baggage
  // (matching the Python SDK's empty context for close-time breaker reports).
  it("detaches close-time reporter delivery from the closing caller's span", async () => {
    const { seen } = await driveUnderCallerSpan();
    const closeTime = seen.filter(
      ({ path, phase }) => phase === "close" && path !== "/api/v1/budgets/lease/surrender",
    );
    expect(closeTime.length).toBeGreaterThan(0);
    for (const { path, spanId, baggage } of closeTime) {
      expect({ path, spanId, baggage }).toEqual({ path, spanId: undefined, baggage: false });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Streams consumed in another async context keep the call-start span.
// ---------------------------------------------------------------------------

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

const STREAM_BODY = sse([
  {
    id: "chatcmpl-synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content: "synthetic" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
  {
    id: "chatcmpl-synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  },
]);

describe("streams settled under another span keep the call-start span", () => {
  function streamingSolwyn(plane: FakeControlPlane) {
    const providerFetch = vi.fn<typeof fetch>(
      async () => new Response(STREAM_BODY, { headers: { "content-type": "text/event-stream" } }),
    );
    return new Solwyn(new OpenAI({ apiKey: "offline", maxRetries: 0, fetch: providerFetch }), {
      apiKey: plane.apiKey,
      apiUrl: plane.apiUrl,
      fetch: plane.fetch,
      logger: noopLogger,
      leaseEnabled: false,
      velocityMode: "off",
      reportUntrackedSurfaces: false,
      budgetCheckCacheTtl: 0,
    });
  }

  it.each([
    "consumed",
    "cancelled",
    "abandoned",
  ] as const)("core client stream %s under span B reports span A", async (mode) => {
    const tracer = registerOtel();
    const plane = new FakeControlPlane();
    const solwyn = streamingSolwyn(plane);
    const spanA = tracer.startSpan("span-a");
    const spanB = tracer.startSpan("span-b");
    try {
      const stream = await context.with(trace.setSpan(context.active(), spanA), () =>
        solwyn.chat.completions.create({ model: "gpt-4o", messages: [], stream: true }),
      );
      await context.with(trace.setSpan(context.active(), spanB), async () => {
        expect(captureTrace()?.spanId).toBe(spanB.spanContext().spanId);
        if (mode === "consumed") {
          for await (const _chunk of stream) {
            /* drain under span B */
          }
        } else if (mode === "cancelled") {
          for await (const _chunk of stream) break;
        }
        // "abandoned": never iterated; close() settles it from span B.
        await solwyn.close();
      });
    } finally {
      await solwyn.close();
      spanA.end();
      spanB.end();
    }

    expect(plane.ingested).toHaveLength(1);
    const event = plane.ingested[0] as MetadataEvent;
    if (mode === "consumed") {
      expect(event).toMatchObject({ status: "success", input_tokens: 5, output_tokens: 2 });
    }
    expect(event).toMatchObject({
      trace_id: spanA.spanContext().traceId,
      span_id: spanA.spanContext().spanId,
      trace_sampled: true,
    });
    expect(event.span_id).not.toBe(spanB.spanContext().spanId);
  });

  it.each([
    "consumed",
    "cancelled",
    "abandoned",
  ] as const)("AI SDK middleware stream %s under span B reports span A", async (mode) => {
    const tracer = registerOtel();
    const plane = new FakeControlPlane();
    const handle = createSolwynMiddleware({
      apiKey: plane.apiKey,
      apiUrl: plane.apiUrl,
      fetch: plane.fetch,
      logger: noopLogger,
      breakerReportingEnabled: false,
      leaseEnabled: false,
    });
    const wrapStream = handle.middleware.wrapStream as unknown as (
      args: unknown,
    ) => Promise<{ stream: ReadableStream<unknown> }>;
    const spanA = tracer.startSpan("span-a");
    const spanB = tracer.startSpan("span-b");
    try {
      const result = await context.with(trace.setSpan(context.active(), spanA), () =>
        wrapStream({
          model: { provider: "openai", modelId: "gpt-4o" },
          params: { prompt: [] },
          doStream: async () => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "text-delta", delta: "synthetic" });
                controller.enqueue({
                  type: "finish",
                  usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } },
                });
                controller.close();
              },
            }),
          }),
        }),
      );
      await context.with(trace.setSpan(context.active(), spanB), async () => {
        const reader = result.stream.getReader();
        if (mode === "consumed") {
          while (!(await reader.read()).done) {
            /* drain under span B */
          }
        } else if (mode === "cancelled") {
          await reader.read();
          await reader.cancel();
        }
        await handle.close();
      });
    } finally {
      await handle.close();
      spanA.end();
      spanB.end();
    }

    expect(plane.ingested).toHaveLength(1);
    expect(plane.ingested[0]).toMatchObject({
      status: "success",
      trace_id: spanA.spanContext().traceId,
      span_id: spanA.spanContext().spanId,
      trace_sampled: true,
    });
  });
});
