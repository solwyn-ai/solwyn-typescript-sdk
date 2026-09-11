/**
 * Routing and failover-policy unit tests covering `SelectionPolicy` ordering, exception
 * classification, retry-delay parsing, strict `RoutingRequest` validation, the
 * `observedP50`/`recordLatency` window, request-scoped price-hint delivery, and the pure
 * dispatch-loop helpers: `Deadline`, shrinking per-hop timeouts, the exact retry margin,
 * disposition-to-verdict mapping, and idempotency-mode resolution.
 *
 * Full dispatch-loop behavior that mutates breakers or builds events lives in `client.ts`
 * and is exercised by the client integration tests; this file pins the pure surface those
 * behaviors consume.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCostPolicyWarningForTesting } from "../../src/client";
import { type Logger, Solwyn } from "../../src/index";
import {
  ambiguousFailoverAllowed,
  BUDGET_CHECK_TIMEOUT,
  budgetCheckTimeout,
  buildCandidate,
  CostPolicy,
  classifyException,
  Deadline,
  Disposition,
  dispositionCountsAsBreakerFailure,
  dropForeignCandidates,
  HealthBasedPolicy,
  hopTimeout,
  LatencyPolicy,
  LatencyTracker,
  MIN_HOP_TIMEOUT,
  type ProviderCandidate,
  providerNameOf,
  RoutingRequestSchema,
  type RoutingRuntime,
  resolveIdempotencyMode,
  retryAfterSeconds,
  retryFitsWithinDeadline,
  type SelectionPolicy,
  sameProviderCandidates,
} from "../../src/routing";
import type { FetchLike } from "../../src/transport";
import type { CircuitState } from "../../src/types";

// ---------------------------------------------------------------------------
// Candidate fixtures.
// ---------------------------------------------------------------------------

function runtime(name: string, dialect = name): RoutingRuntime {
  return { adapter: { name, dialect } };
}

interface CandidateOverrides {
  name?: string;
  state?: CircuitState;
  recoveryEligible?: boolean;
  translatable?: boolean;
  priceHint?: number | null;
  latencyP50?: number | null;
  runtime?: RoutingRuntime;
}

function candidate(overrides: CandidateOverrides = {}): ProviderCandidate {
  const rt = overrides.runtime ?? runtime(overrides.name ?? "provider");
  return {
    runtime: rt,
    breakerState: overrides.state ?? "closed",
    recoveryEligible: overrides.recoveryEligible ?? false,
    translatable: overrides.translatable ?? true,
    priceHint: overrides.priceHint ?? null,
    latencyP50: overrides.latencyP50 ?? null,
  };
}

const REQ = RoutingRequestSchema.parse({ requestedProvider: "openai" });

function names(cands: readonly ProviderCandidate[]): string[] {
  return cands.map(providerNameOf);
}

const API_KEY = `sk_proj_${"a".repeat(64)}`;

function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    logger: {
      debug() {},
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    },
    warnings,
  };
}

function routingFetch(priceHints: Record<string, number> | null): FetchLike {
  return vi.fn(async (url) => {
    if (url.includes("/api/v1/budgets/check")) {
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 950,
          reservation_id: "res-routing",
          mode: "alert_only",
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: priceHints,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  });
}

function routingFetchSequence(priceHints: readonly (Record<string, number> | null)[]): FetchLike {
  let checkIndex = 0;
  return vi.fn(async (url) => {
    if (url.includes("/api/v1/budgets/check")) {
      const hints = priceHints[checkIndex] ?? null;
      checkIndex += 1;
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 950,
          reservation_id: `res-routing-${checkIndex}`,
          mode: "alert_only",
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: hints,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  });
}

function openaiRoutingClient() {
  return {
    chat: {
      completions: {
        create: vi.fn((_kwargs: Record<string, unknown>) => ({
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })),
      },
    },
  };
}

function anthropicRoutingClient() {
  return {
    messages: {
      create: vi.fn(() => ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        model: "claude-3-5-sonnet-20241022",
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    },
  };
}

class RecordingCostPolicy extends CostPolicy {
  readonly orders: string[][] = [];
  readonly hintSnapshots: Array<Array<number | null | undefined>> = [];

  override order(
    candidates: readonly ProviderCandidate[],
    req: Parameters<CostPolicy["order"]>[1],
  ): ProviderCandidate[] {
    this.hintSnapshots.push(candidates.map((candidate) => candidate.priceHint));
    const ordered = super.order(candidates, req);
    this.orders.push(names(ordered));
    return ordered;
  }
}

// ---------------------------------------------------------------------------
// HealthBasedPolicy ordering.
// ---------------------------------------------------------------------------

describe("HealthBasedPolicy — health tiering", () => {
  const policy = new HealthBasedPolicy();

  it("orders CLOSED < HALF_OPEN < recovery-eligible OPEN regardless of input order", () => {
    const input = [
      candidate({ name: "open", state: "open", recoveryEligible: true }),
      candidate({ name: "half", state: "half_open" }),
      candidate({ name: "closed", state: "closed" }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["closed", "half", "open"]);
  });

  it("drops OPEN-not-recovery-eligible candidates entirely, not merely last", () => {
    const input = [
      candidate({ name: "closed", state: "closed" }),
      candidate({ name: "dead", state: "open", recoveryEligible: false }),
      candidate({ name: "half", state: "half_open" }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["closed", "half"]);
  });

  it("preserves configured order within a tier (stable sort)", () => {
    const input = [
      candidate({ name: "c1", state: "closed" }),
      candidate({ name: "c2", state: "closed" }),
      candidate({ name: "c3", state: "closed" }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["c1", "c2", "c3"]);
  });

  it("sinks an untranslatable candidate below a translatable one within the same state", () => {
    const input = [
      candidate({ name: "untr", state: "closed", translatable: false }),
      candidate({ name: "tr", state: "closed", translatable: true }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["tr", "untr"]);
  });

  it("state tier dominates translatability (HALF_OPEN translatable never outranks CLOSED untranslatable)", () => {
    const input = [
      candidate({ name: "half-tr", state: "half_open", translatable: true }),
      candidate({ name: "closed-untr", state: "closed", translatable: false }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["closed-untr", "half-tr"]);
  });

  it("returns empty for empty input (no synthesized candidates)", () => {
    expect(policy.order([], REQ)).toEqual([]);
  });

  it("returns empty when every candidate is OPEN-and-blocked", () => {
    const input = [
      candidate({ name: "a", state: "open", recoveryEligible: false }),
      candidate({ name: "b", state: "open", recoveryEligible: false }),
    ];
    expect(policy.order(input, REQ)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [
      candidate({ name: "open", state: "open", recoveryEligible: true }),
      candidate({ name: "closed", state: "closed" }),
    ];
    const snapshot = [...input];
    policy.order(input, REQ);
    expect(input).toEqual(snapshot);
  });

  it("order() never reaches a breaker — a throwing stub breaker survives ordering", () => {
    // Candidates carry snapshots, so ordering never touches live breakers.
    let touched = false;
    const throwingBreaker = {
      admit(): never {
        touched = true;
        throw new Error("admit must never be called by order()");
      },
      recordFailure(): never {
        touched = true;
        throw new Error("recordFailure must never be called by order()");
      },
      recordSuccess(): never {
        touched = true;
        throw new Error("recordSuccess must never be called by order()");
      },
      getState(): { state: CircuitState; recoveryEligible: boolean } {
        return { state: "closed", recoveryEligible: false };
      },
    };
    const cand = buildCandidate(runtime("x"), throwingBreaker.getState(), null, null);
    expect(() => new HealthBasedPolicy().order([cand], REQ)).not.toThrow();
    expect(() => new LatencyPolicy().order([cand], REQ)).not.toThrow();
    expect(() => new CostPolicy().order([cand], REQ)).not.toThrow();
    expect(touched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LatencyPolicy ordering.
// ---------------------------------------------------------------------------

describe("LatencyPolicy — ascending p50 within health tiers", () => {
  const policy = new LatencyPolicy();

  it("orders usable candidates by ascending p50", () => {
    const input = [
      candidate({ name: "slow", state: "closed", latencyP50: 300 }),
      candidate({ name: "fast", state: "closed", latencyP50: 100 }),
      candidate({ name: "mid", state: "closed", latencyP50: 200 }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["fast", "mid", "slow"]);
  });

  it("sorts a null (under-sampled) p50 after every known p50 in the tier", () => {
    const input = [
      candidate({ name: "unknown", state: "closed", latencyP50: null }),
      candidate({ name: "known", state: "closed", latencyP50: 500 }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["known", "unknown"]);
  });

  it("still applies the health drop-filter (latency never overrides it)", () => {
    const input = [
      candidate({ name: "dead-fast", state: "open", recoveryEligible: false, latencyP50: 1 }),
      candidate({ name: "closed-slow", state: "closed", latencyP50: 999 }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["closed-slow"]);
  });

  it("health tier dominates p50 (a fast HALF_OPEN never outranks a slow CLOSED)", () => {
    const input = [
      candidate({ name: "half-fast", state: "half_open", latencyP50: 1 }),
      candidate({ name: "closed-slow", state: "closed", latencyP50: 9999 }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["closed-slow", "half-fast"]);
  });
});

// ---------------------------------------------------------------------------
// CostPolicy ordering.
// ---------------------------------------------------------------------------

describe("CostPolicy — ascending price hint within health tiers", () => {
  const policy = new CostPolicy();

  it("orders usable candidates by ascending price hint", () => {
    const input = [
      candidate({ name: "pricey", state: "closed", priceHint: 30 }),
      candidate({ name: "cheap", state: "closed", priceHint: 10 }),
      candidate({ name: "mid", state: "closed", priceHint: 20 }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["cheap", "mid", "pricey"]);
  });

  it("sorts a null price hint after every known hint in the tier", () => {
    const input = [
      candidate({ name: "unknown", state: "closed", priceHint: null }),
      candidate({ name: "known", state: "closed", priceHint: 5 }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["known", "unknown"]);
  });

  it("falls back byte-identically to HealthBasedPolicy when NO candidate carries a hint", () => {
    // Without price hints, cost policy preserves health ordering.
    const input = [
      candidate({ name: "open-elig", state: "open", recoveryEligible: true }),
      candidate({ name: "half", state: "half_open" }),
      candidate({ name: "closed-untr", state: "closed", translatable: false }),
      candidate({ name: "closed-tr", state: "closed", translatable: true }),
      candidate({ name: "dead", state: "open", recoveryEligible: false }),
    ];
    const health = new HealthBasedPolicy().order(input, REQ);
    const cost = policy.order(input, REQ);
    expect(names(cost)).toEqual(names(health));
    expect(cost).toEqual(health);
  });

  it("still applies the health drop-filter (price never overrides it)", () => {
    const input = [
      candidate({ name: "dead-cheap", state: "open", recoveryEligible: false, priceHint: 0.01 }),
      candidate({ name: "closed-pricey", state: "closed", priceHint: 1000 }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["closed-pricey"]);
  });

  it("health tier dominates price (a cheap HALF_OPEN never outranks an expensive CLOSED)", () => {
    const input = [
      candidate({ name: "half-cheap", state: "half_open", priceHint: 0.001 }),
      candidate({ name: "closed-pricey", state: "closed", priceHint: 100000 }),
    ];
    expect(names(policy.order(input, REQ))).toEqual(["closed-pricey", "half-cheap"]);
  });

  it("ordering is invariant under positive scaling of every hint", () => {
    const base = [
      candidate({ name: "a", state: "closed", priceHint: 3 }),
      candidate({ name: "b", state: "closed", priceHint: 1 }),
      candidate({ name: "c", state: "closed", priceHint: 2 }),
    ];
    const expected = names(policy.order(base, REQ));
    for (const k of [0.001, 1000, 7.3]) {
      const scaled = base.map((c) =>
        candidate({
          name: providerNameOf(c),
          state: "closed",
          priceHint: (c.priceHint as number) * k,
        }),
      );
      expect(names(policy.order(scaled, REQ))).toEqual(expected);
    }
  });

  it("ranks strictly by relative order — a tiny gap and a huge gap order identically", () => {
    const tinyGap = [
      candidate({ name: "lo", state: "closed", priceHint: 1.0 }),
      candidate({ name: "hi", state: "closed", priceHint: 1.0000001 }),
    ];
    const hugeGap = [
      candidate({ name: "lo", state: "closed", priceHint: 1 }),
      candidate({ name: "hi", state: "closed", priceHint: 1_000_000 }),
    ];
    expect(names(policy.order(tinyGap, REQ))).toEqual(["lo", "hi"]);
    expect(names(policy.order(hugeGap, REQ))).toEqual(["lo", "hi"]);
  });

  it("does no price arithmetic — changing estimatedInputTokens alone never changes order", () => {
    // Cost routing uses server-supplied relative hints without local price arithmetic.
    const input = [
      candidate({ name: "a", state: "closed", priceHint: 2 }),
      candidate({ name: "b", state: "closed", priceHint: 1 }),
    ];
    const few = RoutingRequestSchema.parse({
      requestedProvider: "openai",
      estimatedInputTokens: 1,
    });
    const many = RoutingRequestSchema.parse({
      requestedProvider: "openai",
      estimatedInputTokens: 10_000_000,
    });
    expect(names(policy.order(input, few))).toEqual(["b", "a"]);
    expect(names(policy.order(input, many))).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// CostPolicy no-hint warning (shared client selection path).
// ---------------------------------------------------------------------------

describe("CostPolicy — warns once per process when price hints are unavailable", () => {
  beforeEach(() => {
    __resetCostPolicyWarningForTesting();
  });

  afterEach(() => {
    __resetCostPolicyWarningForTesting();
  });

  it("warns exactly once across three no-hint selections and preserves health order", async () => {
    const policy = new RecordingCostPolicy();
    const log = capturingLogger();
    const primary = openaiRoutingClient();
    const fallback = anthropicRoutingClient();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: routingFetch(null),
      fallback: [[fallback, "claude-3-5-sonnet-20241022"]],
      logger: log.logger,
      selectionPolicy: policy,
    });

    for (let i = 0; i < 3; i += 1) {
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    }
    await solwyn.close();

    expect(policy.orders).toEqual([
      ["openai", "anthropic"],
      ["openai", "anthropic"],
      ["openai", "anthropic"],
    ]);
    expect(log.warnings).toEqual([
      "CostPolicy selected but this budget check carried no price hints; using health-based order",
    ]);
  });

  it.each([
    { label: "an explicit empty map", hints: {} as Record<string, number> },
    { label: "a map containing only unknown providers", hints: { unknown: 1 } },
  ])("keeps configured order without warning for $label", async ({ hints }) => {
    const policy = new RecordingCostPolicy();
    const log = capturingLogger();
    const primary = openaiRoutingClient();
    const fallback = anthropicRoutingClient();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: routingFetch(hints),
      fallback: [[fallback, "claude-3-5-sonnet-20241022"]],
      logger: log.logger,
      selectionPolicy: policy,
    });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(policy.orders).toEqual([["openai", "anthropic"]]);
    expect(policy.hintSnapshots).toEqual([[null, null]]);
    expect(log.warnings).toEqual([]);
  });

  it("orders a hinted anthropic candidate first without warning", async () => {
    const policy = new RecordingCostPolicy();
    const log = capturingLogger();
    const primary = openaiRoutingClient();
    const fallback = anthropicRoutingClient();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: routingFetch({ openai: 10, anthropic: 2 }),
      fallback: [[fallback, "claude-3-5-sonnet-20241022"]],
      logger: log.logger,
      selectionPolicy: policy,
    });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [], max_tokens: 10 });
    await solwyn.close();

    expect(policy.orders).toEqual([["anthropic", "openai"]]);
    expect(fallback.messages.create).toHaveBeenCalledTimes(1);
    expect(log.warnings).toEqual([]);
  });

  it("never warns for health or latency policies, with or without hints", async () => {
    const log = capturingLogger();
    const policies = [
      { policy: undefined, hints: null },
      { policy: undefined, hints: { openai: 0 } },
      { policy: new LatencyPolicy(), hints: null },
      { policy: new LatencyPolicy(), hints: { openai: 0 } },
    ];

    for (const { policy, hints } of policies) {
      const solwyn = new Solwyn(openaiRoutingClient(), {
        apiKey: API_KEY,
        fetch: routingFetch(hints),
        logger: log.logger,
        ...(policy === undefined ? {} : { selectionPolicy: policy }),
      });
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
      await solwyn.close();
    }

    expect(log.warnings).toEqual([]);
  });

  it("warns exactly once across two separate CostPolicy clients", async () => {
    const log = capturingLogger();
    for (let i = 0; i < 2; i += 1) {
      const solwyn = new Solwyn(openaiRoutingClient(), {
        apiKey: API_KEY,
        fetch: routingFetch(null),
        logger: log.logger,
        selectionPolicy: new CostPolicy(),
      });
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
      await solwyn.close();
    }

    expect(log.warnings).toEqual([
      "CostPolicy selected but this budget check carried no price hints; using health-based order",
    ]);
  });

  it("does not carry a hinted order into the next null-hint request", async () => {
    const policy = new RecordingCostPolicy();
    const log = capturingLogger();
    const primary = openaiRoutingClient();
    const fallback = anthropicRoutingClient();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: routingFetchSequence([{ openai: 9, anthropic: 1 }, null, {}]),
      fallback: [[fallback, "claude-3-5-sonnet-20241022"]],
      logger: log.logger,
      selectionPolicy: policy,
    });

    await solwyn.chat.completions.create({ model: "gpt-first", messages: [], max_tokens: 10 });
    await solwyn.chat.completions.create({ model: "gpt-second", messages: [], max_tokens: 10 });
    await solwyn.chat.completions.create({ model: "gpt-third", messages: [], max_tokens: 10 });
    await solwyn.close();

    expect(policy.orders).toEqual([
      ["anthropic", "openai"],
      ["openai", "anthropic"],
      ["openai", "anthropic"],
    ]);
    expect(policy.hintSnapshots).toEqual([
      [9, 1],
      [null, null],
      [null, null],
    ]);
    expect(log.warnings).toEqual([
      "CostPolicy selected but this budget check carried no price hints; using health-based order",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Policy purity + drop-in surface.
// ---------------------------------------------------------------------------

describe("SelectionPolicy — importable surface + drop-in swap", () => {
  it("exports the three concrete policies + the structural protocol", () => {
    // This pins the routing-module exports; the integration suite pins package-root exports.
    expect(new HealthBasedPolicy()).toBeInstanceOf(HealthBasedPolicy);
    expect(new LatencyPolicy()).toBeInstanceOf(LatencyPolicy);
    expect(new CostPolicy()).toBeInstanceOf(CostPolicy);
    const custom: SelectionPolicy = { order: (c) => [...c] };
    expect(custom.order([candidate({ name: "z" })], REQ).map(providerNameOf)).toEqual(["z"]);
  });

  it("declares exactly the routing signals each built-in policy consumes", () => {
    expect(new HealthBasedPolicy()).toMatchObject({
      consumesLatencySignals: false,
      consumesPriceSignals: false,
    });
    expect(new LatencyPolicy()).toMatchObject({
      consumesLatencySignals: true,
      consumesPriceSignals: false,
    });
    expect(new CostPolicy()).toMatchObject({
      consumesLatencySignals: false,
      consumesPriceSignals: true,
    });
  });

  it("swapping only the policy object changes attempt order on an identical chain", () => {
    // Swapping policies changes ordering without changing dispatch mechanics.
    const chain = [
      candidate({ name: "primary", state: "closed", latencyP50: 300, priceHint: 5 }),
      candidate({ name: "fallback", state: "closed", latencyP50: 100, priceHint: 9 }),
    ];
    expect(names(new HealthBasedPolicy().order(chain, REQ))).toEqual(["primary", "fallback"]);
    expect(names(new LatencyPolicy().order(chain, REQ))).toEqual(["fallback", "primary"]);
    expect(names(new CostPolicy().order(chain, REQ))).toEqual(["primary", "fallback"]);
  });
});

// ---------------------------------------------------------------------------
// Client policy-signal hot path.
// ---------------------------------------------------------------------------

describe("SelectionPolicy — client signal consumption", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a real Health dispatch skips both optional signal reads", async () => {
    const observedP50 = vi.spyOn(LatencyTracker.prototype, "observedP50").mockImplementation(() => {
      throw new Error("Health policy must not read latency");
    });
    const order = vi.spyOn(HealthBasedPolicy.prototype, "order");
    const client = openaiRoutingClient();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: routingFetch({ openai: 3 }),
      selectionPolicy: new HealthBasedPolicy(),
    });

    await expect(
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).resolves.toBeDefined();
    expect(observedP50).not.toHaveBeenCalled();
    expect(order.mock.calls[0]?.[0]).toMatchObject([{ latencyP50: null, priceHint: null }]);
    await solwyn.close();
  });

  it("a Latency dispatch reads latency but skips price hints", async () => {
    const observedP50 = vi.spyOn(LatencyTracker.prototype, "observedP50").mockReturnValue(17);
    const order = vi.spyOn(LatencyPolicy.prototype, "order");
    const client = openaiRoutingClient();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: routingFetch({ openai: 3 }),
      selectionPolicy: new LatencyPolicy(),
    });

    await expect(
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).resolves.toBeDefined();
    expect(observedP50).toHaveBeenCalledOnce();
    expect(order.mock.calls[0]?.[0]).toMatchObject([{ latencyP50: 17, priceHint: null }]);
    await solwyn.close();
  });

  it("a Cost dispatch reads price hints but skips latency", async () => {
    const observedP50 = vi.spyOn(LatencyTracker.prototype, "observedP50").mockImplementation(() => {
      throw new Error("Cost policy must not read latency");
    });
    const order = vi.spyOn(CostPolicy.prototype, "order");
    const client = openaiRoutingClient();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: routingFetch({ openai: 3 }),
      selectionPolicy: new CostPolicy(),
    });

    await expect(
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).resolves.toBeDefined();
    expect(observedP50).not.toHaveBeenCalled();
    expect(order.mock.calls[0]?.[0]).toMatchObject([{ latencyP50: null, priceHint: 3 }]);
    await solwyn.close();
  });

  it("an undeclared custom policy receives complete candidate signals", async () => {
    let observed: readonly ProviderCandidate[] = [];
    const policy: SelectionPolicy = {
      order(candidates) {
        observed = candidates;
        return [...candidates];
      },
    };
    const observedP50 = vi.spyOn(LatencyTracker.prototype, "observedP50").mockReturnValue(17);
    const solwyn = new Solwyn(openaiRoutingClient(), {
      apiKey: API_KEY,
      fetch: routingFetch({ openai: 3 }),
      selectionPolicy: policy,
    });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });

    expect(observedP50).toHaveBeenCalledOnce();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ latencyP50: 17, priceHint: 3 });
    await solwyn.close();
  });

  it("constructs the internal routing request without parsing the public strict schema", async () => {
    const parse = vi.spyOn(RoutingRequestSchema, "parse");
    const safeParse = vi.spyOn(RoutingRequestSchema, "safeParse");
    const solwyn = new Solwyn(openaiRoutingClient(), {
      apiKey: API_KEY,
      fetch: routingFetch(null),
    });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });

    expect(parse).not.toHaveBeenCalled();
    expect(safeParse).not.toHaveBeenCalled();
    await solwyn.close();
  });
});

// ---------------------------------------------------------------------------
// RoutingRequest strict schema.
// ---------------------------------------------------------------------------

describe("RoutingRequest — strict schema", () => {
  it("rejects unknown/extra keys", () => {
    expect(() =>
      RoutingRequestSchema.parse({ requestedProvider: "openai", surprise: 1 }),
    ).toThrow();
  });

  it("defaults estimatedInputTokens to 0 when omitted", () => {
    expect(RoutingRequestSchema.parse({ requestedProvider: "openai" }).estimatedInputTokens).toBe(
      0,
    );
  });

  it("rejects a negative estimatedInputTokens", () => {
    expect(() =>
      RoutingRequestSchema.parse({ requestedProvider: "openai", estimatedInputTokens: -1 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// classifyException — Disposition enum + branch order.
// ---------------------------------------------------------------------------

/** Build an error whose constructor-name chain is exactly `chain[0]` extends `chain[1]`… */
function namedError(chain: string[], props: Record<string, unknown> = {}): Error {
  let ctor: new () => Error = Error;
  // Build the chain from the base (last) up to the concrete (first).
  for (let i = chain.length - 1; i >= 0; i--) {
    const parent = ctor;
    const clsName = chain[i] as string;
    const cls = class extends parent {};
    Object.defineProperty(cls, "name", { value: clsName });
    ctor = cls as unknown as new () => Error;
  }
  const err = new ctor();
  err.name = chain[0] as string;
  Object.assign(err, props);
  return err;
}

