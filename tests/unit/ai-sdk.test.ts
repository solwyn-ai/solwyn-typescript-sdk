/**
 * Vercel AI SDK middleware tests. Exercises `src/ai-sdk/index.ts` end to end through the
 * REAL `ai` package (`generateText` / `streamText` / `wrapLanguageModel`) over a mocked
 * `LanguageModel` (`MockLanguageModelV3` from `ai/test`) and a fully injected `fetch` —
 * no network, no provider SDK.
 *
 * Coverage:
 *  - generateText happy path: pre-flight check → provider mock → queued confirm + success
 *    event with correct provider/model attribution and mapped usage (nested V3/V4 shape);
 *  - streamText happy path: usage settles from the terminal `finish` part via a combined
 *    reportSettlement, and every chunk reaches the caller UNCHANGED;
 *  - budget hard-deny throws BudgetExceededError BEFORE the model is invoked (no dispatch);
 *  - provider-mapping matrix (AI SDK provider id → Solwyn ProviderName + catch-all);
 *  - error-path settlement: the model throws → one error event, NO confirm, no double-settle;
 *  - no-usage fallback: a provider reporting no usage yields a length-based ESTIMATE;
 *  - no-leak backstop: sentinel prompt/response text never appears in any fetch body/header.
 *
 * The installed AI SDK test kit exposes `MockLanguageModelV3`/`V4`, and
 * `wrapLanguageModel` upgrades any model to V4 — so the middleware observes the NESTED
 * usage shape at runtime. The middleware reads both shapes defensively; tests use V3.
 */

import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSolwynMiddleware,
  FALLBACK_PROVIDER_NAME,
  resolveProviderName,
} from "../../src/ai-sdk/index";
import { BudgetEnforcer, budgetCheckResult } from "../../src/budget";
import { BudgetExceededError, RunStoppedError } from "../../src/errors";
import { currentRun, run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import type { FetchLike } from "../../src/transport";
import type {
  BudgetCheckResponse,
  BudgetConfirmRequest,
  LeaseGrantResponse,
} from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remediation: explicit AI run tags", () => {
  for (const streaming of [false, true]) {
    for (const leaseEnabled of [false, true]) {
      it(`enforces tagged ${streaming ? "stream" : "generate"} admission with leases ${leaseEnabled}`, async () => {
        const { captured, fetchMock: originalFetch } = makeFetch(() => allow());
        const dispatch = vi.fn(async () => ({ content: [], usage: usage(1, 1) }));
        let leaseCalls = 0;
        const fetchMock: FetchLike = async (url, init) => {
          if (url.endsWith("/budgets/lease")) {
            leaseCalls++;
            return new Response(JSON.stringify(emptyLeaseGrantResponse()), { status: 200 });
          }
          if (url.endsWith("/budgets/check")) {
            const body = JSON.parse(String(init?.body));
            if (body.tags?.team === "restricted") {
              captured.checks.push(body);
              return new Response(JSON.stringify(hardDeny()), { status: 200 });
            }
          }
          return originalFetch(url, init);
        };
        const handle = createSolwynMiddleware({
          apiKey: API_KEY,
          fetch: fetchMock,
          leaseEnabled,
          logger: NOOP_LOGGER,
        });
        await expect(
          run("tagged", { tags: { team: "restricted" } }, () =>
            streaming
              ? wrapStreamDirect(handle, {
                  model: { provider: "openai", modelId: "gpt-5-mini" },
                  params: { prompt: [] },
                  doStream: async () => {
                    await dispatch();
                    return { stream: streamOf([]) };
                  },
                })
              : wrapGenerateDirect(handle, {
                  model: { provider: "openai", modelId: "gpt-5-mini" },
                  params: { prompt: [] },
                  doGenerate: dispatch,
                }),
          ),
        ).rejects.toBeInstanceOf(BudgetExceededError);
        await handle.close();
        expect(dispatch).not.toHaveBeenCalled();
        expect(leaseCalls).toBe(0);
        expect(captured.checks).toHaveLength(1);
        expect(captured.events).toEqual([
          expect.objectContaining({ status: "budget_denied", tags: { team: "restricted" } }),
        ]);
      });
    }
    for (const outcome of ["success", "error"] as const) {
      it(`snapshots tags for ${streaming ? "stream" : "generate"} ${outcome} receipts`, async () => {
        const { captured, fetchMock } = makeFetch(() => allow());
        const handle = createSolwynMiddleware({
          apiKey: API_KEY,
          fetch: fetchMock,
          logger: NOOP_LOGGER,
        });
        const tags = { team: "original" };
        const failure = new Error("synthetic provider failure");
        const call = run("tagged", { tags }, async () => {
          tags.team = "mutated";
          if (streaming) {
            const result = await wrapStreamDirect(handle, {
              model: { provider: "openai", modelId: "gpt-5-mini" },
              params: { prompt: [] },
              doStream: async () => ({
                stream:
                  outcome === "success"
                    ? streamOf([{ type: "finish", usage: usage(1, 1) }])
                    : streamThenError([], failure),
              }),
            });
            const streamError = await drain(result.stream);
            if (streamError !== undefined) throw streamError;
          } else {
            await wrapGenerateDirect(handle, {
              model: { provider: "openai", modelId: "gpt-5-mini" },
              params: { prompt: [] },
              doGenerate: async () => {
                if (outcome === "error") throw failure;
                return { content: [], usage: usage(1, 1) };
              },
            });
          }
        });
        if (outcome === "error") await expect(call).rejects.toBe(failure);
        else await call;
        await handle.close();
        expect(captured.checks).toEqual([expect.objectContaining({ tags: { team: "original" } })]);
        expect(captured.events).toEqual([
          expect.objectContaining({ status: outcome, tags: { team: "original" } }),
        ]);
      });
    }
  }
});

describe("remediation: AI paid usage bookkeeping", () => {
  for (const streaming of [false, true]) {
    for (const nested of [false, true]) {
      it.each([
        ["negative", -1],
        ["fractional", 0.5],
        ["non-finite", Number.POSITIVE_INFINITY],
        ["NaN", Number.NaN],
        ["missing", undefined],
        ["string", "12"],
        ["explicit zero", 0],
      ])(`preserves ${streaming ? "stream" : "generate"} with ${nested ? "nested" : "flat"} %s totals`, async (label, total) => {
        const { fetchMock, captured } = makeEmptyLeaseFetch();
        const surrenderedSpend: number[] = [];
        const handle = createSolwynMiddleware({
          apiKey: API_KEY,
          logger: NOOP_LOGGER,
          fetch: async (url, init) => {
            if (url.endsWith("/budgets/lease/surrender"))
              surrenderedSpend.push(Number(JSON.parse(String(init?.body)).spent_tokens));
            return fetchMock(url, init);
          },
        });
        const counts = nested
          ? { inputTokens: { total }, outputTokens: { total: 0 } }
          : { inputTokens: total, outputTokens: 0 };
        const value = { content: [], usage: counts };
        await run("malformed-paid-ai", async () => {
          const args = {
            model: { provider: "openai", modelId: "gpt-5-mini" },
            params: { prompt: [], maxOutputTokens: 500 },
          };
          if (streaming) {
            const { stream } = await wrapStreamDirect(handle, {
              ...args,
              doStream: async () => ({ stream: streamOf([{ type: "finish", usage: counts }]) }),
            });
            expect(await drain(stream)).toBeUndefined();
          } else {
            expect(
              await wrapGenerateDirect(handle, { ...args, doGenerate: async () => value }),
            ).toBe(value);
          }
        });
        await handle.close();
        const estimated = label !== "explicit zero";
        expect(captured.events).toEqual([expect.objectContaining({ status: "success" })]);
        expect(captured.events[0]?.token_details?.["is_estimated"]).toBe(estimated || undefined);
        expect(surrenderedSpend).toEqual([estimated ? 500 : 0]);
      });
    }
  }
  for (const streaming of [false, true]) {
    for (const leaseEnabled of [false, true]) {
      it(`preserves ${streaming ? "stream" : "generate"} success with over-bound usage and leases ${leaseEnabled}`, async () => {
        const { fetchMock, captured } = makeEmptyLeaseFetch();
        const surrenderedSpend: number[] = [];
        const consume = vi.spyOn(BudgetEnforcer.prototype, "consumeUnknownUsage");
        const logger = { ...NOOP_LOGGER, warn: vi.fn() };
        const handle = createSolwynMiddleware({
          apiKey: API_KEY,
          fetch: async (url, init) => {
            if (url.endsWith("/budgets/lease/surrender"))
              surrenderedSpend.push(Number(JSON.parse(String(init?.body)).spent_tokens));
            return fetchMock(url, init);
          },
          leaseEnabled,
          logger,
        });
        const value = { content: [], usage: usage(100_000_001, 1) };
        await run("unknown-paid", async () => {
          if (streaming) {
            const { stream } = await wrapStreamDirect(handle, {
              model: { provider: "openai", modelId: "gpt-5-mini" },
              params: { prompt: [], maxOutputTokens: 500 },
              doStream: async () => ({
                stream: streamOf([{ type: "finish", usage: value.usage }]),
              }),
            });
            expect(await drain(stream)).toBeUndefined();
          } else {
            expect(
              await wrapGenerateDirect(handle, {
                model: { provider: "openai", modelId: "gpt-5-mini" },
                params: { prompt: [], maxOutputTokens: 500 },
                doGenerate: async () => value,
              }),
            ).toBe(value);
          }
        });
        await handle.close();
        expect(consume).toHaveBeenCalledOnce();
        expect(captured.confirms).toHaveLength(0);
        expect(surrenderedSpend).toEqual(leaseEnabled ? [500] : []);
        expect(logger.warn).toHaveBeenCalledWith(
          "budget.confirm_construction_failed: paid usage retained conservatively",
        );
      });
    }
  }
});

