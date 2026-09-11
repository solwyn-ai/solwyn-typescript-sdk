/**
 * Client-level failover integration covering candidate walks, disposition-driven dispatch,
 * settlement, classification, and dispatch-loop rules through the real `Solwyn` client and
 * adapter registry. Every provider client is a plain object
 * shaped like the vendor SDK (no provider SDK imported), the Solwyn Cloud API `fetch` is
 * mocked, and everything is fully offline.
 *
 * Covered intents:
 *  - a FAILOVER-classified primary error dispatches the same-dialect fallback NATIVELY, with
 *    budget/confirm/metadata attribution to the fallback NAME (invariant 5), is_provider_fallback
 *    true, and failover_reason = "primary_error" (reactive);
 *  - a FAIL_FAST (400-shaped) error stops the chain, re-raises the ORIGINAL, and NEVER counts the
 *    breaker (no fallback attempt);
 *  - an OPEN, not-recovery-eligible primary breaker is SKIPPED (proactive reroute) with the served
 *    fallback carrying failover_reason = "circuit_open";
 *  - a cross-dialect hop FAILS LOUD (`UntranslatableRequestError` propagates, foreign endpoint never
 *    dispatched), and when translatable, reshapes the served response back to the caller's
 *    dialect;
 *  - a spent chain deadline stops the walk with `ProviderUnavailableError("failover deadline expired")`
 *    with the attempted providers;
 *  - a streaming PRE-first-chunk (establishment) failure walks to the next candidate;
 *  - the double-spend classifier trap: a timeout-shaped error subclassing a connection-shaped error
 *    stays POST_SEND_AMBIGUOUS (does NOT fail over under "safe"), while a pure pre-send connection
 *    error DOES fail over.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SolwynCore } from "../../src/client";
import { ProviderUnavailableError, UntranslatableRequestError } from "../../src/errors";
import {
  CircuitBreaker,
  CircuitBreakerManager,
  CostPolicy,
  classifyException,
  Deadline,
  Disposition,
  HealthBasedPolicy,
  LatencyPolicy,
  type SelectionPolicy,
  Solwyn,
} from "../../src/index";
import type { Logger } from "../../src/logging";
import { currentRun, run } from "../../src/node";
import * as translation from "../../src/providers/translation/index";
import {
  markTerminated,
  postcheckTermination,
  resetRunControlForTest,
} from "../../src/run-control";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

afterEach(() => {
  resetRunControlForTest();
});

interface Capture {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  checks: Array<Record<string, unknown>>;
  confirms: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

/** A cloud-API fetch that captures check/confirm/event bodies and ALLOWS with a reservation. */
function makeCapture(directives: readonly (boolean | null | "unreachable")[] = []): Capture {
  const checks: Array<Record<string, unknown>> = [];
  const confirms: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      if (raw !== undefined) {
        checks.push(raw as Record<string, unknown>);
      }
      const directive = directives[checks.length - 1];
      if (directive === "unreachable") {
        return Promise.reject(new TypeError("offline"));
      }
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 950,
          reservation_id: "res-1",
          mode: "alert_only",
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
          ...(typeof directive === "boolean"
            ? {
                failover_directive: {
                  version: "1",
                  failover_tuning_allowed: directive,
                },
              }
            : {}),
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      if (raw !== undefined) {
        confirms.push(raw as Record<string, unknown>);
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(raw)) {
      events.push(...(raw as Array<Record<string, unknown>>));
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), checks, confirms, events };
}

/** A minimal OpenAI-dialect client (native `openai` NAME). */
function openaiClient(
  create: (kwargs: Record<string, unknown>, ...passthroughArgs: unknown[]) => unknown,
) {
  return { chat: { completions: { create: vi.fn(create) } } };
}

/** A minimal OpenAI-compatible client whose baseURL resolves to a distinct NAME (e.g. deepseek). */
function compatClient(
  baseURL: string,
  create: (kwargs: Record<string, unknown>, ...passthroughArgs: unknown[]) => unknown,
) {
  return { chat: { completions: { create: vi.fn(create) } }, baseURL };
}

/** An error carrying an HTTP status the classifier reads (`.status`, matching the npm SDKs). */
function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------------------
// Package-root export surface for the routing subsystem.
// ---------------------------------------------------------------------------

