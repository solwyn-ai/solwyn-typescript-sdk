/**
 * Budget-enforcer tests covering cache behavior, cloud allow/deny
 * (`alert_only` + `hard_deny`), the
 * fail-open / fail-closed × reachable / unreachable outage matrix, hard-deny
 * stickiness (invariant 9), outage-estimate tracking, spec-compliance field guards,
 * provider-required, confirm handoff, and a concurrent-async-calls regression guard
 * for concurrent asynchronous calls.
 *
 * All offline: `fetch` is injected, the logger is a capturing fake, and the clock is
 * injectable so cache-TTL / UTC-day behavior is deterministic.
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  BudgetEnforcer,
  budgetCheckResult,
  buildBudgetExceededError,
  DEFAULT_COST_PER_TOKEN,
} from "../../src/budget";
import {
  BudgetExceededError,
  ConfigurationError,
  RunStoppedError,
  type RunStoppedSource,
} from "../../src/errors";
import type { BudgetCheckResult } from "../../src/index";
import type { Logger } from "../../src/logging";
import { resetRunControlForTest } from "../../src/run-control";
import { zeroTokenDetails } from "../../src/token-details";
import type { BudgetCheckRequest, BudgetCheckResponse } from "../../src/types";

const API_URL = "https://api.solwyn.ai";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const CHECK_URL = `${API_URL}/api/v1/budgets/check`;

afterEach(() => resetRunControlForTest());

/** Deterministic canonical UUIDs keep confirm assertions readable and valid. */
function testCallId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Fixtures + fakes.
// ---------------------------------------------------------------------------

interface CapturedLogger {
  logger: Logger;
  debug: string[];
  info: string[];
  warn: string[];
  error: string[];
}

function capturingLogger(): CapturedLogger {
  const captured: CapturedLogger = {
    debug: [],
    info: [],
    warn: [],
    error: [],
    logger: {
      debug: (m: string) => captured.debug.push(m),
      info: (m: string) => captured.info.push(m),
      warn: (m: string) => captured.warn.push(m),
      error: (m: string) => captured.error.push(m),
    },
  };
  return captured;
}

/** A full, valid BudgetCheckResponse wire body with sensible defaults. */
function makeResponse(overrides: Partial<BudgetCheckResponse> = {}): BudgetCheckResponse {
  return {
    allowed: true,
    remaining_budget: 90,
    reservation_id: "res-abc",
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 10,
    denied_by_period: null,
    project_id: `proj_${"0".repeat(24)}`,
    price_hints: null,
    ...overrides,
  };
}

interface FetchRecord {
  url: string;
  body: string;
}

/** A fetch that returns a 200 with the given JSON response body and records the call. */
function okFetch(records: FetchRecord[], body: () => BudgetCheckResponse) {
  return async (url: string, init?: RequestInit) => {
    records.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(body()), { status: 200 });
  };
}

/** A fetch that always rejects at the network level (cloud unreachable). */
function unreachableFetch(records: FetchRecord[]) {
  return async (url: string, init?: RequestInit) => {
    records.push({ url: String(url), body: String(init?.body ?? "") });
    return Promise.reject(new TypeError("fetch failed"));
  };
}