describe("ai-sdk middleware options", () => {
  it("rejects unknown options while admitting control-plane configuration", async () => {
    expect(() =>
      createSolwynMiddleware({
        apiKey: API_KEY,
        unexpected: true,
      } as unknown as { apiKey: string }),
    ).toThrow("unexpected option 'unexpected'");

    const handle = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: async () =>
        new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 }),
      budgetCheckTimeout: 0.25,
      controlPlaneFailureThreshold: 1,
      controlPlaneRecoveryTimeout: 30,
      breakerReportingEnabled: false,
      reporterMaxSendAttempts: 7,
      reporterRetryBackoffBase: 0.25,
      reporterRetryBackoffCap: 12,
      reporterShutdownDeadline: 0,
      breakerReportHeartbeat: 15,
      leaseEnabled: false,
      leaseOutputBoundDefault: 2048,
    });
    await handle.close();
  });

  it("shares exact close identity and drains reporter before budget", async () => {
    const order: string[] = [];
    vi.spyOn(MetadataReporter.prototype, "close").mockImplementation(() => {
      order.push("reporter");
      return Promise.resolve();
    });
    vi.spyOn(BudgetEnforcer.prototype, "close").mockImplementation(() => {
      order.push("budget");
      return Promise.resolve();
    });
    const handle = createSolwynMiddleware({ apiKey: API_KEY, breakerReportingEnabled: false });

    const first = handle.close();
    const second = handle.close();
    const disposed = handle[Symbol.asyncDispose]();

    expect(second).toBe(first);
    expect(disposed).toBe(first);
    await first;
    expect(order).toEqual(["reporter", "budget"]);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Wire-body helpers (mirrors budget-integration.test.ts).
// ---------------------------------------------------------------------------

interface WireEvent {
  status: string;
  modality?: string;
  media_usage?: Record<string, unknown> | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  call_id: string;
  sdk_instance_id: string;
  is_provider_fallback: boolean;
  is_model_fallback: boolean;
  attempt_index: number;
  failover_error_class?: string;
  possibly_succeeded?: boolean;
  token_details?: Record<string, unknown>;
  agent_run_id?: string;
  agent_run_name?: string;
}

function allow(overrides: Partial<BudgetCheckResponse> = {}): BudgetCheckResponse {
  return {
    allowed: true,
    remaining_budget: 950,
    reservation_id: "res-1",
    mode: "alert_only",
    budget_limit: 1000,
    current_usage: 50,
    denied_by_period: null,
    project_id: `proj_${"0".repeat(24)}`,
    price_hints: null,
    ...overrides,
  };
}

function hardDeny(overrides: Partial<BudgetCheckResponse> = {}): BudgetCheckResponse {
  return allow({
    allowed: false,
    mode: "hard_deny",
    reservation_id: null,
    remaining_budget: 0,
    budget_limit: 100,
    current_usage: 150,
    denied_by_period: "monthly",
    ...overrides,
  });
}

function emptyLeaseGrantResponse(): LeaseGrantResponse {
  return {
    eligible: true,
    allowed: true,
    lease_id: "",
    generation: 1,
    granted_tokens: 15_000,
    refresh_interval_s: 300,
    lease_length_s: 600,
    headroom_share_tokens: 5_000,
    posture: { mode: "alert_only", on_unreachable: "fail_open" },
    final_grant: false,
    project_id: `proj_${"0".repeat(24)}`,
    mode: "alert_only",
    budget_limit: 1_000,
    current_usage: 100,
    remaining_budget: 900,
  };
}

interface Captured {
  events: WireEvent[];
  confirms: Array<Record<string, unknown>>;
  /** Parsed `POST /budgets/check` request bodies (carry `estimated_input_tokens`). */
  checks: Array<Record<string, unknown>>;
  checkCalls: number;
  /** Every request body seen (any endpoint) — for the no-leak sweep. */
  bodies: string[];
  /** Every request's header values — for the no-leak sweep. */
  headerValues: string[];
}

function makeFetch(budget: (call: number) => BudgetCheckResponse | "unreachable"): {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  captured: Captured;
} {
  const captured: Captured = {
    events: [],
    confirms: [],
    checks: [],
    checkCalls: 0,
    bodies: [],
    headerValues: [],
  };
  const impl: FetchLike = async (url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    if (bodyText !== undefined) {
      captured.bodies.push(bodyText);
    }
    const headers = init?.headers;
    if (headers && typeof headers === "object") {
      for (const value of Object.values(headers as Record<string, string>)) {
        captured.headerValues.push(String(value));
      }
    }
    const raw = bodyText !== undefined ? (JSON.parse(bodyText) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      captured.checkCalls += 1;
      if (raw !== undefined) {
        captured.checks.push(raw as Record<string, unknown>);
      }
      const decision = budget(captured.checkCalls);
      if (decision === "unreachable") {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return new Response(JSON.stringify(decision), { status: 200 });
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      if (raw !== undefined) {
        captured.confirms.push(raw as Record<string, unknown>);
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(raw)) {
      captured.events.push(...(raw as WireEvent[]));
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), captured };
}

function makeEmptyLeaseFetch(): ReturnType<typeof makeFetch> {
  const base = makeFetch(() => allow());
  const fetchMock = vi.fn<FetchLike>(async (input, init) => {
    const pathname = new URL(input).pathname;
    if (pathname === "/api/v1/budgets/lease") {
      return new Response(JSON.stringify(emptyLeaseGrantResponse()), { status: 200 });
    }
    if (
      pathname === "/api/v1/budgets/lease/renew" ||
      pathname === "/api/v1/budgets/lease/surrender"
    ) {
      return new Response(null, { status: 204 });
    }
    return base.fetchMock(input, init);
  });
  return { fetchMock, captured: base.captured };
}

const NOOP_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

// The stream-part type, derived from the resolvable `MockLanguageModelV3` (the provider
// package that declares `LanguageModelV3StreamPart` is a pnpm-transitive dep and NOT
// importable by name here). Passing it as the explicit `simulateReadableStream<T>` type
// arg contextually types the chunk literals so `finish`'s `finishReason` does not widen.
type V3StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type V3StreamPart = V3StreamResult extends { stream: ReadableStream<infer P> } ? P : never;
// Likewise for the buffered result: annotate each `doGenerate` so its object literal is
// contextually typed (otherwise free inference widens `finishReason`/`content[].type`).
type V3GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

/** Nested (V3/V4) usage helper. */
function usage(input: number, output: number, extra: Record<string, unknown> = {}) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
    ...extra,
  };
}

/** A usage object that reports NO totals (both sides absent) — drives the invariant-6 estimate. */
const NO_USAGE = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** chars/token ratio 4.0 for openai / openai_compatible — length estimate helper. */
function estTokens(chars: number): number {
  return Math.max(1, Math.trunc(chars / 4));
}

// Direct middleware invocation (bypasses `ai`'s prompt normalization so a test controls the
// EXACT V4 part shapes — tool-call/tool-result/file parts, tool-input-delta stream parts —
// that `generateText`/`streamText` would otherwise assemble internally). The `ai` package
// types `wrapGenerate`/`wrapStream` against its version-specific model surface; the loose
// cast keeps the tests decoupled from that while calling the real middleware code paths.
type DirectModel = { provider: string; modelId: string };
type Handle = ReturnType<typeof createSolwynMiddleware>;

interface DirectGenerateArgs {
  doGenerate: () => Promise<{ content: unknown; usage: unknown }>;
  model: DirectModel;
  params: { prompt: unknown; maxOutputTokens?: unknown };
}
interface DirectStreamArgs {
  doStream: () => Promise<{ stream: ReadableStream<unknown> }>;
  model: DirectModel;
  params: { prompt: unknown; maxOutputTokens?: unknown };
}

function wrapGenerateDirect(handle: Handle, args: DirectGenerateArgs): Promise<unknown> {
  const fn = handle.middleware.wrapGenerate as unknown as (
    a: DirectGenerateArgs,
  ) => Promise<unknown>;
  return fn(args);
}

function wrapStreamDirect(
  handle: Handle,
  args: DirectStreamArgs,
): Promise<{ stream: ReadableStream<unknown> }> {
  const fn = handle.middleware.wrapStream as unknown as (
    a: DirectStreamArgs,
  ) => Promise<{ stream: ReadableStream<unknown> }>;
  return fn(args);
}

/** A `ReadableStream` that enqueues `chunks` in order then closes. */
function streamOf(chunks: readonly unknown[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** A `ReadableStream` that emits `chunks` then errors mid-flight (established-then-dropped). */
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

/** Drain a `ReadableStream` to completion; return the rejection (if any) instead of throwing. */
async function drain(stream: ReadableStream<unknown>): Promise<unknown> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        return undefined;
      }
    }
  } catch (error) {
    return error;
  }
}