describe("failover — routing public surface is importable from the package root", () => {
  it("re-exports the three policies, the protocol, the classifier, and the deadline", () => {
    expect(new HealthBasedPolicy()).toBeInstanceOf(HealthBasedPolicy);
    expect(new LatencyPolicy()).toBeInstanceOf(LatencyPolicy);
    expect(new CostPolicy()).toBeInstanceOf(CostPolicy);
    const custom: SelectionPolicy = { order: (c) => [...c] };
    expect(typeof custom.order).toBe("function");
    expect(typeof classifyException).toBe("function");
    expect(new Deadline(30).remaining()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Failover-tuning entitlement directives — live client application.
// ---------------------------------------------------------------------------

describe("failover — tuning entitlement directives", () => {
  const defaultBreakerTuning = {
    failureThreshold: 3,
    recoveryTimeout: 60,
    successThreshold: 2,
    recoveryTimeoutJitter: 0.2,
  };
  const requestedBreakerTuning = {
    failureThreshold: 8,
    recoveryTimeout: 75,
    successThreshold: 6,
    recoveryTimeoutJitter: 0.05,
  };

  it("cycles false→true→false with exact eight-field tuning, stable identities, and one warning", async () => {
    const managerRetune = vi.spyOn(CircuitBreakerManager.prototype, "replaceTuning");
    const breakerRetune = vi.spyOn(CircuitBreaker.prototype, "replaceTuning");
    const deadlineRetune = vi.spyOn(Deadline.prototype, "replaceTotal");
    const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
    const logger = {
      debug: vi.fn<(message: string, ...args: unknown[]) => void>(),
      info: vi.fn<(message: string, ...args: unknown[]) => void>(),
      warn,
      error: vi.fn<(message: string, ...args: unknown[]) => void>(),
    } satisfies Logger;
    const runtimeOrders: unknown[][] = [];
    const providerOrders: string[][] = [];
    const policy: SelectionPolicy = {
      order(candidates) {
        runtimeOrders.push(candidates.map((candidate) => candidate.runtime));
        providerOrders.push(candidates.map((candidate) => candidate.runtime.adapter.name));
        return [...candidates];
      },
    };
    const primary = openaiClient(() => ({ usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    const { fetchMock } = makeCapture([false, true, false, false]);

    try {
      const solwyn = new Solwyn(primary, {
        apiKey: API_KEY,
        fetch: fetchMock,
        logger,
        fallback: [[fallback, "deepseek-chat"]],
        selectionPolicy: policy,
        failoverTotalTimeout: 91,
        failoverHopReadTimeout: 42,
        failoverIdempotency: "never",
        sameProviderRetries: 4,
        circuitBreakerRecoveryTimeoutJitter: 0.05,
        circuitBreakerFailureThreshold: 8,
        circuitBreakerRecoveryTimeout: 75,
        circuitBreakerSuccessThreshold: 6,
      });

      for (let index = 0; index < 4; index += 1) {
        await solwyn.chat.completions.create({
          model: `gpt-4o-${index}`,
          messages: [],
        });
      }
      await solwyn.close();

      expect(managerRetune.mock.calls).toEqual([
        [defaultBreakerTuning],
        [requestedBreakerTuning],
        [defaultBreakerTuning],
      ]);
      expect(new Set(managerRetune.mock.contexts).size).toBe(1);
      expect(deadlineRetune.mock.calls.map(([total]) => total)).toEqual([30, 91, 30, 30]);
      expect(new Set(deadlineRetune.mock.contexts).size).toBe(4);

      expect(breakerRetune).toHaveBeenCalledTimes(6);
      const firstCycle = breakerRetune.mock.contexts.slice(0, 2);
      expect(new Set(breakerRetune.mock.contexts).size).toBe(2);
      expect(breakerRetune.mock.contexts.slice(2, 4)).toEqual(firstCycle);
      expect(breakerRetune.mock.contexts.slice(4, 6)).toEqual(firstCycle);
      expect(runtimeOrders).toHaveLength(4);
      expect(runtimeOrders.slice(1).every((order) => order[0] === runtimeOrders[0]?.[0])).toBe(
        true,
      );
      expect(runtimeOrders.slice(1).every((order) => order[1] === runtimeOrders[0]?.[1])).toBe(
        true,
      );
      expect(providerOrders).toEqual(Array.from({ length: 4 }, () => ["openai", "deepseek"]));
      expect(primary.chat.completions.create).toHaveBeenCalledTimes(4);
      expect(fallback.chat.completions.create).not.toHaveBeenCalled();
      expect(
        primary.chat.completions.create.mock.calls.map(
          (call) => (call[1] as Record<string, unknown>)["timeout"],
        ),
      ).toEqual([600_000, 42_000, 600_000, 600_000]);
      expect(
        warn.mock.calls.filter(
          ([message]) =>
            message === "Custom failover tuning is unavailable for this plan; SDK defaults applied",
        ),
      ).toHaveLength(1);
    } finally {
      managerRetune.mockRestore();
      breakerRetune.mockRestore();
      deadlineRetune.mockRestore();
    }
  });

  it("suppression uses safe/no-retry defaults and restoration re-enables never/one-retry", async () => {
    let primaryCalls = 0;
    const retryable = () =>
      Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    const primary = openaiClient(() => {
      primaryCalls += 1;
      throw retryable();
    });
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    const { fetchMock } = makeCapture([false, true]);
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "deepseek-chat"]],
      failoverIdempotency: "never",
      sameProviderRetries: 1,
      failoverHopReadTimeout: 42,
    });

    await solwyn.chat.completions.create({ model: "first", messages: [] });
    await expect(solwyn.chat.completions.create({ model: "second", messages: [] })).rejects.toThrow(
      "rate limited",
    );
    await solwyn.close();

    expect(primaryCalls).toBe(3);
    expect(fallback.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(
      primary.chat.completions.create.mock.calls.map(
        (call) => (call[1] as Record<string, unknown>)["timeout"],
      ),
    ).toEqual([600_000, 42_000, 42_000]);
    expect(
      (fallback.chat.completions.create.mock.calls[0]?.[1] as Record<string, unknown>)["timeout"],
    ).toBe(600_000);
  });

  it("snapshots current tuning and replaces the deadline for live null, fail-open, and cache results", async () => {
    const managerRetune = vi.spyOn(CircuitBreakerManager.prototype, "replaceTuning");
    const deadlineRetune = vi.spyOn(Deadline.prototype, "replaceTotal");
    const primary = openaiClient(() => ({ usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    const { fetchMock } = makeCapture([null, "unreachable"]);
    try {
      const solwyn = new Solwyn(primary, {
        apiKey: API_KEY,
        fetch: fetchMock,
        failOpen: true,
        failoverTotalTimeout: 91,
        failoverHopReadTimeout: 42,
        circuitBreakerFailureThreshold: 8,
      });
      await solwyn.chat.completions.create({ model: "first", messages: [] });
      await solwyn.chat.completions.create({ model: "second", messages: [] });
      await solwyn.chat.completions.create({ model: "first", messages: [] });
      await solwyn.close();

      expect(managerRetune).not.toHaveBeenCalled();
      expect(deadlineRetune.mock.calls.map(([total]) => total)).toEqual([91, 91, 91]);
      expect(primary.chat.completions.create).toHaveBeenCalledTimes(3);
      expect(
        primary.chat.completions.create.mock.calls.map(
          (call) => (call[1] as Record<string, unknown>)["timeout"],
        ),
      ).toEqual([42_000, 42_000, 42_000]);
    } finally {
      managerRetune.mockRestore();
      deadlineRetune.mockRestore();
    }
  });

  it("freezes the exact four-field call snapshot for null, true, and false directives", async () => {
    const freeze = vi.spyOn(Object, "freeze");
    const primary = openaiClient(() => ({ usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    const { fetchMock } = makeCapture([null, true, false]);
    try {
      const solwyn = new Solwyn(primary, {
        apiKey: API_KEY,
        fetch: fetchMock,
        failoverTotalTimeout: 91,
        failoverHopReadTimeout: 42,
        failoverIdempotency: "never",
        sameProviderRetries: 4,
      });
      for (const model of ["null-current", "true-custom", "false-default"]) {
        await solwyn.chat.completions.create({ model, messages: [] });
      }
      await solwyn.close();

      const keys = ["hopReadTimeout", "idempotency", "sameProviderRetries", "totalTimeout"];
      const snapshots = freeze.mock.calls
        .map(([value]) => value)
        .filter(
          (value): value is Record<string, unknown> =>
            typeof value === "object" &&
            value !== null &&
            Object.keys(value).sort().join(",") === keys.join(","),
        );
      expect(snapshots).toEqual([
        {
          totalTimeout: 91,
          idempotency: "never",
          sameProviderRetries: 4,
          hopReadTimeout: 42,
        },
        {
          totalTimeout: 91,
          idempotency: "never",
          sameProviderRetries: 4,
          hopReadTimeout: 42,
        },
        {
          totalTimeout: 30,
          idempotency: "safe",
          sameProviderRetries: 0,
          hopReadTimeout: 600,
        },
      ]);
      expect(snapshots.every((snapshot) => Object.isFrozen(snapshot))).toBe(true);
    } finally {
      freeze.mockRestore();
    }
  });

  it("keeps one call's mode, retries, and read bound after a later call mutates live tuning", async () => {
    let firstAttempts = 0;
    let rejectFirst: ((reason: unknown) => void) | undefined;
    const terminal = Object.assign(new Error("terminal rate limit"), {
      status: 429,
      headers: { "retry-after": "0" },
    });
    const primary = openaiClient((kwargs) => {
      if (kwargs["model"] !== "first") {
        return { usage: { prompt_tokens: 2, completion_tokens: 1 } };
      }
      firstAttempts += 1;
      if (firstAttempts === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      throw terminal;
    });
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    const { fetchMock } = makeCapture([true, false]);
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "deepseek-chat"]],
      failoverIdempotency: "never",
      sameProviderRetries: 1,
      failoverHopReadTimeout: 42,
    });

    const firstOutcome = solwyn.chat.completions.create({ model: "first", messages: [] }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
    await solwyn.chat.completions.create({ model: "second", messages: [] });
    rejectFirst?.(
      Object.assign(new Error("initial rate limit"), {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );

    expect(await firstOutcome).toBe(terminal);
    await solwyn.close();

    expect(fallback.chat.completions.create).not.toHaveBeenCalled();
    expect(
      primary.chat.completions.create.mock.calls.map(
        (call) => (call[1] as Record<string, unknown>)["timeout"],
      ),
    ).toEqual([42_000, 600_000, 42_000]);
  });

  it("replaces the media deadline before primary-only dispatch", async () => {
    const order: string[] = [];
    const originalReplaceTotal = Deadline.prototype.replaceTotal;
    const deadlineRetune = vi
      .spyOn(Deadline.prototype, "replaceTotal")
      .mockImplementation(function replaceTotal(this: Deadline, total: number) {
        order.push(`deadline:${total}`);
        return originalReplaceTotal.call(this, total);
      });
    const embeddingsCreate = vi.fn((_kwargs: Record<string, unknown>) => {
      order.push("dispatch");
      return { usage: { prompt_tokens: 3 } };
    });
    const client = {
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: embeddingsCreate },
    };
    const { fetchMock } = makeCapture([false]);
    try {
      const solwyn = new Solwyn(client, {
        apiKey: API_KEY,
        fetch: fetchMock,
        failoverTotalTimeout: 91,
      });
      await solwyn.embeddings.create({ model: "text-embedding-3-small", input: "hello" });
      await solwyn.close();

      expect(order.slice(0, 2)).toEqual(["deadline:30", "dispatch"]);
      expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    } finally {
      deadlineRetune.mockRestore();
    }
  });
});

describe("failover — Bedrock runtime socket-timeout warning", () => {
  const warning =
    "Bedrock client (model %s) has no readable finite socket timeout: Solwyn passes requestTimeout per call, but cannot guarantee a hard end-to-end Converse stream deadline and only checks the failover deadline BETWEEN hops, so one stuck read can hang the call indefinitely. Configure a finite socket timeout on the client's requestHandler.";

  class BedrockRuntimeClient {
    readonly send = vi.fn();
    config?: unknown;

    constructor(config?: unknown) {
      if (config !== undefined) {
        this.config = config;
      }
    }
  }

  function logger() {
    return {
      debug: vi.fn<(message: string, ...args: unknown[]) => void>(),
      info: vi.fn<(message: string, ...args: unknown[]) => void>(),
      warn: vi.fn<(message: string, ...args: unknown[]) => void>(),
      error: vi.fn<(message: string, ...args: unknown[]) => void>(),
    } satisfies Logger;
  }

  it("warns once for every primary/fallback runtime with readable missing or unbounded state", async () => {
    const primary = new BedrockRuntimeClient();
    const fallback = new BedrockRuntimeClient({ requestHandler: { socketTimeout: null } });
    const log = logger();
    const { fetchMock } = makeCapture();
    const core = new SolwynCore(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: log,
      provider: "bedrock",
      model: "amazon.nova-pro-v1:0",
      fallback: [[fallback, "meta.llama3-1-70b-instruct-v1:0", {}, "bedrock"]],
      breakerReportingEnabled: false,
    });

    await core.resolveMediaRequest({ model: "amazon.nova-pro-v1:0" });
    await core.resolveMediaRequest({ model: "amazon.nova-pro-v1:0" });
    await core.close();

    expect(log.warn.mock.calls).toEqual([
      [warning, "amazon.nova-pro-v1:0"],
      [warning, "meta.llama3-1-70b-instruct-v1:0"],
    ]);
  });

  it.each([
    undefined,
    null,
    0,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("warns for readable socketTimeout=%s", async (socketTimeout) => {
    const client = new BedrockRuntimeClient({ requestHandler: { socketTimeout } });
    const log = logger();
    const { fetchMock } = makeCapture();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: log,
      provider: "bedrock",
      model: "amazon.nova-lite-v1:0",
      breakerReportingEnabled: false,
    });

    await core.resolveMediaRequest({ model: "amazon.nova-lite-v1:0" });
    await core.close();
    expect(log.warn.mock.calls).toEqual([[warning, "amazon.nova-lite-v1:0"]]);
  });

  it("stays silent for finite-positive state and hostile/unreadable state", async () => {
    const finite = new BedrockRuntimeClient({ requestHandler: { socketTimeout: 60 } });
    const hostile = new BedrockRuntimeClient();
    Object.defineProperty(hostile, "config", {
      get() {
        throw new Error("hostile config");
      },
    });
    const throwingTimeout = new BedrockRuntimeClient({
      requestHandler: Object.defineProperty({}, "socketTimeout", {
        get() {
          throw new Error("hostile timeout");
        },
      }),
    });
    const log = logger();
    const { fetchMock } = makeCapture();
    const core = new SolwynCore(finite, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: log,
      provider: "bedrock",
      model: "finite-model",
      fallback: [
        [hostile, "hostile-model", {}, "bedrock"],
        [throwingTimeout, "throwing-model", {}, "bedrock"],
      ],
      breakerReportingEnabled: false,
    });

    await core.resolveMediaRequest({ model: "finite-model" });
    await core.close();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FAILOVER: same-dialect cross-provider native passthrough.
// ---------------------------------------------------------------------------

describe("failover — same-dialect FAILOVER serves the fallback natively with NAME attribution", () => {
  it("dispatches the deepseek fallback, attributing budget/confirm/metadata to its own NAME", async () => {
    const primary = openaiClient(() => {
      // 429 → FAILOVER (a provable rejection safe to cross providers under the default "safe").
      throw statusError("rate limited", 429);
    });
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({
      usage: { prompt_tokens: 8, completion_tokens: 5 },
    }));
    const { fetchMock, checks, confirms, events } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "deepseek-chat"]],
    });

    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello there" }],
    });
    await solwyn.close();

    // The primary was attempted-and-errored; the fallback served the call natively.
    expect(primary.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fallback.chat.completions.create).toHaveBeenCalledTimes(1);
    // The fallback hop swapped in its OWN configured model (never the caller's gpt-4o).
    const fallbackCallArg = fallback.chat.completions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(fallbackCallArg["model"]).toBe("deepseek-chat");

    // Budget pre-flight: primary NAME + the fallback chain carries the compat NAME.
    expect(checks).toHaveLength(1);
    expect(checks[0]?.["provider"]).toBe("openai");
    expect(checks[0]?.["fallback_providers"]).toEqual(["deepseek"]);
    expect(checks[0]?.["fallback_models"]).toEqual(["deepseek-chat"]);

    // The reservation confirm attributes to the SERVED fallback NAME + model, is_provider_fallback.
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.["provider"]).toBe("deepseek");
    expect(confirms[0]?.["model"]).toBe("deepseek-chat");
    expect(confirms[0]?.["is_provider_fallback"]).toBe(true);

    // Two metadata events: the primary's 429 error event and the served
    // fallback's success event. The advancing FAILOVER hop is NO longer silent.
    expect(events).toHaveLength(2);
    const errorEvent = events.find((e) => e["status"] === "error") as Record<string, unknown>;
    // The intermediate 429 reports an error event attributed to the FAILED primary (openai).
    expect(errorEvent["provider"]).toBe("openai");
    expect(errorEvent["is_provider_fallback"]).toBe(false);
    expect(typeof errorEvent["failover_error_class"]).toBe("string");
    // A failed-over hop never flags possibly_succeeded.
    expect("possibly_succeeded" in errorEvent).toBe(false);
    const event = events.find((e) => e["status"] === "success") as Record<string, unknown>;
    expect(event["provider"]).toBe("deepseek");
    expect(event["model"]).toBe("deepseek-chat");
    expect(event["is_provider_fallback"]).toBe(true);
    expect(event["is_model_fallback"]).toBe(false);
    // Reactive failover: the primary WAS attempted and threw.
    expect(event["failover_reason"]).toBe("primary_error");
    expect(event["requested_provider"]).toBe("openai");
    expect(event["requested_model"]).toBe("gpt-4o");
    // Configured-chain position (1 = first fallback), not the walk position.
    expect(event["attempt_index"]).toBe(1);
    // The confirm + the success event share the reconciliation join key.
    expect(confirms[0]?.["call_id"]).toBe(event["call_id"]);
  });
});

// ---------------------------------------------------------------------------
// FAIL_FAST: request-shaped error stops the chain, no failover, no breaker penalty.
// ---------------------------------------------------------------------------

describe("failover — a FAIL_FAST (400) error stops the chain and never touches the breaker", () => {
  it("re-raises the ORIGINAL error, never dispatches the fallback, and never opens the breaker", async () => {
    const badRequest = statusError("invalid request", 400);
    const primary = openaiClient(() => {
      throw badRequest;
    });
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({ usage: {} }));
    const { fetchMock, events, confirms } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "deepseek-chat"]],
    });

    // Five consecutive FAIL_FAST errors. If a 400 counted toward the breaker it would OPEN at the
    // default threshold (3) and the 4th/5th calls would raise ProviderUnavailableError; because
    // FAIL_FAST is request-shaped (never a health signal), every call re-reaches the primary and
    // re-raises the IDENTICAL original error, and the fallback is NEVER attempted.
    for (let i = 0; i < 5; i += 1) {
      await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
        badRequest,
      );
    }
    await solwyn.close();

    expect(primary.chat.completions.create).toHaveBeenCalledTimes(5);
    expect(fallback.chat.completions.create).not.toHaveBeenCalled();
    // Five terminal error events (one per FAIL_FAST); no confirm (nothing was served).
    expect(events.filter((e) => e["status"] === "error")).toHaveLength(5);
    expect(confirms).toHaveLength(0);
    // A FAIL_FAST error event carries the structural class name, never possibly_succeeded.
    const errorEvent = events.find((e) => e["status"] === "error") as Record<string, unknown>;
    expect(errorEvent["failover_error_class"]).toBe("Error");
    expect("possibly_succeeded" in errorEvent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker: OPEN-not-eligible primary is skipped (proactive reroute).
// ---------------------------------------------------------------------------

describe("failover — an OPEN primary breaker is skipped straight to the fallback", () => {
  it("proactively reroutes without dispatching the primary; served event reason is circuit_open", async () => {
    // The primary always 429s (FAILOVER, counts the breaker); the fallback always serves. After 3
    // primary failures the breaker OPENS; on the next call the primary is skipped at admission
    // (OPEN, not recovery-eligible) so it is never dispatched again, and the served fallback's
    // event reason flips from reactive "primary_error" to proactive "circuit_open".
    const primary = openaiClient(() => {
      throw statusError("rate limited", 429);
    });
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
    const { fetchMock, events } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "deepseek-chat"]],
    });

    // Three calls: each attempts the primary (429 → breaker failure) then serves the fallback.
    for (let i = 0; i < 3; i += 1) {
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    }
    // The primary was dispatched each of the first three walks (attempted-and-errored).
    expect(primary.chat.completions.create).toHaveBeenCalledTimes(3);

    // Fourth call: the primary breaker is now OPEN — it is SKIPPED without dispatch (the spy count
    // is observable synchronously, before the reporter has flushed its batched events).
    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    // The primary was NOT dispatched a fourth time (proactive skip).
    expect(primary.chat.completions.create).toHaveBeenCalledTimes(3);
    expect(fallback.chat.completions.create).toHaveBeenCalledTimes(4);

    // Flush the batched telemetry, then inspect the events.
    await solwyn.close();
    // Seven events: the first three walks each emit a primary-429 error
    // event + a fallback success; the fourth walk skips the OPEN primary (no error event) and
    // emits only the fallback success.
    expect(events).toHaveLength(7);
    const errors = events.filter((e) => e["status"] === "error");
    const successes = events.filter((e) => e["status"] === "success");
    // Three primary errors (walks 1–3); the fourth walk's OPEN primary is skipped at admission.
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e["provider"] === "openai")).toBe(true);
    // Four fallback successes, all attributed to the served deepseek NAME.
    expect(successes).toHaveLength(4);
    expect(successes.every((e) => e["provider"] === "deepseek")).toBe(true);
    expect(successes.every((e) => e["is_provider_fallback"] === true)).toBe(true);
    // Match by call_id rather than delivery order: the first reserved call is a settlement,
    // so its success may flush behind later cache-hit event-only calls.
    const erroredCallIds = new Set(errors.map((event) => event["call_id"]));
    expect(erroredCallIds.size).toBe(3);
    const reactiveSuccesses = successes.filter((event) => erroredCallIds.has(event["call_id"]));
    const proactiveSuccesses = successes.filter((event) => !erroredCallIds.has(event["call_id"]));
    expect(reactiveSuccesses).toHaveLength(3);
    expect(reactiveSuccesses.every((event) => event["failover_reason"] === "primary_error")).toBe(
      true,
    );
    expect(proactiveSuccesses).toHaveLength(1);
    expect(proactiveSuccesses[0]?.["failover_reason"]).toBe("circuit_open");
  });
});