describe("Disposition enum", () => {
  it("has the exact wire-string values", () => {
    expect(Disposition.FAILOVER).toBe("failover");
    expect(Disposition.POST_SEND_AMBIGUOUS).toBe("post_send_ambiguous");
    expect(Disposition.FAIL_FAST).toBe("fail_fast");
  });
});

describe("classifyException — ordering trap (timeout subclasses connection error)", () => {
  it("APITimeoutError is ambiguous even though it subclasses APIConnectionError", () => {
    // Timeout errors remain ambiguous even when they subclass connection errors.
    const exc = namedError(["APITimeoutError", "APIConnectionError", "APIError"]);
    expect(classifyException(exc)).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });

  it("APIConnectionTimeoutError (the TS-SDK spelling) is also ambiguous", () => {
    const exc = namedError(["APIConnectionTimeoutError", "APIConnectionError", "APIError"]);
    expect(classifyException(exc)).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });

  it.each([
    "APITimeoutError",
    "APIConnectionTimeoutError",
  ])("%s uses only certain cause proof before deciding", (name) => {
    expect(
      classifyException(
        namedError([name, "APIConnectionError", "APIError"], {
          cause: namedError(["ConnectTimeout"]),
        }),
      ),
    ).toBe(Disposition.FAILOVER);
    expect(
      classifyException(
        namedError([name, "APIConnectionError", "APIError"], {
          cause: namedError(["PoolTimeout"]),
        }),
      ),
    ).toBe(Disposition.FAILOVER);
    expect(
      classifyException(
        namedError([name, "APIConnectionError", "APIError"], {
          cause: Object.assign(new Error(), { code: "ECONNREFUSED" }),
        }),
      ),
    ).toBe(Disposition.FAILOVER);
    expect(
      classifyException(
        namedError([name, "APIConnectionError", "APIError"], {
          cause: Object.assign(new Error(), { code: "UND_ERR_CONNECT_TIMEOUT" }),
        }),
      ),
    ).toBe(Disposition.FAILOVER);
    expect(
      classifyException(
        namedError([name, "APIConnectionError", "APIError"], {
          cause: namedError(["ReadTimeout"]),
        }),
      ),
    ).toBe(Disposition.POST_SEND_AMBIGUOUS);
    expect(
      classifyException(
        namedError([name, "APIConnectionError", "APIError"], {
          cause: new TypeError(),
        }),
      ),
    ).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });

  it.each([
    "APITimeoutError",
    "APIConnectionTimeoutError",
  ])("%s traverses a TypeError bridge before deciding from nested cause proof", (name) => {
    const classifyNested = (nested: unknown) =>
      classifyException(
        namedError([name, "APIConnectionError", "APIError"], {
          cause: Object.assign(new TypeError(), { cause: nested }),
        }),
      );

    expect(classifyNested(namedError(["ConnectTimeout"]))).toBe(Disposition.FAILOVER);
    expect(classifyNested(namedError(["PoolTimeout"]))).toBe(Disposition.FAILOVER);
    expect(classifyNested(Object.assign(new Error(), { code: "ECONNREFUSED" }))).toBe(
      Disposition.FAILOVER,
    );
    expect(classifyNested(Object.assign(new Error(), { code: "UND_ERR_CONNECT_TIMEOUT" }))).toBe(
      Disposition.FAILOVER,
    );
    expect(classifyNested(namedError(["ReadTimeout"]))).toBe(Disposition.POST_SEND_AMBIGUOUS);
    expect(classifyNested(new Error())).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });

  it("a bare APIConnectionError (no cause) is failover", () => {
    const exc = namedError(["APIConnectionError", "APIError"]);
    expect(classifyException(exc)).toBe(Disposition.FAILOVER);
  });
});