function installFundedLeaseDecision() {
  const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
    budgetCheckResult({
      allowed: true,
      remainingBudget: 900,
      projectId: `proj_${"0".repeat(24)}`,
      leaseId: "lease-ai-1",
      leaseClaimToken: 77,
    }),
  );
  const releaseReservation = vi
    .spyOn(BudgetEnforcer.prototype, "releaseReservation")
    .mockImplementation(() => {});
  const buildConfirmRequest = vi
    .spyOn(BudgetEnforcer.prototype, "buildConfirmRequest")
    .mockImplementation(
      (options): BudgetConfirmRequest => ({
        lease_id: options.leaseId ?? "lease-ai-1",
        model: options.model,
        provider: options.provider,
        is_provider_fallback: options.isProviderFallback ?? false,
        call_id: options.callId,
        token_details: options.tokenDetails,
        provider_region: options.providerRegion ?? null,
        service_tier: null,
      }),
    );
  return { checkBudget, releaseReservation, buildConfirmRequest };
}

function hostileThrownValue(secret: string): {
  readonly value: object;
  readonly messageReads: () => number;
} {
  let messageReadCount = 0;
  const value = {};
  Object.defineProperties(value, {
    constructor: {
      get(): never {
        throw new Error(secret);
      },
    },
    message: {
      get(): never {
        messageReadCount += 1;
        throw new Error("caller-owned message was read");
      },
    },
  });
  return { value, messageReads: () => messageReadCount };
}

// ---------------------------------------------------------------------------
// generateText happy path.
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — generateText happy path", () => {
  it("checks budget, dispatches, confirms + reports with correct attribution and usage", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    const model = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "gpt-4o-mini",
      doGenerate: async (): Promise<V3GenerateResult> => ({
        content: [{ type: "text", text: "hello world response" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(12, 7, {
          inputTokens: { total: 12, noCache: 9, cacheRead: 3, cacheWrite: 0 },
        }),
        warnings: [],
      }),
    });

    const { text } = await generateText({
      model: wrapLanguageModel({ model, middleware: solwyn.middleware }),
      prompt: "count the tokens please",
    });
    expect(captured.confirms).toHaveLength(0);
    expect(captured.events).toHaveLength(0);
    await solwyn.close();

    expect(text).toBe("hello world response");
    expect(captured.checkCalls).toBe(1);

    // Exactly one success event, attributed to the mapped provider + model.
    const success = captured.events.filter((e) => e.status === "success");
    expect(success).toHaveLength(1);
    const event = success[0];
    expect(event?.provider).toBe("openai");
    expect(event?.model).toBe("gpt-4o-mini");
    expect(event?.input_tokens).toBe(12);
    expect(event?.output_tokens).toBe(7);
    expect(event?.is_provider_fallback).toBe(false);
    expect(event?.is_model_fallback).toBe(false);
    expect(event?.attempt_index).toBe(0);
    // Nested usage mapped: cacheRead → cached_input_tokens.
    expect(event?.token_details?.["cached_input_tokens"]).toBe(3);
    // Provider-reported (not estimated) → is_estimated omitted from the wire.
    expect(event?.token_details?.["is_estimated"]).toBeUndefined();

    // Exactly one confirm, same call_id as the event, same usage.
    expect(captured.confirms).toHaveLength(1);
    const confirm = captured.confirms[0];
    expect(confirm?.["reservation_id"]).toBe("res-1");
    expect(confirm?.["call_id"]).toBe(event?.call_id);
    expect(confirm?.["provider"]).toBe("openai");
    expect(confirm?.["is_provider_fallback"]).toBe(false);
  });

  it("maps a cache-hit allow (no reservation) to a success event with NO confirm", async () => {
    // First allow caches; second call within TTL is served from cache (reservationId null).
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const model = new MockLanguageModelV3({
      provider: "anthropic.messages",
      modelId: "claude-3-5-haiku",
      doGenerate: async (): Promise<V3GenerateResult> => ({
        content: [{ type: "text", text: "hi" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(4, 2),
        warnings: [],
      }),
    });
    const wrapped = wrapLanguageModel({ model, middleware: solwyn.middleware });
    await generateText({ model: wrapped, prompt: "one" });
    await generateText({ model: wrapped, prompt: "two" });
    await solwyn.close();

    // Only the first call hit the API; the second was a cache hit.
    expect(captured.checkCalls).toBe(1);
    // Both calls confirm? No — the cache-hit call carries no reservation id, so it does NOT
    // confirm. Exactly one confirm comes from the first call.
    expect(captured.confirms).toHaveLength(1);
    expect(captured.events.filter((e) => e.status === "success")).toHaveLength(2);
    expect(captured.events.every((e) => e.provider === "anthropic")).toBe(true);
  });

  it("treats an empty reservation id as event-only", async () => {
    const { fetchMock, captured } = makeFetch(() => allow({ reservation_id: "" }));
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const model = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "gpt-4o-mini",
      doGenerate: async (): Promise<V3GenerateResult> => ({
        content: [{ type: "text", text: "hi" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(4, 2),
        warnings: [],
      }),
    });

    await generateText({
      model: wrapLanguageModel({ model, middleware: solwyn.middleware }),
      prompt: "empty reservation",
    });
    await solwyn.close();

    expect(captured.confirms).toHaveLength(0);
    expect(captured.events.filter((event) => event.status === "success")).toHaveLength(1);
  });

  it("keeps language middleware events text-only without inspecting opaque raw usage", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    const hostileRaw = new Proxy<Record<string, unknown>>(
      {},
      {
        get() {
          throw new Error("usage.raw must not be read");
        },
        ownKeys() {
          throw new Error("usage.raw must not be enumerated");
        },
        getOwnPropertyDescriptor() {
          throw new Error("usage.raw descriptors must not be inspected");
        },
      },
    );

    await wrapGenerateDirect(solwyn, {
      model: { provider: "openai.chat", modelId: "gpt-4o" },
      params: { prompt: [{ role: "user", content: [{ type: "text", text: "text prompt" }] }] },
      doGenerate: async () => ({
        content: [{ type: "text", text: "text response" }],
        usage: usage(19, 11, {
          inputTokens: { total: 19, noCache: 14, cacheRead: 5, cacheWrite: 0 },
          outputTokens: { total: 11, text: 8, reasoning: 3 },
          raw: hostileRaw,
        }),
      }),
    });
    await solwyn.close();

    const success = captured.events.filter((event) => event.status === "success");
    expect(success).toHaveLength(1);
    const event = success[0];
    expect(event?.modality).toBe("text");
    expect(event).not.toHaveProperty("media_usage");
    expect(event?.input_tokens).toBe(19);
    expect(event?.output_tokens).toBe(11);
    expect(event?.token_details?.["cached_input_tokens"]).toBe(5);
    expect(event?.token_details?.["reasoning_tokens"]).toBe(3);
    expect(event?.token_details?.["image_input_tokens"]).toBe(0);
    expect(event?.token_details?.["image_output_tokens"]).toBe(0);
    expect(event?.token_details?.["audio_input_tokens"]).toBe(0);
    expect(event?.token_details?.["audio_output_tokens"]).toBe(0);
    expect(event?.token_details?.["is_estimated"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// streamText happy path.
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — streamText happy path", () => {
  it("passes chunks through unchanged and settles usage from the finish part", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    const model = new MockLanguageModelV3({
      provider: "google.generative-ai",
      modelId: "gemini-2.0-flash",
      doStream: async () => ({
        stream: simulateReadableStream<V3StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "streamed " },
            { type: "text-delta", id: "1", delta: "response" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(20, 9) },
          ],
        }),
      }),
    });

    const result = streamText({
      model: wrapLanguageModel({ model, middleware: solwyn.middleware }),
      prompt: "stream it",
    });
    let acc = "";
    for await (const delta of result.textStream) {
      acc += delta;
    }
    const finalUsage = await result.usage;
    await solwyn.close();

    // Caller's stream is UNCHANGED.
    expect(acc).toBe("streamed response");
    expect(finalUsage.inputTokens).toBe(20);
    expect(finalUsage.outputTokens).toBe(9);

    // Settled once from the finish part: one confirm + one success event, matching call_ids.
    const success = captured.events.filter((e) => e.status === "success");
    expect(success).toHaveLength(1);
    expect(success[0]?.provider).toBe("google");
    expect(success[0]?.model).toBe("gemini-2.0-flash");
    expect(success[0]?.input_tokens).toBe(20);
    expect(success[0]?.output_tokens).toBe(9);
    expect(captured.confirms).toHaveLength(1);
    expect(captured.confirms[0]?.["call_id"]).toBe(success[0]?.call_id);
  });
});