// ---------------------------------------------------------------------------
// Same-dialect Bedrock-to-Bedrock model-override command rebuild.
// ---------------------------------------------------------------------------

/** An AWS-import-free command class named like AWS SDK v3's `ConverseCommand`. */
class ConverseCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

class IntegrationBedrockRuntimeClient {
  readonly meta: {
    readonly service_model: { readonly service_name: "bedrock-runtime" };
    readonly region_name: string;
  };

  constructor(
    region: string,
    readonly send: ReturnType<typeof vi.fn>,
  ) {
    this.meta = {
      service_model: { service_name: "bedrock-runtime" },
      region_name: region,
    };
  }
}

describe("failover — a same-dialect bedrock→bedrock hop rebuilds the Converse command for the served model (D14)", () => {
  it("dispatches a same-constructor sibling carrying the FALLBACK modelId; the primary command is untouched", async () => {
    // Primary bedrock client 429s (FAILOVER); the same-dialect bedrock fallback serves the hop.
    // Because the customer's ORIGINAL ConverseCommand carries the PRIMARY modelId, the walk must
    // rebuild a sibling command with the fallback entry's model before dispatching to the
    // fallback client. The fallback endpoint must receive the
    // fallback model, never the primary's.
    const primarySend = vi.fn((..._args: unknown[]) => {
      throw statusError("throttled", 429);
    });
    const primary = new IntegrationBedrockRuntimeClient("us-east-1", primarySend);
    const fallbackSend = vi.fn((..._args: unknown[]) => ({
      usage: { inputTokens: 12, outputTokens: 7 },
    }));
    const fallback = new IntegrationBedrockRuntimeClient("eu-central-1", fallbackSend);
    const { fetchMock, confirms, events } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "meta.llama3-1-70b-instruct-v1:0"]],
    });

    const primaryModel = "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
    const command = new ConverseCommand({
      modelId: primaryModel,
      messages: [{ role: "user", content: [{ text: "hi" }] }],
    });
    await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(command);
    await solwyn.close();

    // Both bedrock clients were dispatched: the primary (429) then the fallback (served).
    expect(primarySend).toHaveBeenCalledTimes(1);
    expect(fallbackSend).toHaveBeenCalledTimes(1);
    // The primary received the customer's original command by identity.
    expect(primarySend.mock.calls[0]?.[0]).toBe(command);
    // The fallback received a REBUILT sibling of the same constructor carrying the fallback model.
    const served = fallbackSend.mock.calls[0]?.[0] as ConverseCommand;
    expect(served).not.toBe(command);
    expect(served).toBeInstanceOf(ConverseCommand);
    expect(served.input["modelId"]).toBe("meta.llama3-1-70b-instruct-v1:0");
    // The customer's original command is never mutated.
    expect(command.input["modelId"]).toBe(primaryModel);

    // The served hop attributes to the fallback NAME/model + region (bedrock is per-model+region).
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.["provider"]).toBe("bedrock");
    expect(confirms[0]?.["model"]).toBe("meta.llama3-1-70b-instruct-v1:0");
    expect(confirms[0]?.["provider_region"]).toBe("eu-central-1");
    const success = events.find((e) => e["status"] === "success");
    expect(success?.["model"]).toBe("meta.llama3-1-70b-instruct-v1:0");
    expect(success?.["is_model_fallback"]).toBe(true);
    expect(success?.["provider_region"]).toBe("eu-central-1");
    // The primary's 429 error event carries the FAILED (primary) hop's region — not null — so a
    // A possibly-succeeded abort on a regionally priced provider stays reconcilable.
    const errorEvent = events.find((e) => e["status"] === "error");
    expect(errorEvent?.["provider"]).toBe("bedrock");
    expect(errorEvent?.["provider_region"]).toBe("us-east-1");
  });
});