describe("classifyException — httpx-style transport errors", () => {
  it("ReadTimeout / WriteTimeout / ReadTimeoutError are ambiguous", () => {
    for (const n of ["ReadTimeout", "WriteTimeout", "ReadTimeoutError"]) {
      expect(classifyException(namedError([n, "TimeoutException"]))).toBe(
        Disposition.POST_SEND_AMBIGUOUS,
      );
    }
  });

  it("ConnectTimeout / PoolTimeout / ConnectError are failover (pre-send)", () => {
    // ConnectTimeout deliberately subclasses the generic TimeoutException — step 3 must win.
    expect(classifyException(namedError(["ConnectTimeout", "TimeoutException"]))).toBe(
      Disposition.FAILOVER,
    );
    expect(classifyException(namedError(["PoolTimeout", "TimeoutException"]))).toBe(
      Disposition.FAILOVER,
    );
    expect(classifyException(namedError(["ConnectError", "TransportError"]))).toBe(
      Disposition.FAILOVER,
    );
  });

  it("a generic timeout and a generic transport error are ambiguous", () => {
    expect(classifyException(namedError(["TimeoutException"]))).toBe(
      Disposition.POST_SEND_AMBIGUOUS,
    );
    expect(classifyException(namedError(["TransportError"]))).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });

  it("a remote-protocol (mid-stream) error is ambiguous", () => {
    expect(classifyException(namedError(["RemoteProtocolError", "TransportError"]))).toBe(
      Disposition.POST_SEND_AMBIGUOUS,
    );
  });
});