/** A mutable epoch-ms clock for deterministic cache-TTL / day control. */
function fakeClock(start = Date.UTC(2026, 6, 3, 12, 0, 0)): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A separately controlled monotonic-ms clock for request/sticky ordering. */
function fakeMonotonicClock(start = 0): {
  now: () => number;
  set: (ms: number) => void;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    set: (ms: number) => {
      t = ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function baseCheck() {
  return { estimatedInputTokens: 1000, model: "gpt-4o", provider: "openai" as const };
}

// ---------------------------------------------------------------------------
// BudgetCheckResult value object.
// ---------------------------------------------------------------------------

describe("BudgetCheckResult", () => {
  // Mutation caught: making either WS-A4 lease field required on the root-exported
  // interface rejects a complete pre-A4 consumer literal.
  it("keeps the root-exported result compatible with complete pre-lease literals", () => {
    const legacyResult: BudgetCheckResult = {
      allowed: true,
      remainingBudget: 5,
      projectId: "proj_legacy",
      reservationId: "res_legacy",
      mode: "alert_only",
      warning: null,
      budgetLimit: 10,
      currentUsage: 5,
      priceHints: null,
      failoverTuningAllowed: null,
      deniedByPeriod: null,
    };

    expect(legacyResult.allowed).toBe(true);
  });

  // Mutation caught: returning the public optional shape from the factory allows
  // `undefined` lease authority into internal settlement contexts.
  it("materializes both lease fields in the factory return type", () => {
    expectTypeOf<ReturnType<typeof budgetCheckResult>["leaseId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ReturnType<typeof budgetCheckResult>["leaseClaimToken"]>().toEqualTypeOf<
      number | null
    >();
  });

  it("keeps denial attribution optional publicly but materializes both factory fields", () => {
    expectTypeOf<BudgetCheckResult["denySource"]>().toEqualTypeOf<
      import("../../src/types").DenySource | null | undefined
    >();
    expectTypeOf<BudgetCheckResult["denyReason"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ReturnType<typeof budgetCheckResult>["denySource"]>().toEqualTypeOf<
      import("../../src/types").DenySource | null
    >();
    expectTypeOf<ReturnType<typeof budgetCheckResult>["denyReason"]>().toEqualTypeOf<
      string | null
    >();
  });

  it("applies the settled defaults for every optional field", () => {
    const r = budgetCheckResult({ allowed: true, remainingBudget: 5 });
    expect(r).toEqual({
      allowed: true,
      remainingBudget: 5,
      projectId: null,
      reservationId: null,
      leaseId: null,
      leaseClaimToken: null,
      mode: "alert_only",
      warning: null,
      budgetLimit: 0,
      currentUsage: 0,
      priceHints: null,
      failoverTuningAllowed: null,
      deniedByPeriod: null,
      denySource: null,
      denyReason: null,
    });
  });

  it("carries every explicitly-set field through", () => {
    const r = budgetCheckResult({
      allowed: false,
      remainingBudget: 0,
      projectId: "proj_x",
      reservationId: "res_x",
      leaseId: "lease_x",
      leaseClaimToken: 17,
      mode: "hard_deny",
      warning: "nope",
      budgetLimit: 100,
      currentUsage: 100,
      priceHints: { openai: 1.2 },
      failoverTuningAllowed: true,
    });
    expect(r.mode).toBe("hard_deny");
    expect(r.priceHints).toEqual({ openai: 1.2 });
    expect(r.failoverTuningAllowed).toBe(true);
    expect(r.warning).toBe("nope");
    expect(r.leaseId).toBe("lease_x");
    expect(r.leaseClaimToken).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Stopped-run result classification.
// ---------------------------------------------------------------------------

interface DenialBuilder {
  buildDenialError(
    result: ReturnType<typeof budgetCheckResult>,
    estimatedInputTokens: number,
    agentRunId: string | null | undefined,
  ): Error;
}

function buildDenialError(
  enforcer: BudgetEnforcer,
  result: ReturnType<typeof budgetCheckResult>,
  estimatedInputTokens: number,
  agentRunId: string | null | undefined,
): Error {
  return (enforcer as unknown as DenialBuilder).buildDenialError(
    result,
    estimatedInputTokens,
    agentRunId,
  );
}

function stoppedResult(deniedByPeriod: string | null): ReturnType<typeof budgetCheckResult> {
  return budgetCheckResult({
    allowed: false,
    remainingBudget: 0,
    projectId: "proj_stopped",
    mode: "hard_deny",
    budgetLimit: 100,
    currentUsage: 99,
    deniedByPeriod,
  });
}

function stoppedBuilderEnforcer(terminationFor: (runId: string) => unknown | null): BudgetEnforcer {
  return new BudgetEnforcer({
    apiUrl: API_URL,
    apiKey: API_KEY,
    leaseEnabled: false,
    terminationFor,
  });
}

describe("BudgetEnforcer stopped-run denial builder", () => {
  it.each([
    ["ordinary period", "monthly", "run-present", "monthly"],
    ["missing period", null, "run-present", "unknown"],
    ["stopped period without a run", "run_stopped", undefined, "run_stopped"],
  ] as const)("keeps %s as the compatible BudgetExceededError and does not inspect termination state", (_label, deniedByPeriod, agentRunId, expectedPeriod) => {
    const terminationFor = vi.fn(() => ({ reason: "must-not-read", source: "server" }));
    const error = buildDenialError(
      stoppedBuilderEnforcer(terminationFor),
      stoppedResult(deniedByPeriod),
      123,
      agentRunId,
    );

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).not.toBeInstanceOf(RunStoppedError);
    expect(error).toMatchObject({ budgetPeriod: expectedPeriod, estimatedCost: 123 * 0.00003 });
    expect(terminationFor).not.toHaveBeenCalled();
  });

  it.each([
    ["trailing whitespace", "run_stopped "],
    ["stopped-prefix suffix", "run_stopped_local"],
  ] as const)("treats an active-run %s near match as an ordinary period without reading stop state", (_label, deniedByPeriod) => {
    const terminationFor = vi.fn(() => {
      throw new Error("near-match period must not resolve stopped-run state");
    });
    const error = buildDenialError(
      stoppedBuilderEnforcer(terminationFor),
      stoppedResult(deniedByPeriod),
      123,
      "run-live",
    );

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).not.toBeInstanceOf(RunStoppedError);
    expect(error).toMatchObject({
      budgetPeriod: deniedByPeriod,
      estimatedCost: 123 * 0.00003,
    });
    expect(terminationFor).not.toHaveBeenCalled();
  });

  it.each([
    ["server", { reason: "server_stop", source: "server" }],
    ["local velocity", { reason: "velocity_stop", source: "local_velocity" }],
    ["maximum reason length", { reason: "x".repeat(64), source: "server" }],
  ] as const)("uses a valid own-data %s resolution", (_label, resolution) => {
    const terminationFor = vi.fn(() => resolution);
    const error = buildDenialError(
      stoppedBuilderEnforcer(terminationFor),
      stoppedResult("run_stopped"),
      5,
      "run-live",
    );

    expect(error).toBeInstanceOf(RunStoppedError);
    expect(error).toMatchObject({ agentRunId: "run-live", ...resolution });
    expect(terminationFor).toHaveBeenCalledTimes(1);
    expect(terminationFor).toHaveBeenCalledWith("run-live");
  });

  it("falls back before evaluating the ordinary estimated-cost path for a stopped run", () => {
    const explosiveEstimate = {
      valueOf(): never {
        throw new Error("ordinary cost path must stay untouched");
      },
    } as unknown as number;

    const error = buildDenialError(
      stoppedBuilderEnforcer(() => null),
      stoppedResult("run_stopped"),
      explosiveEstimate,
      "run-live",
    );

    expect(error).toBeInstanceOf(RunStoppedError);
    expect(error).toMatchObject({
      agentRunId: "run-live",
      reason: "run_stopped",
      source: "server",
    });
  });

  it("normalizes hostile termination values without masking a stopped denial", () => {
    let getterReads = 0;
    const accessor = {};
    Object.defineProperties(accessor, {
      reason: {
        enumerable: true,
        get() {
          getterReads += 1;
          throw new Error("caller-private getter");
        },
      },
      source: { enumerable: true, value: "server" },
    });
    const inherited = Object.create({ reason: "inherited", source: "local_velocity" });
    const revoked = Proxy.revocable({ reason: "revoked", source: "server" }, {});
    revoked.revoke();
    const hostile: ReadonlyArray<readonly [string, () => unknown | null]> = [
      [
        "callback throw",
        () => {
          throw new Error("callback failed");
        },
      ],
      ["primitive", () => "not-a-record"],
      ["absent property", () => ({ reason: "only-reason" })],
      ["accessor", () => accessor],
      ["inherited properties", () => inherited],
      ["revoked proxy", () => revoked.proxy],
      ["empty reason", () => ({ reason: "", source: "server" })],
      ["oversized reason", () => ({ reason: "x".repeat(65), source: "server" })],
      ["unknown source", () => ({ reason: "bad-source", source: "other" })],
    ];

    for (const [_label, resolve] of hostile) {
      const error = buildDenialError(
        stoppedBuilderEnforcer(() => resolve()),
        stoppedResult("run_stopped"),
        5,
        "run-live",
      );
      expect(error).toBeInstanceOf(RunStoppedError);
      expect(error).toMatchObject({
        agentRunId: "run-live",
        reason: "run_stopped",
        source: "server" satisfies RunStoppedSource,
      });
    }
    expect(getterReads).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Request building.
// ---------------------------------------------------------------------------

describe("buildCheckRequest", () => {
  it("types media fallback arrays as optional while text requests retain them at runtime", () => {
    const mediaRequest: BudgetCheckRequest = {
      estimated_input_tokens: 0,
      model: "imagen-3",
      provider: "google",
      modality: "image",
    };
    expect(mediaRequest).not.toHaveProperty("fallback_providers");
    expect(mediaRequest).not.toHaveProperty("fallback_models");
    expectTypeOf<BudgetCheckRequest["fallback_providers"]>().toEqualTypeOf<
      Array<BudgetCheckRequest["provider"]> | undefined
    >();
    expectTypeOf<BudgetCheckRequest["fallback_models"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("emits only the check fields, passes tokens/model/provider through, never leaks other shapes", () => {
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
    const req = enforcer.buildCheckRequest({
      estimatedInputTokens: 42,
      model: "gpt-4o",
      provider: "openai",
    });
    expect(req).toEqual({
      estimated_input_tokens: 42,
      model: "gpt-4o",
      provider: "openai",
      fallback_providers: [],
      fallback_models: [],
      failover_directive_version: "1",
      price_hints_version: "1",
      run_directive_version: "1",
    });
    // No cross-shape leakage (e.g. project_id / reservation_id).
    expect(Object.keys(req).sort()).toEqual([
      "estimated_input_tokens",
      "failover_directive_version",
      "fallback_models",
      "fallback_providers",
      "model",
      "price_hints_version",
      "provider",
      "run_directive_version",
    ]);
  });

  it("defaults fallback arrays to [] and never mutates the caller's arrays", () => {
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
    const fallbackProviders: ("openai" | "anthropic")[] = ["anthropic"];
    const fallbackModels = ["claude-3"];
    const req = enforcer.buildCheckRequest({
      estimatedInputTokens: 1,
      model: "m",
      provider: "openai",
      fallbackProviders,
      fallbackModels,
    });
    // Copied, not aliased.
    expect(req.fallback_providers).not.toBe(fallbackProviders);
    expect(req.fallback_models).not.toBe(fallbackModels);
    if (req.fallback_providers === undefined || req.fallback_models === undefined) {
      throw new Error("text budget checks must include fallback arrays");
    }
    req.fallback_providers.push("google");
    expect(fallbackProviders).toEqual(["anthropic"]);
    expect(fallbackModels).toEqual(["claude-3"]);
  });

  it("sends fallback arrays over the wire on the actual check POST", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse()),
    });
    await enforcer.checkBudget({ ...baseCheck() });
    const sent = JSON.parse(records[0]?.body ?? "null");
    expect(sent.fallback_providers).toEqual([]);
    expect(sent.fallback_models).toEqual([]);
    expect(sent.price_hints_version).toBe("1");
    expect(records[0]?.url).toBe(CHECK_URL);
  });

  it("always opts into failover directives and omits an absent run id", () => {
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
    expect(enforcer.buildCheckRequest(baseCheck())).toMatchObject({
      failover_directive_version: "1",
    });
    expect(enforcer.buildCheckRequest(baseCheck())).not.toHaveProperty("agent_run_id");
  });

  it("copies supplied tags onto the check request while omitting absent tags", () => {
    // Mutation caught: dropping tags or retaining the caller's mutable record causes
    // control-plane attribution to be missing or change after capture.
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
    const tags = { customer: "acme", environment: "test" };
    const request = enforcer.buildCheckRequest({
      ...baseCheck(),
      tags,
    });

    expect(request.tags).toEqual({ customer: "acme", environment: "test" });
    expect(request.tags).not.toBe(tags);
    tags.customer = "mutated";
    expect(request.tags).toEqual({ customer: "acme", environment: "test" });
    expect(enforcer.buildCheckRequest({ ...baseCheck(), tags: null })).not.toHaveProperty("tags");
  });

  it("sends an own __proto__ tag exactly while keeping the call tagged and lease-ineligible", async () => {
    const records: FetchRecord[] = [];
    const tags = Object.fromEntries([
      ["__proto__", "admin"],
      ["constructor", "safe"],
    ]);
    const sourcePrototype = Object.getPrototypeOf(tags);
    const protoDescriptor = Object.getOwnPropertyDescriptor(tags, "__proto__");
    const constructorDescriptor = Object.getOwnPropertyDescriptor(tags, "constructor");
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: true,
      fetch: okFetch(records, () => makeResponse()),
    });

    await enforcer.checkBudget({
      ...baseCheck(),
      agentRunId: "run-reserved-tags",
      tags,
    });
    await enforcer.close();

    expect(records).toHaveLength(1);
    expect(records[0]?.url).toBe(CHECK_URL);
    const sent = JSON.parse(records[0]?.body ?? "null") as Record<string, unknown>;
    const sentTags = Reflect.get(sent, "tags") as object;
    expect(Object.getPrototypeOf(sentTags)).toBe(Object.prototype);
    expect(Object.hasOwn(sentTags, "__proto__")).toBe(true);
    expect(Reflect.get(sentTags, "__proto__")).toBe("admin");
    expect(Object.hasOwn(sentTags, "constructor")).toBe(true);
    expect(Reflect.get(sentTags, "constructor")).toBe("safe");
    expect(Object.getPrototypeOf(tags)).toBe(sourcePrototype);
    expect(Object.getOwnPropertyDescriptor(tags, "__proto__")).toEqual(protoDescriptor);
    expect(Object.getOwnPropertyDescriptor(tags, "constructor")).toEqual(constructorDescriptor);
    expect(Reflect.get(tags, "__proto__")).toBe("admin");
    expect(Reflect.get(tags, "constructor")).toBe("safe");
  });

  it("serializes a supplied run id on the outbound check", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      fetch: okFetch(records, () => makeResponse()),
    });

    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-7" });

    expect(JSON.parse(records[0]?.body ?? "null")).toMatchObject({
      agent_run_id: "run-7",
      failover_directive_version: "1",
    });
  });
});

// ---------------------------------------------------------------------------
// Provider is required at runtime.
// ---------------------------------------------------------------------------

describe("checkBudget provider requirement", () => {
  it("throws ConfigurationError when provider is missing, even from untyped JS", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse()),
    });
    // Simulate an untyped JS caller passing no provider.
    const opts = { estimatedInputTokens: 1, model: "m" } as unknown as Parameters<
      BudgetEnforcer["checkBudget"]
    >[0];
    await expect(enforcer.checkBudget(opts)).rejects.toBeInstanceOf(ConfigurationError);
    // No HTTP call was attempted.
    expect(records).toHaveLength(0);
  });

  it("throws ConfigurationError on an empty-string provider", async () => {
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
    const opts = { estimatedInputTokens: 1, model: "m", provider: "" } as unknown as Parameters<
      BudgetEnforcer["checkBudget"]
    >[0];
    await expect(enforcer.checkBudget(opts)).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// Outbound check requests are validated before send. A caller bug must raise
// loudly instead of 422ing on the wire, being misread as an outage, and fail-opening.
// ---------------------------------------------------------------------------

describe("checkBudget outbound request validation", () => {
  it("retains the direct-call 5-second timeout when no timeout is supplied", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const budget = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });

    try {
      const result = budget.checkBudget(baseCheck());
      await vi.advanceTimersByTimeAsync(4999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ allowed: true });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a hot chain cache bypass validation for an invalid estimate", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse()),
    });
    await enforcer.checkBudget(baseCheck());

    await expect(
      enforcer.checkBudget({ ...baseCheck(), estimatedInputTokens: -1 }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(records).toHaveLength(1);
  });

  it("throws (no fetch, no fail-open) on misaligned fallback arrays", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: okFetch(records, () => makeResponse()),
    });
    await expect(
      enforcer.checkBudget({
        estimatedInputTokens: 1,
        model: "m",
        provider: "openai",
        // Two providers but only one model — the alignment invariant is violated.
        fallbackProviders: ["anthropic", "google"],
        fallbackModels: ["claude-3"],
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    // Never went to the wire, never degraded to a fail-open allow.
    expect(records).toHaveLength(0);
  });

  it("throws (no fetch) on an invalid provider string from an untyped caller", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: okFetch(records, () => makeResponse()),
    });
    const opts = {
      estimatedInputTokens: 1,
      model: "m",
      provider: "not_a_provider",
    } as unknown as Parameters<BudgetEnforcer["checkBudget"]>[0];
    await expect(enforcer.checkBudget(opts)).rejects.toBeInstanceOf(ConfigurationError);
    expect(records).toHaveLength(0);
  });

  it("throws (no fetch) when more than 8 fallback models are supplied", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: okFetch(records, () => makeResponse()),
    });
    await expect(
      enforcer.checkBudget({
        estimatedInputTokens: 1,
        model: "m",
        provider: "openai",
        fallbackProviders: Array.from({ length: 9 }, () => "anthropic" as const),
        fallbackModels: Array.from({ length: 9 }, (_, i) => `m${i}`),
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cloud allow.
// ---------------------------------------------------------------------------

describe("cloud reachable + allow", () => {
  it("returns allowed with fields flowing through untouched and no warning", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () =>
        makeResponse({
          remaining_budget: 77,
          reservation_id: "res-1",
          budget_limit: 100,
          current_usage: 23,
        }),
      ),
    });
    const r = await enforcer.checkBudget({ ...baseCheck() });
    expect(r.allowed).toBe(true);
    expect(r.warning).toBeNull();
    expect(r.remainingBudget).toBe(77);
    expect(r.reservationId).toBe("res-1");
    expect(r.mode).toBe("alert_only");
    expect(r.budgetLimit).toBe(100);
    expect(r.currentUsage).toBe(23);
    expect([r.denySource, r.denyReason]).toEqual([null, null]);
  });

  it("propagates non-null price hints string-keyed and unmodified", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse({ price_hints: { openai: 1.0, anthropic: 1.5 } })),
    });
    const r = await enforcer.checkBudget({ ...baseCheck() });
    expect(r.priceHints).toEqual({ openai: 1.0, anthropic: 1.5 });
  });

  it("records the last-known budget limit/usage on an allow (behavior 6)", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse({ budget_limit: 100, current_usage: 30 })),
    });
    expect(enforcer.lastKnownBudget).toBeNull();
    await enforcer.checkBudget({ ...baseCheck() });
    expect(enforcer.lastKnownBudget).toBe(100);
    expect(enforcer.lastKnownUsage).toBe(30);
  });

  it.each([
    {
      name: "allow",
      response: makeResponse({
        allowed: true,
        failover_directive: { version: "1", failover_tuning_allowed: false },
      }),
      expected: false,
    },
    {
      name: "alert-only deny",
      response: makeResponse({
        allowed: false,
        mode: "alert_only",
        failover_directive: { version: "1", failover_tuning_allowed: true },
      }),
      expected: true,
    },
    {
      name: "hard deny",
      response: makeResponse({
        allowed: false,
        mode: "hard_deny",
        failover_directive: { version: "1", failover_tuning_allowed: false },
      }),
      expected: false,
    },
  ])("propagates failover entitlement from a cloud $name", async ({ response, expected }) => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => response),
    });

    expect((await enforcer.checkBudget(baseCheck())).failoverTuningAllowed).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Cloud deny in alert_only mode.