// ---------------------------------------------------------------------------
// Cross-dialect: translate-or-fail-loud.
// ---------------------------------------------------------------------------

describe("failover — a cross-dialect hop translates the request or fails loud", () => {
  it("fails loud with UntranslatableRequestError when the target is bedrock (no reachable command ctor, D14)", async () => {
    // Anthropic primary → Bedrock fallback. The primary 429s (FAILOVER); the cross-dialect hop
    // INTO bedrock has no reachable Converse command constructor (the primary is not bedrock), so
    // `fromCanonical("bedrock", ...)` fails loud BEFORE any dispatch — and the abort PROPAGATES to
    // the caller (never swallowed into a retry), with the bedrock endpoint never contacted.
    const anthropicCreate = vi.fn(() => {
      throw statusError("overloaded", 429);
    });
    const primary = { messages: { create: anthropicCreate } };
    const bedrockSend = vi.fn();
    const bedrock = new IntegrationBedrockRuntimeClient("us-east-1", bedrockSend);
    const { fetchMock, events, confirms } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[bedrock, "us.anthropic.claude-3-5-sonnet-20241022-v2:0"]],
    });

    const err = await (
      solwyn as unknown as { messages: { create(k: unknown): Promise<unknown> } }
    ).messages
      .create({
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await solwyn.close();

    expect(err).toBeInstanceOf(UntranslatableRequestError);
    expect((err as UntranslatableRequestError).feature).toBe("bedrock.no_converse_command");
    // The primary was attempted; the bedrock endpoint was NEVER dispatched (fail loud pre-send).
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(bedrockSend).not.toHaveBeenCalled();
    // No confirm (nothing served) — the untranslatable abort is not a served success.
    expect(confirms).toHaveLength(0);
    // The events array holds no success (the whole chain aborted).
    expect(events.some((e) => e["status"] === "success")).toBe(false);
  });

  it("translates OpenAI→Anthropic text and reshapes the served response back to the caller's dialect", async () => {
    // OpenAI primary 429s (FAILOVER) → Anthropic fallback serves the translated request and its
    // native response is reshaped back to the OpenAI wire shape before returning to the caller.
    const primary = openaiClient(() => {
      throw statusError("rate limited", 429);
    });
    const anthropicResponse = {
      role: "assistant",
      content: [{ type: "text", text: "hello from claude" }],
      stop_reason: "end_turn",
      model: "claude-3-5-sonnet-20241022",
      usage: { input_tokens: 11, output_tokens: 7 },
    };
    const anthropicCreate = vi.fn(() => anthropicResponse);
    const fallback = { messages: { create: anthropicCreate } };
    const { fetchMock, confirms, events } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "claude-3-5-sonnet-20241022"]],
    });

    const result = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    })) as Record<string, unknown>;
    await solwyn.close();

    // The anthropic fallback served the translated request.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    // The response was reshaped back to the OpenAI wire shape (a `choices` array) for the caller.
    expect(Array.isArray(result["choices"])).toBe(true);
    // Attribution is to the served anthropic NAME, reactive failover.
    expect(confirms[0]?.["provider"]).toBe("anthropic");
    const event = events.find((e) => e["status"] === "success") as Record<string, unknown>;
    expect(event["provider"]).toBe("anthropic");
    expect(event["is_provider_fallback"]).toBe(true);
    expect(event["failover_reason"]).toBe("primary_error");
    expect(event["requested_provider"]).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// Deadline exhaustion stops the walk.