describe("classifyException — transport certainty precedes numeric status", () => {
  const ambiguousNames = [
    "TimeoutException",
    "TimeoutError",
    "AbortError",
    "ReadTimeout",
    "WriteTimeout",
    "ReadTimeoutError",
    "TransportError",
    "RemoteProtocolError",
    "ProtocolError",
    "ReadError",
    "WriteError",
    "ProxyError",
    "LocalProtocolError",
    "ModelTimeoutException",
    "ModelErrorException",
    "ConnectionClosedError",
  ] as const;

  it.each(ambiguousNames)("keeps %s ambiguous when bare, +429, or +500", (name) => {
    expect(classifyException(namedError([name]))).toBe(Disposition.POST_SEND_AMBIGUOUS);
    expect(classifyException(namedError([name], { status: 429 }))).toBe(
      Disposition.POST_SEND_AMBIGUOUS,
    );
    expect(classifyException(namedError([name], { status: 500 }))).toBe(
      Disposition.POST_SEND_AMBIGUOUS,
    );
  });

  it.each([
    "ConnectTimeout",
    "PoolTimeout",
    "ConnectError",
    "EndpointConnectionError",
    "ConnectTimeoutError",
    "ProxyConnectionError",
  ])("keeps pre-send %s failover-eligible even with status 500", (name) => {
    expect(classifyException(namedError([name], { status: 500 }))).toBe(Disposition.FAILOVER);
  });
});