// ---------------------------------------------------------------------------

describe("cloud reachable + deny (alert_only)", () => {
  it("still allows with a 'limit' warning and 2-decimal dollar amounts", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      budgetMode: "alert_only",
      fetch: okFetch(records, () =>
        makeResponse({
          allowed: false,
          mode: "alert_only",
          current_usage: 99.5,
          budget_limit: 100,
        }),
      ),
    });
    const r = await enforcer.checkBudget({ ...baseCheck() });
    expect(r.allowed).toBe(true);
    expect(r.warning).toContain("limit");
    expect(r.warning).toBe("Budget limit reached: $99.50/$100.00 used");
    expect([r.denySource, r.denyReason]).toEqual([null, null]);
  });

  it("emits an operator-facing WARNING with dollar amounts (behavior 4 — finding 6a)", async () => {
    const records: FetchRecord[] = [];
    const log = capturingLogger();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      budgetMode: "alert_only",
      logger: log.logger,
      fetch: okFetch(records, () =>
        makeResponse({
          allowed: false,
          mode: "alert_only",
          current_usage: 99.5,
          budget_limit: 100,
        }),
      ),
    });
    await enforcer.checkBudget({ ...baseCheck() });
    // Dollar amounts only — metadata, never content.
    expect(log.warn.join("\n")).toContain("Budget limit reached (alert_only mode)");
    expect(log.warn.join("\n")).toContain("limit=$100.00");
    expect(log.warn.join("\n")).toContain("usage=$99.50");
  });
});

// ---------------------------------------------------------------------------
// Cloud deny in hard_deny mode.
// ---------------------------------------------------------------------------

describe("cloud reachable + deny (hard_deny)", () => {
  it("blocks the call with an 'exceeded' warning", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      budgetMode: "hard_deny",
      fetch: okFetch(records, () =>
        makeResponse({
          allowed: false,
          mode: "hard_deny",
          current_usage: 120,
          budget_limit: 100,
          denied_by_period: "run_stopped",
        }),
      ),
    });
    const r = await enforcer.checkBudget({ ...baseCheck() });
    expect(r.allowed).toBe(false);
    expect(r.warning).toContain("exceeded");
    expect(r.warning).toBe("Budget exceeded: $120.00/$100.00 used");
    expect([r.denySource, r.denyReason, r.deniedByPeriod]).toEqual([
      "server",
      "run_stopped",
      "run_stopped",
    ]);
  });

  it("attributes a live directive denial to its directive reason", async () => {
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      budgetMode: "hard_deny",
      fetch: okFetch([], () =>
        makeResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "run_stopped",
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-a",
            reason: "manual_kill",
          },
        }),
      ),
    });

    const result = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });

    expect([result.denySource, result.denyReason, result.deniedByPeriod]).toEqual([
      "server",
      "manual_kill",
      "run_stopped",
    ]);
  });

  it("copies budgetLimit/currentUsage VERBATIM from the response, never remaining/0 (Bug 1.1)", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () =>
        makeResponse({
          allowed: false,
          mode: "hard_deny",
          remaining_budget: -20,
          budget_limit: 100,
          current_usage: 120,
        }),
      ),
    });
    const r = await enforcer.checkBudget({ ...baseCheck() });
    // budgetLimit must equal budget_limit (NOT remaining_budget), currentUsage must
    // equal current_usage (NOT hardcoded 0).
    expect(r.budgetLimit).toBe(100);
    expect(r.currentUsage).toBe(120);
  });

  it("records the last-known limit/usage on a deny response too (behavior 6)", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () =>
        makeResponse({ allowed: false, mode: "hard_deny", budget_limit: 50, current_usage: 60 }),
      ),
    });
    await enforcer.checkBudget({ ...baseCheck() });
    expect(enforcer.lastKnownBudget).toBe(50);
    expect(enforcer.lastKnownUsage).toBe(60);
  });

  it("omits reservationId AND priceHints on a hard deny (Python None defaults — finding 5)", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () =>
        makeResponse({
          allowed: false,
          mode: "hard_deny",
          // A server that returns both must not leak them into a denied result — a caller
          // that settles on reservationId != null would confirm a denied reservation.
          reservation_id: "res-should-drop",
          price_hints: { openai: 1.5 },
        }),
      ),
    });
    const r = await enforcer.checkBudget({ ...baseCheck() });
    expect(r.allowed).toBe(false);
    expect(r.reservationId).toBeNull();
    expect(r.priceHints).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BudgetExceededError field construction.
// ---------------------------------------------------------------------------

describe("buildBudgetExceededError", () => {
  it("copies budgetLimit/currentUsage from the response's own fields (not remaining/0)", () => {
    const resp = makeResponse({
      allowed: false,
      mode: "hard_deny",
      remaining_budget: -5,
      budget_limit: 100,
      current_usage: 105,
      denied_by_period: "daily",
    });
    const err = buildBudgetExceededError(resp, 1000);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.budgetLimit).toBe(100);
    expect(err.currentUsage).toBe(105);
    expect(err.mode).toBe("hard_deny");
  });

  it("populates budgetPeriod from denied_by_period (D2 — not hardcoded 'unknown')", () => {
    const withPeriod = buildBudgetExceededError(
      makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "monthly" }),
      500,
    );
    expect(withPeriod.budgetPeriod).toBe("monthly");
    const withoutPeriod = buildBudgetExceededError(
      makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: null }),
      500,
    );
    expect(withoutPeriod.budgetPeriod).toBe("unknown");
  });

  it("derives estimatedCost from the fallback per-token estimate", () => {
    const err = buildBudgetExceededError(makeResponse({ allowed: false, mode: "hard_deny" }), 1000);
    expect(err.estimatedCost).toBeCloseTo(DEFAULT_COST_PER_TOKEN * 1000, 10);
  });
});

// ---------------------------------------------------------------------------
// Cache behavior.
// ---------------------------------------------------------------------------