// ---------------------------------------------------------------------------

describe("failover — a spent chain deadline stops the walk before any dispatch", () => {
  it('throws ProviderUnavailableError("failover deadline expired") and dispatches nothing', async () => {
    const primary = openaiClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({ usage: {} }));
    const { fetchMock } = makeCapture();
    // A zero whole-chain timeout: the deadline is already spent by the time the walk begins.
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      failoverTotalTimeout: 0,
      fallback: [[fallback, "deepseek-chat"]],
    });

    let runId = "";
    let err: unknown;
    await run("entry-deadline-cleanup", async () => {
      runId = currentRun()?.agentRunId ?? "";
      err = await solwyn.chat.completions
        .create({ model: "gpt-4o", messages: [], stream: true })
        .then(
          () => null,
          (e: unknown) => e,
        );
    });
    await solwyn.close();

    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as ProviderUnavailableError).message).toContain("deadline");
    // The full ordered candidate-name list is reported as attempted; nothing was dispatched.
    expect((err as ProviderUnavailableError).attempted).toContain("openai");
    expect(primary.chat.completions.create).not.toHaveBeenCalled();
    expect(fallback.chat.completions.create).not.toHaveBeenCalled();
    markTerminated(runId, { reason: "after_entry_deadline", source: "server" });
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-entry-deadline-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });

  it("releases the watcher when the deadline expires between candidates", async () => {
    let monotonicNow = 0;
    const primaryFailure = statusError("rate limited after delay", 429);
    const primary = openaiClient(async () => {
      monotonicNow = 5;
      throw primaryFailure;
    });
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({ usage: {} }));
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      failoverTotalTimeout: 0.001,
      failoverIdempotency: "always",
      leaseEnabled: false,
      fallback: [[fallback, "deepseek-chat"]],
    });

    let runId = "";
    let err: unknown;
    // Keep preflight inside the 1 ms window; only the primary advances past the deadline.
    const now = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    try {
      await run("between-candidate-deadline-cleanup", async () => {
        runId = currentRun()?.agentRunId ?? "";
        err = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [], stream: true })
          .catch((error: unknown) => error);
      });
    } finally {
      now.mockRestore();
      await solwyn.close();
    }

    expect(err).toBe(primaryFailure);
    expect(primary.chat.completions.create).toHaveBeenCalledOnce();
    expect(fallback.chat.completions.create).not.toHaveBeenCalled();
    markTerminated(runId, { reason: "after_between_deadline", source: "server" });
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-between-deadline-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Streaming: pre-first-chunk (establishment) failure walks to the next candidate.
// ---------------------------------------------------------------------------

describe("failover — a streaming establishment failure fails over to the next candidate", () => {
  it("walks past a primary whose stream establishment rejects and settles on the fallback stream", async () => {
    const primary = openaiClient(() => {
      // Establishment (the `.create(stream: true)` call) rejects BEFORE any wrapper exists → the
      // pre-first-chunk error is failover-eligible.
      throw statusError("rate limited", 429);
    });
    async function* fallbackStream(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "hi" } }] };
      yield { choices: [], usage: { prompt_tokens: 8, completion_tokens: 5 } };
    }
    const fallback = compatClient("https://api.deepseek.com/v1", () => fallbackStream());
    const { fetchMock, events } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "deepseek-chat"]],
    });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello there" }],
      stream: true,
    })) as AsyncIterable<unknown>;

    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    await solwyn.close();

    // The primary establishment was attempted; the fallback stream served the call.
    expect(primary.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(fallback.chat.completions.create).toHaveBeenCalledTimes(1);
    // The caller received the fallback's raw chunks unchanged (same-dialect passthrough).
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // TWO events: the primary's establishment 429 error event + the served fallback settlement.
    expect(events).toHaveLength(2);
    const errorEvent = events.find((e) => e["status"] === "error") as Record<string, unknown>;
    expect(errorEvent["provider"]).toBe("openai");
    const event = events.find((e) => e["status"] === "success") as Record<string, unknown>;
    expect(event["provider"]).toBe("deepseek");
    expect(event["is_provider_fallback"]).toBe(true);
    expect(event["failover_reason"]).toBe("primary_error");
  });
});

// ---------------------------------------------------------------------------
// Double-spend classifier trap: timeout-shaped-before-connection-shaped.
// ---------------------------------------------------------------------------

describe("failover — the double-spend trap: an ambiguous timeout subclassing a connection error", () => {
  it("classifies a timeout that subclasses a connection error as POST_SEND_AMBIGUOUS, not FAILOVER", () => {
    // `APITimeoutError` subclasses `APIConnectionError` in the openai/anthropic SDKs — a naive
    // connection-first branch would misread the ambiguous post-send timeout as a safe pre-send
    // failover and DOUBLE-SPEND. The classifier checks the timeout name FIRST.
    class APIConnectionError extends Error {
      constructor() {
        super("connection");
        this.name = "APIConnectionError";
      }
    }
    class APITimeoutError extends APIConnectionError {
      constructor() {
        super();
        this.name = "APITimeoutError";
      }
    }
    expect(classifyException(new APITimeoutError())).toBe(Disposition.POST_SEND_AMBIGUOUS);
    // A BARE connection error (no timeout subclass) is a provable pre-send outage → FAILOVER.
    class ConnectError extends Error {
      constructor() {
        super("refused");
        this.name = "ConnectError";
      }
    }
    expect(classifyException(new ConnectError())).toBe(Disposition.FAILOVER);
  });

  it('does NOT fail over on an ambiguous timeout under "safe", but DOES on a pre-send connection error', async () => {
    class APIConnectionError extends Error {
      constructor(name = "APIConnectionError") {
        super("connection");
        this.name = name;
      }
    }
    class APITimeoutError extends APIConnectionError {
      constructor() {
        super("APITimeoutError");
      }
    }

    // (a) Ambiguous timeout: POST_SEND_AMBIGUOUS under the default "safe" idempotency re-raises the
    // ORIGINAL and does NOT cross providers — the fallback is never attempted (no double-spend).
    {
      const timeout = new APITimeoutError();
      const primary = openaiClient(() => {
        throw timeout;
      });
      const fallback = compatClient("https://api.deepseek.com/v1", () => ({ usage: {} }));
      const { fetchMock, events } = makeCapture();
      const solwyn = new Solwyn(primary, {
        apiKey: API_KEY,
        fetch: fetchMock,
        fallback: [[fallback, "deepseek-chat"]],
      });
      await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
        timeout,
      );
      await solwyn.close();
      expect(fallback.chat.completions.create).not.toHaveBeenCalled();
      // The not-failed-over post-send-ambiguous abort is the ONLY case flagging possibly_succeeded.
      const event = events.find((e) => e["status"] === "error") as Record<string, unknown>;
      expect(event["possibly_succeeded"]).toBe(true);
    }

    // (b) Pre-send connection error: FAILOVER crosses providers under "safe" — the fallback serves.
    {
      const primary = openaiClient(() => {
        throw new APIConnectionError("ConnectError");
      });
      const fallback = compatClient("https://api.deepseek.com/v1", () => ({
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }));
      const { fetchMock, events } = makeCapture();
      const solwyn = new Solwyn(primary, {
        apiKey: API_KEY,
        fetch: fetchMock,
        fallback: [[fallback, "deepseek-chat"]],
      });
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
      await solwyn.close();
      expect(fallback.chat.completions.create).toHaveBeenCalledTimes(1);
      const event = events.find((e) => e["status"] === "success") as Record<string, unknown>;
      expect(event["provider"]).toBe("deepseek");
    }
  });
});

