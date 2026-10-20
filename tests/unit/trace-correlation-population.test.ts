/**
 * OpenTelemetry trace correlation population across the core wrapped-client paths.
 *
 * Every metadata event a logical call produces must carry exactly the span context that was
 * active when the call was issued: read synchronously, exactly once, and never re-read while
 * the call is admitted, dispatched, failed over, streamed, or settled. Each test installs a
 * fake `@opentelemetry/api` 1.x global registry (no OpenTelemetry dependency), counts
 * `spanContext()` reads per span, and switches the active span to a different trace as soon
 * as the call returns (and again inside provider dispatch) to prove no later read happens.
 * Events are asserted on the serialized ingest bodies the fake control plane received.
 */

import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SolwynOptions } from "../../src/client";
import { BudgetExceededError, RunStoppedError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { noopLogger } from "../../src/logging";
import { currentRun, run } from "../../src/node";
import { markTerminated, resetRunControlForTest } from "../../src/run-control";
import { FakeControlPlane, type FakeControlPlaneOptions } from "../../src/testing";
import type { FetchLike } from "../../src/transport";

// ---------------------------------------------------------------------------
// Fake OpenTelemetry registry
// ---------------------------------------------------------------------------

const REGISTRY_KEY = Symbol.for("opentelemetry.js.api.1");
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");
const BAGGAGE_KEY = Symbol.for("OpenTelemetry Baggage Key");
const INGEST_PATH = "/api/v1/metadata/ingest";
const CHECK_PATH = "/api/v1/budgets/check";

interface SpanContextLike {
  traceId: unknown;
  spanId: unknown;
  traceFlags: unknown;
}

const CALL: SpanContextLike = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: 1,
};
const OTHER: SpanContextLike = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: 1,
};
const CALL_WIRE = {
  trace_id: "0af7651916cd43dd8448eb211c80319c",
  span_id: "b7ad6b7169203331",
  trace_sampled: true,
};
const OTHER_WIRE = {
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  span_id: "00f067aa0ba902b7",
  trace_sampled: true,
};
const TRACE_KEYS = ["trace_id", "span_id", "trace_sampled"] as const;

class FakeContext {
  readonly #values: ReadonlyMap<symbol, unknown>;

  constructor(values: ReadonlyMap<symbol, unknown> = new Map()) {
    this.#values = values;
  }

  getValue(key: symbol): unknown {
    return this.#values.get(key);
  }