describe("cache behavior", () => {
  it("serves a cached allow with zero additional HTTP calls within the TTL", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      cacheTtl: 5,
      now: clock.now,
      fetch: okFetch(records, () => makeResponse()),
    });
    await enforcer.checkBudget({ ...baseCheck() });
    await enforcer.checkBudget({ ...baseCheck() });
    expect(records).toHaveLength(1); // second call served from cache
  });

  it("returns reservationId null on a cache hit (never reuses a reservation)", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      cacheTtl: 5,
      now: clock.now,
      fetch: okFetch(records, () => makeResponse({ reservation_id: "res-cached" })),
    });
    const first = await enforcer.checkBudget({ ...baseCheck() });
    expect(first.reservationId).toBe("res-cached");
    const second = await enforcer.checkBudget({ ...baseCheck() });
    expect(second.reservationId).toBeNull();
    expect(second.failoverTuningAllowed).toBeNull();
  });

  it.each([
    { name: "a populated map", hints: { openai: 1.25 } },
    { name: "an explicitly-cleared map", hints: {} as Record<string, number> },
    { name: "an absent statement", hints: null },
  ])("isolates public $name from its cache entry while replaying it exactly", async ({ hints }) => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () =>
        makeResponse({
          reservation_id: "res-original",
          price_hints: hints,
          failover_directive: { version: "1", failover_tuning_allowed: true },
        }),
      ),
    });

    const live = await enforcer.checkBudget(baseCheck());
    expect(live.priceHints).toEqual(hints);
    if (live.priceHints !== null) {
      live.priceHints["callerMutation"] = 99;
    }

    const cached = await enforcer.checkBudget(baseCheck());
    expect(cached.priceHints).toEqual(hints);
    if (cached.priceHints !== null) {
      cached.priceHints["callerMutation"] = 100;
    }

    const laterCached = await enforcer.checkBudget(baseCheck());

    expect(records).toHaveLength(1);
    expect(laterCached.priceHints).toEqual(hints);
    expect(cached.reservationId).toBeNull();
    expect(cached.failoverTuningAllowed).toBeNull();
  });

  it("excludes estimates from the cache key", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse()),
    });

    await enforcer.checkBudget({ ...baseCheck(), estimatedInputTokens: 1 });
    await enforcer.checkBudget({ ...baseCheck(), estimatedInputTokens: 999_999 });

    expect(records).toHaveLength(1);
  });

  it("normalizes omitted modality and explicit text to the same key", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse()),
    });

    await enforcer.checkBudget(baseCheck());
    await enforcer.checkBudget({ ...baseCheck(), modality: "text" });

    expect(records).toHaveLength(1);
  });

  it.each([
    {
      name: "provider",
      changed: { provider: "anthropic" as const },
    },
    { name: "model", changed: { model: "gpt-4.1" } },
    {
      name: "fallback provider array",
      changed: {
        fallbackProviders: ["anthropic" as const],
        fallbackModels: ["claude-sonnet-4"],
      },
    },
    {
      name: "fallback model array",
      baseline: {
        fallbackProviders: ["anthropic" as const],
        fallbackModels: ["claude-sonnet-4"],
      },
      changed: {
        fallbackProviders: ["anthropic" as const],
        fallbackModels: ["claude-opus-4"],
      },
    },
    {
      name: "modality",
      changed: { modality: "image" as const },
    },
  ])("does not collide when $name changes", async ({ baseline = {}, changed }) => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse()),
    });

    await enforcer.checkBudget({ ...baseCheck(), ...baseline });
    await enforcer.checkBudget({ ...baseCheck(), ...changed });

    expect(records).toHaveLength(2);
  });

  it("is a bounded 16-entry LRU whose touches preserve the touched chain", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse()),
    });

    for (let index = 0; index < 16; index += 1) {
      await enforcer.checkBudget({ ...baseCheck(), model: `model-${index}` });
    }
    await enforcer.checkBudget({ ...baseCheck(), model: "model-0" });
    await enforcer.checkBudget({ ...baseCheck(), model: "model-16" });
    await enforcer.checkBudget({ ...baseCheck(), model: "model-0" });
    await enforcer.checkBudget({ ...baseCheck(), model: "model-1" });

    expect(records).toHaveLength(18);
  });

  it("routes a tagged check past a cached allow without replacing that entry", async () => {
    // Mutation caught: treating tagged checks as cache-eligible would skip the second
    // control-plane decision or replace the untagged chain's cached price hints.
    const records: FetchRecord[] = [];
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      fetch: okFetch(records, () => {
        call += 1;
        return makeResponse({ price_hints: { openai: call } });
      }),
    });

    const first = await enforcer.checkBudget({ ...baseCheck(), model: "model-cache" });
    const tagged = await enforcer.checkBudget({
      ...baseCheck(),
      model: "model-cache",
      tags: { customer: "acme" },
    });
    const replayed = await enforcer.checkBudget({ ...baseCheck(), model: "model-cache" });

    expect(records).toHaveLength(2);
    expect(JSON.parse(records[1]?.body ?? "null")).toMatchObject({
      tags: { customer: "acme" },
    });
    expect(first.priceHints).toEqual({ openai: 1 });
    expect(tagged.priceHints).toEqual({ openai: 2 });
    expect(replayed.priceHints).toEqual({ openai: 1 });
  });

  it("treats an empty tag record as tagged without replacing the hot untagged allow", async () => {
    // Characterization: `{}` is a present direct-enforcer tag statement, not an
    // absent value. A truthiness/size normalization must not make it cache-eligible.
    const records: FetchRecord[] = [];
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      fetch: okFetch(records, () => {
        call += 1;
        return makeResponse({ price_hints: { openai: call } });
      }),
    });

    await enforcer.checkBudget({ ...baseCheck(), model: "empty-tag-model" });
    const emptyTagged = await enforcer.checkBudget({
      ...baseCheck(),
      model: "empty-tag-model",
      tags: {},
    });
    const replayed = await enforcer.checkBudget({ ...baseCheck(), model: "empty-tag-model" });

    expect(records).toHaveLength(2);
    expect(JSON.parse(records[1]?.body ?? "null")).toMatchObject({ tags: {} });
    expect(emptyTagged.priceHints).toEqual({ openai: 2 });
    expect(replayed.priceHints).toEqual({ openai: 1 });
  });

  it("keeps the tag snapshot captured before an in-flight tagged allow resolves", async () => {
    // Mutation caught: reading the caller's record after I/O can send different tags
    // and can incorrectly allow a tagged result to populate the global cache.
    const records: FetchRecord[] = [];
    const delayed = (() => {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    let calls = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        calls += 1;
        return calls === 1
          ? delayed.promise
          : new Response(JSON.stringify(makeResponse()), { status: 200 });
      },
    });
    const tags = { customer: "acme" };
    const options: Parameters<BudgetEnforcer["checkBudget"]>[0] = {
      ...baseCheck(),
      model: "model-snapshot",
      tags,
    };
    const checking = enforcer.checkBudget(options);

    tags.customer = "mutated";
    options.tags = { customer: "replaced" };
    delete options.tags;
    delayed.resolve(new Response(JSON.stringify(makeResponse()), { status: 200 }));
    await checking;
    await enforcer.checkBudget({ ...baseCheck(), model: "model-snapshot" });

    expect(JSON.parse(records[0]?.body ?? "null")).toMatchObject({
      tags: { customer: "acme" },
    });
    expect(records).toHaveLength(2);
  });

  it("keeps null and absent tags on the existing untagged cache path", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: okFetch(records, () => makeResponse()),
    });

    await enforcer.checkBudget({ ...baseCheck(), model: "model-null-tags", tags: null });
    await enforcer.checkBudget({ ...baseCheck(), model: "model-null-tags" });

    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]?.body ?? "null")).not.toHaveProperty("tags");
  });

  it("clears every cached allow after either a project hard deny or alert-only deny", async () => {
    for (const denied of [
      makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "daily" }),
      makeResponse({ allowed: false, mode: "alert_only", denied_by_period: "daily" }),
    ]) {
      const records: FetchRecord[] = [];
      let next = makeResponse();
      const enforcer = new BudgetEnforcer({
        apiUrl: API_URL,
        apiKey: API_KEY,
        fetch: okFetch(records, () => next),
      });
      await enforcer.checkBudget({ ...baseCheck(), model: "model-a" });
      await enforcer.checkBudget({ ...baseCheck(), model: "model-b" });
      next = denied;
      await enforcer.checkBudget({ ...baseCheck(), model: "denied" });
      next = makeResponse();
      await enforcer.checkBudget({ ...baseCheck(), model: "model-a" });
      await enforcer.checkBudget({ ...baseCheck(), model: "model-b" });

      expect(records).toHaveLength(5);
    }
  });

  it("leaves cached allows untouched after a scoped agent-run hard deny", async () => {
    const records: FetchRecord[] = [];
    let next = makeResponse({ price_hints: { openai: 1.2 } });
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      fetch: okFetch(records, () => next),
    });
    await enforcer.checkBudget({ ...baseCheck(), model: "model-a" });
    next = makeResponse({
      allowed: false,
      mode: "hard_deny",
      denied_by_period: "agent_run",
    });
    await enforcer.checkBudget({ ...baseCheck(), model: "model-denied", agentRunId: "run-a" });
    next = makeResponse();
    const cached = await enforcer.checkBudget({ ...baseCheck(), model: "model-a" });

    expect(records).toHaveLength(2);
    expect(cached.priceHints).toEqual({ openai: 1.2 });
  });

  it("leaves cached allows untouched after a selector-local tag hard deny", async () => {
    const records: FetchRecord[] = [];
    let next = makeResponse({ price_hints: { openai: 1.2 } });
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      fetch: okFetch(records, () => next),
    });
    await enforcer.checkBudget({ ...baseCheck(), model: "model-a" });
    next = makeResponse({
      allowed: false,
      mode: "hard_deny",
      denied_by_period: "tag",
    });
    await enforcer.checkBudget({ ...baseCheck(), model: "tag-selector" });
    next = makeResponse();
    const cached = await enforcer.checkBudget({ ...baseCheck(), model: "model-a" });

    expect(records).toHaveLength(2);
    expect(cached.priceHints).toEqual({ openai: 1.2 });
  });

  it("never caches a deny decision — two consecutive denies both hit HTTP", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      cacheTtl: 5,
      now: clock.now,
      fetch: okFetch(records, () => makeResponse({ allowed: false, mode: "hard_deny" })),
    });
    await enforcer.checkBudget({ ...baseCheck() });
    await enforcer.checkBudget({ ...baseCheck() });
    expect(records).toHaveLength(2);
  });

  it("a deny invalidates a raced cached allow: the next call within TTL re-contacts the cloud (finding 1)", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      cacheTtl: 5,
      now: clock.now,
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        call += 1;
        if (call === 1) {
          // The allow lands FIRST and is cached.
          return new Response(JSON.stringify(makeResponse({ allowed: true })), { status: 200 });
        }
        // The hard deny lands SECOND (delayed) and must invalidate that cached allow.
        await new Promise((r) => setTimeout(r, 5));
        return new Response(JSON.stringify(makeResponse({ allowed: false, mode: "hard_deny" })), {
          status: 200,
        });
      },
    });

    // Two concurrent checks both miss the empty cache and POST. The allow caches; the
    // later-resolving hard deny must clear that cached allow.
    const [first, second] = await Promise.all([
      enforcer.checkBudget({ ...baseCheck() }),
      enforcer.checkBudget({ ...baseCheck() }),
    ]);
    expect(records).toHaveLength(2);
    expect([first.allowed, second.allowed].sort()).toEqual([false, true]);

    // A third call WITHIN the (never-advanced) TTL must NOT be served the stale cached
    // allow — the deny cleared it, so the cloud is re-contacted (and denies again).
    const third = await enforcer.checkBudget({ ...baseCheck() });
    expect(records).toHaveLength(3); // re-contacted, not cache-served
    expect(third.allowed).toBe(false);
  });

  it("treats cacheTtl=0 as immediately stale (re-checks the cloud every call)", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      cacheTtl: 0,
      now: clock.now,
      fetch: okFetch(records, () => makeResponse()),
    });
    await enforcer.checkBudget({ ...baseCheck() });
    await enforcer.checkBudget({ ...baseCheck() });
    expect(records).toHaveLength(2);
  });

  it("expires the cache after the TTL elapses", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      cacheTtl: 5,
      now: clock.now,
      fetch: okFetch(records, () => makeResponse()),
    });
    await enforcer.checkBudget({ ...baseCheck() }); // HTTP
    clock.advance(4999);
    await enforcer.checkBudget({ ...baseCheck() }); // still cached
    expect(records).toHaveLength(1);
    clock.advance(2); // now > TTL boundary
    await enforcer.checkBudget({ ...baseCheck() }); // re-checks
    expect(records).toHaveLength(2);
  });

  it("keeps the last-known limit across a cache expiry (behavior: TestLastKnownBudgetLimit)", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      cacheTtl: 5,
      now: clock.now,
      fetch: okFetch(records, () => makeResponse({ budget_limit: 100, current_usage: 10 })),
    });
    await enforcer.checkBudget({ ...baseCheck() });
    clock.advance(10_000); // beyond TTL
    expect(enforcer.lastKnownBudget).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Fail-open outage matrix.