// ---------------------------------------------------------------------------
// Zero translation on the native path: the
// native happy path and a same-provider model swap NEVER touch the translation seam.
// ---------------------------------------------------------------------------

describe("failover — the native path performs ZERO translation (TestZeroTranslationOnNativePath)", () => {
  it("never calls toCanonical / normalizeResponse on a primary-served native call", async () => {
    const toCanonicalSpy = vi.spyOn(translation, "toCanonical");
    const normalizeSpy = vi.spyOn(translation, "normalizeResponse");
    const primary = openaiClient(() => ({ usage: { prompt_tokens: 5, completion_tokens: 3 } }));
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(primary, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    await solwyn.close();

    // The native happy path short-circuits before the content-privileged translation seam.
    expect(toCanonicalSpy).not.toHaveBeenCalled();
    expect(normalizeSpy).not.toHaveBeenCalled();
    toCanonicalSpy.mockRestore();
    normalizeSpy.mockRestore();
  });

  it("never calls toCanonical / normalizeResponse on a same-provider model-swap failover", async () => {
    const toCanonicalSpy = vi.spyOn(translation, "toCanonical");
    const normalizeSpy = vi.spyOn(translation, "normalizeResponse");
    // The primary model 429s (FAILOVER) → a same-provider model-swap entry on the SAME client
    // serves. A same-dialect hop is native passthrough — no translation, even on failover.
    let call = 0;
    const create = vi.fn((_kwargs: Record<string, unknown>) => {
      call += 1;
      if (call === 1) {
        throw statusError("rate limited", 429);
      }
      return { usage: { prompt_tokens: 4, completion_tokens: 2 } };
    });
    const client = { chat: { completions: { create } } };
    const { fetchMock, events } = makeCapture();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[client, "gpt-4o-mini"]],
    });

    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    await solwyn.close();

    expect(toCanonicalSpy).not.toHaveBeenCalled();
    expect(normalizeSpy).not.toHaveBeenCalled();
    // The swap served on the SAME client, attributed as a model (not provider) fallback.
    const success = events.find((e) => e["status"] === "success") as Record<string, unknown>;
    expect(success["is_model_fallback"]).toBe(true);
    expect(success["is_provider_fallback"]).toBe(false);
    toCanonicalSpy.mockRestore();
    normalizeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Cross-dialect streaming failover: per-chunk translateStreamChunk wiring and the
// pre-dispatch tool-stream guard through
// the real client walk.
// ---------------------------------------------------------------------------

describe("failover — a cross-dialect streaming hop translates chunks or fails loud on tools", () => {
  it("streams openai→anthropic failover, translating each chunk back to the caller's dialect", async () => {
    const primary = openaiClient(() => {
      // Establishment (streaming `.create`) rejects with a 429 → pre-first-chunk FAILOVER.
      throw statusError("rate limited", 429);
    });
    async function* anthropicStream(): AsyncGenerator<unknown> {
      yield { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      };
      yield { type: "message_stop" };
    }
    const anthropicCreate = vi.fn(() => anthropicStream());
    const fallback = { messages: { create: anthropicCreate } };
    const { fetchMock, confirms, events } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "claude-3-5-sonnet-20241022"]],
    });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      stream: true,
    })) as AsyncIterable<unknown>;

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Record<string, unknown>);
    }
    await solwyn.close();

    // The anthropic fallback served the translated streaming request.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    // Every chunk delivered to the caller is OpenAI-dialect shaped (a `choices` array) — the
    // translateStreamChunk seam ran end-to-end, and the PRIMARY (openai) adapter owned the result.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => Array.isArray(c["choices"]))).toBe(true);
    const textDelta = chunks.find((c) => {
      const choice = (c["choices"] as Array<Record<string, unknown>>)[0];
      return (choice?.["delta"] as Record<string, unknown> | undefined)?.["content"] === "hello";
    });
    expect(textDelta).toBeDefined();

    // ONE primary error event + ONE settlement; usage settles from the RAW anthropic stream.
    expect(events.filter((e) => e["status"] === "error")).toHaveLength(1);
    const success = events.filter((e) => e["status"] === "success");
    expect(success).toHaveLength(1);
    const event = success[0] as Record<string, unknown>;
    expect(event["provider"]).toBe("anthropic");
    expect(event["is_provider_fallback"]).toBe(true);
    expect(event["failover_reason"]).toBe("primary_error");
    expect(event["input_tokens"]).toBe(11);
    expect(event["output_tokens"]).toBe(7);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.["provider"]).toBe("anthropic");
  });

  it("cooperatively stops a served cross-dialect stream with one partial settlement", async () => {
    const primary = openaiClient(() => {
      throw statusError("rate limited", 429);
    });
    let rawPulls = 0;
    let closed = 0;
    async function* anthropicStream(): AsyncGenerator<unknown> {
      try {
        rawPulls += 1;
        yield { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } };
        rawPulls += 1;
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        rawPulls += 1;
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "no" } };
        rawPulls += 1;
        yield { type: "content_block_stop", index: 0 };
        rawPulls += 1;
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        };
      } finally {
        closed += 1;
      }
    }
    const fallback = { messages: { create: vi.fn(() => anthropicStream()) } };
    const { fetchMock, confirms, events } = makeCapture();
    const translateChunk = vi.spyOn(translation, "translateStreamChunk");
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "claude-3-5-sonnet-20241022"]],
      velocityMode: "off",
    });

    let firstError: unknown;
    let secondError: unknown;
    let firstItem: IteratorResult<unknown> | undefined;
    let translationsBeforeStop = 0;
    let translationsAfterStop = 0;
    let runId = "";
    try {
      await run("cross-stream-stop", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const stream = (await solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 100,
          stream: true,
        })) as AsyncIterableIterator<unknown>;
        firstItem = await stream.next();
        translationsBeforeStop = translateChunk.mock.calls.length;
        markTerminated(runId, { reason: "operator_stop", source: "server" });
        firstError = await stream.next().catch((error: unknown) => error);
        secondError = await stream.next().catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
      translationsAfterStop = translateChunk.mock.calls.length;
      translateChunk.mockRestore();
    }

    expect(firstItem).toMatchObject({ done: false, value: { choices: expect.any(Array) } });
    expect(firstError).toMatchObject({
      name: "RunStoppedError",
      reason: "operator_stop",
      source: "server",
    });
    expect(secondError).toBe(firstError);
    expect(rawPulls).toBe(4);
    expect(closed).toBe(1);
    expect(translationsAfterStop).toBe(translationsBeforeStop);
    const success = events.filter((event) => event["status"] === "success");
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      input_tokens: 11,
      output_tokens: 0,
      token_details: { input_tokens: 11, output_tokens: 0 },
      is_provider_fallback: true,
      requested_provider: "openai",
      requested_model: "gpt-4o",
      agent_run_id: runId,
    });
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({
      reservation_id: "res-1",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      token_details: { input_tokens: 11, output_tokens: 0 },
      call_id: success[0]?.["call_id"],
    });
    markTerminated(runId, { reason: "after_cross_stop", source: "server" });
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-cross-stop-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });

  it("fails loud BEFORE dispatching the anthropic client when a streaming request carries tools", async () => {
    // Tool-call deltas are outside the supported streaming-translation subset, so the guard must
    // raise before any foreign
    // stream is opened.
    const primary = openaiClient(() => {
      throw statusError("rate limited", 429);
    });
    const anthropicCreate = vi.fn();
    const fallback = { messages: { create: anthropicCreate } };
    const { fetchMock, confirms, events } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "claude-3-5-sonnet-20241022"]],
    });

    const err = await solwyn.chat.completions
      .create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await solwyn.close();

    expect(err).toBeInstanceOf(UntranslatableRequestError);
    expect((err as UntranslatableRequestError).feature).toBe("cross_provider_tool_stream");
    // The foreign (anthropic) client was NEVER dispatched — the guard fired pre-send.
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(confirms).toHaveLength(0);
    expect(events.some((e) => e["status"] === "success")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Same-provider 429 retries retain one immutable provider-read bound even when the
// failover window is much shorter.
// ---------------------------------------------------------------------------

describe("failover — a same-provider 429 retry keeps the immutable provider-read bound", () => {
  it("dispatches a 42 second read bound despite a 0.25 second total window", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const generateContent = vi.fn((_args: Record<string, unknown>) => ({
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    }));
    const client = { models: { generateContent, generateContentStream: vi.fn() } };
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      failoverTotalTimeout: 0.25,
      failoverHopReadTimeout: 42,
    });

    await (
      solwyn as unknown as { models: { generateContent(k: unknown): Promise<unknown> } }
    ).models.generateContent({ model: "gemini-2.0-flash", contents: "hello there" });
    await solwyn.close();

    const dispatched = generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
    const config = dispatched["config"] as Record<string, unknown>;
    const httpOptions = config["httpOptions"] as Record<string, unknown>;
    expect(httpOptions["timeout"]).toBe(42_000);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 42_000);
    timer.mockRestore();
  });

  it("keeps 42 seconds after a Retry-After sleep", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    let call = 0;
    const generateContent = vi.fn((_args: Record<string, unknown>) => {
      call += 1;
      if (call === 1) {
        throw Object.assign(new Error("rate limited"), {
          code: 429,
          headers: { "retry-after": "0" },
        });
      }
      return { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } };
    });
    const client = { models: { generateContent, generateContentStream: vi.fn() } };
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      failoverTotalTimeout: 2,
      failoverHopReadTimeout: 42,
      sameProviderRetries: 1,
    });

    await (
      solwyn as unknown as { models: { generateContent(k: unknown): Promise<unknown> } }
    ).models.generateContent({ model: "gemini-2.0-flash", contents: "hello there" });
    await solwyn.close();

    expect(generateContent).toHaveBeenCalledTimes(2);
    const timeoutMsOf = (i: number): number => {
      const dispatched = generateContent.mock.calls[i]?.[0] as Record<string, unknown>;
      const config = dispatched["config"] as Record<string, unknown>;
      const httpOptions = config["httpOptions"] as Record<string, unknown>;
      return httpOptions["timeout"] as number;
    };
    expect(timeoutMsOf(0)).toBe(42_000);
    expect(timeoutMsOf(1)).toBe(42_000);
    expect(timer.mock.calls.filter((call) => call[1] === 42_000)).toHaveLength(2);
    timer.mockRestore();
  });
});