describe("classifyException — numeric status classification", () => {
  it("429 / 529 are failover via .status", () => {
    expect(classifyException({ status: 429 })).toBe(Disposition.FAILOVER);
    expect(classifyException({ status: 529 })).toBe(Disposition.FAILOVER);
  });

  it("other 4xx are fail-fast", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(classifyException({ status: s })).toBe(Disposition.FAIL_FAST);
    }
  });

  it("5xx are ambiguous", () => {
    for (const s of [500, 502, 503]) {
      expect(classifyException({ status: s })).toBe(Disposition.POST_SEND_AMBIGUOUS);
    }
  });

  it("reads .statusCode and .status_code shapes too", () => {
    expect(classifyException({ statusCode: 429 })).toBe(Disposition.FAILOVER);
    expect(classifyException({ status_code: 400 })).toBe(Disposition.FAIL_FAST);
  });

  it("reads Google's .code-shaped status", () => {
    expect(classifyException({ code: 429 })).toBe(Disposition.FAILOVER);
    expect(classifyException({ code: 400 })).toBe(Disposition.FAIL_FAST);
    expect(classifyException({ code: 503 })).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });
});

describe("classifyException — bool guard", () => {
  it("never reads a boolean as a numeric status", () => {
    // A boolean `.status` must be skipped rather than coerced to 1 or 0.
    expect(classifyException({ status: true, code: 429 })).toBe(Disposition.FAILOVER);
    expect(classifyException({ status: false, code: 429 })).toBe(Disposition.FAILOVER);
    // With ONLY a boolean status and nothing else, it falls through to the safe default.
    expect(classifyException({ status: true })).toBe(Disposition.FAIL_FAST);
  });
});