// ---------------------------------------------------------------------------

describe("outage + fail_open", () => {
  it("allows with a 'fail-open' warning, mode=configured, remainingBudget 0", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      budgetMode: "alert_only",
      fetch: unreachableFetch(records),
    });
    const r = await enforcer.checkBudget({ ...baseCheck() });
    expect(r.allowed).toBe(true);
    expect(r.warning).toContain("fail-open");
    expect(r.warning).toBe("Cloud API unreachable; proceeding in fail-open mode");
    expect(r.mode).toBe("alert_only");
    expect(r.remainingBudget).toBe(0);
    expect(r.failoverTuningAllowed).toBeNull();
  });

  it("still accrues local spend while failing open (DEFAULT_COST_PER_TOKEN * tokens)", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: unreachableFetch(records),
    });
    await enforcer.checkBudget({ estimatedInputTokens: 1000, model: "m", provider: "openai" });
    expect(enforcer.getLocalCurrentSpend()).toBeCloseTo(DEFAULT_COST_PER_TOKEN * 1000, 10);
  });

  it("logs the outage with the exception CLASS NAME only, never a body", async () => {
    const records: FetchRecord[] = [];
    const warn = vi.fn<Logger["warn"]>();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      logger,
      fetch: unreachableFetch(records),
    });
    await enforcer.checkBudget({ ...baseCheck() });
    expect(warn).toHaveBeenCalledWith("Cloud API budget check failed: %s", "TransportNetworkError");
    expect(warn.mock.calls.flat().join("\n")).not.toContain("fetch failed");
  });
});

// ---------------------------------------------------------------------------
// Hard-deny stickiness preserves an authoritative deny across outages.
// ---------------------------------------------------------------------------

describe("hard-deny stickiness (invariant 9)", () => {
  /** Build an enforcer whose fetch first hard-denies, then becomes unreachable. */
  function stickyEnforcer(options: { failOpen: boolean; budgetMode: "alert_only" | "hard_deny" }) {
    const records: FetchRecord[] = [];
    let reachable = true;
    let response = makeResponse({
      allowed: false,
      mode: "hard_deny",
      budget_limit: 100,
      current_usage: 150,
      denied_by_period: "monthly",
    });
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: options.failOpen,
      budgetMode: options.budgetMode,
      cacheTtl: 0, // never serve an allow from cache — every call re-contacts the cloud
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        if (!reachable) return Promise.reject(new TypeError("fetch failed"));
        return new Response(JSON.stringify(response), { status: 200 });
      },
    });
    return {
      enforcer,
      records,
      goOffline: () => {
        reachable = false;
      },
      setResponse: (r: BudgetCheckResponse) => {
        response = r;
      },
    };
  }

  it("keeps denying through a later outage even with failOpen=true", async () => {
    const ctx = stickyEnforcer({ failOpen: true, budgetMode: "alert_only" });
    const first = await ctx.enforcer.checkBudget({ ...baseCheck() });
    expect(first.allowed).toBe(false);
    ctx.goOffline();
    const second = await ctx.enforcer.checkBudget({ ...baseCheck() });
    expect(second.allowed).toBe(false);
    expect(second.warning).toContain("preserving prior hard deny");
    expect(second.warning).toBe(
      "Cloud API unreachable; preserving prior hard deny: $150.00/$100.00 used",
    );
    // Copied from the remembered hard-deny response.
    expect(second.budgetLimit).toBe(100);
    expect(second.currentUsage).toBe(150);
    expect([second.denySource, second.denyReason, second.deniedByPeriod]).toEqual([
      "sticky_replay",
      "monthly",
      "monthly",
    ]);
  });

  it("uses a sticky directive reason only for the directive's active run", async () => {
    let online = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      leaseEnabled: false,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(
          JSON.stringify(
            makeResponse({
              allowed: false,
              mode: "hard_deny",
              denied_by_period: "monthly",
              run_control: {
                version: "1",
                action: "terminate",
                agent_run_id: "run-a",
                reason: "manual_kill",
              },
            }),
          ),
          { status: 200 },
        );
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    online = false;

    const matching = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    const unrelated = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" });

    expect([matching.denyReason, matching.deniedByPeriod]).toEqual(["manual_kill", "run_stopped"]);
    expect(unrelated.allowed).toBe(true);
  });

  it("lets a selector-local tag denial clear an older global hard-deny sticky", async () => {
    const records: FetchRecord[] = [];
    const monotonic = fakeMonotonicClock(10);
    let calls = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "monthly",
              }),
            ),
            { status: 200 },
          );
        }
        if (calls === 2) {
          return new Response(
            JSON.stringify(
              makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "tag" }),
            ),
            { status: 200 },
          );
        }
        throw new TypeError("offline");
      },
    });

    await enforcer.checkBudget(baseCheck());
    monotonic.set(20);
    expect(
      await enforcer.checkBudget({
        ...baseCheck(),
        model: "tag-selector",
        agentRunId: "run-tag",
        tags: { customer: "acme" },
      }),
    ).toMatchObject({ allowed: false, deniedByPeriod: "tag", denySource: "server" });
    expect(enforcer.hasStickyHardDeny).toBe(false);
    expect(
      await enforcer.checkBudget({ ...baseCheck(), model: "after-tag", agentRunId: "run-other" }),
    ).toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    expect(records).toHaveLength(3);
  });

  it("wins even when the enforcer's own configured mode is alert_only", async () => {
    // Sticky deny is checked BEFORE fail-open regardless of configured mode.
    const ctx = stickyEnforcer({ failOpen: true, budgetMode: "alert_only" });
    await ctx.enforcer.checkBudget({ ...baseCheck() });
    ctx.goOffline();
    const r = await ctx.enforcer.checkBudget({ ...baseCheck() });
    expect(r.allowed).toBe(false);
  });

  it("overrides the fail-closed local-enforcement path too (checked first)", async () => {
    const ctx = stickyEnforcer({ failOpen: false, budgetMode: "hard_deny" });
    await ctx.enforcer.checkBudget({ ...baseCheck() });
    ctx.goOffline();
    const r = await ctx.enforcer.checkBudget({ ...baseCheck() });
    expect(r.allowed).toBe(false);
    expect(r.warning).toContain("preserving prior hard deny");
  });

  it("an alert_only cloud deny does NOT create a sticky deny (behavior 10)", async () => {
    const records: FetchRecord[] = [];
    let reachable = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      budgetMode: "hard_deny", // local mode is hard_deny…
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        if (!reachable) return Promise.reject(new TypeError("fetch failed"));
        // …but the cloud deny is under alert_only, so it must NOT stick.
        return new Response(JSON.stringify(makeResponse({ allowed: false, mode: "alert_only" })), {
          status: 200,
        });
      },
    });
    await enforcer.checkBudget({ ...baseCheck() });
    expect(enforcer.hasStickyHardDeny).toBe(false);
    reachable = false;
    const r = await enforcer.checkBudget({ ...baseCheck() });
    // Falls through to normal fail-open, not a forced deny.
    expect(r.allowed).toBe(true);
    expect(r.warning).toContain("fail-open");
  });

  it("a later allow clears the sticky deny before an even-later outage (behavior 11)", async () => {
    const ctx = stickyEnforcer({ failOpen: true, budgetMode: "alert_only" });
    await ctx.enforcer.checkBudget({ ...baseCheck() }); // hard deny → sticky
    expect(ctx.enforcer.hasStickyHardDeny).toBe(true);
    ctx.setResponse(makeResponse({ allowed: true })); // later allow clears it
    await ctx.enforcer.checkBudget({ ...baseCheck() });
    expect(ctx.enforcer.hasStickyHardDeny).toBe(false);
    ctx.goOffline();
    const r = await ctx.enforcer.checkBudget({ ...baseCheck() });
    // Falls through to normal fail-open now, not the sticky deny.
    expect(r.allowed).toBe(true);
    expect(r.warning).toContain("fail-open");
  });

  it("a subsequent alert_only deny clears a sticky hard deny; a later outage fails open (finding 6b)", async () => {
    const ctx = stickyEnforcer({ failOpen: true, budgetMode: "alert_only" });
    await ctx.enforcer.checkBudget({ ...baseCheck() }); // hard deny → sticky
    expect(ctx.enforcer.hasStickyHardDeny).toBe(true);
    // An alert_only-mode deny (mode !== hard_deny) must CLEAR the sticky hard deny.
    ctx.setResponse(makeResponse({ allowed: false, mode: "alert_only" }));
    await ctx.enforcer.checkBudget({ ...baseCheck() });
    expect(ctx.enforcer.hasStickyHardDeny).toBe(false);
    ctx.goOffline();
    const r = await ctx.enforcer.checkBudget({ ...baseCheck() });
    // Falls through to fail-open, NOT the stale sticky deny.
    expect(r.allowed).toBe(true);
    expect(r.warning).toContain("fail-open");
  });
});

// ---------------------------------------------------------------------------
// Run-scoped sticky denials + ordered cloud ALLOW folding.
// ---------------------------------------------------------------------------