  setValue(key: symbol, value: unknown): FakeContext {
    return new FakeContext(new Map(this.#values).set(key, value));
  }

  deleteValue(key: symbol): FakeContext {
    const next = new Map(this.#values);
    next.delete(key);
    return new FakeContext(next);
  }
}

/** A span whose `spanContext()` reads are counted. */
class CountingSpan {
  calls = 0;

  constructor(readonly context: SpanContextLike | (() => unknown)) {}

  spanContext(): unknown {
    this.calls += 1;
    return typeof this.context === "function" ? this.context() : { ...this.context };
  }
}

interface FakeOtel {
  /** Make a fresh counting span for `context` the active span and return it. */
  activate(context: SpanContextLike | (() => unknown)): CountingSpan;
  /** Make an arbitrary (possibly malformed) value the active span. */
  setActiveSpan(span: unknown): void;
  /** Replace `context.active()` (for failure injection). */
  overrideActive(active: () => unknown): void;
  /** Total `spanContext()` reads across every span this registry handed out. */
  readonly totalReads: number;
}

function installOtel(version = "1.9.1"): FakeOtel {
  let current: unknown = new FakeContext();
  let active: () => unknown = () => current;
  const spans: CountingSpan[] = [];
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = {
    version,
    context: {
      active: () => active(),
      with: (context: unknown, fn: () => unknown) => {
        const previous = current;
        current = context;
        try {
          return fn();
        } finally {
          current = previous;
        }
      },
    },
  };
  return {
    activate(context) {
      const span = new CountingSpan(context);
      spans.push(span);
      current = new FakeContext().setValue(SPAN_KEY, span).setValue(BAGGAGE_KEY, {});
      return span;
    },
    setActiveSpan(span) {
      current = new FakeContext().setValue(SPAN_KEY, span);
    },
    overrideActive(next) {
      active = next;
    },
    get totalReads() {
      return spans.reduce((sum, span) => sum + span.calls, 0);
    },
  };
}

function uninstallOtel(): void {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
}

// ---------------------------------------------------------------------------
// Control-plane harness: the real FakeControlPlane plus raw ingest bodies
// ---------------------------------------------------------------------------

type WireEvent = Record<string, unknown>;

const BASE_OPTIONS = {
  leaseEnabled: false,
  reportUntrackedSurfaces: false,
  breakerReportingEnabled: false,
  velocityMode: "off",
  logger: noopLogger,
} satisfies Omit<SolwynOptions, "apiKey" | "apiUrl" | "fetch">;

interface Harness {
  readonly plane: FakeControlPlane;
  /** Serialized ingest bodies exactly as the SDK sent them. */
  readonly bodies: string[];
  /** Events parsed from the serialized bodies (not the plane's schema-parsed copies). */
  events(): WireEvent[];
  wrap<C extends object>(
    client: C,
    options?: Omit<SolwynOptions, "apiKey" | "apiUrl" | "fetch">,
  ): C;
  /** Run `hook` synchronously whenever a budget check request reaches the plane. */
  onCheck(hook: () => void): void;
  /** Wiring for constructing a `Solwyn` directly (bypassing the hermetic wrap). */
  readonly wiring: { apiKey: string; apiUrl: string; fetch: FetchLike };
}

function harness(planeOptions: FakeControlPlaneOptions = {}): Harness {
  const plane = new FakeControlPlane(planeOptions);
  const bodies: string[] = [];
  const checkHooks: Array<() => void> = [];
  const planeFetch = plane.fetch;
  const recording: FetchLike = async (input, init) => {
    const path = new URL(input).pathname;
    if (path === INGEST_PATH && typeof init?.body === "string") bodies.push(init.body);
    if (path === CHECK_PATH) for (const hook of checkHooks) hook();
    return planeFetch(input, init);
  };
  Object.defineProperty(plane, "fetch", { value: recording });
  return {
    plane,
    bodies,
    events: () => bodies.flatMap((body) => JSON.parse(body) as WireEvent[]),
    wrap: (client, options = {}) =>
      plane.wrap(client, { ...BASE_OPTIONS, ...options }) as unknown as typeof client,
    onCheck: (hook) => {
      checkHooks.push(hook);
    },
    wiring: { apiKey: plane.apiKey, apiUrl: plane.apiUrl, fetch: recording },
  };
}

async function close(client: unknown): Promise<void> {
  await (client as { close(): Promise<void> }).close();
}

function traceOf(event: WireEvent): Record<string, unknown> {
  return Object.fromEntries(
    TRACE_KEYS.filter((key) => Object.hasOwn(event, key)).map((key) => [key, event[key]]),
  );
}

/** Every event carries exactly `expected`, every event was accepted, and nothing else leaked. */
function expectEventsTraced(h: Harness, count: number, expected: Record<string, unknown>): void {
  const events = h.events();
  expect(events).toHaveLength(count);
  expect(h.plane.ingested).toHaveLength(count);
  for (const event of events) expect(traceOf(event)).toEqual(expected);
}

function expectEventsUntraced(h: Harness, count: number): void {
  expectEventsTraced(h, count, {});
}

function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** Named like the openai/anthropic SDK timeout: classified POST_SEND_AMBIGUOUS. */
class APITimeoutError extends Error {
  constructor() {
    super("synthetic request timeout");
    this.name = "APITimeoutError";
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _chunk of stream) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// Provider fakes (plain objects shaped like the vendor SDKs)
// ---------------------------------------------------------------------------

type Create = (kwargs: Record<string, unknown>, ...rest: unknown[]) => unknown;

interface ChatClient {
  chat: {
    completions: { create(kwargs: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> };
  };
}

function chatClient(create: Create, baseURL?: string) {
  return {
    chat: { completions: { create: vi.fn(create) } },
    embeddings: { create: vi.fn(() => ({ usage: { prompt_tokens: 3, total_tokens: 3 } })) },
    ...(baseURL === undefined ? {} : { baseURL }),
  };
}

const chatUsage = () => ({ usage: { prompt_tokens: 12, completion_tokens: 4 } });

async function* chatChunks(
  options: { failAfterFirst?: unknown; onFirst?: () => void } = {},
): AsyncGenerator<unknown> {
  yield {
    id: "chatcmpl_synthetic",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "x" } }],
  };
  options.onFirst?.();
  if (options.failAfterFirst !== undefined) throw options.failAfterFirst;
  yield {
    id: "chatcmpl_synthetic",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  };
}

class ConverseCommand {
  constructor(readonly input: Record<string, unknown>) {}
}
class ConverseStreamCommand {
  constructor(readonly input: Record<string, unknown>) {}
}
class BedrockRuntimeClient {
  readonly meta = { service_model: { service_name: "bedrock-runtime" }, region_name: "us-east-1" };

  constructor(readonly send: (command: unknown, ...rest: unknown[]) => unknown) {}
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  uninstallOtel();
  resetRunControlForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// OpenAI-style chat completions: one call-start snapshot for every outcome
// ---------------------------------------------------------------------------

interface ChatOutcome {
  readonly name: string;
  /** Events the call produces. */
  readonly events: number;
  /** Build the primary provider create; `otel.activate(OTHER)` simulates in-dispatch span churn. */
  readonly create: (switchSpan: () => void) => Create;
  readonly fallback?: Create;
  readonly options?: Omit<SolwynOptions, "apiKey" | "apiUrl" | "fetch">;
  readonly stream?: boolean;
  readonly arrange?: (h: Harness) => void;
  /** Run the call (already issued) to completion; returns nothing or throws the expected error. */
  readonly settle: (issued: Promise<unknown>, switchSpan: () => void) => Promise<void>;
  readonly verify?: (events: WireEvent[]) => void;
}

const nonStreamSettled = async (issued: Promise<unknown>) => {
  await issued;
};

const CHAT_OUTCOMES: readonly ChatOutcome[] = [
  {
    name: "non-stream success",
    events: 1,
    create: (switchSpan) => () => {
      switchSpan();
      return chatUsage();
    },
    settle: nonStreamSettled,
    verify: ([event]) => expect(event).toMatchObject({ status: "success", input_tokens: 12 }),
  },
  {
    name: "non-retryable provider error",
    events: 1,
    create: (switchSpan) => () => {
      switchSpan();
      throw statusError("synthetic bad request", 400);
    },
    settle: async (issued) => {
      await expect(issued).rejects.toMatchObject({ status: 400 });
    },
    verify: ([event]) => {
      expect(event).toMatchObject({ status: "error" });
      expect(Object.hasOwn(event as WireEvent, "possibly_succeeded")).toBe(false);
    },
  },
  {
    name: "ambiguous post-send failure",
    events: 1,
    create: (switchSpan) => () => {
      switchSpan();
      throw new APITimeoutError();
    },
    settle: async (issued) => {
      await expect(issued).rejects.toBeInstanceOf(APITimeoutError);
    },
    verify: ([event]) => expect(event).toMatchObject({ status: "error", possibly_succeeded: true }),
  },
  {
    name: "budget denial",
    events: 1,
    arrange: (h) => h.plane.denyNext(1),
    create: () => () => {
      throw new Error("denied calls never dispatch");
    },
    settle: async (issued) => {
      await expect(issued).rejects.toBeInstanceOf(BudgetExceededError);
    },
    verify: ([event]) =>
      expect(event).toMatchObject({ status: "budget_denied", denied_by_period: "monthly" }),
  },
  {
    name: "failover (hop 1 fails, hop 2 succeeds)",
    events: 2,
    create: (switchSpan) => () => {
      switchSpan();
      throw statusError("synthetic rate limit", 429);
    },
    fallback: chatUsage,
    settle: nonStreamSettled,
    verify: (events) => {
      expect(events.map((event) => [event["status"], event["attempt_index"]])).toEqual([
        ["error", 0],
        ["success", 1],
      ]);
      expect(new Set(events.map((event) => event["call_id"])).size).toBe(1);
    },
  },
  {
    name: "ambiguous failover under idempotency 'always'",
    events: 2,
    options: { failoverIdempotency: "always" },
    create: (switchSpan) => () => {
      switchSpan();
      throw new APITimeoutError();
    },
    fallback: chatUsage,
    settle: nonStreamSettled,
    verify: (events) =>
      expect(events.map((event) => [event["status"], event["attempt_index"]])).toEqual([
        ["error", 0],
        ["success", 1],
      ]),
  },
  {
    name: "streaming success with usage",
    events: 1,
    stream: true,
    create: (switchSpan) => () => {
      switchSpan();
      return chatChunks();
    },
    settle: async (issued, switchSpan) => {
      const stream = (await issued) as AsyncIterable<unknown>;
      switchSpan();
      expect(await drain(stream)).toBe(2);
    },
    verify: ([event]) =>
      expect(event).toMatchObject({ status: "success", input_tokens: 12, output_tokens: 4 }),
  },
  {
    name: "stream abandoned early",
    events: 1,
    stream: true,
    create: (switchSpan) => () => {
      switchSpan();
      return chatChunks();
    },
    settle: async (issued, switchSpan) => {
      const stream = (await issued) as AsyncIterator<unknown>;
      await stream.next();
      switchSpan();
      await stream.return?.();
    },
    verify: ([event]) => expect(event).toMatchObject({ status: "success" }),
  },
  {
    name: "mid-stream provider error",
    events: 1,
    stream: true,
    create: (switchSpan) => () => {
      switchSpan();
      return chatChunks({ failAfterFirst: statusError("synthetic stream failure", 500) });
    },
    settle: async (issued, switchSpan) => {
      const stream = (await issued) as AsyncIterable<unknown>;
      switchSpan();
      await expect(drain(stream)).rejects.toMatchObject({ status: 500 });
    },
    verify: ([event]) => expect(event).toMatchObject({ status: "error", possibly_succeeded: true }),
  },
  {
    name: "caller abort mid-stream",
    events: 1,
    stream: true,
    create: (switchSpan) => (_kwargs, options) => {
      switchSpan();
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
      return chatChunks({
        onFirst: () => {
          if (signal?.aborted) throw new DOMException("synthetic abort", "AbortError");
        },
      });
    },
    settle: async (issued, switchSpan) => {
      const stream = (await issued) as AsyncIterator<unknown>;
      await stream.next();
      switchSpan();
      abortController?.abort();
      await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    },
    verify: ([event]) => expect(event).toMatchObject({ status: "success" }),
  },
];

// The abort case needs the controller at issuance; the table runner owns its lifetime.
let abortController: AbortController | undefined;

describe("OpenAI chat completions: every outcome uses one call-start snapshot", () => {
  it.each(CHAT_OUTCOMES)("$name", async (outcome) => {
    const otel = installOtel();
    const h = harness();
    outcome.arrange?.(h);
    const switchSpan = () => {
      otel.activate(OTHER);
    };
    const options: Omit<SolwynOptions, "apiKey" | "apiUrl" | "fetch"> = { ...outcome.options };
    if (outcome.fallback !== undefined) {
      options.fallback = [
        [chatClient(outcome.fallback, "https://api.deepseek.com/v1"), "deepseek-chat"],
      ];
    }
    const client = h.wrap(chatClient(outcome.create(switchSpan)), options) as unknown as ChatClient;
    abortController = new AbortController();
    try {
      const callSpan = otel.activate(CALL);
      const issued = client.chat.completions.create(
        {
          model: "gpt-4o",
          messages: [{ role: "user", content: "synthetic" }],
          ...(outcome.stream === true ? { stream: true } : {}),
        },
        { signal: abortController.signal },
      );
      // The capture is synchronous on the caller's path: the span can change immediately.
      switchSpan();
      expect(callSpan.calls).toBe(1);
      await outcome.settle(issued, switchSpan);
      expect(callSpan.calls).toBe(1);
    } finally {
      await close(client);
      abortController = undefined;
    }
    expect(otel.totalReads).toBe(1);
    expectEventsTraced(h, outcome.events, CALL_WIRE);
    outcome.verify?.(h.events());
  });
});

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------

describe("run control receipts carry the call-start snapshot", () => {
  it("server run stop (run_stopped verdict at admission)", async () => {
    const otel = installOtel();
    const h = harness();
    const create = vi.fn(chatUsage);
    const client = h.wrap(chatClient(create)) as unknown as ChatClient;
    try {
      await run("trace-server-stop", async () => {
        const callSpan = otel.activate(CALL);
        const issued = client.chat.completions.create({
          model: "solwyn-test/deny-stopped",
          messages: [],
        });
        otel.activate(OTHER);
        await expect(issued).rejects.toBeInstanceOf(RunStoppedError);
        expect(callSpan.calls).toBe(1);
      });
    } finally {
      await close(client);
    }
    expect(create).not.toHaveBeenCalled();
    expect(otel.totalReads).toBe(1);
    expectEventsTraced(h, 1, CALL_WIRE);
    expect(h.events()[0]).toMatchObject({
      status: "budget_denied",
      denied_by_period: "run_stopped",
    });
  });

  it.each([
    ["chat", "local velocity stop before admission", false, "precheck"],
    ["media", "local velocity stop before admission", true, "precheck"],
    ["chat", "server stop observed during admission", false, "postcheck"],
    ["media", "server stop observed during admission", true, "postcheck"],
  ] as const)("%s: %s (registry receipt)", async (_surface, _label, media, gate) => {
    const otel = installOtel();
    const h = harness();
    const create = vi.fn(chatUsage);
    const embed = vi.fn(() => ({ usage: { prompt_tokens: 3, total_tokens: 3 } }));
    const client = h.wrap({
      chat: { completions: { create } },
      embeddings: { create: embed },
    }) as unknown as ChatClient & MediaClient;
    try {
      await run("trace-run-stop", async () => {
        const runId = currentRun()?.agentRunId as string;
        if (gate === "precheck") {
          markTerminated(runId, { reason: "velocity:repeat_size", source: "local_velocity" });
        } else {
          // A server stop that lands while the admission request is in flight.
          h.onCheck(() => markTerminated(runId, { reason: "manual_kill", source: "server" }));
        }
        const callSpan = otel.activate(CALL);
        const issued = media
          ? client.embeddings.create({ model: "text-embedding-3-small", input: "synthetic" })
          : client.chat.completions.create({ model: "gpt-4o", messages: [] });
        otel.activate(OTHER);
        await expect(issued).rejects.toBeInstanceOf(RunStoppedError);
        expect(callSpan.calls).toBe(1);
      });
    } finally {
      await close(client);
    }
    expect(create).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(otel.totalReads).toBe(1);
    expectEventsTraced(h, 1, CALL_WIRE);
    expect(h.events()[0]).toMatchObject({
      status: "budget_denied",
      denied_by_period: "run_stopped",
    });
  });
});

// ---------------------------------------------------------------------------
// Responses API (real openai SDK, offline fetch)
// ---------------------------------------------------------------------------

describe("Responses API", () => {
  function responsesClient(onDispatch: () => void) {
    const response = {
      id: "resp_synthetic",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 18, output_tokens: 7, total_tokens: 25 },
    };
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      onDispatch();
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (body.stream !== true) return Response.json(response);
      const chunks = [
        {
          type: "response.created",
          sequence_number: 0,
          response: { ...response, status: "in_progress" },
        },
        { type: "response.completed", sequence_number: 1, response },
      ];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    return new OpenAI({ apiKey: "offline", maxRetries: 0, fetch: providerFetch });
  }

  it("responses.create", async () => {
    const otel = installOtel();
    const h = harness();
    const client = h.wrap(
      responsesClient(() => otel.activate(OTHER)),
      { model: "gpt-4o" },
    );
    try {
      const callSpan = otel.activate(CALL);
      const issued = client.responses.create({ model: "gpt-4o", input: "synthetic" });
      otel.activate(OTHER);
      await issued;
      expect(callSpan.calls).toBe(1);
    } finally {
      await close(client);
    }
    expect(otel.totalReads).toBe(1);
    expectEventsTraced(h, 1, CALL_WIRE);
    expect(h.events()[0]).toMatchObject({ status: "success", input_tokens: 18 });
  });

  it.each([
    "iterate",
    "finalResponse",
  ] as const)("deferred responses.stream keeps the issuance trace (%s)", async (activation) => {
    const otel = installOtel();
    const h = harness();
    const client = h.wrap(
      responsesClient(() => otel.activate(OTHER)),
      { model: "gpt-4o" },
    );
    try {
      const callSpan = otel.activate(CALL);
      const helper = client.responses.stream({ model: "gpt-4o", input: "synthetic" });
      expect(callSpan.calls).toBe(1);
      // Start and consume the stream under a different active span.
      const laterSpan = otel.activate(OTHER);
      if (activation === "iterate") {
        expect(await drain(helper)).toBe(2);
      } else {
        await helper.finalResponse();
      }
      expect(callSpan.calls).toBe(1);
      expect(laterSpan.calls).toBe(0);
    } finally {
      await close(client);
    }
    expect(otel.totalReads).toBe(1);
    expectEventsTraced(h, 1, CALL_WIRE);
    expect(h.events()[0]).toMatchObject({ status: "success", input_tokens: 18 });
  });
});

// ---------------------------------------------------------------------------
// Anthropic, Google, Bedrock
// ---------------------------------------------------------------------------

type AsyncMethod = (kwargs: Record<string, unknown>) => Promise<unknown>;

/** The union of wrapped native surfaces the dialect table invokes. */
interface DialectClient {
  messages: { create: AsyncMethod };
  models: { generateContent: AsyncMethod; generateContentStream: AsyncMethod };
  send(command: unknown): Promise<unknown>;
}

interface DialectCase {
  readonly name: string;
  /** Build the raw client; `dispatched` must be called inside provider dispatch. */
  readonly build: (dispatched: () => void) => object;
  readonly invoke: (client: DialectClient) => Promise<unknown>;
  /** Consume a stream result (if any) after the caller switched spans. */
  readonly consume?: (result: unknown) => Promise<void>;
  readonly usage: { input_tokens: number; output_tokens: number };
}

const DIALECT_CASES: readonly DialectCase[] = [
  {
    name: "Anthropic messages.create",
    build: (dispatched) => ({
      messages: {
        create: vi.fn(() => {
          dispatched();
          return { usage: { input_tokens: 11, output_tokens: 7 } };
        }),
      },
    }),
    invoke: (client) =>
      client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [] }),
    usage: { input_tokens: 11, output_tokens: 7 },
  },
  {
    name: "Anthropic messages.create stream",
    build: (dispatched) => ({
      messages: {
        create: vi.fn(async () => {
          dispatched();
          return (async function* () {
            yield {
              type: "message_start",
              message: { usage: { input_tokens: 11, output_tokens: 0 } },
            };
            yield { type: "message_delta", usage: { output_tokens: 7 } };
            yield { type: "message_stop" };
          })();
        }),
      },
    }),
    invoke: (client) =>
      client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [],
        stream: true,
      }),
    consume: async (stream) => {
      expect(await drain(stream as AsyncIterable<unknown>)).toBe(3);
    },
    usage: { input_tokens: 11, output_tokens: 7 },
  },
  {
    name: "Google models.generateContent",
    build: (dispatched) => ({
      models: {
        generateContent: vi.fn(() => {
          dispatched();
          return { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } };
        }),
        generateContentStream: vi.fn(),
      },
    }),
    invoke: (client) => client.models.generateContent({ model: "gemini-2.0-flash", contents: "x" }),
    usage: { input_tokens: 9, output_tokens: 4 },
  },
  {
    name: "Google models.generateContentStream",
    build: (dispatched) => ({
      models: {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(async () => {
          dispatched();
          return (async function* () {
            yield { candidates: [{ content: { parts: [] } }] };
            yield {
              candidates: [{ content: { parts: [] } }],
              usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
            };
          })();
        }),
      },
    }),
    invoke: (client) =>
      client.models.generateContentStream({ model: "gemini-2.0-flash", contents: "x" }),
    consume: async (stream) => {
      expect(await drain(stream as AsyncIterable<unknown>)).toBe(2);
    },
    usage: { input_tokens: 9, output_tokens: 4 },
  },
  {
    name: "Bedrock send(ConverseCommand)",
    build: (dispatched) =>
      new BedrockRuntimeClient(() => {
        dispatched();
        return { usage: { inputTokens: 15, outputTokens: 6 } };
      }),
    invoke: (client) =>
      client.send(new ConverseCommand({ modelId: "amazon.nova-pro-v1:0", messages: [] })),
    usage: { input_tokens: 15, output_tokens: 6 },
  },
  {
    name: "Bedrock send(ConverseStreamCommand)",
    build: (dispatched) =>
      new BedrockRuntimeClient(() => {
        dispatched();
        return {
          stream: (async function* () {
            yield { messageStart: { role: "assistant" } };
            yield { metadata: { usage: { inputTokens: 15, outputTokens: 6 } } };
          })(),
        };
      }),
    invoke: (client) =>
      client.send(new ConverseStreamCommand({ modelId: "amazon.nova-pro-v1:0", messages: [] })),
    consume: async (result) => {
      expect(await drain((result as { stream: AsyncIterable<unknown> }).stream)).toBe(2);
    },
    usage: { input_tokens: 15, output_tokens: 6 },
  },
];