// ---------------------------------------------------------------------------
// Budget hard-deny short-circuits dispatch.
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — budget deny", () => {
  it("throws BudgetExceededError BEFORE invoking the model and reports budget_denied", async () => {
    const { fetchMock, captured } = makeFetch(() => hardDeny());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
      budgetMode: "hard_deny",
    });

    let dispatched = 0;
    const model = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "gpt-4o",
      doGenerate: async (): Promise<V3GenerateResult> => {
        dispatched += 1;
        return {
          content: [{ type: "text", text: "never" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(1, 1),
          warnings: [],
        };
      },
    });

    await expect(
      generateText({
        model: wrapLanguageModel({ model, middleware: solwyn.middleware }),
        prompt: "should be denied",
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();

    expect(dispatched).toBe(0);
    expect(captured.confirms).toHaveLength(0);
    const denied = captured.events.filter((e) => e.status === "budget_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.provider).toBe("openai");
    // The denied event carries the pre-flight estimate (non-zero for a non-empty prompt).
    expect(denied[0]?.input_tokens).toBeGreaterThan(0);
    expect(denied[0]?.output_tokens).toBe(0);
    expect(captured.events.filter((e) => e.status === "success")).toHaveLength(0);
  });

  it("run-scoped preflight forwards the run id, retains deny attribution, and omits the id outside", async () => {
    const { fetchMock, captured } = makeFetch((call) =>
      call === 1 ? hardDeny({ denied_by_period: "agent_run" }) : allow(),
    );
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
      budgetMode: "hard_deny",
    });

    let dispatched = 0;
    const model = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "gpt-4o-run-scope",
      doGenerate: async (): Promise<V3GenerateResult> => {
        dispatched += 1;
        return {
          content: [{ type: "text", text: "outside succeeds" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(2, 1),
          warnings: [],
        };
      },
    });
    const wrapped = wrapLanguageModel({ model, middleware: solwyn.middleware });

    let activeRunId = "";
    await run("ai-sdk-denied-run", async () => {
      activeRunId = currentRun()?.agentRunId ?? "";
      await expect(
        generateText({ model: wrapped, prompt: "denied in scope", maxRetries: 0 }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
    });
    await generateText({ model: wrapped, prompt: "allowed outside", maxRetries: 0 });
    await solwyn.close();

    expect(activeRunId).toMatch(/^run_/);
    expect(dispatched).toBe(1);
    expect(captured.checks).toHaveLength(2);
    expect(captured.checks[0]?.["agent_run_id"]).toBe(activeRunId);
    expect(captured.checks[1]).not.toHaveProperty("agent_run_id");
    const denied = captured.events.filter((event) => event.status === "budget_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.agent_run_id).toBe(activeRunId);
    expect(denied[0]?.agent_run_name).toBe("ai-sdk-denied-run");
  });

  it.each([
    "generate",
    "stream",
  ] as const)("reports then preserves a typed stopped-run error before AI SDK %s dispatch", async (surface) => {
    const { fetchMock, captured } = makeFetch(() => hardDeny({ denied_by_period: "run_stopped" }));
    const order: string[] = [];
    const originalReport = MetadataReporter.prototype.report;
    const report = vi.spyOn(MetadataReporter.prototype, "report").mockImplementation(function (
      this: MetadataReporter,
      event,
    ) {
      order.push("report");
      originalReport.call(this, event);
      throw new Error("report failure must not mask the stop");
    });
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
      budgetMode: "hard_deny",
      leaseEnabled: false,
    });

    let caught: unknown;
    try {
      await run(`ai-sdk-stopped-${surface}`, async () => {
        const call =
          surface === "generate"
            ? wrapGenerateDirect(solwyn, {
                model: { provider: "openai", modelId: "gpt-4o" },
                params: { prompt: "stop before dispatch" },
                doGenerate: async () => {
                  order.push("dispatch");
                  return { content: [], usage: usage(1, 1) };
                },
              })
            : wrapStreamDirect(solwyn, {
                model: { provider: "openai", modelId: "gpt-4o" },
                params: { prompt: "stop before dispatch" },
                doStream: async () => {
                  order.push("dispatch");
                  return { stream: new ReadableStream<unknown>() };
                },
              });
        caught = await call.then(
          () => null,
          (error: unknown) => {
            order.push("error");
            return error;
          },
        );
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(caught).toBeInstanceOf(RunStoppedError);
    expect(caught).toMatchObject({ reason: "run_stopped", source: "server" });
    expect(order).toEqual(["report", "error"]);
    expect(captured.events.filter((event) => event.status === "budget_denied")).toHaveLength(1);
    expect(captured.confirms).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Provider-mapping matrix.
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — provider mapping", () => {
  it("maps every AI SDK provider id (and surface variants) to the right ProviderName", () => {
    const cases: Array<[string, string]> = [
      ["openai", "openai"],
      ["openai.chat", "openai"],
      ["openai.responses", "openai"],
      ["anthropic", "anthropic"],
      ["anthropic.messages", "anthropic"],
      ["google", "google"],
      ["google.generative-ai", "google"],
      ["google.vertex", "google"],
      ["amazon-bedrock", "bedrock"],
      ["bedrock", "bedrock"],
      ["xai", "xai"],
      ["deepseek", "deepseek"],
      ["mistral", "mistral"],
      ["mistral.chat", "mistral"],
      ["zai", "zai"],
      ["groq", "groq"],
      ["togetherai", "together"],
      ["together", "together"],
      ["fireworks", "fireworks"],
      ["perplexity", "perplexity"],
      ["azure", "azure_openai"],
      ["azure-openai", "azure_openai"],
      ["openrouter", "openrouter"],
      ["ollama", "ollama"],
      ["OpenAI.Chat", "openai"], // case-insensitive
    ];
    for (const [input, expected] of cases) {
      expect(resolveProviderName(input)).toBe(expected);
    }
  });

  it("falls back to the openai_compatible catch-all for unknown providers", () => {
    expect(resolveProviderName("some-unknown-gateway")).toBe(FALLBACK_PROVIDER_NAME);
    expect(resolveProviderName("")).toBe(FALLBACK_PROVIDER_NAME);
    expect(FALLBACK_PROVIDER_NAME).toBe("openai_compatible");
  });

  it("derives Vercel AI Gateway attribution from the model id's vendor prefix (D15)", () => {
    // `provider: "gateway"` (ai v7's default for a bare string model id) — the true vendor
    // is the `vendor/model` prefix of modelId, not openai_compatible.
    expect(resolveProviderName("gateway", "anthropic/claude-sonnet-4.5")).toBe("anthropic");
    expect(resolveProviderName("gateway", "openai/gpt-4o")).toBe("openai");
    expect(resolveProviderName("gateway", "google/gemini-2.0-flash")).toBe("google");
    expect(resolveProviderName("gateway", "xai/grok-2")).toBe("xai");
    expect(resolveProviderName("gateway", "zai/glm-4.6")).toBe("zai");
    // Dotted gateway surface variant resolves the same way.
    expect(resolveProviderName("gateway.chat", "mistral/mistral-large")).toBe("mistral");
    // No derivable vendor → the catch-all (unknown prefix, no slash, or no modelId at all).
    expect(resolveProviderName("gateway", "unknown-vendor/some-model")).toBe(
      FALLBACK_PROVIDER_NAME,
    );
    expect(resolveProviderName("gateway", "bare-model-no-slash")).toBe(FALLBACK_PROVIDER_NAME);
    expect(resolveProviderName("gateway")).toBe(FALLBACK_PROVIDER_NAME);
    // A non-gateway provider ignores modelId entirely (attribution stays vendor-stamped).
    expect(resolveProviderName("anthropic", "anthropic/claude-3-5-haiku")).toBe("anthropic");
    expect(resolveProviderName("openai", "anthropic/should-be-ignored")).toBe("openai");
  });

  it("attributes a gateway-wrapped call end-to-end to the derived vendor, not openai_compatible", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    await wrapGenerateDirect(solwyn, {
      model: { provider: "gateway", modelId: "anthropic/claude-sonnet-4.5" },
      params: { prompt: [{ role: "user", content: [{ type: "text", text: "hi there" }] }] },
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        usage: usage(10, 4),
      }),
    });
    await solwyn.close();

    const success = captured.events.filter((e) => e.status === "success");
    expect(success).toHaveLength(1);
    expect(success[0]?.provider).toBe("anthropic");
    // The `model` field keeps the FULL gateway model id (it is the real model identifier).
    expect(success[0]?.model).toBe("anthropic/claude-sonnet-4.5");
    // Budget + confirm are attributed to the same derived vendor.
    expect(captured.confirms[0]?.["provider"]).toBe("anthropic");
  });

  it("attributes a Z.ai gateway model to zai while preserving the full model id", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    await wrapGenerateDirect(solwyn, {
      model: { provider: "gateway", modelId: "zai/glm-4.6" },
      params: { prompt: [{ role: "user", content: [{ type: "text", text: "hi there" }] }] },
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        usage: usage(10, 4),
      }),
    });
    await solwyn.close();

    const success = captured.events.filter((event) => event.status === "success");
    expect(success).toHaveLength(1);
    expect(success[0]?.provider).toBe("zai");
    expect(success[0]?.model).toBe("zai/glm-4.6");
    expect(captured.confirms[0]?.["provider"]).toBe("zai");
  });
});