describe("run-scoped sticky denials", () => {
  function deferredResponse(): {
    promise: Promise<Response>;
    resolve: (response: Response) => void;
  } {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  const runDeny = (overrides: Partial<BudgetCheckResponse> = {}) =>
    makeResponse({
      allowed: false,
      mode: "hard_deny",
      denied_by_period: "agent_run",
      budget_limit: 100,
      current_usage: 99.5,
      ...overrides,
    });

  it("bypasses the allow cache both ways for scoped checks without consuming the hot global entry", async () => {
    const records: FetchRecord[] = [];
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      fetch: okFetch(records, () => {
        call += 1;
        return makeResponse({
          reservation_id: `res-${call}`,
          price_hints: { openai: call },
        });
      }),
    });

    const global = await enforcer.checkBudget(baseCheck());
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    const replayedGlobal = await enforcer.checkBudget(baseCheck());

    expect(records).toHaveLength(3);
    expect(JSON.parse(records[1]?.body ?? "null").agent_run_id).toBe("run-a");
    expect(global.priceHints).toEqual({ openai: 1 });
    expect(replayedGlobal.priceHints).toEqual({ openai: 1 });
    expect(replayedGlobal.reservationId).toBeNull();
  });

  it("lets an ordered tagged allow clear stale project and same-run server stickies", async () => {
    // Mutation caught: treating tags as a separate sticky domain leaves an obsolete
    // project or same-run deny authoritative after the newer control-plane allow.
    const monotonic = fakeMonotonicClock(10);
    let online = true;
    let next = runDeny();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      monotonicNow: monotonic.now,
      fetch: async () => {
        if (!online) throw new TypeError("offline");
        return new Response(JSON.stringify(next), { status: 200 });
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    monotonic.set(20);
    next = makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "monthly" });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" });
    monotonic.set(30);
    next = makeResponse();
    await enforcer.checkBudget({
      ...baseCheck(),
      agentRunId: "run-a",
      tags: { customer: "acme" },
    });
    online = false;

    await expect(
      enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("preserves a newer project hard deny when an older tagged denial resolves later", async () => {
    // Mutation caught: an older selector-local response must not erase project authority
    // established by a check whose request began later.
    const monotonic = fakeMonotonicClock(10);
    const olderTaggedResponse = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return olderTaggedResponse.promise;
        if (call === 2) {
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "monthly",
              }),
            ),
            { status: 200 },
          );
        }
        throw new TypeError("offline");
      },
    });

    const olderTagged = enforcer.checkBudget({
      ...baseCheck(),
      model: "older-tagged",
      tags: { customer: "acme" },
    });
    monotonic.set(20);
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "newer-project" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    olderTaggedResponse.resolve(
      new Response(
        JSON.stringify(
          makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "tag" }),
        ),
        { status: 200 },
      ),
    );

    await expect(olderTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "offline-after-race" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("suppresses an older tagged allow when a newer project hard deny resolves first", async () => {
    // Mutation caught: a delayed allow cannot authorize over project authority from a
    // check whose request began later, even though the allow completes last.
    const monotonic = fakeMonotonicClock(10);
    const olderTaggedResponse = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return olderTaggedResponse.promise;
        if (call === 2) {
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "monthly",
              }),
            ),
            { status: 200 },
          );
        }
        throw new TypeError("offline");
      },
    });

    const olderTagged = enforcer.checkBudget({
      ...baseCheck(),
      model: "older-tagged-allow",
      tags: { customer: "acme" },
    });
    monotonic.set(20);
    await enforcer.checkBudget({ ...baseCheck(), model: "newer-project-deny" });
    olderTaggedResponse.resolve(new Response(JSON.stringify(makeResponse()), { status: 200 }));

    await expect(olderTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "offline-after-delayed-allow" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("orders equal-epoch checks by dispatch so a later tagged allow clears an older project deny", async () => {
    // Mutation caught: using the numeric monotonic epoch as the complete request order
    // lets the older denial overwrite the later allow when both timestamps collide.
    const olderProjectResponse = deferredResponse();
    const laterTaggedAllowResponse = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: () => 10,
      fetch: async () => {
        call += 1;
        if (call === 1) return olderProjectResponse.promise;
        if (call === 2) return laterTaggedAllowResponse.promise;
        throw new TypeError("offline");
      },
    });

    const olderProject = enforcer.checkBudget({
      ...baseCheck(),
      model: "older-equal-epoch-project-deny",
    });
    const laterTaggedAllow = enforcer.checkBudget({
      ...baseCheck(),
      model: "later-equal-epoch-tagged-allow",
      tags: { customer: "acme" },
    });

    laterTaggedAllowResponse.resolve(new Response(JSON.stringify(makeResponse()), { status: 200 }));
    await expect(laterTaggedAllow).resolves.toMatchObject({ allowed: true });
    olderProjectResponse.resolve(
      new Response(
        JSON.stringify(
          makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "monthly" }),
        ),
        { status: 200 },
      ),
    );
    await olderProject;

    const outage = await enforcer.checkBudget({
      ...baseCheck(),
      model: "offline-after-equal-epoch-clear",
    });
    expect([enforcer.hasStickyHardDeny, outage.allowed, outage.warning]).toEqual([
      false,
      true,
      "Cloud API unreachable; proceeding in fail-open mode",
    ]);
  });

  it("orders equal-epoch checks by dispatch so a later project deny beats an older tagged allow", async () => {
    // Mutation caught: using only the numeric epoch lets the older tagged allow erase
    // the later-dispatched project denial when the clock cannot distinguish them.
    const monotonic = fakeMonotonicClock(10);
    const olderTaggedAllowResponse = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return olderTaggedAllowResponse.promise;
        return new Response(
          JSON.stringify(
            makeResponse({
              allowed: false,
              mode: "hard_deny",
              denied_by_period: "daily",
            }),
          ),
          { status: 200 },
        );
      },
    });

    const olderTaggedAllow = enforcer.checkBudget({
      ...baseCheck(),
      model: "older-equal-epoch-tagged-allow",
      tags: { customer: "acme" },
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "later-equal-epoch-project-deny" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "server",
    });
    olderTaggedAllowResponse.resolve(new Response(JSON.stringify(makeResponse()), { status: 200 }));

    await expect(olderTaggedAllow).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "server",
    });
  });

  it("orders equal-epoch project denials by dispatch so the later denial controls outages", async () => {
    // Mutation caught: using only the numeric epoch leaves the earlier daily denial
    // authoritative instead of advancing to the later-dispatched monthly denial.
    const monotonic = fakeMonotonicClock(10);
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "daily",
              }),
            ),
            { status: 200 },
          );
        }
        if (call === 2) {
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "monthly",
              }),
            ),
            { status: 200 },
          );
        }
        throw new TypeError("offline");
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), model: "equal-project-first" });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "equal-project-second" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "offline-after-equal-project" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("does not let an older deferred project denial outlive a newer tagged denial", async () => {
    // Mutation caught: a selector-local response must advance global authority even
    // when there is no sticky response to clear at the time it is observed.
    const monotonic = fakeMonotonicClock(10);
    const olderProjectResponse = deferredResponse();
    let checkCalls = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        checkCalls += 1;
        if (checkCalls === 1) return olderProjectResponse.promise;
        if (checkCalls === 2) {
          return new Response(
            JSON.stringify(
              makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "tag" }),
            ),
            { status: 200 },
          );
        }
        throw new TypeError("offline");
      },
    });

    const olderProject = enforcer.checkBudget({
      ...baseCheck(),
      model: "older-deferred-project",
    });
    monotonic.set(20);
    await expect(
      enforcer.checkBudget({
        ...baseCheck(),
        model: "newer-tagged-denial",
        tags: { customer: "acme" },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "tag",
      denySource: "server",
    });
    monotonic.set(30);
    olderProjectResponse.resolve(
      new Response(
        JSON.stringify(
          makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "monthly" }),
        ),
        { status: 200 },
      ),
    );

    await expect(olderProject).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "outage-after-newer-tagged-denial" }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it.each([
    ["allow", makeResponse(), {}],
    [
      "alert-only denial",
      makeResponse({ allowed: false, mode: "alert_only", denied_by_period: "monthly" }),
      {},
    ],
    ["scoped agent-run denial", runDeny(), { agentRunId: "run-newer-clear" }],
  ] as const)("does not let an older project denial outlive a newer %s clear", async (_label, newerResponse, newerScope) => {
    const monotonic = fakeMonotonicClock(10);
    const olderProjectResponse = deferredResponse();
    let checkCalls = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        checkCalls += 1;
        if (checkCalls === 1) return olderProjectResponse.promise;
        if (checkCalls === 2) {
          return new Response(JSON.stringify(newerResponse), { status: 200 });
        }
        throw new TypeError("offline");
      },
    });

    const olderProject = enforcer.checkBudget({
      ...baseCheck(),
      model: `older-project-before-${_label}`,
    });
    monotonic.set(20);
    await enforcer.checkBudget({
      ...baseCheck(),
      ...newerScope,
      model: `newer-${_label}`,
    });
    monotonic.set(30);
    olderProjectResponse.resolve(
      new Response(
        JSON.stringify(
          makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "monthly" }),
        ),
        { status: 200 },
      ),
    );

    await expect(olderProject).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: `outage-after-${_label}-clear` }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("stamps an ordered project hard deny at request time rather than response time", async () => {
    // Mutation caught: stamping the project denial when its deferred response folds at
    // t=30 would make it appear newer than the tagged request that began at t=20.
    const monotonic = fakeMonotonicClock(10);
    const projectResponse = deferredResponse();
    const taggedResponse = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return projectResponse.promise;
        if (call === 2) return taggedResponse.promise;
        throw new TypeError("offline");
      },
    });

    const project = enforcer.checkBudget({ ...baseCheck(), model: "older-project-request" });
    monotonic.set(20);
    const tagged = enforcer.checkBudget({
      ...baseCheck(),
      model: "newer-tagged-request",
      tags: { customer: "acme" },
    });
    monotonic.set(30);
    projectResponse.resolve(
      new Response(
        JSON.stringify(
          makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "monthly" }),
        ),
        { status: 200 },
      ),
    );
    await expect(project).resolves.toMatchObject({ allowed: false, deniedByPeriod: "monthly" });
    taggedResponse.resolve(
      new Response(
        JSON.stringify(
          makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "tag" }),
        ),
        { status: 200 },
      ),
    );

    await expect(tagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "tag",
      denySource: "server",
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "offline-after-newer-tag" }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it.each([
    [
      "alert-only denial",
      makeResponse({ allowed: false, mode: "alert_only", denied_by_period: "tag" }),
      { tags: { customer: "acme" } },
    ],
    ["run-scoped denial", runDeny(), { agentRunId: "run-older" }],
    [
      "project denial",
      makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "monthly" }),
      {},
    ],
  ] as const)("does not let a delayed older %s displace newer project authority", async (_label, olderResponse, olderScope) => {
    const monotonic = fakeMonotonicClock(10);
    const delayedResponse = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return delayedResponse.promise;
        if (call === 2) {
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "daily",
              }),
            ),
            { status: 200 },
          );
        }
        throw new TypeError("offline");
      },
    });

    const older = enforcer.checkBudget({
      ...baseCheck(),
      ...olderScope,
      model: `older-${_label}`,
    });
    monotonic.set(20);
    await enforcer.checkBudget({ ...baseCheck(), model: `newer-project-${_label}` });
    delayedResponse.resolve(
      new Response(JSON.stringify(olderResponse), {
        status: 200,
      }),
    );

    await expect(older).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "server",
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: `outage-after-${_label}` }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "sticky_replay",
    });
  });

  it("retains a delayed run denial even while a newer project denial controls its result", async () => {
    // Mutation caught: returning the newer global sticky before classifying the older
    // run verdict loses independent authority that must survive a later global clear.
    const monotonic = fakeMonotonicClock(10);
    const delayedRunResponse = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return delayedRunResponse.promise;
        if (call === 2) {
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "daily",
              }),
            ),
            { status: 200 },
          );
        }
        if (call === 3) return new Response(JSON.stringify(makeResponse()), { status: 200 });
        throw new TypeError("offline");
      },
    });

    const olderRun = enforcer.checkBudget({
      ...baseCheck(),
      model: "older-run-denial",
      agentRunId: "run-older",
    });
    monotonic.set(20);
    await enforcer.checkBudget({ ...baseCheck(), model: "newer-project-before-run" });
    delayedRunResponse.resolve(new Response(JSON.stringify(runDeny()), { status: 200 }));
    await expect(olderRun).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "server",
    });

    monotonic.set(30);
    await expect(
      enforcer.checkBudget({
        ...baseCheck(),
        model: "later-global-clear",
        tags: { customer: "acme" },
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      enforcer.checkBudget({
        ...baseCheck(),
        model: "offline-run-after-global-clear",
        agentRunId: "run-older",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "sticky_replay",
    });
    await expect(
      enforcer.checkBudget({
        ...baseCheck(),
        model: "offline-other-after-global-clear",
        agentRunId: "run-other",
      }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("clears an older matching run sticky while a newer project denial controls an alert result", async () => {
    // Mutation caught: global result precedence must not return before the ordered
    // alert-only response clears strictly older authority for its matching run.
    const monotonic = fakeMonotonicClock(10);
    const delayedAlertResponse = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      cacheTtl: 0,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return new Response(JSON.stringify(runDeny()), { status: 200 });
        if (call === 2) return delayedAlertResponse.promise;
        if (call === 3) {
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "daily",
              }),
            ),
            { status: 200 },
          );
        }
        if (call === 4) return new Response(JSON.stringify(makeResponse()), { status: 200 });
        throw new TypeError("offline");
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), model: "old-run", agentRunId: "run-a" });
    monotonic.set(20);
    const alert = enforcer.checkBudget({
      ...baseCheck(),
      model: "ordered-alert",
      agentRunId: "run-a",
    });
    monotonic.set(30);
    await enforcer.checkBudget({ ...baseCheck(), model: "newer-project-before-alert" });
    delayedAlertResponse.resolve(
      new Response(
        JSON.stringify(
          makeResponse({ allowed: false, mode: "alert_only", denied_by_period: "agent_run" }),
        ),
        { status: 200 },
      ),
    );
    await expect(alert).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "server",
    });

    monotonic.set(40);
    await enforcer.checkBudget({
      ...baseCheck(),
      model: "later-project-clear",
      tags: { customer: "acme" },
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "offline-cleared-run", agentRunId: "run-a" }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("keeps a same-run authority and an unrelated cached allow after a tagged tag-period deny", async () => {
    // Mutation caught: a tag-period deny must not erase a run sticky or invalidate an
    // unrelated untagged allow-cache entry.
    const records: FetchRecord[] = [];
    let online = true;
    let next = makeResponse({ price_hints: { openai: 1 } });
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        if (!online) throw new TypeError("offline");
        return new Response(JSON.stringify(next), { status: 200 });
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), model: "cached-model" });
    next = runDeny();
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    next = makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "tag" });
    await enforcer.checkBudget({
      ...baseCheck(),
      agentRunId: "run-a",
      tags: { customer: "acme" },
    });
    online = false;

    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "cached-model" }),
    ).resolves.toMatchObject({
      allowed: true,
      priceHints: { openai: 1 },
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "sticky_replay",
    });
    expect(records).toHaveLength(4);
  });

  it("retains project and agent-run authority from tagged hard denies", async () => {
    const checkTaggedPeriod = async (deniedByPeriod: "monthly" | "agent_run") => {
      let online = true;
      const enforcer = new BudgetEnforcer({
        apiUrl: API_URL,
        apiKey: API_KEY,
        leaseEnabled: false,
        failOpen: true,
        fetch: async () => {
          if (!online) throw new TypeError("offline");
          return new Response(
            JSON.stringify(
              makeResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: deniedByPeriod,
              }),
            ),
            { status: 200 },
          );
        },
      });
      await enforcer.checkBudget({
        ...baseCheck(),
        agentRunId: "run-a",
        tags: { customer: "acme" },
      });
      online = false;
      return enforcer;
    };

    const project = await checkTaggedPeriod("monthly");
    await expect(
      project.checkBudget({ ...baseCheck(), agentRunId: "run-b" }),
    ).resolves.toMatchObject({ allowed: false, deniedByPeriod: "monthly" });

    const run = await checkTaggedPeriod("agent_run");
    await expect(run.checkBudget({ ...baseCheck(), agentRunId: "run-b" })).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    await expect(run.checkBudget({ ...baseCheck(), agentRunId: "run-a" })).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
    });
  });

  it("invalidates cached allows when a tagged check receives a project-period hard deny", async () => {
    const records: FetchRecord[] = [];
    let online = true;
    let next = makeResponse({ price_hints: { openai: 1 } });
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      failOpen: true,
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        if (!online) throw new TypeError("offline");
        return new Response(JSON.stringify(next), { status: 200 });
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), model: "cached-model" });
    next = makeResponse({ allowed: false, mode: "hard_deny", denied_by_period: "monthly" });
    await enforcer.checkBudget({
      ...baseCheck(),
      model: "tagged-monthly",
      tags: { customer: "acme" },
    });
    online = false;

    await expect(
      enforcer.checkBudget({ ...baseCheck(), model: "cached-model" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
    expect(records).toHaveLength(3);
  });

  it("replays a run denial only for the same run during an outage", async () => {
    let online = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(runDeny()), { status: 200 });
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    expect(enforcer.hasStickyHardDeny).toBe(true);
    online = false;
    const unrelated = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" });
    const same = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });

    expect(unrelated.allowed).toBe(true);
    expect(unrelated.warning).toContain("fail-open");
    expect(same.allowed).toBe(false);
    expect(same.deniedByPeriod).toBe("agent_run");
    expect([same.denySource, same.denyReason]).toEqual(["sticky_replay", "agent_run"]);
  });

  it("a run denial clears an older global project sticky for unrelated runs", async () => {
    let online = true;
    let next = makeResponse({
      allowed: false,
      mode: "hard_deny",
      denied_by_period: "daily",
    });
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(next), { status: 200 });
      },
    });

    await enforcer.checkBudget(baseCheck());
    next = runDeny();
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    online = false;

    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" })).allowed).toBe(
      true,
    );
    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" })).allowed).toBe(
      false,
    );
  });

  it("a project-period denial received inside a run remains globally sticky", async () => {
    let online = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(
          JSON.stringify(
            makeResponse({
              allowed: false,
              mode: "hard_deny",
              denied_by_period: "monthly",
            }),
          ),
          { status: 200 },
        );
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    online = false;

    const other = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" });
    expect(other.allowed).toBe(false);
    expect(other.deniedByPeriod).toBe("monthly");
  });

  it("a newer ordered allow clears only its matching run sticky", async () => {
    const monotonic = fakeMonotonicClock(10);
    let online = true;
    let next = runDeny();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      monotonicNow: monotonic.now,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(next), { status: 200 });
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    monotonic.set(20);
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" });
    monotonic.set(30);
    next = makeResponse({ allowed: true });
    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" })).allowed).toBe(
      true,
    );
    online = false;

    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" })).allowed).toBe(
      true,
    );
    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" })).allowed).toBe(
      false,
    );
  });

  it("suppresses a delayed allow whose request epoch predates a newer run denial", async () => {
    const monotonic = fakeMonotonicClock(10);
    const delayedAllow = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return delayedAllow.promise;
        return new Response(
          JSON.stringify(
            runDeny({
              run_control: {
                version: "1",
                action: "terminate",
                agent_run_id: "run-a",
                reason: "manual_kill",
              },
            }),
          ),
          { status: 200 },
        );
      },
    });

    const olderAllow = enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    monotonic.set(20);
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    delayedAllow.resolve(new Response(JSON.stringify(makeResponse()), { status: 200 }));

    const folded = await olderAllow;
    expect(folded.allowed).toBe(false);
    expect([folded.denySource, folded.denyReason, folded.deniedByPeriod]).toEqual([
      "server",
      "manual_kill",
      "run_stopped",
    ]);
  });

  it("lets an equal request epoch lose to the existing sticky denial", async () => {
    const monotonic = fakeMonotonicClock(10);
    let next = runDeny();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      monotonicNow: monotonic.now,
      fetch: okFetch([], () => next),
    });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    next = makeResponse();

    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" })).allowed).toBe(
      false,
    );
  });

  it("bounds run stickies at 128 and a replay touch preserves the touched key", async () => {
    let online = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(runDeny()), { status: 200 });
      },
    });
    for (let index = 0; index < 128; index += 1) {
      await enforcer.checkBudget({ ...baseCheck(), agentRunId: `run-${index}` });
    }
    online = false;
    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-0" })).allowed).toBe(
      false,
    );
    online = true;
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-128" });
    online = false;

    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-0" })).allowed).toBe(
      false,
    );
    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-1" })).allowed).toBe(
      true,
    );
    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-128" })).allowed).toBe(
      false,
    );
  });

  it("touches a run sticky without changing its observation stamp", async () => {
    const monotonic = fakeMonotonicClock(10);
    const delayedAllow = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      leaseEnabled: false,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 1) return new Response(JSON.stringify(runDeny()), { status: 200 });
        if (call === 2) return delayedAllow.promise;
        return Promise.reject(new TypeError("offline"));
      },
    });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    monotonic.set(20);
    const newerAllow = enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    monotonic.set(30);
    const touched = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    expect(touched.allowed).toBe(false);
    delayedAllow.resolve(new Response(JSON.stringify(makeResponse()), { status: 200 }));

    expect((await newerAllow).allowed).toBe(true);
  });

  it("refreshes the observation stamp when the same run denial is filed again", async () => {
    const monotonic = fakeMonotonicClock(10);
    const delayedAllow = deferredResponse();
    let call = 0;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: false,
      monotonicNow: monotonic.now,
      fetch: async () => {
        call += 1;
        if (call === 2) return delayedAllow.promise;
        return new Response(JSON.stringify(runDeny()), { status: 200 });
      },
    });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    monotonic.set(15);
    const olderAllow = enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    monotonic.set(20);
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    delayedAllow.resolve(new Response(JSON.stringify(makeResponse()), { status: 200 }));

    expect((await olderAllow).allowed).toBe(false);
  });

  it("an alert-only response clears the matching run sticky", async () => {
    let online = true;
    let next = runDeny();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(next), { status: 200 });
      },
    });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    online = false;
    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" })).allowed).toBe(
      false,
    );
    online = true;
    next = makeResponse({ allowed: false, mode: "alert_only", denied_by_period: "agent_run" });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    online = false;

    expect((await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" })).allowed).toBe(
      true,
    );
  });

  it("logs the exact preserved-deny warning once on every replay", async () => {
    const log = capturingLogger();
    let online = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      logger: log.logger,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(runDeny()), { status: 200 });
      },
    });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    online = false;
    const first = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    const second = await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    const expected = "Cloud API unreachable; preserving prior hard deny: $99.50/$100.00 used";

    expect(first.warning).toBe(expected);
    expect(second.warning).toBe(expected);
    expect(log.warn.filter((message) => message === expected)).toHaveLength(2);
  });

  it.each([
    "agent_run",
    "run_stopped",
  ] as const)("replays a %s denial only for its matching run during an outage", async (deniedByPeriod) => {
    let online = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      leaseEnabled: false,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(runDeny({ denied_by_period: deniedByPeriod })), {
          status: 200,
        });
      },
    });

    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    online = false;

    await expect(
      enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" }),
    ).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod,
    });
  });

  it("keeps an older global project sticky when a stopped run denial is learned inside a run", async () => {
    let online = true;
    let next = makeResponse({
      allowed: false,
      mode: "hard_deny",
      denied_by_period: "daily",
    });
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      leaseEnabled: false,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(next), { status: 200 });
      },
    });

    await enforcer.checkBudget(baseCheck());
    next = runDeny({ denied_by_period: "run_stopped" });
    await enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-a" });
    online = false;

    await expect(
      enforcer.checkBudget({ ...baseCheck(), agentRunId: "run-b" }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
    });
    const runStickies = (
      enforcer as unknown as {
        runHardDenyResponses: Map<string, { response: BudgetCheckResponse }>;
      }
    ).runHardDenyResponses;
    expect(runStickies.get("run-a")?.response.denied_by_period).toBe("run_stopped");
  });

  it("uses global fallback for a no-run stopped denial without overwriting a stronger sticky or creating an undefined run key", async () => {
    let online = true;
    let next = makeResponse({
      allowed: false,
      mode: "hard_deny",
      denied_by_period: "daily",
    });
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      leaseEnabled: false,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(next), { status: 200 });
      },
    });

    await enforcer.checkBudget(baseCheck());
    next = runDeny({ denied_by_period: "run_stopped" });
    await enforcer.checkBudget(baseCheck());
    online = false;

    await expect(enforcer.checkBudget(baseCheck())).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
    });
    const runStickies = (
      enforcer as unknown as {
        runHardDenyResponses: Map<string, unknown>;
      }
    ).runHardDenyResponses;
    expect(runStickies.has(undefined as unknown as string)).toBe(false);
  });

  it("retains a no-run stopped denial globally when no stronger global sticky exists", async () => {
    let online = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      leaseEnabled: false,
      fetch: async () => {
        if (!online) return Promise.reject(new TypeError("offline"));
        return new Response(JSON.stringify(runDeny({ denied_by_period: "run_stopped" })), {
          status: 200,
        });
      },
    });

    await enforcer.checkBudget(baseCheck());
    online = false;

    await expect(enforcer.checkBudget(baseCheck())).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
    });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed local enforcement.