describe("native dialects keep the call-start snapshot", () => {
  it.each(DIALECT_CASES)("$name", async (testCase) => {
    const otel = installOtel();
    const h = harness();
    const client = h.wrap(testCase.build(() => otel.activate(OTHER)));
    try {
      const callSpan = otel.activate(CALL);
      const issued = testCase.invoke(client as unknown as DialectClient);
      const laterSpan = otel.activate(OTHER);
      const result = await issued;
      if (testCase.consume !== undefined) {
        otel.activate(OTHER);
        await testCase.consume(result);
      }
      expect(callSpan.calls).toBe(1);
      expect(laterSpan.calls).toBe(0);
    } finally {
      await close(client);
    }
    expect(otel.totalReads).toBe(1);
    expectEventsTraced(h, 1, CALL_WIRE);
    expect(h.events()[0]).toMatchObject({ status: "success", ...testCase.usage });
  });
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

interface MediaClient {
  embeddings: { create(kwargs: Record<string, unknown>): Promise<unknown> };
  audio: { speech: { create(kwargs: Record<string, unknown>): Promise<unknown> } };
}

describe("media surfaces keep the call-start snapshot", () => {
  function mediaClient(embed: Create, speech: Create = () => new Uint8Array([1, 2, 3])) {
    return {
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: vi.fn(embed) },
      audio: { speech: { create: vi.fn(speech) } },
    };
  }

  it.each([
    {
      name: "embeddings success",
      embed: () => ({ usage: { prompt_tokens: 3, total_tokens: 3 } }),
      status: "success",
    },
    {
      name: "embeddings provider error",
      embed: () => {
        throw statusError("synthetic bad request", 400);
      },
      status: "error",
    },
    {
      name: "embeddings budget denial",
      deny: true,
      embed: () => {
        throw new Error("denied calls never dispatch");
      },
      status: "budget_denied",
    },
  ])("$name", async ({ embed, status, deny }) => {
    const otel = installOtel();
    const h = harness();
    if (deny === true) h.plane.denyNext(1);
    const client = h.wrap(
      mediaClient(() => {
        otel.activate(OTHER);
        return embed();
      }),
    ) as unknown as MediaClient;
    try {
      const callSpan = otel.activate(CALL);
      const issued = client.embeddings.create({
        model: "text-embedding-3-small",
        input: "synthetic",
      });
      otel.activate(OTHER);
      if (status === "success") await issued;
      else if (status === "error") await expect(issued).rejects.toMatchObject({ status: 400 });
      else await expect(issued).rejects.toBeInstanceOf(BudgetExceededError);
      expect(callSpan.calls).toBe(1);
    } finally {
      await close(client);
    }
    expect(otel.totalReads).toBe(1);
    expectEventsTraced(h, 1, CALL_WIRE);
    expect(h.events()[0]).toMatchObject({ status, modality: "embedding" });
  });

  it("audio.speech resolves first, then meters in a later microtask with the issuance trace", async () => {
    const otel = installOtel();
    const h = harness();
    const speech = vi.fn(() => {
      otel.activate(OTHER);
      return new Uint8Array([1, 2, 3]);
    });
    const client = h.wrap(mediaClient(() => ({}), speech)) as unknown as MediaClient;
    try {
      const callSpan = otel.activate(CALL);
      const issued = client.audio.speech.create({
        model: "tts-1",
        input: "synthetic",
        voice: "alloy",
      });
      const laterSpan = otel.activate(OTHER);
      await issued;
      expect(callSpan.calls).toBe(1);
      expect(laterSpan.calls).toBe(0);
    } finally {
      await close(client);
    }
    expect(speech).toHaveBeenCalledTimes(1);
    expect(otel.totalReads).toBe(1);
    expectEventsTraced(h, 1, CALL_WIRE);
    expect(h.events()[0]).toMatchObject({ status: "success", modality: "audio" });
  });
});

// ---------------------------------------------------------------------------
// Wire shape: sampled flag, disabled correlation, absent registry
// ---------------------------------------------------------------------------

async function oneChatCall(
  h: Harness,
  options: Omit<SolwynOptions, "apiKey" | "apiUrl" | "fetch"> = {},
): Promise<void> {
  const client = h.wrap(chatClient(chatUsage), options) as unknown as ChatClient;
  try {
    await client.chat.completions.create({ model: "gpt-4o", messages: [] });
  } finally {
    await close(client);
  }
}

describe("wire shape", () => {
  it("serializes an unsampled span as trace_sampled: false (never dropped)", async () => {
    const otel = installOtel();
    const h = harness();
    const span = otel.activate({ ...CALL, traceFlags: 0 });
    await oneChatCall(h);
    expect(span.calls).toBe(1);
    expectEventsTraced(h, 1, { ...CALL_WIRE, trace_sampled: false });
    expect(h.bodies).toHaveLength(1);
    expect(h.bodies[0]).toContain('"trace_sampled":false');
    expect(h.plane.ingested[0]?.trace_sampled).toBe(false);
  });

  it("reads only the W3C sampled bit of the trace flags", async () => {
    const otel = installOtel();
    const h = harness();
    otel.activate({ ...CALL, traceFlags: 0b11 });
    await oneChatCall(h);
    expectEventsTraced(h, 1, CALL_WIRE);
  });

  it.each([
    ["chat", false, false],
    ["chat stream", true, false],
    ["embeddings", false, true],
  ] as const)("traceCorrelation: false never reads the span (%s)", async (_label, stream, media) => {
    const otel = installOtel();
    const h = harness();
    const client = h.wrap(
      chatClient(() => (stream ? chatChunks() : chatUsage())),
      { traceCorrelation: false },
    ) as unknown as ChatClient & MediaClient;
    try {
      const span = otel.activate(CALL);
      if (media) {
        await client.embeddings.create({ model: "text-embedding-3-small", input: "x" });
      } else {
        const result = await client.chat.completions.create({
          model: "gpt-4o",
          messages: [],
          ...(stream ? { stream: true } : {}),
        });
        if (stream) await drain(result as AsyncIterable<unknown>);
      }
      expect(span.calls).toBe(0);
    } finally {
      await close(client);
    }
    expect(otel.totalReads).toBe(0);
    expectEventsUntraced(h, 1);
  });

  it("SOLWYN_TRACE_CORRELATION=false disables capture for a directly constructed client", async () => {
    vi.stubEnv("SOLWYN_TRACE_CORRELATION", "false");
    const otel = installOtel();
    const h = harness();
    const client = new Solwyn(chatClient(chatUsage), { ...BASE_OPTIONS, ...h.wiring });
    try {
      const span = otel.activate(CALL);
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
      expect(span.calls).toBe(0);
    } finally {
      await client.close();
    }
    expectEventsUntraced(h, 1);
  });

  it("FakeControlPlane.wrap neutralizes an ambient SOLWYN_TRACE_CORRELATION=false", async () => {
    vi.stubEnv("SOLWYN_TRACE_CORRELATION", "false");
    const otel = installOtel();
    const h = harness();
    const span = otel.activate(CALL);
    await oneChatCall(h);
    expect(span.calls).toBe(1);
    expectEventsTraced(h, 1, CALL_WIRE);
  });

  it("without a registry, events carry no trace keys and keep the disabled shape", async () => {
    const absent = harness();
    await oneChatCall(absent);
    expectEventsUntraced(absent, 1);

    const disabled = harness();
    installOtel().activate(CALL);
    await oneChatCall(disabled, { traceCorrelation: false });
    uninstallOtel();

    const [absentEvent] = absent.events();
    const [disabledEvent] = disabled.events();
    expect(Object.keys(absentEvent ?? {}).sort()).toEqual(Object.keys(disabledEvent ?? {}).sort());
    for (const key of TRACE_KEYS) expect(Object.hasOwn(absentEvent ?? {}, key)).toBe(false);
  });

  it("a registry with no active span yields no trace keys", async () => {
    installOtel();
    const h = harness();
    await oneChatCall(h);
    expectEventsUntraced(h, 1);
  });
});

// ---------------------------------------------------------------------------
// Malformed span contexts never break the call or the batch
// ---------------------------------------------------------------------------

describe("malformed span contexts", () => {
  const malformed: ReadonlyArray<readonly [string, (otel: FakeOtel) => void]> = [
    ["all-zero trace id", (otel) => otel.activate({ ...CALL, traceId: "0".repeat(32) })],
    ["all-zero span id", (otel) => otel.activate({ ...CALL, spanId: "0".repeat(16) })],
    ["short trace id", (otel) => otel.activate({ ...CALL, traceId: "a".repeat(31) })],
    ["long span id", (otel) => otel.activate({ ...CALL, spanId: "a".repeat(17) })],
    ["non-hex trace id", (otel) => otel.activate({ ...CALL, traceId: "z".repeat(32) })],
    ["non-hex span id", (otel) => otel.activate({ ...CALL, spanId: "g".repeat(16) })],
    ["non-string trace id", (otel) => otel.activate({ ...CALL, traceId: 42 })],
    ["string trace flags", (otel) => otel.activate({ ...CALL, traceFlags: "1" })],
    ["fractional trace flags", (otel) => otel.activate({ ...CALL, traceFlags: 1.5 })],
    ["null span context", (otel) => otel.activate(() => null)],
    [
      "spanContext() throws",
      (otel) =>
        otel.activate(() => {
          throw new Error("synthetic spanContext failure");
        }),
    ],
    ["span without spanContext()", (otel) => otel.setActiveSpan({})],
    ["primitive span", (otel) => otel.setActiveSpan("span")],
    [
      "active() throws",
      (otel) =>
        otel.overrideActive(() => {
          throw new Error("synthetic context failure");
        }),
    ],
    [
      "getValue() throws",
      (otel) =>
        otel.overrideActive(() => ({
          getValue: () => {
            throw new Error("synthetic getValue failure");
          },
          deleteValue: () => {
            throw new Error("synthetic deleteValue failure");
          },
        })),
    ],
    ["active() returns a non-context", (otel) => otel.overrideActive(() => 7)],
  ];

  it.each(
    malformed,
  )("%s: call succeeds and the event is accepted without trace keys", async (_name, arrange) => {
    arrange(installOtel());
    const h = harness();
    await oneChatCall(h);
    expectEventsUntraced(h, 1);
    expect(h.events()[0]).toMatchObject({ status: "success" });
  });

  it("an unsupported registry version is ignored", async () => {
    const otel = installOtel("2.0.0");
    const span = otel.activate(CALL);
    const h = harness();
    await oneChatCall(h);
    expect(span.calls).toBe(0);
    expectEventsUntraced(h, 1);
  });

  it("uppercase hex ids are accepted and normalized to lowercase", async () => {
    const otel = installOtel();
    otel.activate({
      ...CALL,
      traceId: String(CALL.traceId).toUpperCase(),
      spanId: String(CALL.spanId).toUpperCase(),
    });
    const h = harness();
    await oneChatCall(h);
    expectEventsTraced(h, 1, CALL_WIRE);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrent calls", () => {
  it("interleaved calls under different spans each keep their own trace", async () => {
    const otel = installOtel();
    const h = harness();
    const pending: Array<{ model: string; resolve: (value: unknown) => void }> = [];
    const create = vi.fn(
      (kwargs: Record<string, unknown>) =>
        new Promise((resolve) => {
          pending.push({ model: String(kwargs["model"]), resolve });
        }),
    );
    const client = h.wrap(chatClient(create)) as unknown as ChatClient;
    try {
      const spanA = otel.activate(CALL);
      const callA = client.chat.completions.create({ model: "gpt-4o", messages: [] });
      const spanB = otel.activate(OTHER);
      const callB = client.chat.completions.create({ model: "gpt-4o-mini", messages: [] });
      const unrelated = otel.activate({ ...OTHER, traceId: "1".repeat(32) });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      // Settle in reverse issuance order.
      for (const entry of [...pending].reverse()) entry.resolve(chatUsage());
      await Promise.all([callA, callB]);
      expect([spanA.calls, spanB.calls, unrelated.calls]).toEqual([1, 1, 0]);
    } finally {
      await close(client);
    }
    const events = h.events();
    expect(events).toHaveLength(2);
    const byModel = Object.fromEntries(events.map((event) => [event["model"], traceOf(event)]));
    expect(byModel).toEqual({ "gpt-4o": CALL_WIRE, "gpt-4o-mini": OTHER_WIRE });
  });

  it("interleaved streams settle with their own issuance traces", async () => {
    const otel = installOtel();
    const h = harness();
    const client = h.wrap(chatClient(() => chatChunks())) as unknown as ChatClient;
    try {
      otel.activate(CALL);
      const streamA = await client.chat.completions.create({
        model: "gpt-4o",
        messages: [],
        stream: true,
      });
      otel.activate(OTHER);
      const streamB = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [],
        stream: true,
      });
      // Consume A under B's span and B under a third span.
      await drain(streamA as AsyncIterable<unknown>);
      otel.activate({ ...OTHER, traceId: "2".repeat(32) });
      await drain(streamB as AsyncIterable<unknown>);
    } finally {
      await close(client);
    }
    expect(otel.totalReads).toBe(2);
    const byModel = Object.fromEntries(h.events().map((event) => [event["model"], traceOf(event)]));
    expect(byModel).toEqual({ "gpt-4o": CALL_WIRE, "gpt-4o-mini": OTHER_WIRE });
  });
});