describe("classifyException — default + built-in connection reset", () => {
  it("defaults unrecognized values (incl. non-Error throws) to fail-fast", () => {
    expect(classifyException("boom")).toBe(Disposition.FAIL_FAST);
    expect(classifyException(42)).toBe(Disposition.FAIL_FAST);
    expect(classifyException(null)).toBe(Disposition.FAIL_FAST);
    expect(classifyException(undefined)).toBe(Disposition.FAIL_FAST);
    expect(classifyException({})).toBe(Disposition.FAIL_FAST);
    expect(classifyException(new Error("nope"))).toBe(Disposition.FAIL_FAST);
  });

  it("a built-in ConnectionReset-shaped error stays fail-fast, never failover", () => {
    // The bare "ConnectionError"
    // name must NEVER match, and a reset with no other signal is the safe default.
    const reset = namedError(["ConnectionResetError"], { code: "ECONNRESET" });
    expect(classifyException(reset)).toBe(Disposition.FAIL_FAST);
    // A plain error literally named "ConnectionError" must also not failover.
    expect(classifyException(namedError(["ConnectionError"]))).toBe(Disposition.FAIL_FAST);
  });
});

describe("classifyException — Bedrock / botocore shapes", () => {
  it("botocore status is read from the nested ResponseMetadata", () => {
    expect(classifyException({ response: { ResponseMetadata: { HTTPStatusCode: 429 } } })).toBe(
      Disposition.FAILOVER,
    );
    expect(classifyException({ response: { ResponseMetadata: { HTTPStatusCode: 400 } } })).toBe(
      Disposition.FAIL_FAST,
    );
    expect(classifyException({ response: { ResponseMetadata: { HTTPStatusCode: 500 } } })).toBe(
      Disposition.POST_SEND_AMBIGUOUS,
    );
  });

  it("Bedrock model names override a misleading 408/424 status", () => {
    // Once a request reaches the model, its failure is ambiguous rather than fail-fast.
    const modelTimeout = namedError(["ModelTimeoutException"], {
      response: { ResponseMetadata: { HTTPStatusCode: 408 } },
    });
    const modelError = namedError(["ModelErrorException"], {
      response: { ResponseMetadata: { HTTPStatusCode: 424 } },
    });
    expect(classifyException(modelTimeout)).toBe(Disposition.POST_SEND_AMBIGUOUS);
    expect(classifyException(modelError)).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });

  it("pre-send botocore names classify by name alone (no status)", () => {
    for (const n of ["EndpointConnectionError", "ConnectTimeoutError", "ProxyConnectionError"]) {
      expect(classifyException(namedError([n]))).toBe(Disposition.FAILOVER);
    }
    // ConnectionClosedError reached the model mid-flight → ambiguous.
    expect(classifyException(namedError(["ConnectionClosedError"]))).toBe(
      Disposition.POST_SEND_AMBIGUOUS,
    );
  });

  it("reads the AWS SDK v3 $metadata.httpStatusCode shape (smithy ServiceException)", () => {
    // The v3-only TS customer surface: @aws-sdk/client-bedrock-runtime throws exceptions whose
    // status lives ONLY at $metadata.httpStatusCode (no .status/.statusCode/.code) — mirror of
    // Cover the status shape exposed to Bedrock customers.
    const throttle = namedError(["ThrottlingException", "BedrockRuntimeServiceException"], {
      $metadata: { httpStatusCode: 429 },
    });
    const serviceUnavailable = namedError(["ServiceUnavailableException"], {
      $metadata: { httpStatusCode: 503 },
    });
    const internal = namedError(["InternalServerException"], {
      $metadata: { httpStatusCode: 500 },
    });
    const validation = namedError(["ValidationException"], {
      $metadata: { httpStatusCode: 400 },
    });
    expect(classifyException(throttle)).toBe(Disposition.FAILOVER);
    expect(classifyException(serviceUnavailable)).toBe(Disposition.POST_SEND_AMBIGUOUS);
    expect(classifyException(internal)).toBe(Disposition.POST_SEND_AMBIGUOUS);
    expect(classifyException(validation)).toBe(Disposition.FAIL_FAST);
  });
});

describe("classifyException — APIConnectionError cause CHAIN walk (openai/anthropic SDK-faithful)", () => {
  // The real openai/@anthropic-ai npm SDKs wrap a fetch rejection as
  // APIConnectionError({ cause: TypeError("fetch failed") }) whose cause.cause is the Node
  // system error carrying the ECONN* code — the discriminating pre-send signal sits TWO links
  // below the wrapper, so a single-level cause read misclassifies a hard-down primary.
  function apiConnectionError(cause: unknown): Error {
    const err = new Error("Connection error.");
    err.name = "APIConnectionError";
    (err as { cause?: unknown }).cause = cause;
    return err;
  }
  function fetchFailed(cause: unknown): TypeError {
    const err = new TypeError("fetch failed");
    if (cause !== undefined) {
      (err as { cause?: unknown }).cause = cause;
    }
    return err;
  }
  function coded(code: string): Error {
    return Object.assign(new Error("system error"), { code });
  }

  it("fails over on a connection-refused chain (APIConnectionError → fetch failed → ECONNREFUSED)", () => {
    expect(classifyException(apiConnectionError(fetchFailed(coded("ECONNREFUSED"))))).toBe(
      Disposition.FAILOVER,
    );
  });

  it("fails over on DNS-failure chains (ENOTFOUND / EAI_AGAIN nested two levels deep)", () => {
    expect(classifyException(apiConnectionError(fetchFailed(coded("ENOTFOUND"))))).toBe(
      Disposition.FAILOVER,
    );
    expect(classifyException(apiConnectionError(fetchFailed(coded("EAI_AGAIN"))))).toBe(
      Disposition.FAILOVER,
    );
  });

  it("stays ambiguous on an ECONNRESET-only chain (a reset can fire post-send)", () => {
    expect(classifyException(apiConnectionError(fetchFailed(coded("ECONNRESET"))))).toBe(
      Disposition.POST_SEND_AMBIGUOUS,
    );
  });

  it("keeps a bare fetch-shaped TypeError cause ambiguous without transport proof", () => {
    expect(classifyException(apiConnectionError(fetchFailed(undefined)))).toBe(
      Disposition.POST_SEND_AMBIGUOUS,
    );
  });

  it("fails over on undici's explicit connect-timeout code", () => {
    expect(
      classifyException(apiConnectionError(fetchFailed(coded("UND_ERR_CONNECT_TIMEOUT")))),
    ).toBe(Disposition.FAILOVER);
  });

  it("descends into AggregateError.errors for the pre-send signal", () => {
    const agg = Object.assign(new Error("all failed"), {
      name: "AggregateError",
      errors: [coded("ENOTFOUND"), coded("ECONNREFUSED")],
    });
    // Both failed connections prove pre-send failure.
    expect(classifyException(apiConnectionError(agg))).toBe(Disposition.FAILOVER);
  });

  it("keeps mixed refusal/reset aggregates ambiguous", () => {
    const agg = new AggregateError([coded("ECONNRESET"), coded("ECONNREFUSED")]);
    expect(classifyException(apiConnectionError(agg))).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });

  it("is bounded — a deep/cyclic cause chain never hangs and defaults ambiguous", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a; // cycle
    expect(classifyException(apiConnectionError(a))).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });
});