// ---------------------------------------------------------------------------

describe("outage + fail_closed local enforcement", () => {
  it("denies (fail-closed) when the cloud was never reached", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: false,
      fetch: unreachableFetch(records),
    });
    const r = await enforcer.checkBudget({ ...baseCheck() });
    expect(r.allowed).toBe(false);
    expect(r.warning).toContain("no prior budget limit");
    expect(r.warning).toBe(
      "Cloud unreachable and no prior budget limit known; denying request (fail-closed)",
    );
    expect(r.remainingBudget).toBe(0);
    expect([r.denySource, r.denyReason, r.deniedByPeriod]).toEqual([
      "local_enforcement",
      "no_prior_budget_limit",
      null,
    ]);
  });

  it("allows within the last-known limit and tracks the estimated cost", async () => {
    const records: FetchRecord[] = [];
    let reachable = true;
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: false,
      cacheTtl: 0, // force the offline second call to re-contact (not serve a cached allow)
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        if (!reachable) return Promise.reject(new TypeError("fetch failed"));
        return new Response(
          JSON.stringify(makeResponse({ allowed: true, budget_limit: 100, current_usage: 0 })),
          { status: 200 },
        );
      },
    });
    await enforcer.checkBudget({ ...baseCheck() }); // establishes last-known limit 100
    reachable = false;
    const r = await enforcer.checkBudget({
      estimatedInputTokens: 1000,
      model: "m",
      provider: "openai",
    });
    expect(r.allowed).toBe(true);
    expect(r.warning).toContain("locally");
    expect(r.warning).toBe("Cloud API unreachable; enforcing locally");
    const estCost = DEFAULT_COST_PER_TOKEN * 1000;
    expect(r.budgetLimit).toBe(100);
    expect(r.currentUsage).toBeCloseTo(estCost, 10);
    expect(r.remainingBudget).toBeCloseTo(100 - estCost, 10);
    expect(enforcer.getLocalCurrentSpend()).toBeCloseTo(estCost, 10);
  });

  it("denies once accumulated local spend would cross the last-known limit", async () => {
    const records: FetchRecord[] = [];
    let reachable = true;
    // A tiny limit that even one estimate exceeds.
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: false,
      cacheTtl: 0, // force the offline second call to re-contact (not serve a cached allow)
      fetch: async (url, init) => {
        records.push({ url: String(url), body: String(init?.body ?? "") });
        if (!reachable) return Promise.reject(new TypeError("fetch failed"));
        return new Response(
          JSON.stringify(makeResponse({ allowed: true, budget_limit: 0.01, current_usage: 0 })),
          { status: 200 },
        );
      },
    });
    await enforcer.checkBudget({ ...baseCheck() }); // last-known limit 0.01
    reachable = false;
    const r = await enforcer.checkBudget({
      estimatedInputTokens: 1000,
      model: "m",
      provider: "openai",
    });
    expect(r.allowed).toBe(false);
    expect(r.warning).toContain("denies");
    expect(r.budgetLimit).toBe(0.01);
    expect([r.denySource, r.denyReason, r.deniedByPeriod]).toEqual([
      "local_enforcement",
      "local_budget_exceeded",
      null,
    ]);
    // A denied local-enforcement call does NOT accrue spend.
    expect(enforcer.getLocalCurrentSpend()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Local outage-estimate tracking.
// ---------------------------------------------------------------------------

describe("local cost tracking", () => {
  it("accumulates repeated fail-open spend within the same UTC day", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock();
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      now: clock.now,
      fetch: unreachableFetch(records),
    });
    await enforcer.checkBudget({ estimatedInputTokens: 1000, model: "m", provider: "openai" });
    await enforcer.checkBudget({ estimatedInputTokens: 2000, model: "m", provider: "openai" });
    expect(enforcer.getLocalCurrentSpend()).toBeCloseTo(DEFAULT_COST_PER_TOKEN * 3000, 10);
  });

  it("buckets spend per UTC calendar day (a new day starts fresh)", async () => {
    const records: FetchRecord[] = [];
    const clock = fakeClock(Date.UTC(2026, 6, 3, 23, 59, 0));
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      now: clock.now,
      fetch: unreachableFetch(records),
    });
    await enforcer.checkBudget({ estimatedInputTokens: 1000, model: "m", provider: "openai" });
    expect(enforcer.getLocalCurrentSpend()).toBeCloseTo(DEFAULT_COST_PER_TOKEN * 1000, 10);
    clock.advance(2 * 60 * 1000); // cross midnight UTC into the next day
    expect(enforcer.getLocalCurrentSpend()).toBe(0);
  });
});