describe("failover — active-stream handle cleanup on terminal traversal", () => {
  it("releases the logical handle after Retry-After traversal reaches provider AbortSignal rejection", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const aborted = new DOMException("request cancelled", "AbortError");
    const primary = openaiClient((_kwargs, requestOptions) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("retry"), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      expect((requestOptions as { signal?: AbortSignal } | undefined)?.signal?.aborted).toBe(true);
      throw aborted;
    });
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "off",
      sameProviderRetries: 1,
    });

    let runId = "";
    try {
      await run("retry-abort-cleanup", async () => {
        runId = currentRun()?.agentRunId ?? "";
        await expect(
          solwyn.chat.completions.create(
            { model: "gpt-4o", messages: [], stream: true },
            { signal: controller.signal },
          ),
        ).rejects.toBe(aborted);
      });
    } finally {
      await solwyn.close();
    }

    expect(attempts).toBe(2);
    markTerminated(runId, { reason: "after_terminal", source: "server" });
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-retry-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });

  it("lets a nonzero Retry-After finish and observes a stop only at the resulting stream boundary", async () => {
    vi.useFakeTimers();
    let signalFirstAttempt: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      signalFirstAttempt = resolve;
    });
    let attempts = 0;
    let rawPulls = 0;
    async function* retriedStream(): AsyncGenerator<unknown> {
      rawPulls += 1;
      yield { choices: [{ delta: { content: "discarded" } }] };
    }
    const primary = openaiClient(() => {
      attempts += 1;
      if (attempts === 1) {
        signalFirstAttempt?.();
        throw Object.assign(new Error("retry after a real delay"), {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return retriedStream();
    });
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      velocityMode: "off",
      failoverTotalTimeout: 5,
      sameProviderRetries: 1,
    });

    let runId = "";
    let terminalError: unknown;
    try {
      await run("retry-timer-non-preemption", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const establishing = solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [],
          stream: true,
        });
        await firstAttempt;
        markTerminated(runId, { reason: "stop_during_retry_delay", source: "server" });
        await vi.advanceTimersByTimeAsync(1_000);
        const stream = (await establishing) as AsyncIterableIterator<unknown>;
        terminalError = await stream.next().catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
      vi.useRealTimers();
    }

    expect(attempts).toBe(2);
    expect(rawPulls).toBe(1);
    expect(terminalError).toMatchObject({
      name: "RunStoppedError",
      agentRunId: runId,
      reason: "stop_during_retry_delay",
      source: "server",
    });
    markTerminated(runId, { reason: "after_retry_timer", source: "server" });
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-retry-timer-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Global defaultParams reach the Bedrock rebuild seam: the
// pipeline's merged kwargs are opaque to Bedrock's Converse command, so the client
// must thread the fill-absent-layered {global, entry} defaults to prepareCall.
// ---------------------------------------------------------------------------