// ---------------------------------------------------------------------------
// Error-path settlement.
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — error path", () => {
  it("reports one error event and sends NO confirm when the model throws", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    class ProviderBoom extends Error {
      constructor() {
        super("provider exploded");
        this.name = "ProviderBoom";
      }
    }
    const model = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "gpt-4o",
      doGenerate: async (): Promise<V3GenerateResult> => {
        throw new ProviderBoom();
      },
    });

    await expect(
      generateText({
        model: wrapLanguageModel({ model, middleware: solwyn.middleware }),
        prompt: "will fail",
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ProviderBoom);
    await solwyn.close();

    // Budget was checked (reservation created), but NO confirm was sent (reservation expires).
    expect(captured.checkCalls).toBe(1);
    expect(captured.confirms).toHaveLength(0);
    // Exactly one error event, no success — no double settlement.
    const errors = captured.events.filter((e) => e.status === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.provider).toBe("openai");
    // Privacy-safe structural error class (name only), never the message.
    expect(errors[0]?.failover_error_class).toBe("ProviderBoom");
    expect(captured.events.filter((e) => e.status === "success")).toHaveLength(0);
  });

  it("omits a constructor-shaped class label from a non-Error throw and rethrows it unchanged", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const forged = { constructor: { name: "SecretToken" } };

    let caught: unknown;
    try {
      await wrapGenerateDirect(solwyn, {
        model: { provider: "openai.chat", modelId: "gpt-4o" },
        params: { prompt: [] },
        doGenerate: async () => {
          throw forged;
        },
      });
    } catch (error) {
      caught = error;
    }
    await solwyn.close();

    expect(caught).toBe(forged);
    const errors = captured.events.filter((event) => event.status === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.failover_error_class).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No-usage fallback (invariant 6).
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — no-usage estimate", () => {
  it("marks a length-based estimate when the provider reports no usage", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    const model = new MockLanguageModelV3({
      provider: "some-unknown-gateway",
      modelId: "mystery-model",
      doGenerate: async (): Promise<V3GenerateResult> => ({
        content: [{ type: "text", text: "a fairly long generated response body here" }],
        finishReason: { unified: "stop", raw: "stop" },
        // No usage reported at all (both totals undefined).
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    await generateText({
      model: wrapLanguageModel({ model, middleware: solwyn.middleware }),
      prompt: "a reasonably sized prompt to estimate input tokens from",
    });
    await solwyn.close();

    const success = captured.events.filter((e) => e.status === "success");
    expect(success).toHaveLength(1);
    // Provider unknown → openai_compatible attribution.
    expect(success[0]?.provider).toBe("openai_compatible");
    // Estimated usage: is_estimated true and non-zero input/output from length.
    expect(success[0]?.token_details?.["is_estimated"]).toBe(true);
    expect(success[0]?.input_tokens).toBeGreaterThan(0);
    expect(success[0]?.output_tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No-leak backstop.
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — privacy: content never reaches the wire", () => {
  const SENTINEL_PROMPT = "SENTINEL_PROMPT_e3f1a2b4c5d6";
  const SENTINEL_RESPONSE = "SENTINEL_RESPONSE_9a8b7c6d5e4f";

  it("never transmits prompt or response text in any fetch body or header (generate)", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    const model = new MockLanguageModelV3({
      provider: "openai.chat",
      modelId: "gpt-4o",
      doGenerate: async (): Promise<V3GenerateResult> => ({
        content: [{ type: "text", text: SENTINEL_RESPONSE }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(11, 6),
        warnings: [],
      }),
    });

    const { text } = await generateText({
      model: wrapLanguageModel({ model, middleware: solwyn.middleware }),
      prompt: SENTINEL_PROMPT,
    });
    await solwyn.close();

    expect(text).toBe(SENTINEL_RESPONSE); // sentinel really flowed through the model
    expect(captured.bodies.length).toBeGreaterThan(0);
    for (const body of captured.bodies) {
      expect(body).not.toContain(SENTINEL_PROMPT);
      expect(body).not.toContain(SENTINEL_RESPONSE);
    }
    for (const header of captured.headerValues) {
      expect(header).not.toContain(SENTINEL_PROMPT);
      expect(header).not.toContain(SENTINEL_RESPONSE);
    }
  });

  it("never transmits prompt or streamed response text (stream)", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    const model = new MockLanguageModelV3({
      provider: "anthropic.messages",
      modelId: "claude-3-5-sonnet",
      doStream: async () => ({
        stream: simulateReadableStream<V3StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: SENTINEL_RESPONSE },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(15, 8) },
          ],
        }),
      }),
    });

    const result = streamText({
      model: wrapLanguageModel({ model, middleware: solwyn.middleware }),
      prompt: SENTINEL_PROMPT,
    });
    let acc = "";
    for await (const delta of result.textStream) {
      acc += delta;
    }
    await solwyn.close();

    expect(acc).toBe(SENTINEL_RESPONSE);
    expect(captured.bodies.length).toBeGreaterThan(0);
    for (const body of captured.bodies) {
      expect(body).not.toContain(SENTINEL_PROMPT);
      expect(body).not.toContain(SENTINEL_RESPONSE);
    }
    for (const header of captured.headerValues) {
      expect(header).not.toContain(SENTINEL_PROMPT);
      expect(header).not.toContain(SENTINEL_RESPONSE);
    }
  });
});