describe("classifyException — APIConnectionError cause inspection", () => {
  it("a pre-send cause makes the wrapper failover", () => {
    const wrapper = namedError(["APIConnectionError", "APIError"], {
      cause: namedError(["ConnectError"]),
    });
    expect(classifyException(wrapper)).toBe(Disposition.FAILOVER);
  });

  it("a post-send (read-timeout) cause makes the wrapper ambiguous", () => {
    const wrapper = namedError(["APIConnectionError", "APIError"], {
      cause: namedError(["ReadTimeout"]),
    });
    expect(classifyException(wrapper)).toBe(Disposition.POST_SEND_AMBIGUOUS);
  });

  it("no inspectable cause makes the bare wrapper failover", () => {
    const wrapper = namedError(["APIConnectionError", "APIError"]);
    expect(classifyException(wrapper)).toBe(Disposition.FAILOVER);
  });
});

// ---------------------------------------------------------------------------
// retryAfterSeconds.
// ---------------------------------------------------------------------------

describe("retryAfterSeconds", () => {
  it("returns the delta-seconds for a 429 with an integer Retry-After", () => {
    // Sanity check: status 429 with Retry-After "2" produces 2 seconds.
    expect(retryAfterSeconds({ status: 429, headers: { "retry-after": "2" } })).toBe(2);
    expect(retryAfterSeconds({ status: 429, headers: { "retry-after": "0" } })).toBe(0);
  });

  it("only fires for status EXACTLY 429 (never 529 or any other, even with a header)", () => {
    expect(retryAfterSeconds({ status: 529, headers: { "retry-after": "2" } })).toBeNull();
    expect(retryAfterSeconds({ status: 500, headers: { "retry-after": "2" } })).toBeNull();
    expect(retryAfterSeconds({ status: 429 })).toBeNull();
  });

  it("reads response.headers case-insensitively (fetch Headers + plain dict)", () => {
    expect(retryAfterSeconds({ status: 429, response: { headers: { "Retry-After": "5" } } })).toBe(
      5,
    );
    expect(retryAfterSeconds({ status: 429, headers: { "RETRY-AFTER": "7" } })).toBe(7);
    const fetchHeaders = new Headers({ "retry-after": "9" });
    expect(retryAfterSeconds({ status: 429, response: { headers: fetchHeaders } })).toBe(9);
  });

  it("reads the botocore nested HTTPHeaders shape", () => {
    const exc = {
      response: { ResponseMetadata: { HTTPStatusCode: 429, HTTPHeaders: { "retry-after": "3" } } },
    };
    expect(retryAfterSeconds(exc)).toBe(3);
  });

  it("reads the AWS SDK v3 $metadata.httpStatusCode + $response.headers shape", () => {
    // A v3 ThrottlingException carries its 429 at $metadata.httpStatusCode and its headers on the
    // smithy $response.headers (plain lowercased-key object) — the shape a TS Bedrock customer
    // sees. Without both reads, same-provider 429 retry is inoperative for Bedrock.
    const exc = {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
      $response: { headers: { "retry-after": "4" } },
    };
    expect(retryAfterSeconds(exc)).toBe(4);
  });

  it("reads a Map header carrier case-insensitively (Retry-After casing)", () => {
    // A wrapped client / middleware may surface headers as a `Map` with canonical casing. `Map.get`
    // is case-SENSITIVE, so the lookup must iterate the Map — never fall into the generic `.get`
    // fast-path (which would silently miss `"Retry-After"` and skip the same-provider retry).
    expect(
      retryAfterSeconds({ status: 429, response: { headers: new Map([["Retry-After", "5"]]) } }),
    ).toBe(5);
    expect(retryAfterSeconds({ status: 429, headers: new Map([["RETRY-AFTER", "8"]]) })).toBe(8);
  });

  it("rejects non-unsigned-integer delta forms", () => {
    for (const v of ["-1", "2.5", "+2", "1e3", "inf", "abc", ""]) {
      expect(retryAfterSeconds({ status: 429, headers: { "retry-after": v } })).toBeNull();
    }
  });

  it("clamps a past HTTP-date to 0.0 and never negative", () => {
    expect(
      retryAfterSeconds({
        status: 429,
        headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
      }),
    ).toBe(0);
  });

  it("returns a positive delay for a future HTTP-date", () => {
    const delay = retryAfterSeconds({
      status: 429,
      headers: { "retry-after": "Wed, 21 Oct 2099 07:28:00 GMT" },
    });
    expect(delay).not.toBeNull();
    expect(delay as number).toBeGreaterThan(0);
  });

  it("swallows a throwing headers accessor and returns null (never masks the exception)", () => {
    const exc: Record<string, unknown> = { status: 429 };
    Object.defineProperty(exc, "headers", {
      get() {
        throw new Error("accessor blew up");
      },
    });
    expect(retryAfterSeconds(exc)).toBeNull();
  });

  it("returns null when there is no Retry-After header at all", () => {
    expect(retryAfterSeconds({ status: 429, headers: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LatencyTracker — recordLatency + observedP50.
// ---------------------------------------------------------------------------

describe("LatencyTracker", () => {
  it("returns null below the minimum sample count and for unknown providers", () => {
    const t = new LatencyTracker();
    expect(t.observedP50("unseen")).toBeNull();
    t.recordLatency("p", 100);
    t.recordLatency("p", 200);
    expect(t.observedP50("p")).toBeNull(); // only 2 samples < 3
  });

  it("returns the median above the threshold (odd and even counts)", () => {
    const odd = new LatencyTracker();
    for (const v of [30, 10, 20]) odd.recordLatency("p", v);
    expect(odd.observedP50("p")).toBe(20); // median of {10,20,30}

    const even = new LatencyTracker();
    for (const v of [40, 10, 30, 20]) even.recordLatency("p", v);
    expect(even.observedP50("p")).toBe(25); // mean of two middle values 20,30
  });

  it("caps the rolling window at LATENCY_WINDOW, evicting oldest", () => {
    // The rolling window retains only the configured number of most recent samples.
    const t = new LatencyTracker();
    for (let i = 0; i < 60; i++) t.recordLatency("p", i);
    // Only the last 50 samples (10..59) survive; median of 10..59 = (34+35)/2 = 34.5.
    expect(t.observedP50("p")).toBe(34.5);
  });
});

// ---------------------------------------------------------------------------
// buildCandidate + defensive candidate filters.
// ---------------------------------------------------------------------------

describe("candidate helpers", () => {
  it("buildCandidate sets translatable=true and freezes the candidate", () => {
    // New candidates are translatable by default and immutable at runtime.
    const c = buildCandidate(
      runtime("openai"),
      { state: "half_open", recoveryEligible: false },
      42,
      7,
    );
    expect(c.translatable).toBe(true);
    expect(c.breakerState).toBe("half_open");
    expect(c.latencyP50).toBe(42);
    expect(c.priceHint).toBe(7);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("dropForeignCandidates keeps only reference-identical runtimes, preserving order", () => {
    // Foreign runtime identities are dropped while valid policy order is preserved.
    const rtA = runtime("a");
    const rtB = runtime("b");
    const foreign = runtime("a"); // same NAME, different reference
    const cands = [
      candidate({ runtime: rtB }),
      candidate({ runtime: foreign }),
      candidate({ runtime: rtA }),
    ];
    const kept = dropForeignCandidates(cands, [rtA, rtB]);
    expect(kept.map((c) => c.runtime)).toEqual([rtB, rtA]); // foreign dropped in place
  });

  it("sameProviderCandidates filters to one provider name, preserving order", () => {
    // `never` mode limits the walk to the same-provider subset.
    const cands = [
      candidate({ name: "openai" }),
      candidate({ name: "anthropic" }),
      candidate({ name: "openai" }),
    ];
    expect(names(sameProviderCandidates(cands, "openai"))).toEqual(["openai", "openai"]);
  });
});

// ---------------------------------------------------------------------------
// Dispatch-loop pure rule helpers (consumed by client.ts).
// ---------------------------------------------------------------------------

describe("Deadline + per-hop / budget timeouts", () => {
  it("replaceTotal rebases against the immutable original start instead of restarting time", () => {
    let t = 1_000;
    const deadline = new Deadline(30, () => t);
    t = 11_000;

    deadline.replaceTotal(15);
    expect(deadline.remaining()).toBe(5);

    t = 36_000;
    expect(deadline.remaining()).toBe(0);
    deadline.replaceTotal(40);
    expect(deadline.remaining()).toBe(5);
  });

  it("remaining() is never negative and expired() is remaining<=0", () => {
    let t = 0;
    const dl = new Deadline(1.0, () => t);
    expect(dl.remaining()).toBe(1);
    expect(dl.expired()).toBe(false);
    t = 2000; // 2s elapsed on a 1s budget
    expect(dl.remaining()).toBe(0);
    expect(dl.expired()).toBe(true);
  });

  it("hopTimeout divides the remaining budget across not-yet-attempted candidates", () => {
    const dl = new Deadline(30, () => 0); // remaining fixed at 30s
    expect(hopTimeout(dl, 1)).toBe(30); // min(30, max(1, 30/1))
    expect(hopTimeout(dl, 3)).toBe(10); // min(30, max(1, 30/3))
    expect(hopTimeout(dl, 60)).toBe(MIN_HOP_TIMEOUT); // floor wins: 30/60=0.5 → max(1, .5)=1
  });

  it("hopTimeout returns a tiny positive value on a spent deadline", () => {
    const spent = new Deadline(0, () => 0);
    expect(hopTimeout(spent, 3)).toBeCloseTo(0.001);
  });

  it("budgetCheckTimeout is capped by BUDGET_CHECK_TIMEOUT and the chain deadline, always > 0", () => {
    expect(budgetCheckTimeout(new Deadline(30, () => 0))).toBe(BUDGET_CHECK_TIMEOUT);
    expect(budgetCheckTimeout(new Deadline(2, () => 0))).toBe(BUDGET_CHECK_TIMEOUT);
    expect(budgetCheckTimeout(new Deadline(0, () => 0))).toBeCloseTo(0.001);
    expect(budgetCheckTimeout(new Deadline(30, () => 0), 0.25)).toBe(0.25);
    expect(budgetCheckTimeout(new Deadline(0.1, () => 0), 0.25)).toBe(0.1);
  });

  it("both timeouts stay within the same chain deadline for a tiny total", () => {
    const dl = new Deadline(0.5, () => 0); // remaining 0.5s
    expect(hopTimeout(dl, 3)).toBeLessThanOrEqual(dl.remaining());
    expect(budgetCheckTimeout(dl)).toBeLessThanOrEqual(dl.remaining());
    expect(hopTimeout(dl, 3)).toBeGreaterThan(0);
    expect(budgetCheckTimeout(dl)).toBeGreaterThan(0);
  });
});

describe("same-provider retry margin (#19, inclusive <=)", () => {
  it("a delay that exactly fits the remaining budget plus the floor still retries", () => {
    // Retry-After 4 plus the one-second margin exactly fits a five-second window.
    const dl = new Deadline(5, () => 0);
    expect(retryFitsWithinDeadline(4, dl)).toBe(true);
  });

  it("one second more than the exact margin skips the retry", () => {
    // Retry-After 5 plus the margin exceeds a five-second window.
    const dl = new Deadline(5, () => 0);
    expect(retryFitsWithinDeadline(5, dl)).toBe(false);
  });
});

describe("disposition → breaker verdict (#22)", () => {
  it("FAILOVER and POST_SEND_AMBIGUOUS count as a health signal; FAIL_FAST never does", () => {
    expect(dispositionCountsAsBreakerFailure(Disposition.FAILOVER)).toBe(true);
    expect(dispositionCountsAsBreakerFailure(Disposition.POST_SEND_AMBIGUOUS)).toBe(true);
    expect(dispositionCountsAsBreakerFailure(Disposition.FAIL_FAST)).toBe(false);
  });
});

describe("idempotency-mode resolution (#23)", () => {
  it("an explicit per-call boolean override wins over the client-level config", () => {
    // Per-call true selects always; false selects safe.
    expect(resolveIdempotencyMode(true, "safe")).toBe("always");
    expect(resolveIdempotencyMode(false, "always")).toBe("safe");
    expect(resolveIdempotencyMode(true, "never")).toBe("always");
  });

  it("absent an override, the client-level setting applies (default safe)", () => {
    expect(resolveIdempotencyMode(undefined, "safe")).toBe("safe");
    expect(resolveIdempotencyMode(undefined, "always")).toBe("always");
    expect(resolveIdempotencyMode(undefined, "never")).toBe("never");
  });

  it("only 'always' allows a POST_SEND_AMBIGUOUS failure to cross providers", () => {
    // possiblySucceeded is true only for an ambiguous failure that cannot fail over.
    expect(ambiguousFailoverAllowed("always")).toBe(true);
    expect(ambiguousFailoverAllowed("safe")).toBe(false);
    expect(ambiguousFailoverAllowed("never")).toBe(false);
  });
});