describe("failover — a client-level defaultParams reaches the Bedrock command boundary on the primary hop", () => {
  it("rebuilds the Converse command with the global default's inferenceConfig cap (fill-absent)", async () => {
    // A Bedrock client has client-level `defaultParams`, but its command is opaque to the
    // configuration merge. The client must thread the layered defaults to the rebuild
    // seam. A non-empty global default therefore triggers a sibling rebuild carrying the cap — a
    // stale entry-only thread would silently drop it (generations run uncapped).
    const send = vi.fn((..._args: unknown[]) => ({ usage: { inputTokens: 5, outputTokens: 3 } }));
    const bedrock = new IntegrationBedrockRuntimeClient("us-east-1", send);
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(bedrock, {
      apiKey: API_KEY,
      fetch: fetchMock,
      defaultParams: { inferenceConfig: { maxTokens: 128 } },
    });

    const model = "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
    const command = new ConverseCommand({
      modelId: model,
      messages: [{ role: "user", content: [{ text: "hi" }] }],
    });
    await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(command);
    await solwyn.close();

    expect(send).toHaveBeenCalledTimes(1);
    // A rebuilt sibling (the non-empty global default triggers a reshape even on the primary hop).
    const sent = send.mock.calls[0]?.[0] as ConverseCommand;
    expect(sent).not.toBe(command);
    expect(sent).toBeInstanceOf(ConverseCommand);
    // The global default fills the ABSENT inferenceConfig; the served model is preserved.
    expect(sent.input["inferenceConfig"]).toEqual({ maxTokens: 128 });
    expect(sent.input["modelId"]).toBe(model);
    // The customer's ORIGINAL command is never mutated.
    expect("inferenceConfig" in command.input).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Google lazy-stream establishment materialization:
// a Google `generateContentStream` generator establishes only on the FIRST pull, so
// its establishment error must be forced PRE-wrapper (materialized) to be failover-
// eligible — otherwise it would surface mid-stream (onError, no failover). This is the
// contrast to OpenAI/Anthropic, whose `.create(stream:true)` establishes eagerly.
// ---------------------------------------------------------------------------

describe("failover — a Google lazy-stream establishment error is materialized and fails over", () => {
  it("walks past a Google lazy stream whose FIRST-PULL establishment throws, onto the model-swap hop", async () => {
    let call = 0;
    // A Google lazy async-iterable: no network I/O until the first `.next()`. The primary hop's
    // stream rejects with a 429 ONLY when pulled (establishment) — exactly what materialization
    // forces pre-wrapper so the walk can fail over instead of the wrapper firing a mid-stream onError.
    const lazyEstablishmentThrow = (): AsyncIterable<unknown> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(Object.assign(new Error("rate limited"), { code: 429 })),
      }),
    });
    async function* workingStream(): AsyncGenerator<unknown> {
      yield { candidates: [{ content: { parts: [{ text: "hi" }] } }] };
      yield { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } };
    }
    const generateContentStream = vi.fn(() => {
      call += 1;
      return call === 1 ? lazyEstablishmentThrow() : workingStream();
    });
    const client = { models: { generateContent: vi.fn(), generateContentStream } };
    const { fetchMock, events } = makeCapture();
    // A same-provider model-swap fallback on the SAME google client (walks to the next candidate).
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[client, "gemini-1.5-flash"]],
    });

    const stream = (await (
      solwyn as unknown as {
        models: { generateContentStream(k: unknown): Promise<AsyncIterable<unknown>> };
      }
    ).models.generateContentStream({
      model: "gemini-2.0-flash",
      contents: "hello there",
    })) as AsyncIterable<unknown>;

    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    await solwyn.close();

    // BOTH the primary lazy establishment (materialized → threw pre-wrapper) and the served
    // model-swap stream were attempted; the caller received the fallback's chunks.
    expect(generateContentStream).toHaveBeenCalledTimes(2);
    // The served stream's two chunks are each yielded EXACTLY once — the materialization splice
    // replays the eagerly pulled first chunk without a duplicate emission.
    expect(chunks).toHaveLength(2);
    // TWO events: the primary's establishment 429 error event + the served model-swap settlement.
    expect(events).toHaveLength(2);
    const errorEvent = events.find((e) => e["status"] === "error") as Record<string, unknown>;
    expect(errorEvent["provider"]).toBe("google");
    const success = events.find((e) => e["status"] === "success") as Record<string, unknown>;
    expect(success["provider"]).toBe("google");
    // A same-provider model swap → is_model_fallback (never is_provider_fallback).
    expect(success["is_model_fallback"]).toBe(true);
    expect(success["is_provider_fallback"]).toBe(false);
    expect(success["failover_reason"]).toBe("model_fallback");
    expect(success["output_tokens"]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// o-series keyword rewrite on the failover path. A same-provider model swap onto
// an o1/o3/o4/gpt-5 target rewrites `max_tokens` → `max_completion_tokens`; a same-dialect
// cross-vendor hop rewrites the inverse for non-OpenAI targets; a cross-dialect hop filters
// the source-incompatible entry defaults before seeding translation (`_SOURCE_COMPATIBLE_DEFAULT_KEYS`).
// ---------------------------------------------------------------------------

describe("failover — the o-series completion-token rewrite matrix applies on the failover path", () => {
  it("rewrites max_tokens → max_completion_tokens on a same-provider swap onto an o-series model", async () => {
    let call = 0;
    const create = vi.fn((_kwargs: Record<string, unknown>) => {
      call += 1;
      if (call === 1) {
        throw statusError("rate limited", 429);
      }
      return { usage: { prompt_tokens: 4, completion_tokens: 2 } };
    });
    const primary = { chat: { completions: { create } } };
    const { fetchMock } = makeCapture();
    // Same-provider model-swap fallback onto an o-series model on the SAME openai client.
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[primary, "o3-mini"]],
    });

    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    });
    await solwyn.close();

    // The primary hop (gpt-4o, NOT o-series) keeps the legacy key untouched.
    const primaryArgs = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(primaryArgs["max_tokens"]).toBe(100);
    expect(primaryArgs).not.toHaveProperty("max_completion_tokens");
    // The model-swap hop (o3-mini) rewrites max_tokens → max_completion_tokens (fill-absent),
    // dropping the legacy key.
    const swapArgs = create.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(swapArgs["model"]).toBe("o3-mini");
    expect(swapArgs["max_completion_tokens"]).toBe(100);
    expect(swapArgs).not.toHaveProperty("max_tokens");
  });

  it("rewrites max_completion_tokens → legacy max_tokens on a same-dialect cross-vendor hop to a non-OpenAI target", async () => {
    const primary = openaiClient(() => {
      throw statusError("rate limited", 429);
    });
    const fallback = compatClient("https://api.deepseek.com/v1", () => ({
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "deepseek-chat"]],
    });

    // Kwargs authored for an OpenAI o-series model carry the modern key; the strict compat target
    // would 4xx it as unknown, so the same-dialect cross-vendor hop rewrites it back to the legacy key.
    await solwyn.chat.completions.create({
      model: "o3-mini",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 128,
    });
    await solwyn.close();

    const fbArgs = fallback.chat.completions.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fbArgs["model"]).toBe("deepseek-chat");
    expect(fbArgs["max_tokens"]).toBe(128);
    expect(fbArgs).not.toHaveProperty("max_completion_tokens");
  });

  it("filters a source-incompatible entry default (anthropic top_k) before seeding cross-dialect translation, then re-applies it", async () => {
    // openai → anthropic cross-dialect hop. The anthropic fallback entry carries a TARGET-NATIVE
    // default (`top_k`) that is NOT a legal openai top-level kwarg. Without _SOURCE_COMPATIBLE_DEFAULT_KEYS
    // filtering, feeding top_k into `toCanonical("openai", ...)` would fail loud (unsupported kwarg),
    // aborting the chain and never dispatching anthropic. Filtering drops it before translation; the
    // trailing entry-default fill-absent merge re-applies it onto the anthropic wire request.
    const primary = openaiClient(() => {
      throw statusError("rate limited", 429);
    });
    const anthropicCreate = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    const fallback = { messages: { create: anthropicCreate } };
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "claude-3-5-sonnet-20241022", { top_k: 40 }]],
    });

    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    });
    await solwyn.close();

    // Translation succeeded (top_k was filtered out of the canonical seed, not fed into it) and the
    // anthropic fallback WAS dispatched — the chain did not fail loud.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    const args = anthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args["model"]).toBe("claude-3-5-sonnet-20241022");
    // The target-native default is re-applied onto the translated request (fill-absent trailing merge).
    expect(args["top_k"]).toBe(40);
    // The caller's max_tokens survived translation into the anthropic dialect.
    expect(args["max_tokens"]).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// ProviderUnavailableError "all providers unavailable" attempted-list: when every eligible
// candidate refuses admission
// mid-walk (no hop ever dispatched), the terminal error must report the FULL ordered
// candidate-name list as `attempted`, not the (empty) admitted subset.
// ---------------------------------------------------------------------------

describe("failover — the terminal 'all providers unavailable' lists the full candidate names", () => {
  it("reports every candidate name as attempted when all admissions are refused (OPEN breaker)", async () => {
    // A pass-through policy that does NOT apply the health drop-filter, so an OPEN-not-recovery-
    // eligible candidate SURVIVES into the walk (where admit() refuses it) instead of being dropped
    // before the walk (which would take the empty-attempted `candidates.length === 0` branch).
    const passthroughPolicy: SelectionPolicy = { order: (candidates) => [...candidates] };
    const boom = statusError("upstream 503", 503); // POST_SEND_AMBIGUOUS → counts the breaker.
    const client = openaiClient(() => {
      throw boom;
    });
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      selectionPolicy: passthroughPolicy,
    });

    // Three consecutive health-signal failures OPEN the primary breaker (default threshold 3).
    for (let i = 0; i < 3; i += 1) {
      await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
        boom,
      );
    }
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);

    // The fourth call: the pass-through policy keeps the OPEN candidate, its admission is refused,
    // no hop is dispatched → the terminal branch throws with the FULL candidate-name list.
    const err = await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }).then(
      () => null,
      (e: unknown) => e,
    );
    await solwyn.close();

    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as ProviderUnavailableError).message).toBe("all providers unavailable");
    // The FIX: the full ordered candidate list (["openai"]), NOT the empty admitted subset.
    expect((err as ProviderUnavailableError).attempted).toEqual(["openai"]);
    // No hop was dispatched on the fourth call (admission refused).
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
  });
});