describe("buildConfirmRequest", () => {
  it("carries provider_region and a recognized service_tier through", () => {
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
    const req = enforcer.buildConfirmRequest({
      reservationId: "res-1",
      model: "m",
      tokenDetails: zeroTokenDetails(),
      provider: "bedrock",
      callId: testCallId(12),
      providerRegion: "us-east-1",
      serviceTier: "priority",
    });
    expect(req.provider_region).toBe("us-east-1");
    expect(req.service_tier).toBe("priority");
  });

  it("downgrades an unrecognized service_tier to absent and logs at DEBUG (behavior 20)", () => {
    const log = capturingLogger();
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY, logger: log.logger });
    const req = enforcer.buildConfirmRequest({
      reservationId: "res-1",
      model: "m",
      tokenDetails: zeroTokenDetails(),
      provider: "openai",
      callId: testCallId(13),
      serviceTier: "turbo_ludicrous", // not a ServiceTier value
    });
    expect(req.service_tier).toBeNull();
    expect(log.debug.join("\n")).toContain("budget.confirm_service_tier_unrecognized");
  });

  it("throws from buildConfirmRequest on a missing callId, before any wire work", () => {
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
    expect(() =>
      enforcer.buildConfirmRequest({
        reservationId: "res-1",
        model: "m",
        tokenDetails: zeroTokenDetails(),
        provider: "openai",
        callId: "",
      }),
    ).toThrow("call_id is required for budget confirm reconciliation");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("close() is idempotent and no-op-safe", async () => {
    const enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
    await enforcer.close();
    await enforcer.close();
    expect(enforcer.isClosed).toBe(true);
  });

  it("supports Symbol.asyncDispose (await using)", async () => {
    let closedRef: BudgetEnforcer | null = null;
    {
      await using enforcer = new BudgetEnforcer({ apiUrl: API_URL, apiKey: API_KEY });
      closedRef = enforcer;
      expect(enforcer.isClosed).toBe(false);
    }
    expect(closedRef?.isClosed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrent asynchronous checks.
// ---------------------------------------------------------------------------

describe("concurrent async calls (single-threaded atomicity)", () => {
  it("sums fail-open local spend exactly across many concurrent checkBudget calls", async () => {
    const records: FetchRecord[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      failOpen: true,
      fetch: unreachableFetch(records),
    });
    const N = 500;
    await Promise.all(
      Array.from({ length: N }, () =>
        enforcer.checkBudget({ estimatedInputTokens: 100, model: "m", provider: "openai" }),
      ),
    );
    // Each of the N calls accrues DEFAULT_COST_PER_TOKEN * 100; no lost updates.
    expect(enforcer.getLocalCurrentSpend()).toBeCloseTo(DEFAULT_COST_PER_TOKEN * 100 * N, 6);
  });
});