// ---------------------------------------------------------------------------
// Agentic content sizing — tool-call inputs, tool-result outputs, inline-file text,
// and streamed tool-input deltas all contribute to the estimate (invariant 6).
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — agentic prompt sizing", () => {
  it("counts tool-call input, tool-result output, and inline-file text in the pre-flight estimate", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    // A step-2 agent prompt: a tiny text part, then the bulk of the bytes in a tool-call's
    // arguments object, a tool-result's text output, and a file part's inline text — none of
    // which the shared `{text}`-block walker sees.
    const textPart = "hi";
    const toolInput = { location: "San Francisco", precision: "high", note: "n".repeat(200) };
    const toolOutputText = "y".repeat(300);
    const fileText = "z".repeat(100);
    const prompt = [
      { role: "user", content: [{ type: "text", text: textPart }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "getWeather", input: toolInput },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "getWeather",
            output: { type: "text", value: toolOutputText },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "file", mediaType: "text/plain", data: { type: "text", text: fileText } },
        ],
      },
    ];

    await wrapGenerateDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: { prompt },
      doGenerate: async () => ({ content: [{ type: "text", text: "ok" }], usage: usage(9, 3) }),
    });
    await solwyn.close();

    const expectedChars =
      textPart.length + JSON.stringify(toolInput).length + toolOutputText.length + fileText.length;
    const estimate = captured.checks[0]?.["estimated_input_tokens"];
    expect(estimate).toBe(estTokens(expectedChars));
    // Guard the regression: the text-only walk would have estimated a floor of 1 token.
    expect(estimate).toBeGreaterThan(estTokens(textPart.length));
  });

  it("estimates output tokens for a tool-call-only response with no reported usage (buffered)", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    // A usage-less endpoint serves a tool-call-only step (finishReason "tool-calls"); the
    // content is entirely the stringified tool arguments — zero `{text}` parts.
    const argsJson = JSON.stringify({ query: "weather in SF", extra: "w".repeat(400) });
    await wrapGenerateDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: { prompt: [{ role: "user", content: [{ type: "text", text: "call the tool" }] }] },
      doGenerate: async () => ({
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "getWeather", input: argsJson }],
        usage: NO_USAGE,
      }),
    });
    await solwyn.close();

    const success = captured.events.filter((e) => e.status === "success");
    expect(success).toHaveLength(1);
    // No silent zero: the tool-call arguments drive a non-zero estimated output.
    expect(success[0]?.token_details?.["is_estimated"]).toBe(true);
    expect(success[0]?.output_tokens).toBe(estTokens(argsJson.length));
    expect(success[0]?.output_tokens).toBeGreaterThan(0);
  });

  it("estimates output tokens from streamed tool-input deltas with no reported usage (stream)", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    const deltas = ['{"location":"', "San Francisco", '","unit":"celsius"}'];
    const fullArgs = deltas.join("");
    const { stream } = await wrapStreamDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "stream a tool call" }] }],
      },
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "t1", toolName: "getWeather" },
          { type: "tool-input-delta", id: "t1", delta: deltas[0] },
          { type: "tool-input-delta", id: "t1", delta: deltas[1] },
          { type: "tool-input-delta", id: "t1", delta: deltas[2] },
          { type: "tool-input-end", id: "t1" },
          // The terminal aggregate tool-call repeats the assembled args — must NOT double-count.
          { type: "tool-call", toolCallId: "t1", toolName: "getWeather", input: fullArgs },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: NO_USAGE,
          },
        ]),
      }),
    });
    expect(await drain(stream)).toBeUndefined();
    await solwyn.close();

    const success = captured.events.filter((e) => e.status === "success");
    expect(success).toHaveLength(1);
    expect(success[0]?.token_details?.["is_estimated"]).toBe(true);
    // Exactly the summed deltas — NOT deltas + the terminal tool-call aggregate.
    expect(success[0]?.output_tokens).toBe(estTokens(fullArgs.length));
    expect(success[0]?.output_tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Mid-stream rejection settlement matches the core client.
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — mid-stream rejection (F9)", () => {
  it("settles an established-then-dropped stream with possibly_succeeded and NO failover_error_class", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    class StreamBoom extends Error {
      constructor() {
        super("stream dropped mid-flight");
        this.name = "StreamBoom";
      }
    }

    const { stream } = await wrapStreamDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: { prompt: [{ role: "user", content: [{ type: "text", text: "stream it" }] }] },
      doStream: async () => ({
        // The stream ESTABLISHES (delivers a chunk) then drops — a mid-stream error, not a
        // pre-first-chunk establishment failure.
        stream: streamThenError(
          [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "partial output" },
          ],
          new StreamBoom(),
        ),
      }),
    });
    const rejection = await drain(stream);
    await solwyn.close();

    // The error still propagates to the caller unchanged.
    expect(rejection).toBeInstanceOf(StreamBoom);

    const errors = captured.events.filter((e) => e.status === "error");
    expect(errors).toHaveLength(1);
    // Established stream may have generated billable output → possibly_succeeded true.
    expect(errors[0]?.possibly_succeeded).toBe(true);
    // Mid-stream errors never fail over, so no health-signal
    // class name is sent (null → dropped from the wire), unlike the buffered/establishment path.
    expect(errors[0]?.failover_error_class).toBeUndefined();
    // No confirm (reservation left to expire), no success double-settle.
    expect(captured.confirms).toHaveLength(0);
    expect(captured.events.filter((e) => e.status === "success")).toHaveLength(0);
  });

  it("keeps the class name on a pre-first-chunk establishment failure (not a mid-stream drop)", async () => {
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    class EstablishBoom extends Error {
      constructor() {
        super("could not open the stream");
        this.name = "EstablishBoom";
      }
    }

    await expect(
      wrapStreamDirect(solwyn, {
        model: { provider: "openai", modelId: "gpt-4o" },
        params: { prompt: [{ role: "user", content: [{ type: "text", text: "stream it" }] }] },
        doStream: async () => {
          throw new EstablishBoom();
        },
      }),
    ).rejects.toBeInstanceOf(EstablishBoom);
    await solwyn.close();

    const errors = captured.events.filter((e) => e.status === "error");
    expect(errors).toHaveLength(1);
    // Establishment failure is failover-eligible → the structural class name is preserved.
    expect(errors[0]?.failover_error_class).toBe("EstablishBoom");
    // Pre-first-chunk: the stream never established → not possibly_succeeded.
    expect(errors[0]?.possibly_succeeded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lease funding propagation and one-shot ownership.
// ---------------------------------------------------------------------------

describe("ai-sdk middleware — lease funding ownership", () => {
  it("settles a spec-valid empty lease id after a buffered success", async () => {
    const { fetchMock, captured } = makeEmptyLeaseFetch();
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    await run("ai-empty-lease-buffered", () =>
      wrapGenerateDirect(solwyn, {
        model: { provider: "openai", modelId: "gpt-5-mini" },
        params: { prompt: [] },
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          usage: usage(8, 3),
        }),
      }),
    );
    await solwyn.close();

    expect(captured.confirms).toHaveLength(1);
    expect(captured.confirms[0]).toMatchObject({
      lease_id: "",
      token_details: { input_tokens: 8, output_tokens: 3 },
    });
    const success = captured.events.find((event) => event.status === "success");
    expect(captured.confirms[0]?.["call_id"]).toBe(success?.call_id);
  });

  it("settles a spec-valid empty lease id after a streaming success", async () => {
    const { fetchMock, captured } = makeEmptyLeaseFetch();
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    const { stream } = await run("ai-empty-lease-stream", () =>
      wrapStreamDirect(solwyn, {
        model: { provider: "anthropic", modelId: "claude-3-5-haiku" },
        params: { prompt: [] },
        doStream: async () => ({
          stream: streamOf([
            { type: "text-delta", delta: "partial" },
            { type: "finish", usage: usage(5, 2) },
          ]),
        }),
      }),
    );
    expect(await drain(stream)).toBeUndefined();
    await solwyn.close();

    expect(captured.confirms).toHaveLength(1);
    expect(captured.confirms[0]).toMatchObject({
      lease_id: "",
      token_details: { input_tokens: 5, output_tokens: 2 },
    });
    const success = captured.events.find((event) => event.status === "success");
    expect(captured.confirms[0]?.["call_id"]).toBe(success?.call_id);
  });

  it("propagates one call id and the structural output bound through buffered settlement", async () => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });

    await wrapGenerateDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-5-mini" },
      params: { prompt: [], maxOutputTokens: 640 },
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        usage: usage(8, 3),
      }),
    });
    await solwyn.close();

    const check = checkBudget.mock.calls[0]?.[0];
    const confirm = buildConfirmRequest.mock.calls[0]?.[0];
    expect(check?.callId).toMatch(/^[0-9a-f-]+$/);
    expect(check?.estimatedOutputBound).toBe(640);
    expect(confirm).toMatchObject({
      callId: check?.callId,
      leaseId: "lease-ai-1",
      leaseClaimToken: 77,
    });
    expect(confirm?.floorAtReservation).toBe(false);
    expect(captured.events[0]?.call_id).toBe(check?.callId);
    expect(releaseReservation).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("releases once and preserves a buffered dispatch failure", async () => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const sentinel = new Error("buffered-dispatch");

    const result = wrapGenerateDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: { prompt: [] },
      doGenerate: async () => {
        throw sentinel;
      },
    });

    await expect(result).rejects.toBe(sentinel);
    await solwyn.close();
    const callId = checkBudget.mock.calls[0]?.[0].callId;
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledWith(callId, 77);
    expect(buildConfirmRequest).not.toHaveBeenCalled();
    expect(captured.events.filter((event) => event.status === "error")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it.each([
    "reported-usage",
    "synthetic",
  ] as const)("returns the exact paid buffered result when hostile reads fall through the %s rung", async (rung) => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock, captured } = makeFetch(() => allow());
    const logValues: unknown[] = [];
    const logger = {
      debug: (...values: unknown[]) => logValues.push(...values),
      info: (...values: unknown[]) => logValues.push(...values),
      warn: (...values: unknown[]) => logValues.push(...values),
      error: (...values: unknown[]) => logValues.push(...values),
    };
    const solwyn = createSolwynMiddleware({ apiKey: API_KEY, fetch: fetchMock, logger });
    const secret = `BUFFERED_${rung}_MUST_NOT_LEAK`;
    let contentReads = 0;
    const result = {} as { content: unknown; usage: unknown };
    Object.defineProperties(result, {
      usage:
        rung === "reported-usage"
          ? { value: usage(4, 2), enumerable: true }
          : {
              enumerable: true,
              get(): never {
                throw new TypeError(secret);
              },
            },
      content: {
        enumerable: true,
        get(): never {
          contentReads += 1;
          throw new RangeError(secret);
        },
      },
    });

    const returned = await wrapGenerateDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "abcd" }] }],
        maxOutputTokens: 300,
      },
      doGenerate: async () => result,
    });
    expect(returned).toBe(result);
    await solwyn.close();

    const confirm = buildConfirmRequest.mock.calls[0]?.[0];
    expect(checkBudget).toHaveBeenCalledOnce();
    expect(buildConfirmRequest).toHaveBeenCalledOnce();
    expect(confirm?.floorAtReservation).toBe(rung === "synthetic");
    expect(confirm?.tokenDetails).toMatchObject(
      rung === "synthetic"
        ? { input_tokens: 1, output_tokens: 0, is_estimated: true }
        : { input_tokens: 4, output_tokens: 2, is_estimated: false },
    );
    expect(contentReads).toBe(rung === "synthetic" ? 1 : 0);
    expect(captured.events.filter((event) => event.status === "success")).toHaveLength(1);
    expect(captured.events.filter((event) => event.status === "error")).toHaveLength(0);
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(captured.bodies.join("\n")).not.toContain(secret);
    expect(logValues.map(String).join("\n")).not.toContain(secret);
  });

  it("keeps a buffered length estimate conservative against the reservation", async () => {
    const { releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const result = {
      content: [{ type: "text", text: "a measured output long enough to estimate" }],
      usage: NO_USAGE,
    };

    await expect(
      wrapGenerateDirect(solwyn, {
        model: { provider: "openai", modelId: "gpt-4o" },
        params: { prompt: [{ role: "user", content: "abcd" }] },
        doGenerate: async () => result,
      }),
    ).resolves.toBe(result);
    await solwyn.close();

    expect(buildConfirmRequest).toHaveBeenCalledOnce();
    expect(buildConfirmRequest.mock.calls[0]?.[0].floorAtReservation).toBe(true);
    expect(buildConfirmRequest.mock.calls[0]?.[0].tokenDetails).toMatchObject({
      input_tokens: 1,
      is_estimated: true,
    });
    expect(buildConfirmRequest.mock.calls[0]?.[0].tokenDetails.output_tokens).toBeGreaterThan(0);
    expect(captured.events.filter((event) => event.status === "success")).toHaveLength(1);
    expect(releaseReservation).not.toHaveBeenCalled();
  });

  it.each([
    "buffered",
    "establishment",
    "setup",
  ] as const)("preserves and releases a hostile %s thrown value without leaking caller data", async (exit) => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock, captured } = makeFetch(() => allow());
    const logValues: unknown[] = [];
    const logger = {
      debug: (...values: unknown[]) => logValues.push(...values),
      info: (...values: unknown[]) => logValues.push(...values),
      warn: (...values: unknown[]) => logValues.push(...values),
      error: (...values: unknown[]) => logValues.push(...values),
    };
    const solwyn = createSolwynMiddleware({ apiKey: API_KEY, fetch: fetchMock, logger });
    const secret = `CALLER_SECRET_${exit}_7d9f`;
    const hostile = hostileThrownValue(secret);
    const cancel = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    let caught: unknown;
    try {
      if (exit === "buffered") {
        await wrapGenerateDirect(solwyn, {
          model: { provider: "openai", modelId: "gpt-4o" },
          params: { prompt: [] },
          doGenerate: async () => Promise.reject(hostile.value),
        });
      } else {
        await wrapStreamDirect(solwyn, {
          model: { provider: "openai", modelId: "gpt-4o" },
          params: { prompt: [] },
          doStream:
            exit === "establishment"
              ? async () => Promise.reject(hostile.value)
              : async () => ({
                  stream: {
                    getReader(): never {
                      throw hostile.value;
                    },
                    cancel,
                  } as unknown as ReadableStream<unknown>,
                }),
        });
      }
    } catch (error) {
      caught = error;
    }
    await solwyn.close();

    const callId = checkBudget.mock.calls[0]?.[0].callId;
    expect(Object.is(caught, hostile.value)).toBe(true);
    expect(releaseReservation.mock.calls).toEqual([[callId, 77]]);
    expect(buildConfirmRequest).not.toHaveBeenCalled();
    expect(captured.confirms).toHaveLength(0);
    expect(hostile.messageReads()).toBe(0);
    expect(captured.bodies.join("\n")).not.toContain(secret);
    expect(captured.headerValues.join("\n")).not.toContain(secret);
    expect(logValues.some((value) => Object.is(value, hostile.value))).toBe(false);
    expect(logValues.map(String).join("\n")).not.toContain(secret);
    if (exit === "setup") {
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["end", "cancel"] as const)("settles a lease once on stream %s", async (exit) => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const { stream } = await wrapStreamDirect(solwyn, {
      model: { provider: "anthropic", modelId: "claude-3-5-haiku" },
      params: { prompt: [], maxOutputTokens: 321 },
      doStream: async () => ({
        stream: streamOf([
          { type: "text-delta", delta: "partial" },
          { type: "finish", usage: usage(5, 2) },
        ]),
      }),
    });

    if (exit === "end") {
      expect(await drain(stream)).toBeUndefined();
    } else {
      await stream.cancel("consumer stopped");
    }
    await solwyn.close();

    const callId = checkBudget.mock.calls[0]?.[0].callId;
    expect(checkBudget.mock.calls[0]?.[0].estimatedOutputBound).toBe(321);
    expect(buildConfirmRequest).toHaveBeenCalledTimes(1);
    expect(buildConfirmRequest.mock.calls[0]?.[0]).toMatchObject({
      callId,
      leaseId: "lease-ai-1",
      leaseClaimToken: 77,
    });
    expect(captured.events.filter((event) => event.status === "success")).toHaveLength(1);
    expect(releaseReservation).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("contains hostile terminal stream usage and conservatively consumes its reservation", async () => {
    const { releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock, captured } = makeFetch(() => allow());
    const secret = "TERMINAL_USAGE_MUST_NOT_LEAK";
    const logValues: unknown[] = [];
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: {
        debug: (...values: unknown[]) => logValues.push(...values),
        info: (...values: unknown[]) => logValues.push(...values),
        warn: (...values: unknown[]) => logValues.push(...values),
        error: (...values: unknown[]) => logValues.push(...values),
      },
    });
    const finish = { type: "finish" } as { type: string; usage?: unknown };
    Object.defineProperty(finish, "usage", {
      get(): never {
        throw new TypeError(secret);
      },
    });
    const { stream } = await wrapStreamDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: { prompt: [{ role: "user", content: "abcd" }] },
      doStream: async () => ({
        stream: streamOf([{ type: "text-delta", delta: "measured output" }, finish]),
      }),
    });

    expect(await drain(stream)).toBeUndefined();
    await solwyn.close();

    expect(buildConfirmRequest).toHaveBeenCalledOnce();
    expect(buildConfirmRequest.mock.calls[0]?.[0]).toHaveProperty("floorAtReservation", true);
    expect(buildConfirmRequest.mock.calls[0]?.[0].tokenDetails).toMatchObject({
      input_tokens: 1,
      is_estimated: true,
    });
    expect(buildConfirmRequest.mock.calls[0]?.[0].tokenDetails.output_tokens).toBeGreaterThan(0);
    expect(captured.events.filter((event) => event.status === "success")).toHaveLength(1);
    expect(captured.events.filter((event) => event.status === "error")).toHaveLength(0);
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(captured.bodies.join("\n")).not.toContain(secret);
    expect(logValues.map(String).join("\n")).not.toContain(secret);
  });

  it("releases once on a mid-stream rejection and preserves the source error", async () => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock, captured } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const sentinel = new Error("midstream-source");
    const { stream } = await wrapStreamDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: { prompt: [] },
      doStream: async () => ({
        stream: streamThenError([{ type: "text-delta", delta: "partial" }], sentinel),
      }),
    });

    expect(await drain(stream)).toBe(sentinel);
    await solwyn.close();
    const callId = checkBudget.mock.calls[0]?.[0].callId;
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledWith(callId, 77);
    expect(buildConfirmRequest).not.toHaveBeenCalled();
    expect(captured.events.filter((event) => event.status === "error")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("cancels the source and releases when a stream observation hook fails", async () => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const sentinel = new Error("hostile-stream-part");
    const hostilePart = new Proxy(
      {},
      {
        get() {
          throw sentinel;
        },
      },
    );
    const cancelled = vi.fn();
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(hostilePart);
      },
      cancel: cancelled,
    });
    const { stream } = await wrapStreamDirect(solwyn, {
      model: { provider: "openai", modelId: "gpt-4o" },
      params: { prompt: [] },
      doStream: async () => ({ stream: source }),
    });

    expect(await drain(stream)).toBe(sentinel);
    await solwyn.close();
    const callId = checkBudget.mock.calls[0]?.[0].callId;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledWith(callId, 77);
    expect(buildConfirmRequest).not.toHaveBeenCalled();
  });

  it("cancels an acquired reader and releases when result reconstruction fails", async () => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const cancelled = vi.fn();
    const source = new ReadableStream<unknown>({ cancel: cancelled });
    const sentinel = new Error("result-spread");

    await expect(
      wrapStreamDirect(solwyn, {
        model: { provider: "openai", modelId: "gpt-4o" },
        params: { prompt: [] },
        doStream: async () =>
          ({
            stream: source,
            get hostile(): never {
              throw sentinel;
            },
          }) as unknown as { stream: ReadableStream<unknown> },
      }),
    ).rejects.toBe(sentinel);
    await solwyn.close();

    const callId = checkBudget.mock.calls[0]?.[0].callId;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledWith(callId, 77);
    expect(buildConfirmRequest).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("cancels the source and releases when reader acquisition fails", async () => {
    const { checkBudget, releaseReservation, buildConfirmRequest } = installFundedLeaseDecision();
    const { fetchMock } = makeFetch(() => allow());
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: NOOP_LOGGER,
    });
    const sentinel = new Error("get-reader");
    const cancel = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const source = {
      getReader(): never {
        throw sentinel;
      },
      cancel,
    } as unknown as ReadableStream<unknown>;

    await expect(
      wrapStreamDirect(solwyn, {
        model: { provider: "openai", modelId: "gpt-4o" },
        params: { prompt: [] },
        doStream: async () => ({ stream: source }),
      }),
    ).rejects.toBe(sentinel);
    await solwyn.close();

    const callId = checkBudget.mock.calls[0]?.[0].callId;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledTimes(1);
    expect(releaseReservation).toHaveBeenCalledWith(callId, 77);
    expect(buildConfirmRequest).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("ai-sdk middleware — lease activation identity", () => {
  it("uses one SDK instance id for the lease holder and metadata", async () => {
    const grants: Array<Record<string, unknown>> = [];
    const events: WireEvent[] = [];
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (path === "/api/v1/budgets/lease") {
        grants.push(body as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            eligible: true,
            allowed: true,
            lease_id: "lease-ai-holder",
            generation: 1,
            // Enough for the configured 768 default, but not the built-in 4096 default:
            // proves the middleware option reached the real lease ledger.
            granted_tokens: 1_024,
            refresh_interval_s: 300,
            lease_length_s: 600,
            headroom_share_tokens: 0,
            posture: { mode: "alert_only", on_unreachable: "fail_open" },
            final_grant: false,
            project_id: `proj_${"0".repeat(24)}`,
            mode: "alert_only",
            budget_limit: 1_000,
            current_usage: 100,
            remaining_budget: 900,
          }),
          { status: 200 },
        );
      }
      if (path === "/api/v1/metadata/ingest") {
        events.push(...(body as WireEvent[]));
        return new Response(
          JSON.stringify({ ingested: (body as unknown[]).length, rejected: [] }),
          {
            status: 202,
          },
        );
      }
      if (path === "/api/v1/budgets/confirm" || path === "/api/v1/budgets/lease/surrender") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected control-plane path ${path}`);
    };
    const solwyn = createSolwynMiddleware({
      apiKey: API_KEY,
      fetch,
      logger: NOOP_LOGGER,
      breakerReportingEnabled: false,
      leaseEnabled: true,
      leaseOutputBoundDefault: 768,
    });

    await run("ai-holder", async () => {
      await wrapGenerateDirect(solwyn, {
        model: { provider: "openai", modelId: "gpt-4o" },
        params: { prompt: [] },
        doGenerate: async () => ({
          content: [{ type: "text", text: "ok" }],
          usage: usage(3, 2),
        }),
      });
    });
    await solwyn.close();

    expect(grants).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(grants[0]?.["holder_id"]).toBe(events[0]?.sdk_instance_id);
  });
});
