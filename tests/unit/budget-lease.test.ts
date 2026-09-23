import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, type BudgetEnforcerOptions } from "../../src/budget";
import {
  CircuitBreaker,
  type CircuitBreakerAdmission,
  type CircuitBreakerOptions,
} from "../../src/circuit-breaker";
import { ConfigurationError } from "../../src/errors";
import type { LeaseLedger, LeaseState } from "../../src/lease";
import type { Logger } from "../../src/logging";
import { resetRunControlForTest, runTermination } from "../../src/run-control";
import { createTokenDetails, zeroTokenDetails } from "../../src/token-details";
import { TransportNetworkError } from "../../src/transport";
import type { BudgetCheckResponse, LeaseGrantResponse } from "../../src/types";
import { serializeBudgetConfirmRequest } from "../../src/validation";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const LEASE_URL = `${API_URL}/api/v1/budgets/lease`;
const RENEW_URL = `${API_URL}/api/v1/budgets/lease/renew`;
const SURRENDER_URL = `${API_URL}/api/v1/budgets/lease/surrender`;
const CHECK_URL = `${API_URL}/api/v1/budgets/check`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;
const MALFORMED_POSITIVE_OUTPUT_BOUNDS = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["fraction", 1.5],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ["boolean", true],
  ["numeric string", "512"],
] as const;

afterEach(() => {
  resetRunControlForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function callId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function grant(overrides: Partial<LeaseGrantResponse> = {}): LeaseGrantResponse {
  return {
    eligible: true,
    allowed: true,
    lease_id: "lease-1",
    generation: 1,
    granted_tokens: 15_000,
    refresh_interval_s: 300,
    lease_length_s: 600,
    headroom_share_tokens: 5_000,
    posture: { mode: "alert_only", on_unreachable: "fail_open" },
    final_grant: false,
    project_id: PROJECT_ID,
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 20,
    remaining_budget: 80,
    ...overrides,
  };
}

function leaseDenial(overrides: Partial<LeaseGrantResponse> = {}): LeaseGrantResponse {
  return grant({
    allowed: false,
    lease_id: null,
    generation: null,
    granted_tokens: null,
    refresh_interval_s: null,
    lease_length_s: null,
    headroom_share_tokens: null,
    posture: null,
    ...overrides,
  });
}

function checkResponse(overrides: Partial<BudgetCheckResponse> = {}): BudgetCheckResponse {
  return {
    allowed: true,
    remaining_budget: 70,
    reservation_id: "reservation-check",
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 30,
    denied_by_period: null,
    project_id: PROJECT_ID,
    price_hints: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushUntil(predicate: () => boolean, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) {
    await Promise.resolve();
  }
}

function leaseCheck(
  index: number,
  overrides: Partial<Parameters<BudgetEnforcer["checkBudget"]>[0]> = {},
): Parameters<BudgetEnforcer["checkBudget"]>[0] {
  return {
    callId: callId(index),
    estimatedInputTokens: 100,
    estimatedOutputBound: 500,
    model: "gpt-5.5",
    provider: "openai",
    fallbackProviders: ["anthropic"],
    fallbackModels: ["claude-opus-4"],
    agentRunId: "run_lease",
    ...overrides,
  };
}

function enforcer(
  fetch: NonNullable<BudgetEnforcerOptions["fetch"]>,
  overrides: Partial<BudgetEnforcerOptions> = {},
): BudgetEnforcer {
  return new BudgetEnforcer({
    apiUrl: API_URL,
    apiKey: API_KEY,
    fetch,
    leaseEnabled: true,
    holderId: "sdk-instance-1",
    ...overrides,
  });
}

function leaseState(value: BudgetEnforcer, runId = "run_lease"): LeaseState | null {
  const internal = value as unknown as { leaseLedger: LeaseLedger };
  return internal.leaseLedger.stateFor(runId);
}

class CountingBreaker extends CircuitBreaker {
  successes = 0;
  failures = 0;
  releases = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    super(options);
  }

  override recordSuccess(): void {
    this.successes += 1;
    super.recordSuccess();
  }

  override recordFailure(): void {
    this.failures += 1;
    super.recordFailure();
  }

  override releaseProbe(admission?: CircuitBreakerAdmission | null): void {
    this.releases += 1;
    super.releaseProbe(admission);
  }
}

describe("BudgetEnforcer lease grant and synchronous admission", () => {
  it("enables leases by default at the low-level constructor", async () => {
    const urls: string[] = [];
    const budget = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      holderId: "sdk-default-holder",
      fetch: async (url) => {
        urls.push(url);
        return jsonResponse(grant());
      },
    });

    const result = await budget.checkBudget(leaseCheck(1));

    expect(urls[0]).toBe(LEASE_URL);
    expect(result.leaseId).toBe("lease-1");
  });

  it("bypasses live lease authority for a tagged run and posts tags only to the check body", async () => {
    // Mutation caught: admitting this call from a live lease would skip the check POST
    // and would risk extending tags into lease identity or grant payloads.
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const budget = enforcer(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (url === LEASE_URL) return jsonResponse(grant());
      return jsonResponse(checkResponse());
    });

    await budget.checkBudget(leaseCheck(1, { tags: null }));
    const tagged = await budget.checkBudget(
      leaseCheck(2, { tags: { customer: "acme", environment: "test" } }),
    );

    expect(tagged).toMatchObject({ reservationId: "reservation-check", leaseId: null });
    expect(seen.map(({ url }) => url)).toEqual([LEASE_URL, CHECK_URL]);
    expect(seen[0]?.body).not.toHaveProperty("tags");
    expect(seen[1]?.body).toMatchObject({
      tags: { customer: "acme", environment: "test" },
      agent_run_id: "run_lease",
    });
    expect(seen[1]?.body).not.toHaveProperty("lease_id");
  });

  it("treats explicit empty tags as tagged after a run already holds a live lease", async () => {
    // Mutation caught: truthiness-based tag detection would admit `{}` from the live
    // lease and skip the selector-aware check endpoint entirely.
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const budget = enforcer(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (url === LEASE_URL) return jsonResponse(grant());
      return jsonResponse(checkResponse());
    });

    await budget.checkBudget(leaseCheck(10));
    const emptyTagged = await budget.checkBudget(leaseCheck(11, { tags: {} }));

    expect(emptyTagged).toMatchObject({ reservationId: "reservation-check", leaseId: null });
    expect(seen.map(({ url }) => url)).toEqual([LEASE_URL, CHECK_URL]);
    expect(seen[1]?.body).toHaveProperty("tags");
    expect(seen[1]?.body["tags"]).toEqual({});
    expect(seen[1]?.body["agent_run_id"]).toBe("run_lease");
    expect(seen[1]?.body).not.toHaveProperty("lease_id");
  });

  it.each([
    ["string", "oops"],
    ["array", ["oops"]],
  ] as const)("rejects malformed runtime %s tags before a live lease or control-plane check can mutate", async (_label, tags) => {
    // Mutation caught: spreading an untyped string before schema validation turns it
    // into numeric tag keys and lets this call reach the check endpoint.
    const urls: string[] = [];
    const budget = enforcer(async (url) => {
      urls.push(url);
      if (url === LEASE_URL) return jsonResponse(grant());
      return jsonResponse(checkResponse());
    });
    await budget.checkBudget(leaseCheck(1));
    const before = leaseState(budget);
    const malformed = {
      ...leaseCheck(2),
      tags,
    } as unknown as Parameters<BudgetEnforcer["checkBudget"]>[0];

    await expect(budget.checkBudget(malformed)).rejects.toEqual(
      new ConfigurationError("invalid tags", { field: "tags" }),
    );
    expect(urls).toEqual([LEASE_URL]);
    expect(leaseState(budget)).toBe(before);
    expect(leaseState(budget)?.reservations.has(callId(2))).toBe(false);
  });

  it("posts the literal grant request and returns the exact first local result", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const budget = enforcer(async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse(grant());
    });

    await expect(
      budget.checkBudget(
        leaseCheck(1, { estimatedInputTokens: 100, estimatedOutputBound: undefined }),
      ),
    ).resolves.toEqual({
      allowed: true,
      remainingBudget: 80,
      projectId: PROJECT_ID,
      reservationId: null,
      leaseId: "lease-1",
      leaseClaimToken: 1,
      mode: "alert_only",
      warning: null,
      budgetLimit: 100,
      currentUsage: 20,
      priceHints: null,
      failoverTuningAllowed: null,
      deniedByPeriod: null,
      denySource: null,
      denyReason: null,
    });
    expect(seen).toEqual([
      {
        url: LEASE_URL,
        body: {
          agent_run_id: "run_lease",
          holder_id: "sdk-instance-1",
          model: "gpt-5.5",
          provider: "openai",
          fallback_providers: ["anthropic"],
          fallback_models: ["claude-opus-4"],
          fail_open: true,
          estimated_input_tokens: 100,
          run_directive_version: "1",
        },
      },
    ]);
  });

  it("uses one grant and one off-path renewal for ten 1,500-token admissions", async () => {
    const urls: string[] = [];
    const budget = enforcer(async (url) => {
      urls.push(url);
      if (url === LEASE_URL) return jsonResponse(grant());
      return jsonResponse(checkResponse({ reservation_id: "reservation-11" }));
    });

    const results = [];
    for (let index = 1; index <= 11; index += 1) {
      results.push(
        await budget.checkBudget(
          leaseCheck(index, { estimatedInputTokens: 0, estimatedOutputBound: 1_500 }),
        ),
      );
    }

    expect(urls).toEqual([LEASE_URL, RENEW_URL, CHECK_URL]);
    expect(results.slice(0, 10).map((result) => result.leaseId)).toEqual(
      Array.from({ length: 10 }, () => "lease-1"),
    );
    expect(results[10]).toMatchObject({
      reservationId: "reservation-11",
      leaseId: null,
      leaseClaimToken: 11,
    });
  });

  it("validates call IDs only after the lease gate and before claiming authority", async () => {
    const fetch = vi.fn(async (url: string) =>
      url === LEASE_URL ? jsonResponse(grant()) : jsonResponse(checkResponse()),
    );
    const budget = enforcer(fetch);

    await expect(budget.checkBudget(leaseCheck(1, { callId: "not-a-uuid" }))).rejects.toEqual(
      new ConfigurationError("invalid call_id", { field: "call_id" }),
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(budget.checkBudget(leaseCheck(2))).resolves.toMatchObject({
      leaseClaimToken: 1,
    });

    const bypasses: Array<Partial<BudgetEnforcerOptions> & { check: Record<string, unknown> }> = [
      { leaseEnabled: false, check: { agentRunId: "run_lease" } },
      { check: {} },
      { check: { agentRunId: "run_lease", modality: "image" } },
      {
        check: { agentRunId: "run_lease", estimatedMedia: { image_count: 1 } },
      },
      { terminationFor: () => ({ reason: "later" }), check: { agentRunId: "run_lease" } },
      {
        terminationFor: () => {
          throw new Error("termination reader unavailable");
        },
        check: { agentRunId: "run_lease" },
      },
    ];
    for (const bypass of bypasses) {
      const isolatedFetch = vi.fn(async () => jsonResponse(checkResponse()));
      const isolated = enforcer(isolatedFetch, bypass);
      await expect(
        isolated.checkBudget({
          callId: "not-a-uuid",
          estimatedInputTokens: 1,
          model: "gpt-5.5",
          provider: "openai",
          ...bypass.check,
        }),
      ).resolves.toMatchObject({ reservationId: "reservation-check", leaseClaimToken: null });
      expect(isolatedFetch).toHaveBeenCalledOnce();
    }
  });

  it("retries a 503 grant refusal at the inclusive 30-second floor", async () => {
    let now = 0;
    const urls: string[] = [];
    const budget = enforcer(
      async (url) => {
        urls.push(url);
        return url === LEASE_URL
          ? new Response(null, { status: 503 })
          : jsonResponse(checkResponse());
      },
      { monotonicNow: () => now },
    );

    await budget.checkBudget(leaseCheck(1));
    now = 29_999;
    await budget.checkBudget(leaseCheck(2));
    now = 30_000;
    await budget.checkBudget(leaseCheck(3));

    expect(urls).toEqual([LEASE_URL, CHECK_URL, CHECK_URL, LEASE_URL, CHECK_URL]);
  });

  it("makes a 409 holder-cap refusal permanently ineligible", async () => {
    let now = 0;
    const urls: string[] = [];
    const budget = enforcer(
      async (url) => {
        urls.push(url);
        return url === LEASE_URL
          ? new Response(null, { status: 409 })
          : jsonResponse(checkResponse());
      },
      { monotonicNow: () => now },
    );

    await budget.checkBudget(leaseCheck(1));
    now = Number.MAX_SAFE_INTEGER;
    await budget.checkBudget(leaseCheck(2));
    expect(urls).toEqual([LEASE_URL, CHECK_URL, CHECK_URL]);
  });

  it.each([
    ["65-character lease ID", () => jsonResponse(grant({ lease_id: "x".repeat(65) }))],
    ["invalid JSON", () => new Response("not json", { status: 200 })],
    ["strict extra response key", () => jsonResponse({ ...grant(), extra: true })],
  ])("degrades %s and suppresses repeat grants for 30 seconds", async (_name, response) => {
    let now = 0;
    const urls: string[] = [];
    const budget = enforcer(
      async (url) => {
        urls.push(url);
        return url === LEASE_URL ? response() : jsonResponse(checkResponse());
      },
      { monotonicNow: () => now },
    );

    await budget.checkBudget(leaseCheck(1));
    now = 29_999;
    await budget.checkBudget(leaseCheck(2));
    expect(urls).toEqual([LEASE_URL, CHECK_URL, CHECK_URL]);
    expect(leaseState(budget)?.leaseId).toBeNull();
  });

  it.each([
    ["applied 200", () => jsonResponse(grant()), [1, 0, 1]],
    ["503 then check 200", () => new Response(null, { status: 503 }), [2, 0, 2]],
    ["malformed 2xx then check 200", () => jsonResponse({ ...grant(), extra: true }), [2, 0, 2]],
    ["non-503 500", () => new Response(null, { status: 500 }), [0, 1, 1]],
  ] as const)("scores and releases the shared breaker for %s", async (_name, response, expected) => {
    const breaker = new CountingBreaker();
    const urls: string[] = [];
    const budget = enforcer(
      async (url) => {
        urls.push(url);
        return url === LEASE_URL ? response() : jsonResponse(checkResponse());
      },
      { controlPlaneBreaker: breaker },
    );

    await budget.checkBudget(leaseCheck(1));
    expect([breaker.successes, breaker.failures, breaker.releases]).toEqual(expected);
    if (_name === "non-503 500") expect(urls).toEqual([LEASE_URL]);
  });

  it("releases the check breaker admission when the dispatch clock throws", async () => {
    const breaker = new CountingBreaker();
    const clockError = new Error("clock failed");
    const fetch = vi.fn(async () => jsonResponse(checkResponse()));
    const budget = enforcer(fetch, {
      controlPlaneBreaker: breaker,
      monotonicNow: () => {
        throw clockError;
      },
    });

    await expect(budget.checkBudget(leaseCheck(12, { tags: { customer: "acme" } }))).rejects.toBe(
      clockError,
    );
    expect(breaker.releases).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [true, true, "Cloud API unreachable; proceeding in fail-open mode", null, null],
    [
      false,
      false,
      "Cloud unreachable and no prior budget limit known; denying request (fail-closed)",
      "local_enforcement",
      "no_prior_budget_limit",
    ],
  ])("retains the claim on non-503 outage when failOpen=%s", async (failOpen, allowed, warning, denySource, denyReason) => {
    const budget = enforcer(async () => new Response(null, { status: 500 }), { failOpen });
    await expect(budget.checkBudget(leaseCheck(1))).resolves.toEqual({
      allowed,
      remainingBudget: 0,
      projectId: null,
      reservationId: null,
      leaseId: null,
      leaseClaimToken: 1,
      mode: "alert_only",
      warning,
      budgetLimit: 0,
      currentUsage: 0,
      priceHints: null,
      failoverTuningAllowed: null,
      deniedByPeriod: null,
      denySource,
      denyReason,
    });
  });

  it.each([
    [
      "caller-named transport error",
      () => {
        const value = new TransportNetworkError("caller-private-message");
        value.name = "caller-private-error-name";
        return value;
      },
    ],
    [
      "throwing transport error name getter",
      () => {
        const value = new TransportNetworkError("caller-private-message");
        Object.defineProperty(value, "name", {
          get: () => {
            throw new Error("caller-private-getter-message");
          },
        });
        return value;
      },
    ],
    ["null-prototype rejection", () => Object.create(null) as unknown],
    [
      "throwing constructor getter",
      () => {
        const value = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(value, "constructor", {
          get: () => {
            throw new Error("caller-private-constructor-message");
          },
        });
        return value;
      },
    ],
  ])("keeps grant outage diagnostics fixed for a %s", async (_name, rejection) => {
    const warnings: Array<{ message: string; args: unknown[] }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message, ...args) => warnings.push({ message, args }),
      error: () => {},
    };
    const budget = enforcer(
      async () => {
        throw rejection();
      },
      { failOpen: true, logger },
    );

    await expect(budget.checkBudget(leaseCheck(1))).resolves.toMatchObject({
      allowed: true,
      leaseClaimToken: 1,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    expect(warnings[0]).toEqual({
      message: "lease.grant_failed: control_plane_unreachable",
      args: [],
    });
    expect(JSON.stringify(warnings)).not.toContain("caller-private");
  });

  it("lets a grant loser check immediately and makes the older grant recheck its tombstone", async () => {
    let resolveGrant!: (response: Response) => void;
    const pendingGrant = new Promise<Response>((resolve) => {
      resolveGrant = resolve;
    });
    const urls: string[] = [];
    const budget = enforcer(async (url) => {
      urls.push(url);
      return url === LEASE_URL ? pendingGrant : jsonResponse(checkResponse());
    });

    const first = budget.checkBudget(leaseCheck(1));
    await expect(budget.checkBudget(leaseCheck(2))).resolves.toMatchObject({
      reservationId: "reservation-check",
      leaseClaimToken: 2,
    });
    expect(urls).toEqual([LEASE_URL, CHECK_URL]);
    resolveGrant(jsonResponse(grant()));
    await expect(first).resolves.toMatchObject({
      reservationId: "reservation-check",
      leaseId: null,
      leaseClaimToken: 1,
    });
    expect(urls.filter((url) => url === CHECK_URL)).toHaveLength(2);
    expect(urls).toContain(SURRENDER_URL);
  });

  it("re-enters on an occupied HALF_OPEN probe and preserves exhausted hard-deny authority", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 0 });
    const fetch = vi.fn(async (url: string) =>
      url === LEASE_URL
        ? jsonResponse(
            grant({
              granted_tokens: 0,
              headroom_share_tokens: 0,
              mode: "hard_deny",
              posture: { mode: "hard_deny", on_unreachable: "local_enforce" },
            }),
          )
        : jsonResponse(checkResponse()),
    );
    const budget = enforcer(fetch, { controlPlaneBreaker: breaker });
    await budget.checkBudget(leaseCheck(1, { estimatedInputTokens: 0, estimatedOutputBound: 100 }));
    breaker.recordFailure();
    expect(breaker.admit().allowed).toBe(true);
    fetch.mockClear();

    await expect(
      budget.checkBudget(leaseCheck(2, { estimatedInputTokens: 0, estimatedOutputBound: 100 })),
    ).resolves.toMatchObject({
      allowed: false,
      leaseId: null,
      leaseClaimToken: 2,
      deniedByPeriod: "agent_run",
      denySource: "lease_exhausted",
      denyReason: "lease_share_exhausted",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surrenders an older grant allow instead of weakening a newer tagged project denial", async () => {
    // Mutation caught: a grant allow must carry its dispatch epoch; treating its late
    // response as current installs stale lease authority and clears the project deny.
    let now = 10;
    const grantResponse = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "monthly",
              }),
            );
          }
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(33));
    now = 20;
    await expect(
      budget.checkBudget(leaseCheck(34, { tags: { customer: "acme" } })),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    now = 30;
    grantResponse.resolve(jsonResponse(grant()));
    const delayedGrant = await pendingGrant;
    const outage = await budget.checkBudget(
      leaseCheck(35, { agentRunId: undefined, model: "outage-after-stale-grant" }),
    );
    await flushUntil(() => surrenders.length === 1);

    expect(delayedGrant).toMatchObject({
      allowed: false,
      leaseId: null,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    expect(outage).toMatchObject({
      allowed: false,
      leaseId: null,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
    expect(leaseState(budget)).toBeNull();
    expect(surrenders).toEqual([
      {
        lease_id: "lease-1",
        holder_id: "sdk-instance-1",
        generation: 1,
        spent_tokens: 0,
      },
    ]);
  });

  it("surrenders an older grant while a newer tagged project check is pending", async () => {
    // Mutation caught: comparing the newer check's request epoch with the older
    // grant's response-observation epoch lets the grant install and later masks the deny.
    let now = 10;
    const grantResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(45));
    now = 20;
    const pendingTagged = budget.checkBudget(leaseCheck(46, { tags: { customer: "acme" } }));
    now = 30;
    grantResponse.resolve(jsonResponse(grant()));
    await expect(pendingGrant).resolves.toMatchObject({
      allowed: true,
      leaseId: null,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    await flushUntil(() => surrenders.length === 1);
    expect(leaseState(budget)).toBeNull();
    expect(surrenders).toEqual([
      {
        lease_id: "lease-1",
        holder_id: "sdk-instance-1",
        generation: 1,
        spent_tokens: 0,
      },
    ]);

    now = 40;
    taggedResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(budget.checkBudget(leaseCheck(47))).resolves.toMatchObject({
      allowed: false,
      leaseId: null,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(51, { agentRunId: undefined, model: "outage-after-pending-check" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("surrenders a grant allow when a later pending check shares its clock value", async () => {
    const grantResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(64));
    const pendingTagged = budget.checkBudget(leaseCheck(65, { tags: { customer: "acme" } }));
    grantResponse.resolve(jsonResponse(grant()));
    await expect(pendingGrant).resolves.toMatchObject({
      allowed: true,
      leaseId: null,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    await flushUntil(() => surrenders.length === 1);
    expect(leaseState(budget)).toBeNull();
    expect(surrenders).toEqual([
      {
        lease_id: "lease-1",
        holder_id: "sdk-instance-1",
        generation: 1,
        spent_tokens: 0,
      },
    ]);

    taggedResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(budget.checkBudget(leaseCheck(66))).resolves.toMatchObject({
      allowed: false,
      leaseId: null,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("does not let an older pending check fence a later grant at the same clock value", async () => {
    const taggedResponse = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    let taggedStarted = false;
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            taggedStarted = true;
            return taggedResponse.promise;
          }
          throw new TypeError("offline");
        }
        if (url === LEASE_URL) return jsonResponse(grant());
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const olderTagged = budget.checkBudget(leaseCheck(67, { tags: { customer: "acme" } }));
    await flushUntil(() => taggedStarted);
    await expect(budget.checkBudget(leaseCheck(68))).resolves.toMatchObject({
      allowed: true,
      leaseId: "lease-1",
    });
    expect(leaseState(budget)).toMatchObject({ leaseId: "lease-1", generation: 1 });
    expect(surrenders).toEqual([]);

    taggedResponse.resolve(jsonResponse(checkResponse()));
    await expect(olderTagged).resolves.toMatchObject({ allowed: true, leaseId: null });
    await expect(budget.checkBudget(leaseCheck(69))).resolves.toMatchObject({
      allowed: true,
      leaseId: "lease-1",
    });
    expect(checkCalls).toBe(1);
  });

  it("keeps a pending-check-fenced grant surrendered when that check later fails", async () => {
    let now = 10;
    const olderGrant = deferred<Response>();
    const pendingCheck = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    let leaseCalls = 0;
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          leaseCalls += 1;
          return leaseCalls === 1
            ? olderGrant.promise
            : jsonResponse(grant({ lease_id: "lease-fresh" }));
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return pendingCheck.promise;
          if (checkCalls === 2) return jsonResponse(checkResponse());
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(48));
    now = 20;
    const failingTagged = budget.checkBudget(leaseCheck(49, { tags: { customer: "acme" } }));
    now = 30;
    olderGrant.resolve(jsonResponse(grant()));
    await expect(pendingGrant).resolves.toMatchObject({
      allowed: true,
      reservationId: "reservation-check",
      leaseId: null,
    });
    await flushUntil(() => surrenders.length === 1);
    expect(leaseState(budget)).toBeNull();

    now = 40;
    pendingCheck.reject(new TypeError("offline"));
    await expect(failingTagged).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    now = 50;
    await expect(budget.checkBudget(leaseCheck(50))).resolves.toMatchObject({
      allowed: true,
      leaseId: "lease-fresh",
    });
    expect(leaseCalls).toBe(2);
    expect(surrenders).toHaveLength(1);
  });

  it("lets a later tagged denial clear an older grant denial when clock values collide", async () => {
    const grantResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(52));
    const pendingTagged = budget.checkBudget(leaseCheck(53, { tags: { customer: "acme" } }));
    grantResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingGrant).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });

    taggedResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "tag",
        }),
      ),
    );
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "tag",
      denySource: "server",
    });
    expect(budget.hasStickyHardDeny).toBe(false);
    await expect(
      budget.checkBudget(
        leaseCheck(54, { agentRunId: undefined, model: "outage-after-pending-tag-clear" }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("retains an older grant denial when the newer pending check fails", async () => {
    let now = 10;
    const grantResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(58));
    now = 20;
    const pendingTagged = budget.checkBudget(leaseCheck(59, { tags: { customer: "acme" } }));
    now = 30;
    grantResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
          budget_limit: 120,
          current_usage: 119,
          remaining_budget: 1,
        }),
      ),
    );
    await expect(pendingGrant).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 120,
      currentUsage: 119,
    });

    now = 40;
    taggedResponse.reject(new TypeError("offline"));
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 120,
      currentUsage: 119,
    });
    await expect(
      budget.checkBudget(
        leaseCheck(60, { agentRunId: undefined, model: "outage-after-pending-check-failure" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 120,
      currentUsage: 119,
    });
  });

  it("retains an older grant denial when the newer check handles a matching directive", async () => {
    let now = 10;
    const grantResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(61));
    now = 20;
    const pendingTagged = budget.checkBudget(leaseCheck(62, { tags: { customer: "acme" } }));
    now = 30;
    grantResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingGrant).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });

    now = 40;
    taggedResponse.resolve(
      jsonResponse(
        checkResponse({
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run_lease",
            reason: "manual_kill",
          },
        }),
      ),
    );
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denyReason: "manual_kill",
      denySource: "server",
    });
    expect(runTermination("run_lease")).toMatchObject({
      reason: "manual_kill",
      source: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(63, { agentRunId: undefined, model: "outage-after-pending-directive" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("does not let an older grant denial resurrect authority after a newer tag tombstone", async () => {
    const grantResponse = deferred<Response>();
    let now = 10;
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "tag",
              }),
            );
          }
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(36));
    now = 20;
    await expect(
      budget.checkBudget(leaseCheck(37, { tags: { customer: "acme" } })),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "tag",
      denySource: "server",
    });
    now = 30;
    grantResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );

    await expect(pendingGrant).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    expect(budget.hasStickyHardDeny).toBe(false);
    await expect(
      budget.checkBudget(
        leaseCheck(38, { agentRunId: undefined, model: "outage-after-stale-grant-deny" }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("keeps later-dispatched project authority when an older grant denial resolves later", async () => {
    // Mutation caught: comparing the project's dispatch with the grant's later observation
    // lets an older grant replace authority merely because all run-clock values collide.
    const grantResponse = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "daily",
              }),
            );
          }
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(30));
    await budget.checkBudget(
      leaseCheck(31, { agentRunId: undefined, model: "equal-epoch-project-check" }),
    );
    grantResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );

    await expect(pendingGrant).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(32, { agentRunId: undefined, model: "outage-after-grant-denial" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "sticky_replay",
    });
  });

  it("keeps lease response-observation ordering when clock values collide", async () => {
    // The dispatch fence is for newer ordered check authority. A lease-created
    // tombstone must not suppress another lease response observed afterward.
    const olderGrant = deferred<Response>();
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          if (body.agent_run_id === "run-older") return olderGrant.promise;
          return jsonResponse(grant({ lease_id: "lease-newer" }));
        }
        if (url === CHECK_URL) throw new TypeError("offline");
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const pendingOlder = budget.checkBudget(leaseCheck(39, { agentRunId: "run-older" }));
    await expect(
      budget.checkBudget(leaseCheck(40, { agentRunId: "run-newer" })),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-newer" });
    olderGrant.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );

    await expect(pendingOlder).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(41, { agentRunId: undefined, model: "outage-after-later-lease-denial" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("keeps the latest lease dispatch fence when an older dispatch wins payload observation", async () => {
    // Mutation caught: replacing the complete lease authority stamp when a response
    // wins observation order loses a newer lease dispatch that must still fence B.
    const olderGrant = deferred<Response>();
    const newerGrant = deferred<Response>();
    const orderedAllow = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          return body.agent_run_id === "run-older" ? olderGrant.promise : newerGrant.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return orderedAllow.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const pendingOlder = budget.checkBudget(
      leaseCheck(73, { agentRunId: "run-older", model: "older-grant" }),
    );
    const pendingOrdered = budget.checkBudget(
      leaseCheck(74, {
        agentRunId: undefined,
        model: "middle-ordered-allow",
        tags: { customer: "acme" },
      }),
    );
    const pendingNewer = budget.checkBudget(
      leaseCheck(75, { agentRunId: "run-newer", model: "newer-grant" }),
    );

    newerGrant.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "daily",
        }),
      ),
    );
    await expect(pendingNewer).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "server",
    });

    olderGrant.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingOlder).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });

    orderedAllow.resolve(jsonResponse(checkResponse()));
    await expect(pendingOrdered).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(76, { agentRunId: undefined, model: "outage-after-dispatch-fence-cycle" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it.each([
    ["allow", 980, checkResponse(), { allowed: true, deniedByPeriod: null }],
    [
      "project denial",
      984,
      checkResponse({ allowed: false, mode: "hard_deny", denied_by_period: "daily" }),
      { allowed: false, deniedByPeriod: "daily" },
    ],
  ] as const)("does not let a rejected ordered %s suppress an older grant denial", async (_label, baseCallId, middleResponse, expectedMiddle) => {
    // Mutation caught: a completed-ordered watermark must describe accepted global
    // authority, not every ordered response that reaches a lease tombstone.
    const olderGrant = deferred<Response>();
    const middleOrdered = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          if (body.agent_run_id === "run-inverse-older") return olderGrant.promise;
          return jsonResponse(grant({ lease_id: "lease-inverse-newer" }));
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return middleOrdered.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const pendingOlder = budget.checkBudget(
      leaseCheck(baseCallId, {
        agentRunId: "run-inverse-older",
        model: "inverse-older-grant",
      }),
    );
    const pendingMiddle = budget.checkBudget(
      leaseCheck(baseCallId + 1, {
        agentRunId: undefined,
        model: "inverse-middle-ordered",
        tags: { customer: "acme" },
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(baseCallId + 2, {
          agentRunId: "run-inverse-newer",
          model: "inverse-newer-grant",
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-inverse-newer" });

    middleOrdered.resolve(jsonResponse(middleResponse));
    await expect(pendingMiddle).resolves.toMatchObject(expectedMiddle);

    olderGrant.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingOlder).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(baseCallId + 3, {
          agentRunId: undefined,
          model: "outage-after-rejected-ordered-authority",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it.each([
    "agent_run",
    "run_stopped",
  ] as const)("carries a no-run %s fallback dispatch through an older grant denial", async (fallbackPeriod) => {
    // Mutation caught: replacing weak fallback payload with a lease denial must
    // retain the fallback's dispatch fence for still-pending ordered work.
    const olderGrant = deferred<Response>();
    const middleOrdered = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          if (body.agent_run_id === "run-fallback-bridge-older") {
            return olderGrant.promise;
          }
          return jsonResponse(grant({ lease_id: "lease-fallback-bridge-newer" }));
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return middleOrdered.promise;
          if (checkCalls === 2) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: fallbackPeriod,
              }),
            );
          }
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );
    const baseCallId = fallbackPeriod === "agent_run" ? 1_000 : 1_005;

    const pendingOlder = budget.checkBudget(
      leaseCheck(baseCallId, {
        agentRunId: "run-fallback-bridge-older",
        model: "fallback-bridge-older-grant",
      }),
    );
    const pendingMiddle = budget.checkBudget(
      leaseCheck(baseCallId + 1, {
        agentRunId: undefined,
        model: "fallback-bridge-middle-ordered",
        tags: { customer: "acme" },
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(baseCallId + 2, {
          agentRunId: "run-fallback-bridge-newer",
          model: "fallback-bridge-newer-grant",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      leaseId: "lease-fallback-bridge-newer",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(baseCallId + 3, {
          agentRunId: undefined,
          model: "fallback-bridge-no-run-fallback",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: fallbackPeriod,
      denySource: "server",
    });

    olderGrant.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingOlder).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });

    middleOrdered.resolve(jsonResponse(checkResponse()));
    await expect(pendingMiddle).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(baseCallId + 4, {
          agentRunId: undefined,
          model: "outage-after-grant-fallback-bridge",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it.each([
    "agent_run",
    "run_stopped",
  ] as const)("keeps a strong grant denial when a later no-run %s fallback fences an older grant allow", async (fallbackPeriod) => {
    // Mutation caught: skipping fallback authority while a strong sticky exists loses
    // its later dispatch barrier, letting the older pending grant allow clear enforcement.
    const olderGrantAllow = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          if (body.agent_run_id === "run-barrier-older-allow") return olderGrantAllow.promise;
          if (body.agent_run_id === "run-barrier-strong-denial") {
            return jsonResponse(
              leaseDenial({
                mode: "hard_deny",
                denied_by_period: "monthly",
                budget_limit: 120,
                current_usage: 119,
                remaining_budget: 1,
              }),
            );
          }
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: fallbackPeriod,
              }),
            );
          }
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) return new Response(null, { status: 204 });
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const pendingOlderAllow = budget.checkBudget(
      leaseCheck(1_010, {
        agentRunId: "run-barrier-older-allow",
        model: "barrier-older-grant-allow",
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(1_011, {
          agentRunId: "run-barrier-strong-denial",
          model: "barrier-strong-grant-denial",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 120,
      currentUsage: 119,
    });
    await expect(
      budget.checkBudget(
        leaseCheck(1_012, {
          agentRunId: undefined,
          model: "barrier-no-run-fallback",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: fallbackPeriod,
      denySource: "server",
    });
    expect(budget.hasStickyHardDeny).toBe(true);

    olderGrantAllow.resolve(jsonResponse(grant({ lease_id: "lease-barrier-older-allow" })));
    await pendingOlderAllow;
    const outage = await budget.checkBudget(
      leaseCheck(1_013, {
        agentRunId: undefined,
        model: "outage-after-strong-sticky-barrier",
      }),
    );

    expect({ hasStickyHardDeny: budget.hasStickyHardDeny, outage }).toMatchObject({
      hasStickyHardDeny: true,
      outage: {
        allowed: false,
        deniedByPeriod: "monthly",
        denySource: "sticky_replay",
        budgetLimit: 120,
        currentUsage: 119,
      },
    });
  });

  it("keeps a strong ordered denial when a later no-run fallback fences an older ordered allow", async () => {
    // Mutation caught: dropping the fallback barrier while preserving an existing
    // strong payload lets the earlier ordered allow clear that payload when it settles.
    const olderOrderedAllow = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url !== CHECK_URL) throw new Error("unexpected test URL");
        checkCalls += 1;
        if (checkCalls === 1) {
          return jsonResponse(
            checkResponse({
              allowed: false,
              mode: "hard_deny",
              denied_by_period: "monthly",
              budget_limit: 130,
              current_usage: 129,
              remaining_budget: 1,
            }),
          );
        }
        if (checkCalls === 2) return olderOrderedAllow.promise;
        if (checkCalls === 3) {
          return jsonResponse(
            checkResponse({
              allowed: false,
              mode: "hard_deny",
              denied_by_period: "agent_run",
            }),
          );
        }
        throw new TypeError("offline");
      },
      { monotonicNow: () => 10, failOpen: true, cacheTtl: 0 },
    );

    await expect(
      budget.checkBudget(
        leaseCheck(1_014, {
          agentRunId: undefined,
          model: "barrier-strong-ordered-denial",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 130,
      currentUsage: 129,
    });
    const pendingOlderAllow = budget.checkBudget(
      leaseCheck(1_015, {
        agentRunId: undefined,
        model: "barrier-older-ordered-allow",
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(1_016, {
          agentRunId: undefined,
          model: "barrier-later-no-run-fallback",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "server",
    });

    olderOrderedAllow.resolve(jsonResponse(checkResponse()));
    await expect(pendingOlderAllow).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 130,
      currentUsage: 129,
    });
    await expect(
      budget.checkBudget(
        leaseCheck(1_017, {
          agentRunId: undefined,
          model: "outage-after-ordered-strong-sticky-barrier",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 130,
      currentUsage: 129,
    });
  });

  it("keeps a strong payload through fallback fencing until an older lease denial replaces it", async () => {
    // Mutation caught: omitting the fallback barrier while retaining B lets O and A
    // clear B, while treating that barrier as strong prevents D from replacing it.
    const strongOrderedDenial = deferred<Response>();
    const leaseAllow = deferred<Response>();
    const leaseDenialResponse = deferred<Response>();
    const orderedAllow = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          if (body.agent_run_id === "run-barrier-lease-allow") return leaseAllow.promise;
          if (body.agent_run_id === "run-barrier-lease-denial") {
            return leaseDenialResponse.promise;
          }
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return strongOrderedDenial.promise;
          if (checkCalls === 2) return orderedAllow.promise;
          if (checkCalls === 3) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "agent_run",
              }),
            );
          }
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) return new Response(null, { status: 204 });
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true, cacheTtl: 0 },
    );

    const pendingStrongDenial = budget.checkBudget(
      leaseCheck(1_018, {
        agentRunId: undefined,
        model: "barrier-retained-strong-ordered-denial",
      }),
    );
    const pendingLeaseAllow = budget.checkBudget(
      leaseCheck(1_019, {
        agentRunId: "run-barrier-lease-allow",
        model: "barrier-older-lease-allow",
      }),
    );
    const pendingLeaseDenial = budget.checkBudget(
      leaseCheck(1_020, {
        agentRunId: "run-barrier-lease-denial",
        model: "barrier-older-lease-denial",
      }),
    );
    strongOrderedDenial.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "monthly",
          budget_limit: 140,
          current_usage: 139,
          remaining_budget: 1,
        }),
      ),
    );
    await expect(pendingStrongDenial).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 140,
      currentUsage: 139,
    });
    const pendingOrderedAllow = budget.checkBudget(
      leaseCheck(1_021, {
        agentRunId: undefined,
        model: "barrier-older-ordered-allow",
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(1_022, {
          agentRunId: undefined,
          model: "barrier-later-no-run-fallback",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "server",
    });

    orderedAllow.resolve(jsonResponse(checkResponse()));
    await expect(pendingOrderedAllow).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 140,
      currentUsage: 139,
    });
    leaseAllow.resolve(jsonResponse(grant({ lease_id: "lease-barrier-older-allow" })));
    await expect(pendingLeaseAllow).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 140,
      currentUsage: 139,
    });
    expect(budget.hasStickyHardDeny).toBe(true);

    leaseDenialResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "daily",
          budget_limit: 160,
          current_usage: 159,
          remaining_budget: 1,
        }),
      ),
    );
    await expect(pendingLeaseDenial).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "server",
      budgetLimit: 160,
      currentUsage: 159,
    });
    await expect(
      budget.checkBudget(
        leaseCheck(1_023, {
          agentRunId: undefined,
          model: "outage-after-fallback-barrier-replacement",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "daily",
      denySource: "sticky_replay",
      budgetLimit: 160,
      currentUsage: 159,
    });
  });

  it.each([
    "agent_run",
    "run_stopped",
  ] as const)("carries a no-run %s fallback through a denial to fence a second older grant allow", async (fallbackPeriod) => {
    // Mutation caught: once a lease denial replaces the weak fallback stamp, its
    // inherited dispatch watermark must still fence other pre-fallback lease allows.
    const olderGrantAllow = deferred<Response>();
    const olderGrantDenial = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          return body.agent_run_id === "run-transitive-barrier-allow"
            ? olderGrantAllow.promise
            : olderGrantDenial.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: fallbackPeriod,
              }),
            );
          }
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) return new Response(null, { status: 204 });
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true, cacheTtl: 0 },
    );

    const pendingAllow = budget.checkBudget(
      leaseCheck(1_024, {
        agentRunId: "run-transitive-barrier-allow",
        model: "transitive-barrier-older-allow",
      }),
    );
    const pendingDenial = budget.checkBudget(
      leaseCheck(1_025, {
        agentRunId: "run-transitive-barrier-denial",
        model: "transitive-barrier-older-denial",
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(1_026, {
          agentRunId: undefined,
          model: "transitive-barrier-no-run-fallback",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: fallbackPeriod,
      denySource: "server",
    });

    olderGrantDenial.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
          budget_limit: 170,
          current_usage: 169,
          remaining_budget: 1,
        }),
      ),
    );
    await expect(pendingDenial).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 170,
      currentUsage: 169,
    });

    olderGrantAllow.resolve(
      jsonResponse(
        grant({
          lease_id: "lease-transitive-barrier-allow",
          mode: "hard_deny",
          posture: { mode: "hard_deny", on_unreachable: "fail_open" },
        }),
      ),
    );
    await expect(pendingAllow).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 170,
      currentUsage: 169,
    });
    await expect(
      budget.checkBudget(
        leaseCheck(1_027, {
          agentRunId: undefined,
          model: "outage-after-transitive-fallback-barrier",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 170,
      currentUsage: 169,
    });
  });

  it.each([
    {
      label: "run-scoped denial",
      response: leaseDenial({ mode: "hard_deny", denied_by_period: "agent_run" }),
    },
    {
      label: "alert-only response",
      response: leaseDenial({ mode: "alert_only", denied_by_period: "monthly" }),
    },
  ])("carries a fallback through a project denial to fence an older $label global clear", async ({
    response,
  }) => {
    const olderGlobalClear = deferred<Response>();
    const olderProjectDenial = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          return body.agent_run_id === "run-transitive-clear"
            ? olderGlobalClear.promise
            : olderProjectDenial.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "agent_run",
              }),
            );
          }
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true, cacheTtl: 0 },
    );

    const pendingClear = budget.checkBudget(
      leaseCheck(1_034, {
        agentRunId: "run-transitive-clear",
        model: "transitive-barrier-older-global-clear",
      }),
    );
    const pendingProjectDenial = budget.checkBudget(
      leaseCheck(1_035, {
        agentRunId: "run-transitive-project-denial",
        model: "transitive-barrier-older-project-denial",
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(1_036, {
          agentRunId: undefined,
          model: "transitive-clear-no-run-fallback",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "server",
    });

    olderProjectDenial.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
          budget_limit: 190,
          current_usage: 189,
          remaining_budget: 1,
        }),
      ),
    );
    await expect(pendingProjectDenial).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 190,
      currentUsage: 189,
    });

    olderGlobalClear.resolve(jsonResponse(response));
    await expect(pendingClear).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
      budgetLimit: 190,
      currentUsage: 189,
    });
    await expect(
      budget.checkBudget(
        leaseCheck(1_037, {
          agentRunId: undefined,
          model: "outage-after-transitive-clear-fence",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 190,
      currentUsage: 189,
    });
  });

  it("lets a grant allow dispatched after a pending no-run fallback clear the barrier", async () => {
    const fallbackResponse = deferred<Response>();
    const newerGrantAllow = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) return newerGrantAllow.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return fallbackResponse.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true, cacheTtl: 0 },
    );

    const pendingFallback = budget.checkBudget(
      leaseCheck(1_028, {
        agentRunId: undefined,
        model: "pending-no-run-fallback-before-newer-grant",
      }),
    );
    const pendingNewerAllow = budget.checkBudget(
      leaseCheck(1_029, {
        agentRunId: "run-newer-than-fallback",
        model: "grant-allow-newer-than-fallback",
      }),
    );
    fallbackResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "agent_run",
        }),
      ),
    );
    await expect(pendingFallback).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "server",
    });

    newerGrantAllow.resolve(jsonResponse(grant({ lease_id: "lease-newer-than-fallback" })));
    await expect(pendingNewerAllow).resolves.toMatchObject({
      allowed: true,
      leaseId: "lease-newer-than-fallback",
    });
    expect(budget.hasStickyHardDeny).toBe(false);
    await expect(
      budget.checkBudget(
        leaseCheck(1_030, {
          agentRunId: undefined,
          model: "outage-after-newer-grant-clear",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("lets a later-observed lease allow clear an earlier-observed lease denial", async () => {
    const olderDenial = deferred<Response>();
    const newerAllow = deferred<Response>();
    let now = 10;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          return body.agent_run_id === "run-denied" ? olderDenial.promise : newerAllow.promise;
        }
        if (url === CHECK_URL) throw new TypeError("offline");
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    const denied = budget.checkBudget(leaseCheck(55, { agentRunId: "run-denied" }));
    now = 20;
    const allowed = budget.checkBudget(leaseCheck(56, { agentRunId: "run-allowed" }));
    now = 30;
    olderDenial.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(denied).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });

    now = 40;
    newerAllow.resolve(jsonResponse(grant({ lease_id: "lease-newer" })));
    await expect(allowed).resolves.toMatchObject({ allowed: true, leaseId: "lease-newer" });
    expect(leaseState(budget, "run-allowed")).toMatchObject({ leaseId: "lease-newer" });
    expect(budget.hasStickyHardDeny).toBe(false);
    await expect(
      budget.checkBudget(
        leaseCheck(57, { agentRunId: undefined, model: "outage-after-later-lease-allow" }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it.each([
    "agent_run",
    "run_stopped",
  ] as const)("does not let a no-run %s fallback fence an older lease denial", async (deniedByPeriod) => {
    const olderGrant = deferred<Response>();
    let now = 10;
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) return olderGrant.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: deniedByPeriod,
              }),
            );
          }
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(42, { agentRunId: "run-older" }));
    now = 20;
    await budget.checkBudget(
      leaseCheck(43, { agentRunId: undefined, model: "newer-no-run-stopped" }),
    );
    now = 30;
    olderGrant.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );

    await expect(pendingGrant).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(44, { agentRunId: undefined, model: "outage-after-no-run-fallback" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("keeps an observed lease clear ahead of a still-pending weak fallback", async () => {
    const grantResponse = deferred<Response>();
    const fallbackResponse = deferred<Response>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) return grantResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return fallbackResponse.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    const pendingGrant = budget.checkBudget(leaseCheck(70));
    const pendingFallback = budget.checkBudget(
      leaseCheck(71, { agentRunId: undefined, model: "pending-no-run-fallback" }),
    );
    grantResponse.resolve(
      jsonResponse(leaseDenial({ mode: "alert_only", denied_by_period: "monthly" })),
    );
    await expect(pendingGrant).resolves.toMatchObject({
      allowed: true,
      leaseId: null,
      mode: "alert_only",
    });

    fallbackResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "agent_run",
        }),
      ),
    );
    await expect(pendingFallback).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "server",
    });
    expect(budget.hasStickyHardDeny).toBe(false);
    await expect(
      budget.checkBudget(
        leaseCheck(72, { agentRunId: undefined, model: "outage-after-weak-fallback" }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("files a hard grant denial as run sticky and bypasses lease authority on replay", async () => {
    let attempts = 0;
    const urls: string[] = [];
    const budget = enforcer(async (url) => {
      attempts += 1;
      urls.push(url);
      if (attempts === 1) {
        return jsonResponse(
          leaseDenial({
            mode: "hard_deny",
            denied_by_period: "agent_run",
          }),
        );
      }
      throw new TypeError("offline private detail");
    });

    await expect(budget.checkBudget(leaseCheck(1))).resolves.toMatchObject({
      allowed: false,
      leaseClaimToken: 1,
      deniedByPeriod: "agent_run",
    });
    await expect(budget.checkBudget(leaseCheck(2))).resolves.toMatchObject({
      allowed: false,
      leaseClaimToken: null,
      deniedByPeriod: "agent_run",
    });
    expect(urls).toEqual([LEASE_URL, CHECK_URL]);
  });

  it("forwards an explicit stopped-run grant denial into the matching run sticky", async () => {
    const urls: string[] = [];
    const budget = enforcer(async (url) => {
      urls.push(url);
      if (url === LEASE_URL) {
        return jsonResponse(
          leaseDenial({
            mode: "hard_deny",
            denied_by_period: "run_stopped",
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run_lease",
              reason: "manual_kill",
            },
          }),
        );
      }
      throw new TypeError("offline");
    });

    await expect(budget.checkBudget(leaseCheck(1))).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denyReason: "manual_kill",
    });
    await expect(budget.checkBudget(leaseCheck(2))).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denyReason: "manual_kill",
    });
    expect(urls).toEqual([LEASE_URL, CHECK_URL]);
  });

  it("uses agent_run only when a hard grant denial omits its period", async () => {
    const budget = enforcer(async () =>
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: undefined,
        }),
      ),
    );

    await expect(budget.checkBudget(leaseCheck(1))).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
    });
  });

  it("preserves an explicit null hard grant denial period instead of defaulting it", async () => {
    const budget = enforcer(async () =>
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: null,
        }),
      ),
    );

    await expect(budget.checkBudget(leaseCheck(1))).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: null,
    });
  });

  it("tallies every cold uncounted reserve while rate-limiting diagnostics at 30 seconds", async () => {
    let now = 0;
    const warnings: Array<{ message: string; args: unknown[] }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message, ...args) => warnings.push({ message, args }),
      error: () => {},
    };
    const budget = enforcer(async () => new Response(null, { status: 500 }), {
      monotonicNow: () => now,
      logger,
      failOpen: true,
    });

    await budget.checkBudget(
      leaseCheck(1, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    now = 29_999;
    await budget.checkBudget(
      leaseCheck(2, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    now = 30_000;
    await budget.checkBudget(
      leaseCheck(3, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );

    expect(leaseState(budget)).toMatchObject({ uncountedCalls: 3, uncountedTokens: 1_800 });
    expect(warnings.filter(({ message }) => message.startsWith("lease.uncounted_"))).toEqual([
      {
        message:
          "lease.uncounted_entry: Solwyn is unreachable and this run holds no live lease; calls proceed UNCOUNTED under fail_open and are tallied; a successful renewal reports the tallies, otherwise they are aggregated into a local warning when the run ends (reason=%s)",
        args: ["grant_unreachable"],
      },
      {
        message:
          "lease.uncounted_continuing: still admitting UNCOUNTED under fail_open (reason=%s)",
        args: ["grant_unreachable"],
      },
    ]);
  });

  it.each(
    MALFORMED_POSITIVE_OUTPUT_BOUNDS,
  )("tallies a cold outage %s with the configured output bound", async (_label, estimatedOutputBound) => {
    const budget = enforcer(async () => new Response(null, { status: 500 }), {
      failOpen: true,
      leaseOutputBoundDefault: 2_048,
    });

    await budget.checkBudget(
      leaseCheck(10, {
        estimatedInputTokens: 1_000,
        estimatedOutputBound: estimatedOutputBound as number,
      }),
    );

    const uncountedTokens = leaseState(budget)?.uncountedTokens;
    expect(leaseState(budget)).toMatchObject({ uncountedCalls: 1, uncountedTokens: 3_048 });
    expect(Number.isFinite(uncountedTokens)).toBe(true);
    expect(Number.isInteger(uncountedTokens)).toBe(true);
  });

  it.each(
    MALFORMED_POSITIVE_OUTPUT_BOUNDS,
  )("keeps a live lease authoritative for malformed %s output bounds", async (_label, estimatedOutputBound) => {
    const urls: string[] = [];
    const budget = enforcer(
      async (url) => {
        urls.push(url);
        if (url === LEASE_URL) return jsonResponse(grant({ granted_tokens: 10_000 }));
        if (url === CHECK_URL) return jsonResponse(checkResponse());
        throw new Error("unexpected test URL");
      },
      { leaseOutputBoundDefault: 2_048 },
    );

    await expect(
      budget.checkBudget(
        leaseCheck(11, {
          estimatedInputTokens: 1_000,
          estimatedOutputBound: estimatedOutputBound as number,
        }),
      ),
    ).resolves.toMatchObject({ leaseId: "lease-1", reservationId: null });
    expect(urls).toEqual([LEASE_URL]);
    expect(leaseState(budget)).toMatchObject({
      grantedRemainingTokens: 6_952,
      reservedTokens: 3_048,
    });
  });
});

describe("BudgetEnforcer lease settlement capabilities", () => {
  it("true-ups a named lease confirm only after validation and preserves reservation bytes", async () => {
    const budget = enforcer(async () => jsonResponse(grant({ granted_tokens: 1_000 })));
    const admitted = await budget.checkBudget(
      leaseCheck(601, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    const state = leaseState(budget);
    expect(state?.grantedRemainingTokens).toBe(400);

    const tokenDetails = createTokenDetails({ input_tokens: 125, output_tokens: 75 });
    const confirm = budget.buildConfirmRequest({
      reservationId: "reservation-must-lose",
      leaseId: admitted.leaseId,
      leaseClaimToken: admitted.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails,
      provider: "openai",
      callId: callId(601),
    });

    expect(confirm).toEqual({
      lease_id: "lease-1",
      model: "gpt-5.5",
      provider: "openai",
      modality: "text",
      is_provider_fallback: false,
      call_id: callId(601),
      token_details: tokenDetails,
      provider_region: null,
      service_tier: null,
    });
    expect(confirm).not.toHaveProperty("reservation_id");
    expect(state).toMatchObject({ grantedRemainingTokens: 800, spentTokensSinceReport: 200 });

    const named = budget.buildConfirmRequest({
      reservationId: "reservation-legacy",
      model: "gpt-5.5",
      tokenDetails: zeroTokenDetails(),
      provider: "openai",
      callId: callId(602),
    });
    expect(JSON.stringify(serializeBudgetConfirmRequest(named))).toBe(
      `{"reservation_id":"reservation-legacy","model":"gpt-5.5","provider":"openai","modality":"text","is_provider_fallback":false,"call_id":"${callId(602)}","token_details":{"input_tokens":0,"output_tokens":0,"cached_input_tokens":0,"cache_creation_5m_tokens":0,"cache_creation_1h_tokens":0,"reasoning_tokens":0,"audio_input_tokens":0,"audio_output_tokens":0,"image_input_tokens":0,"image_output_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0,"tool_use_input_tokens":0}}`,
    );
  });

  it("rejects an untyped positional confirm with a typed configuration error", () => {
    const budget = enforcer(async () => jsonResponse(grant()));
    const positional = budget.buildConfirmRequest as unknown as (...args: unknown[]) => unknown;

    expect(() =>
      positional.call(budget, "reservation-legacy", "gpt-5.5", zeroTokenDetails(), {
        provider: "openai",
        callId: callId(602),
      }),
    ).toThrow(ConfigurationError);
  });

  it("rejects missing capability and invalid confirm fields before mutating lease authority", async () => {
    const budget = enforcer(async () => jsonResponse(grant({ granted_tokens: 1_000 })));
    const admitted = await budget.checkBudget(
      leaseCheck(603, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    const state = leaseState(budget);
    const before = state?.grantedRemainingTokens;

    expect(() =>
      budget.buildConfirmRequest({
        leaseId: admitted.leaseId,
        leaseClaimToken: null,
        model: "gpt-5.5",
        tokenDetails: createTokenDetails({ input_tokens: 200 }),
        provider: "openai",
        callId: callId(603),
      }),
    ).toThrow("lease_claim_token");
    expect(state?.grantedRemainingTokens).toBe(before);
    expect(state?.reservations.has(callId(603))).toBe(true);

    expect(() =>
      budget.buildConfirmRequest({
        leaseId: admitted.leaseId,
        leaseClaimToken: admitted.leaseClaimToken,
        model: "x".repeat(2_049),
        tokenDetails: createTokenDetails({ input_tokens: 200 }),
        provider: "openai",
        callId: callId(603),
      }),
    ).toThrow(ConfigurationError);
    expect(state?.grantedRemainingTokens).toBe(before);
    expect(state?.reservations.has(callId(603))).toBe(true);

    expect(() =>
      budget.buildConfirmRequest({
        leaseId: admitted.leaseId,
        leaseClaimToken: admitted.leaseClaimToken,
        model: "gpt-5.5",
        tokenDetails: createTokenDetails({ input_tokens: 200 }),
        provider: "openai",
        callId: "not-a-call-id",
      }),
    ).toThrow(ConfigurationError);
    expect(state?.grantedRemainingTokens).toBe(before);
    expect(state?.reservations.has(callId(603))).toBe(true);
  });

  it("makes wrong and stale claims harmless to successor authority", async () => {
    const budget = enforcer(async () => jsonResponse(grant({ granted_tokens: 1_000 })));
    const admitted = await budget.checkBudget(
      leaseCheck(604, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    const state = leaseState(budget);

    budget.buildConfirmRequest({
      leaseId: admitted.leaseId,
      leaseClaimToken: 99_999,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 200 }),
      provider: "openai",
      callId: callId(604),
    });
    expect(state).toMatchObject({ grantedRemainingTokens: 400, spentTokensSinceReport: 0 });
    expect(state?.reservations.has(callId(604))).toBe(true);

    const ledger = (budget as unknown as { leaseLedger: LeaseLedger }).leaseLedger;
    expect(
      ledger.applyGrantResponse(
        "run_lease",
        grant({ lease_id: "lease-successor", generation: 2, granted_tokens: 2_000 }),
        { now: 1, declaredModels: ["gpt-5.5", "claude-opus-4"] },
      ),
    ).toBe("applied");
    const successorRemaining = state?.grantedRemainingTokens;

    budget.buildConfirmRequest({
      leaseId: "lease-1",
      leaseClaimToken: admitted.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 900 }),
      provider: "openai",
      callId: callId(604),
    });
    expect(state).toMatchObject({
      leaseId: "lease-successor",
      grantedRemainingTokens: successorRemaining,
      spentTokensSinceReport: 0,
    });
  });

  it("uses floorAtReservation as a floor without clamping measured overshoot", async () => {
    const budget = enforcer(async () => jsonResponse(grant({ granted_tokens: 2_000 })));
    const underReport = await budget.checkBudget(
      leaseCheck(605, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );

    budget.buildConfirmRequest({
      leaseId: underReport.leaseId,
      leaseClaimToken: underReport.leaseClaimToken,
      floorAtReservation: true,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 200 }),
      provider: "openai",
      callId: callId(605),
    });

    expect(leaseState(budget)).toMatchObject({
      grantedRemainingTokens: 1_400,
      spentTokensSinceReport: 600,
    });

    const overshoot = await budget.checkBudget(
      leaseCheck(606, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    budget.buildConfirmRequest({
      leaseId: overshoot.leaseId,
      leaseClaimToken: overshoot.leaseClaimToken,
      floorAtReservation: true,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 500, output_tokens: 300 }),
      provider: "openai",
      callId: callId(606),
    });

    expect(leaseState(budget)).toMatchObject({
      grantedRemainingTokens: 600,
      spentTokensSinceReport: 1_400,
    });
  });

  it("releases only the exact current capability once and validates claimed call IDs", async () => {
    const budget = enforcer(async () => jsonResponse(grant({ granted_tokens: 2_000 })));
    const first = await budget.checkBudget(
      leaseCheck(606, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    const state = leaseState(budget);
    expect(state?.grantedRemainingTokens).toBe(1_400);

    budget.releaseReservation(callId(606), null);
    budget.releaseReservation(callId(606), 99_999);
    expect(state?.grantedRemainingTokens).toBe(1_400);
    expect(() => budget.releaseReservation("not-a-call-id", first.leaseClaimToken ?? null)).toThrow(
      ConfigurationError,
    );
    expect(state?.grantedRemainingTokens).toBe(1_400);

    budget.releaseReservation(callId(606), first.leaseClaimToken ?? null);
    expect(state?.grantedRemainingTokens).toBe(2_000);
    budget.releaseReservation(callId(606), first.leaseClaimToken ?? null);
    expect(state?.grantedRemainingTokens).toBe(2_000);

    const second = await budget.checkBudget(
      leaseCheck(607, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    const ledger = (budget as unknown as { leaseLedger: LeaseLedger }).leaseLedger;
    expect(
      ledger.applyGrantResponse(
        "run_lease",
        grant({ lease_id: "lease-successor", generation: 2, granted_tokens: 3_000 }),
        { now: 1, declaredModels: ["gpt-5.5", "claude-opus-4"] },
      ),
    ).toBe("applied");
    budget.releaseReservation(callId(607), second.leaseClaimToken ?? null);
    expect(state).toMatchObject({ leaseId: "lease-successor", grantedRemainingTokens: 3_000 });
  });
});

describe("BudgetEnforcer off-path lease renewal", () => {
  it("returns before one deferred 75%-due renewal and sends the exact immutable request", async () => {
    const renewGate = deferred<Response>();
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const budget = enforcer(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ url, body });
      if (url === LEASE_URL) {
        return jsonResponse(
          grant({ granted_tokens: 800, refresh_interval_s: 300, lease_length_s: 600 }),
        );
      }
      if (url === RENEW_URL) return renewGate.promise;
      throw new Error("unexpected test URL");
    });

    const first = await budget.checkBudget(
      leaseCheck(701, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    expect(first).toMatchObject({ allowed: true, leaseId: "lease-1" });
    expect(seen).toEqual([
      {
        url: LEASE_URL,
        body: {
          agent_run_id: "run_lease",
          holder_id: "sdk-instance-1",
          model: "gpt-5.5",
          provider: "openai",
          fallback_providers: ["anthropic"],
          fallback_models: ["claude-opus-4"],
          fail_open: true,
          estimated_input_tokens: 100,
          run_directive_version: "1",
        },
      },
      {
        url: RENEW_URL,
        body: {
          lease_id: "lease-1",
          holder_id: "sdk-instance-1",
          generation: 1,
          spent_tokens: 0,
          reserved_tokens: 600,
          uncounted_calls: 0,
          uncounted_tokens: 0,
          model: "gpt-5.5",
          provider: "openai",
          fallback_providers: ["anthropic"],
          fallback_models: ["claude-opus-4"],
          run_directive_version: "1",
        },
      },
    ]);
    expect(seen[1]?.body).toHaveProperty("run_directive_version", "1");

    await budget.checkBudget(
      leaseCheck(702, { estimatedInputTokens: 0, estimatedOutputBound: 100 }),
    );
    expect(seen.filter(({ url }) => url === RENEW_URL)).toHaveLength(1);
    renewGate.resolve(jsonResponse(grant({ generation: 2, granted_tokens: 2_000 })));
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
  });

  it("surrenders an older renewal allow instead of installing it after a newer project denial", async () => {
    // Mutation caught: renewal successors need the same dispatch-epoch fence as an
    // initial grant, even though renewal completion is detached from admission.
    let now = 10;
    const renewResponse = deferred<Response>();
    const urls: string[] = [];
    const surrenders: Array<Record<string, unknown>> = [];
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        urls.push(url);
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 800, refresh_interval_s: 0, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) return renewResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "monthly",
              }),
            );
          }
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    await expect(
      budget.checkBudget(leaseCheck(703, { estimatedInputTokens: 100, estimatedOutputBound: 500 })),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-1" });
    await flushUntil(() => urls.includes(RENEW_URL));
    now = 20;
    await expect(
      budget.checkBudget(leaseCheck(704, { tags: { customer: "acme" } })),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    now = 30;
    renewResponse.resolve(
      jsonResponse(grant({ generation: 2, granted_tokens: 2_000, refresh_interval_s: 300 })),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    const stateAfterRenewal = leaseState(budget);
    const outage = await budget.checkBudget(
      leaseCheck(705, { agentRunId: undefined, model: "outage-after-stale-renewal-allow" }),
    );
    await flushUntil(() => surrenders.length === 1);

    expect(stateAfterRenewal).toMatchObject({
      leaseId: "lease-1",
      generation: 1,
      renewalInFlight: false,
    });
    expect(surrenders).toEqual([
      {
        lease_id: "lease-1",
        holder_id: "sdk-instance-1",
        generation: 2,
        spent_tokens: 0,
      },
    ]);
    expect(outage).toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("surrenders an older renewal while a newer tagged project check is pending", async () => {
    let now = 10;
    const renewResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    let renewalStarted = false;
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 800, refresh_interval_s: 0, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) {
          renewalStarted = true;
          return renewResponse.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    await budget.checkBudget(
      leaseCheck(714, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => renewalStarted);
    now = 20;
    const pendingTagged = budget.checkBudget(leaseCheck(715, { tags: { customer: "acme" } }));
    now = 30;
    renewResponse.resolve(
      jsonResponse(grant({ lease_id: "lease-successor", generation: 2, refresh_interval_s: 300 })),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    await flushUntil(() => surrenders.length === 1);
    expect(leaseState(budget)).toMatchObject({ leaseId: "lease-1", generation: 1 });
    expect(surrenders).toEqual([
      {
        lease_id: "lease-successor",
        holder_id: "sdk-instance-1",
        generation: 2,
        spent_tokens: 0,
      },
    ]);

    now = 40;
    taggedResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(budget.checkBudget(leaseCheck(716))).resolves.toMatchObject({
      allowed: false,
      leaseId: null,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(717, { agentRunId: undefined, model: "outage-after-pending-renew-check" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("surrenders a renewal allow when a later pending check has the same epoch", async () => {
    const renewResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    let renewalStarted = false;
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 800, refresh_interval_s: 0, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) {
          renewalStarted = true;
          return renewResponse.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    await budget.checkBudget(
      leaseCheck(724, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => renewalStarted);
    const pendingTagged = budget.checkBudget(leaseCheck(725, { tags: { customer: "acme" } }));
    renewResponse.resolve(
      jsonResponse(grant({ lease_id: "lease-successor", generation: 2, refresh_interval_s: 300 })),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    await flushUntil(() => surrenders.length === 1);
    expect(leaseState(budget)).toMatchObject({
      leaseId: "lease-1",
      generation: 1,
      renewalInFlight: false,
    });
    expect(surrenders).toEqual([
      {
        lease_id: "lease-successor",
        holder_id: "sdk-instance-1",
        generation: 2,
        spent_tokens: 0,
      },
    ]);

    taggedResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(budget.checkBudget(leaseCheck(726))).resolves.toMatchObject({
      allowed: false,
      leaseId: null,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("lets a later tagged denial clear an older renewal denial when clock values collide", async () => {
    const renewResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    let renewalStarted = false;
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 800, refresh_interval_s: 0, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) {
          renewalStarted = true;
          return renewResponse.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    await budget.checkBudget(
      leaseCheck(718, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => renewalStarted);
    const pendingTagged = budget.checkBudget(leaseCheck(719, { tags: { customer: "acme" } }));
    renewResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    expect(leaseState(budget)).toMatchObject({ leaseId: null, renewalInFlight: false });

    taggedResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "tag",
        }),
      ),
    );
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "tag",
      denySource: "server",
    });
    expect(budget.hasStickyHardDeny).toBe(false);
    await expect(
      budget.checkBudget(
        leaseCheck(720, { agentRunId: undefined, model: "outage-after-pending-renew-tag-clear" }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("keeps the latest renewal dispatch fence when an older renewal wins payload observation", async () => {
    const olderRenewal = deferred<Response>();
    const newerRenewal = deferred<Response>();
    const orderedAllow = deferred<Response>();
    const renewalsStarted = new Set<string>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          agent_run_id?: string;
          lease_id?: string;
        };
        if (url === LEASE_URL) {
          const older = body.agent_run_id === "run-renew-older";
          return jsonResponse(
            grant({
              lease_id: older ? "lease-renew-older" : "lease-renew-newer",
              granted_tokens: 800,
              refresh_interval_s: 0,
              lease_length_s: 600,
            }),
          );
        }
        if (url === RENEW_URL) {
          const leaseId = body.lease_id ?? "";
          renewalsStarted.add(leaseId);
          return leaseId === "lease-renew-older" ? olderRenewal.promise : newerRenewal.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return orderedAllow.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    await expect(
      budget.checkBudget(
        leaseCheck(950, {
          agentRunId: "run-renew-older",
          model: "older-renewal",
          estimatedInputTokens: 100,
          estimatedOutputBound: 500,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-renew-older" });
    await flushUntil(() => renewalsStarted.has("lease-renew-older"));

    const pendingOrdered = budget.checkBudget(
      leaseCheck(951, {
        agentRunId: undefined,
        model: "middle-renewal-ordered-allow",
        tags: { customer: "acme" },
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(952, {
          agentRunId: "run-renew-newer",
          model: "newer-renewal",
          estimatedInputTokens: 100,
          estimatedOutputBound: 500,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-renew-newer" });
    await flushUntil(() => renewalsStarted.has("lease-renew-newer"));

    newerRenewal.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "daily",
        }),
      ),
    );
    await flushUntil(() => leaseState(budget, "run-renew-newer")?.renewalInFlight === false);

    olderRenewal.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await flushUntil(() => leaseState(budget, "run-renew-older")?.renewalInFlight === false);

    orderedAllow.resolve(jsonResponse(checkResponse()));
    await expect(pendingOrdered).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(953, {
          agentRunId: undefined,
          model: "outage-after-renewal-dispatch-fence-cycle",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("does not let a rejected ordered allow suppress an older renewal denial", async () => {
    const olderRenewal = deferred<Response>();
    const newerRenewal = deferred<Response>();
    const middleOrdered = deferred<Response>();
    const renewalsStarted = new Set<string>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          agent_run_id?: string;
          lease_id?: string;
        };
        if (url === LEASE_URL) {
          const older = body.agent_run_id === "run-inverse-renew-older";
          return jsonResponse(
            grant({
              lease_id: older ? "lease-inverse-renew-older" : "lease-inverse-renew-newer",
              granted_tokens: 800,
              refresh_interval_s: 0,
              lease_length_s: 600,
            }),
          );
        }
        if (url === RENEW_URL) {
          const leaseId = body.lease_id ?? "";
          renewalsStarted.add(leaseId);
          return leaseId === "lease-inverse-renew-older"
            ? olderRenewal.promise
            : newerRenewal.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return middleOrdered.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    await expect(
      budget.checkBudget(
        leaseCheck(990, {
          agentRunId: "run-inverse-renew-older",
          model: "inverse-older-renewal",
          estimatedInputTokens: 100,
          estimatedOutputBound: 500,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-inverse-renew-older" });
    await flushUntil(() => renewalsStarted.has("lease-inverse-renew-older"));

    const pendingMiddle = budget.checkBudget(
      leaseCheck(991, {
        agentRunId: undefined,
        model: "inverse-middle-renewal-ordered",
        tags: { customer: "acme" },
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(992, {
          agentRunId: "run-inverse-renew-newer",
          model: "inverse-newer-renewal",
          estimatedInputTokens: 100,
          estimatedOutputBound: 500,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-inverse-renew-newer" });
    await flushUntil(() => renewalsStarted.has("lease-inverse-renew-newer"));

    newerRenewal.resolve(
      jsonResponse(
        grant({
          lease_id: "lease-inverse-renew-successor",
          generation: 2,
          granted_tokens: 2_000,
          refresh_interval_s: 300,
        }),
      ),
    );
    await flushUntil(
      () => leaseState(budget, "run-inverse-renew-newer")?.renewalInFlight === false,
    );
    expect(leaseState(budget, "run-inverse-renew-newer")).toMatchObject({
      leaseId: "lease-inverse-renew-successor",
      generation: 2,
    });

    middleOrdered.resolve(jsonResponse(checkResponse()));
    await expect(pendingMiddle).resolves.toMatchObject({ allowed: true, leaseId: null });

    olderRenewal.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await flushUntil(
      () => leaseState(budget, "run-inverse-renew-older")?.renewalInFlight === false,
    );
    await expect(
      budget.checkBudget(
        leaseCheck(993, {
          agentRunId: undefined,
          model: "outage-after-rejected-renewal-ordered-authority",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("carries a no-run fallback dispatch through an older renewal denial", async () => {
    const olderRenewal = deferred<Response>();
    const newerRenewal = deferred<Response>();
    const middleOrdered = deferred<Response>();
    const renewalsStarted = new Set<string>();
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          agent_run_id?: string;
          lease_id?: string;
        };
        if (url === LEASE_URL) {
          const older = body.agent_run_id === "run-renew-fallback-older";
          return jsonResponse(
            grant({
              lease_id: older ? "lease-renew-fallback-older" : "lease-renew-fallback-newer",
              granted_tokens: 800,
              refresh_interval_s: 0,
              lease_length_s: 600,
            }),
          );
        }
        if (url === RENEW_URL) {
          const leaseId = body.lease_id ?? "";
          renewalsStarted.add(leaseId);
          return leaseId === "lease-renew-fallback-older"
            ? olderRenewal.promise
            : newerRenewal.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return middleOrdered.promise;
          if (checkCalls === 2) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "agent_run",
              }),
            );
          }
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true },
    );

    await expect(
      budget.checkBudget(
        leaseCheck(1_010, {
          agentRunId: "run-renew-fallback-older",
          model: "renew-fallback-older",
          estimatedInputTokens: 100,
          estimatedOutputBound: 500,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-renew-fallback-older" });
    await flushUntil(() => renewalsStarted.has("lease-renew-fallback-older"));

    const pendingMiddle = budget.checkBudget(
      leaseCheck(1_011, {
        agentRunId: undefined,
        model: "renew-fallback-middle-ordered",
        tags: { customer: "acme" },
      }),
    );
    await expect(
      budget.checkBudget(
        leaseCheck(1_012, {
          agentRunId: "run-renew-fallback-newer",
          model: "renew-fallback-newer",
          estimatedInputTokens: 100,
          estimatedOutputBound: 500,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-renew-fallback-newer" });
    await flushUntil(() => renewalsStarted.has("lease-renew-fallback-newer"));

    newerRenewal.resolve(
      jsonResponse(
        grant({
          lease_id: "lease-renew-fallback-successor",
          generation: 2,
          granted_tokens: 2_000,
          refresh_interval_s: 300,
        }),
      ),
    );
    await flushUntil(
      () => leaseState(budget, "run-renew-fallback-newer")?.renewalInFlight === false,
    );
    await expect(
      budget.checkBudget(
        leaseCheck(1_013, {
          agentRunId: undefined,
          model: "renew-fallback-no-run",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "server",
    });

    olderRenewal.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await flushUntil(
      () => leaseState(budget, "run-renew-fallback-older")?.renewalInFlight === false,
    );

    middleOrdered.resolve(jsonResponse(checkResponse()));
    await expect(pendingMiddle).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "server",
    });
    await expect(
      budget.checkBudget(
        leaseCheck(1_014, {
          agentRunId: undefined,
          model: "outage-after-renewal-fallback-bridge",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("carries a no-run fallback through a denial to fence a second older renewal allow", async () => {
    const allowRenewal = deferred<Response>();
    const denialRenewal = deferred<Response>();
    const renewalsStarted = new Set<string>();
    const surrenders: Array<Record<string, unknown>> = [];
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          agent_run_id?: string;
          lease_id?: string;
        };
        if (url === LEASE_URL) {
          const allowRun = body.agent_run_id === "run-transitive-renew-allow";
          return jsonResponse(
            grant({
              lease_id: allowRun ? "lease-transitive-renew-allow" : "lease-transitive-renew-denial",
              granted_tokens: 800,
              refresh_interval_s: 0,
              lease_length_s: 600,
            }),
          );
        }
        if (url === RENEW_URL) {
          const leaseId = body.lease_id ?? "";
          renewalsStarted.add(leaseId);
          return leaseId === "lease-transitive-renew-allow"
            ? allowRenewal.promise
            : denialRenewal.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "agent_run",
              }),
            );
          }
          throw new TypeError("offline");
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => 10, failOpen: true, cacheTtl: 0 },
    );

    await expect(
      budget.checkBudget(
        leaseCheck(1_030, {
          agentRunId: "run-transitive-renew-allow",
          model: "transitive-renew-older-allow",
          estimatedInputTokens: 100,
          estimatedOutputBound: 500,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-transitive-renew-allow" });
    await flushUntil(() => renewalsStarted.has("lease-transitive-renew-allow"));
    await expect(
      budget.checkBudget(
        leaseCheck(1_031, {
          agentRunId: "run-transitive-renew-denial",
          model: "transitive-renew-older-denial",
          estimatedInputTokens: 100,
          estimatedOutputBound: 500,
        }),
      ),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-transitive-renew-denial" });
    await flushUntil(() => renewalsStarted.has("lease-transitive-renew-denial"));

    await expect(
      budget.checkBudget(
        leaseCheck(1_032, {
          agentRunId: undefined,
          model: "transitive-renew-no-run-fallback",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "server",
    });

    denialRenewal.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
          budget_limit: 180,
          current_usage: 179,
          remaining_budget: 1,
        }),
      ),
    );
    await flushUntil(
      () => leaseState(budget, "run-transitive-renew-denial")?.renewalInFlight === false,
    );
    expect(leaseState(budget, "run-transitive-renew-denial")).toMatchObject({ leaseId: null });

    allowRenewal.resolve(
      jsonResponse(
        grant({
          lease_id: "lease-transitive-renew-successor",
          generation: 2,
          granted_tokens: 2_000,
          refresh_interval_s: 300,
          mode: "hard_deny",
          posture: { mode: "hard_deny", on_unreachable: "fail_open" },
        }),
      ),
    );
    await flushUntil(
      () => leaseState(budget, "run-transitive-renew-allow")?.renewalInFlight === false,
    );
    await flushUntil(() => surrenders.length === 1);
    expect(leaseState(budget, "run-transitive-renew-allow")).toMatchObject({
      leaseId: "lease-transitive-renew-allow",
      generation: 1,
    });
    expect(surrenders).toEqual([
      {
        lease_id: "lease-transitive-renew-successor",
        holder_id: "sdk-instance-1",
        generation: 2,
        spent_tokens: 0,
      },
    ]);
    await expect(
      budget.checkBudget(
        leaseCheck(1_033, {
          agentRunId: undefined,
          model: "outage-after-transitive-renewal-barrier",
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 180,
      currentUsage: 179,
    });
  });

  it("retains an older renewal denial when the newer pending check is unreadable", async () => {
    let now = 10;
    const renewResponse = deferred<Response>();
    const taggedResponse = deferred<Response>();
    let renewalStarted = false;
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 800, refresh_interval_s: 0, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) {
          renewalStarted = true;
          return renewResponse.promise;
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    await budget.checkBudget(
      leaseCheck(721, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => renewalStarted);
    now = 20;
    const pendingTagged = budget.checkBudget(leaseCheck(722, { tags: { customer: "acme" } }));
    now = 30;
    renewResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
          budget_limit: 220,
          current_usage: 219,
          remaining_budget: 1,
        }),
      ),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    expect(leaseState(budget)).toMatchObject({ leaseId: null, renewalInFlight: false });

    now = 40;
    taggedResponse.resolve(new Response("not json", { status: 200 }));
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 220,
      currentUsage: 219,
    });
    await expect(
      budget.checkBudget(
        leaseCheck(723, { agentRunId: undefined, model: "outage-after-pending-check-unreadable" }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 220,
      currentUsage: 219,
    });
  });

  it("surrenders a renewal allow that loses to a newer same-run denial", async () => {
    const taggedResponse = deferred<Response>();
    const renewResponse = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    let now = 0;
    let checkCalls = 0;
    let renewalStarted = false;
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 3_000, refresh_interval_s: 1, lease_length_s: 600 }),
          );
        }
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) return taggedResponse.promise;
          throw new TypeError("offline");
        }
        if (url === RENEW_URL) {
          renewalStarted = true;
          return renewResponse.promise;
        }
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    await budget.checkBudget(leaseCheck(710));
    now = 1_000;
    const pendingTagged = budget.checkBudget(leaseCheck(711, { tags: { customer: "acme" } }));
    now = 2_000;
    await budget.checkBudget(leaseCheck(712));
    await flushUntil(() => renewalStarted);
    now = 3_000;
    taggedResponse.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "agent_run",
        }),
      ),
    );
    await expect(pendingTagged).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "server",
    });
    now = 4_000;
    renewResponse.resolve(
      jsonResponse(grant({ lease_id: "lease-successor", generation: 2, refresh_interval_s: 300 })),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    await flushUntil(() => surrenders.length === 1);

    expect(leaseState(budget)).toMatchObject({ leaseId: "lease-1", generation: 1 });
    expect(surrenders).toEqual([
      {
        lease_id: "lease-successor",
        holder_id: "sdk-instance-1",
        generation: 2,
        spent_tokens: 0,
      },
    ]);
    await expect(budget.checkBudget(leaseCheck(713))).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
      denySource: "sticky_replay",
    });
  });

  it("does not let an older renewal denial resurrect authority after a newer tag tombstone", async () => {
    // Mutation caught: response-observation ordering is valid for lease peers only
    // after the renewal dispatch has passed the ordered-authority fence.
    let now = 10;
    const renewResponse = deferred<Response>();
    const urls: string[] = [];
    let leaseCalls = 0;
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        urls.push(url);
        if (url === LEASE_URL) {
          leaseCalls += 1;
          return jsonResponse(
            grant({
              granted_tokens: leaseCalls === 1 ? 800 : 3_000,
              refresh_interval_s: leaseCalls === 1 ? 0 : 300,
              lease_length_s: 600,
            }),
          );
        }
        if (url === RENEW_URL) return renewResponse.promise;
        if (url === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "tag",
              }),
            );
          }
          throw new TypeError("offline");
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now, failOpen: true },
    );

    await budget.checkBudget(
      leaseCheck(706, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => urls.includes(RENEW_URL));
    now = 20;
    await expect(
      budget.checkBudget(leaseCheck(707, { tags: { customer: "acme" } })),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "tag",
      denySource: "server",
    });
    now = 30;
    renewResponse.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "monthly",
        }),
      ),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);

    expect(budget.hasStickyHardDeny).toBe(false);
    expect(leaseState(budget)).toMatchObject({ leaseId: null, renewalInFlight: false });
    await expect(
      budget.checkBudget(
        leaseCheck(708, { agentRunId: undefined, model: "outage-after-stale-renewal-deny" }),
      ),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    await expect(budget.checkBudget(leaseCheck(709))).resolves.toMatchObject({
      allowed: true,
      leaseId: "lease-1",
    });
    expect(leaseCalls).toBe(2);
  });

  it("starts one due renewal when a depleted live lease falls through to the legacy check", async () => {
    let now = 0;
    const renewGate = deferred<Response>();
    const urls: string[] = [];
    const budget = enforcer(
      async (url) => {
        urls.push(url);
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 1_000, refresh_interval_s: 10, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) return renewGate.promise;
        if (url === CHECK_URL) return jsonResponse(checkResponse());
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now },
    );

    await budget.checkBudget(
      leaseCheck(703, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    now = 20_000;

    const result = await budget.checkBudget(
      leaseCheck(704, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => urls.includes(RENEW_URL));

    expect(result).toMatchObject({ allowed: true, leaseId: null });
    expect(urls.filter((url) => url === CHECK_URL)).toHaveLength(1);
    expect(urls.filter((url) => url === RENEW_URL)).toHaveLength(1);

    renewGate.resolve(jsonResponse(grant({ generation: 2, granted_tokens: 2_000 })));
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
  });

  it("caps four distinct-run renewals without wedging the fifth run", async () => {
    const renewalGates: Array<ReturnType<typeof deferred<Response>>> = [];
    const renewBodies: Array<Record<string, unknown>> = [];
    const budget = enforcer(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url === LEASE_URL) {
        const runId = String(body["agent_run_id"]);
        return jsonResponse(
          grant({
            lease_id: `${runId}-lease`,
            granted_tokens: 10_000,
            refresh_interval_s: 0,
          }),
        );
      }
      if (url === RENEW_URL) {
        renewBodies.push(body);
        const gate = deferred<Response>();
        renewalGates.push(gate);
        return gate.promise;
      }
      throw new Error("unexpected test URL");
    });

    for (let index = 0; index < 5; index += 1) {
      await budget.checkBudget(
        leaseCheck(710 + index, {
          agentRunId: `run-cap-${index}`,
          estimatedInputTokens: 0,
          estimatedOutputBound: 100,
        }),
      );
    }

    expect(renewBodies).toHaveLength(4);
    expect(leaseState(budget, "run-cap-4")?.renewalInFlight).toBe(false);

    const firstBody = renewBodies[0];
    renewalGates[0]?.resolve(
      jsonResponse(
        grant({
          lease_id: String(firstBody?.["lease_id"]),
          generation: 2,
          granted_tokens: 10_000,
        }),
      ),
    );
    await flushUntil(
      () =>
        (budget as unknown as { renewalOperations: Set<Promise<void>> }).renewalOperations.size ===
        3,
    );

    await budget.checkBudget(
      leaseCheck(720, {
        agentRunId: "run-cap-4",
        estimatedInputTokens: 0,
        estimatedOutputBound: 100,
      }),
    );
    expect(renewBodies).toHaveLength(5);
    expect(renewBodies[4]?.["lease_id"]).toBe("run-cap-4-lease");

    for (let index = 1; index < renewalGates.length; index += 1) {
      const body = renewBodies[index];
      renewalGates[index]?.resolve(
        jsonResponse(
          grant({
            lease_id: String(body?.["lease_id"]),
            generation: 2,
            granted_tokens: 10_000,
          }),
        ),
      );
    }
    await flushUntil(() =>
      Array.from(
        { length: 5 },
        (_, index) => leaseState(budget, `run-cap-${index}`)?.renewalInFlight === false,
      ).every(Boolean),
    );
  });

  it("clears a renewal at the exact 5,000ms transport timeout without delaying admission", async () => {
    vi.useFakeTimers();
    const budget = enforcer(async (url) => {
      if (url === LEASE_URL) {
        return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 0 }));
      }
      if (url === RENEW_URL) return new Promise<Response>(() => {});
      throw new Error("unexpected test URL");
    });

    await expect(
      budget.checkBudget(leaseCheck(725, { estimatedInputTokens: 100, estimatedOutputBound: 500 })),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-1" });
    expect(leaseState(budget)?.renewalInFlight).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(leaseState(budget)?.renewalInFlight).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    expect(leaseState(budget)).toMatchObject({ renewalInFlight: false, consecutiveFailures: 1 });
  });

  it("applies a same-lease successor while acknowledging only captured tallies", async () => {
    let now = 0;
    const renewGate = deferred<Response>();
    const renewBodies: Array<Record<string, unknown>> = [];
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 3_000, refresh_interval_s: 10, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) {
          renewBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return renewGate.promise;
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now },
    );

    const first = await budget.checkBudget(
      leaseCheck(730, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    budget.buildConfirmRequest({
      leaseId: first.leaseId,
      leaseClaimToken: first.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 200 }),
      provider: "openai",
      callId: callId(730),
    });
    now = 20_000;
    const second = await budget.checkBudget(
      leaseCheck(731, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    expect(renewBodies[0]).toMatchObject({ spent_tokens: 200, reserved_tokens: 600 });
    budget.buildConfirmRequest({
      leaseId: second.leaseId,
      leaseClaimToken: second.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 300 }),
      provider: "openai",
      callId: callId(731),
    });

    renewGate.resolve(
      jsonResponse(
        grant({
          generation: 2,
          granted_tokens: 2_000,
          refresh_interval_s: 10,
          lease_length_s: 600,
        }),
      ),
    );
    await flushUntil(() => leaseState(budget)?.generation === 2);

    expect(leaseState(budget)).toMatchObject({
      leaseId: "lease-1",
      generation: 2,
      grantedRemainingTokens: 1_700,
      spentTokensSinceReport: 300,
      renewalInFlight: false,
      consecutiveFailures: 0,
    });
    expect([...new Set(leaseState(budget)?.declaredModels)]).toEqual(["gpt-5.5", "claude-opus-4"]);
  });

  it.each([
    ["unreadable 200", () => new Response("not-json", { status: 200 })],
    ["503 refusal", () => new Response(null, { status: 503 })],
    ["non-503 500", () => new Response(null, { status: 500 })],
    ["stale generation", () => jsonResponse(grant({ generation: 1 }))],
  ])("backs off one %s renewal without losing owed tallies or retrying per call", async (_name, reply) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    let renewals = 0;
    const budget = enforcer(async (url) => {
      if (url === LEASE_URL) {
        return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 0 }));
      }
      if (url === RENEW_URL) {
        renewals += 1;
        return reply();
      }
      throw new Error("unexpected test URL");
    });

    const admitted = await budget.checkBudget(
      leaseCheck(740, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    budget.buildConfirmRequest({
      leaseId: admitted.leaseId,
      leaseClaimToken: admitted.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 200 }),
      provider: "openai",
      callId: callId(740),
    });
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);

    expect(leaseState(budget)).toMatchObject({
      leaseId: "lease-1",
      generation: 1,
      renewalInFlight: false,
      consecutiveFailures: 1,
      spentTokensSinceReport: 200,
    });
    expect(leaseState(budget)?.nextAttemptAt).toBeGreaterThan(0);
    await budget.checkBudget(
      leaseCheck(741, { estimatedInputTokens: 0, estimatedOutputBound: 100 }),
    );
    expect(renewals).toBe(1);
    random.mockRestore();
  });

  it.each([
    404, 409,
  ])("drops a current lease on renewal %s and regrants the next call", async (status) => {
    let grants = 0;
    let renewals = 0;
    const budget = enforcer(async (url) => {
      if (url === LEASE_URL) {
        grants += 1;
        return jsonResponse(
          grant({
            lease_id: `lease-${grants}`,
            granted_tokens: 3_000,
            refresh_interval_s: grants === 1 ? 0 : 300,
          }),
        );
      }
      if (url === RENEW_URL) {
        renewals += 1;
        return new Response(null, { status });
      }
      throw new Error("unexpected test URL");
    });

    await budget.checkBudget(
      leaseCheck(750, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => leaseState(budget)?.leaseId === null);
    await expect(
      budget.checkBudget(leaseCheck(751, { estimatedInputTokens: 100, estimatedOutputBound: 500 })),
    ).resolves.toMatchObject({ leaseId: "lease-2" });
    expect({ grants, renewals }).toEqual({ grants: 2, renewals: 1 });
  });

  it.each([404, 409])("fences a late %s so it cannot drop a replacement lease", async (status) => {
    const renewGate = deferred<Response>();
    const budget = enforcer(async (url) => {
      if (url === LEASE_URL) {
        return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 0 }));
      }
      if (url === RENEW_URL) return renewGate.promise;
      throw new Error("unexpected test URL");
    });

    await budget.checkBudget(
      leaseCheck(760, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    const internal = budget as unknown as {
      leaseLedger: LeaseLedger;
      renewalOperations: Set<Promise<void>>;
    };
    expect(internal.renewalOperations.size).toBe(1);
    expect(
      internal.leaseLedger.applyGrantResponse(
        "run_lease",
        grant({ lease_id: "lease-replacement", generation: 2, granted_tokens: 4_000 }),
        { now: 1, declaredModels: ["gpt-5.5", "claude-opus-4"] },
      ),
    ).toBe("applied");
    renewGate.resolve(new Response(null, { status }));
    let renewalCompleted = false;
    await flushUntil(() => {
      renewalCompleted = internal.renewalOperations.size === 0;
      return renewalCompleted;
    });
    expect(renewalCompleted).toBe(true);
    expect(leaseState(budget)).toMatchObject({ leaseId: "lease-replacement", generation: 2 });
  });

  it.each([
    ["applied 200", () => jsonResponse(grant({ generation: 2 })), [1, 0, 1]],
    ["503 refusal", () => new Response(null, { status: 503 }), [1, 0, 1]],
    ["non-503 500", () => new Response(null, { status: 500 }), [0, 1, 1]],
  ] as const)("scores and releases the shared breaker for renewal %s", async (_name, reply, expected) => {
    let now = 0;
    const breaker = new CountingBreaker();
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) {
          return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 10 }));
        }
        if (url === RENEW_URL) return reply();
        throw new Error("unexpected test URL");
      },
      { controlPlaneBreaker: breaker, monotonicNow: () => now },
    );

    await budget.checkBudget(
      leaseCheck(770, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    breaker.successes = 0;
    breaker.failures = 0;
    breaker.releases = 0;
    now = 20_000;
    await budget.checkBudget(
      leaseCheck(771, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    expect([breaker.successes, breaker.failures, breaker.releases]).toEqual(expected);
  });

  it("releases a refused breaker admission without scoring it", async () => {
    let now = 0;
    const breaker = new CountingBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 3_000, refresh_interval_s: 10, lease_length_s: 600 }),
          );
        }
        throw new Error(`unexpected test URL ${url}`);
      },
      { monotonicNow: () => now, controlPlaneBreaker: breaker },
    );
    await budget.checkBudget(
      leaseCheck(780, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    breaker.recordFailure();
    breaker.successes = 0;
    breaker.failures = 0;
    breaker.releases = 0;
    now = 20_000;

    await budget.checkBudget(
      leaseCheck(781, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    expect([breaker.successes, breaker.failures, breaker.releases]).toEqual([0, 0, 1]);
    expect(leaseState(budget)).toMatchObject({ leaseId: "lease-1", consecutiveFailures: 1 });
  });

  it("files a renewal hard deny for the run without changing the admitted result", async () => {
    const urls: string[] = [];
    const budget = enforcer(async (url) => {
      urls.push(url);
      if (url === LEASE_URL) {
        return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 0 }));
      }
      if (url === RENEW_URL) {
        return jsonResponse(
          grant({
            eligible: true,
            allowed: false,
            denied_by_period: "agent_run",
            lease_id: null,
            generation: null,
            granted_tokens: null,
            refresh_interval_s: null,
            lease_length_s: null,
            headroom_share_tokens: null,
            posture: null,
            mode: "hard_deny",
          }),
        );
      }
      if (url === CHECK_URL) throw new TypeError("offline");
      throw new Error("unexpected test URL");
    });

    await expect(
      budget.checkBudget(leaseCheck(790, { estimatedInputTokens: 100, estimatedOutputBound: 500 })),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-1" });
    await flushUntil(() => budget.hasStickyHardDeny);
    await expect(budget.checkBudget(leaseCheck(791))).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "agent_run",
    });
    expect(urls).toEqual([LEASE_URL, RENEW_URL, CHECK_URL]);
  });

  it("files a renewal stopped-run denial for replay on the next call", async () => {
    const urls: string[] = [];
    const budget = enforcer(async (url) => {
      urls.push(url);
      if (url === LEASE_URL) {
        return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 0 }));
      }
      if (url === RENEW_URL) {
        return jsonResponse(
          grant({
            eligible: true,
            allowed: false,
            denied_by_period: "run_stopped",
            lease_id: null,
            generation: null,
            granted_tokens: null,
            refresh_interval_s: null,
            lease_length_s: null,
            headroom_share_tokens: null,
            posture: null,
            mode: "hard_deny",
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run_lease",
              reason: "manual_kill",
            },
          }),
        );
      }
      if (url === CHECK_URL) throw new TypeError("offline");
      throw new Error("unexpected test URL");
    });

    await expect(
      budget.checkBudget(leaseCheck(792, { estimatedInputTokens: 100, estimatedOutputBound: 500 })),
    ).resolves.toMatchObject({ allowed: true, leaseId: "lease-1" });
    await flushUntil(() => budget.hasStickyHardDeny);
    await expect(budget.checkBudget(leaseCheck(793))).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denyReason: "manual_kill",
    });
    expect(urls).toEqual([LEASE_URL, RENEW_URL, CHECK_URL]);
  });

  it("keeps hostile renewal transport and logger values out of diagnostics", async () => {
    const warnings: Array<{ message: string; args: unknown[] }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message, ...args) => warnings.push({ message, args }),
      error: () => {},
    };
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) {
          return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 0 }));
        }
        if (url === RENEW_URL) {
          const failure = new TransportNetworkError("caller-private-message");
          failure.name = "caller-private-name";
          throw failure;
        }
        throw new Error("unexpected test URL");
      },
      { logger },
    );

    await budget.checkBudget(
      leaseCheck(795, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(() => leaseState(budget)?.renewalInFlight === false);
    expect(warnings).toContainEqual({
      message: "lease.renew_failed: control_plane_unreachable",
      args: [],
    });
    expect(JSON.stringify(warnings)).not.toContain("caller-private");
  });
});

describe("BudgetEnforcer lease surrender lifecycle", () => {
  it("surrenders every holder concurrently, clears all authority, and is single-flight", async () => {
    const surrenderGates: Array<ReturnType<typeof deferred<Response>>> = [];
    const surrenderBodies: Array<Record<string, unknown>> = [];
    const budget = enforcer(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url === LEASE_URL) {
        const runId = String(body["agent_run_id"]);
        return jsonResponse(
          grant({ lease_id: `${runId}-lease`, granted_tokens: 3_000, refresh_interval_s: 300 }),
        );
      }
      if (url === SURRENDER_URL) {
        surrenderBodies.push(body);
        const gate = deferred<Response>();
        surrenderGates.push(gate);
        return gate.promise;
      }
      throw new Error("unexpected test URL");
    });

    const first = await budget.checkBudget(
      leaseCheck(801, {
        agentRunId: "run-close-a",
        estimatedInputTokens: 100,
        estimatedOutputBound: 500,
      }),
    );
    budget.buildConfirmRequest({
      leaseId: first.leaseId,
      leaseClaimToken: first.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 200 }),
      provider: "openai",
      callId: callId(801),
    });
    const second = await budget.checkBudget(
      leaseCheck(802, {
        agentRunId: "run-close-b",
        estimatedInputTokens: 100,
        estimatedOutputBound: 500,
      }),
    );
    expect(second.leaseClaimToken).not.toBeNull();

    const internal = budget as unknown as {
      leaseLedger: LeaseLedger;
      uncountedEpisodes: Map<string, unknown>;
    };
    internal.leaseLedger.markIneligible("run-close-ineligible", { now: 0, retryAfter: null });
    internal.uncountedEpisodes.set("run-close-episode", { lastWarnAt: 0 });

    const firstClose = budget.close();
    const secondClose = budget.close();
    expect(firstClose).toBe(secondClose);
    expect(budget.isClosed).toBe(true);
    await flushUntil(() => surrenderBodies.length === 2);
    expect(surrenderBodies).toEqual([
      {
        lease_id: "run-close-a-lease",
        holder_id: "sdk-instance-1",
        generation: 1,
        spent_tokens: 200,
      },
      {
        lease_id: "run-close-b-lease",
        holder_id: "sdk-instance-1",
        generation: 1,
        spent_tokens: 0,
      },
    ]);
    expect(leaseState(budget, "run-close-a")).toBeNull();
    expect(leaseState(budget, "run-close-b")).toBeNull();
    expect(internal.leaseLedger.activeRunIds()).toEqual([]);
    expect(internal.uncountedEpisodes.size).toBe(0);
    budget.releaseReservation(callId(802), second.leaseClaimToken ?? null);
    expect(internal.leaseLedger.activeRunIds()).toEqual([]);

    for (const gate of surrenderGates) gate.resolve(new Response(null, { status: 204 }));
    await expect(firstClose).resolves.toBeUndefined();
    await expect(budget[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(surrenderBodies).toHaveLength(2);
  });

  it("never rejects close when a surrender is refused or its transport fails", async () => {
    for (const reply of [
      () => new Response(null, { status: 503 }),
      () => Promise.reject(new TypeError("private surrender failure")),
    ]) {
      const budget = enforcer(async (url) => {
        if (url === LEASE_URL) return jsonResponse(grant({ refresh_interval_s: 300 }));
        if (url === SURRENDER_URL) return reply();
        throw new Error("unexpected test URL");
      });
      await budget.checkBudget(leaseCheck(810));
      await expect(budget.close()).resolves.toBeUndefined();
      expect(leaseState(budget)).toBeNull();
    }
  });

  it("bounds renewal joining and surrender fan-out by one absolute 1,000ms deadline", async () => {
    vi.useFakeTimers();
    const renewGate = deferred<Response>();
    const surrenderBodies: Array<Record<string, unknown>> = [];
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 0 }));
        }
        if (url === RENEW_URL) return renewGate.promise;
        if (url === SURRENDER_URL) {
          surrenderBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Promise<Response>(() => {});
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => performance.now() },
    );
    await budget.checkBudget(
      leaseCheck(820, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );

    let settled = false;
    const closing = budget.close().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(400);
    renewGate.resolve(jsonResponse(grant({ generation: 2, granted_tokens: 4_000 })));
    await flushUntil(() => surrenderBodies.length === 2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(599);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(performance.now()).toBe(1_000);
    vi.useRealTimers();
  });

  it("starts origin surrender while renewal is pending and detaches one late successor", async () => {
    vi.useFakeTimers();
    const renewGate = deferred<Response>();
    const surrenderBodies: Array<Record<string, unknown>> = [];
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          return jsonResponse(grant({ granted_tokens: 3_000, refresh_interval_s: 0 }));
        }
        if (url === RENEW_URL) return renewGate.promise;
        if (url === SURRENDER_URL) {
          surrenderBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => performance.now() },
    );
    await budget.checkBudget(
      leaseCheck(821, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    await flushUntil(
      () =>
        (budget as unknown as { renewalOperations: Set<Promise<void>> }).renewalOperations.size ===
        1,
    );

    const closing = budget.close(1_000);
    await flushUntil(() => surrenderBodies.length > 0);

    expect(surrenderBodies).toEqual([
      {
        lease_id: "lease-1",
        holder_id: "sdk-instance-1",
        generation: 1,
        spent_tokens: 0,
      },
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    renewGate.resolve(
      jsonResponse(grant({ lease_id: "lease-successor", generation: 2, granted_tokens: 4_000 })),
    );
    await flushUntil(() => surrenderBodies.length === 2);

    expect(surrenderBodies.map((body) => body["lease_id"])).toEqual(["lease-1", "lease-successor"]);
  });

  it("surrenders a valid grant that lands after close without installing it", async () => {
    const grantGate = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    const budget = enforcer(async (url, init) => {
      if (url === LEASE_URL) return grantGate.promise;
      if (url === SURRENDER_URL) {
        surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      if (url === CHECK_URL) return jsonResponse(checkResponse());
      throw new Error("unexpected test URL");
    });

    const checking = budget.checkBudget(leaseCheck(830));
    await flushUntil(() => leaseState(budget) !== null);
    await budget.close();
    grantGate.resolve(
      jsonResponse(
        grant({
          lease_id: "late-grant",
          generation: 7,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run_lease",
            reason: "must-not-land",
          },
        }),
      ),
    );
    await expect(checking).resolves.toMatchObject({ leaseId: null });
    await flushUntil(() => surrenders.length === 1);

    expect(leaseState(budget)).toBeNull();
    expect(runTermination("run_lease")).toBeUndefined();
    expect(surrenders).toEqual([
      {
        lease_id: "late-grant",
        holder_id: "sdk-instance-1",
        generation: 7,
        spent_tokens: 0,
      },
    ]);
  });

  it("surrenders a late renewal successor with only its close-captured spend delta", async () => {
    let now = 0;
    const renewGate = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    const budget = enforcer(
      async (url, init) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 4_000, refresh_interval_s: 10, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) return renewGate.promise;
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now },
    );

    const beforeSnapshot = await budget.checkBudget(
      leaseCheck(840, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    budget.buildConfirmRequest({
      leaseId: beforeSnapshot.leaseId,
      leaseClaimToken: beforeSnapshot.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 200 }),
      provider: "openai",
      callId: callId(840),
    });
    now = 20_000;
    const afterSnapshot = await budget.checkBudget(
      leaseCheck(841, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    budget.buildConfirmRequest({
      leaseId: afterSnapshot.leaseId,
      leaseClaimToken: afterSnapshot.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 300 }),
      provider: "openai",
      callId: callId(841),
    });

    const closing = budget.close();
    renewGate.resolve(
      jsonResponse(
        grant({
          lease_id: "late-successor",
          generation: 2,
          granted_tokens: 5_000,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run_lease",
            reason: "must-not-land",
          },
        }),
      ),
    );
    await closing;

    expect(surrenders).toEqual([
      {
        lease_id: "lease-1",
        holder_id: "sdk-instance-1",
        generation: 1,
        spent_tokens: 500,
      },
      {
        lease_id: "late-successor",
        holder_id: "sdk-instance-1",
        generation: 2,
        spent_tokens: 300,
      },
    ]);
    expect(leaseState(budget)).toBeNull();
    expect(runTermination("run_lease")).toBeUndefined();
  });

  it("forgets close-captured spend when a late renewal response is unreadable", async () => {
    let now = 0;
    const renewGate = deferred<Response>();
    const budget = enforcer(
      async (url) => {
        if (url === LEASE_URL) {
          return jsonResponse(
            grant({ granted_tokens: 4_000, refresh_interval_s: 10, lease_length_s: 600 }),
          );
        }
        if (url === RENEW_URL) return renewGate.promise;
        if (url === SURRENDER_URL) return new Response(null, { status: 204 });
        throw new Error("unexpected test URL");
      },
      { monotonicNow: () => now },
    );

    const first = await budget.checkBudget(
      leaseCheck(850, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    budget.buildConfirmRequest({
      leaseId: first.leaseId,
      leaseClaimToken: first.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 200 }),
      provider: "openai",
      callId: callId(850),
    });
    now = 20_000;
    const second = await budget.checkBudget(
      leaseCheck(851, { estimatedInputTokens: 100, estimatedOutputBound: 500 }),
    );
    budget.buildConfirmRequest({
      leaseId: second.leaseId,
      leaseClaimToken: second.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: 200 }),
      provider: "openai",
      callId: callId(851),
    });

    const closing = budget.close();
    renewGate.resolve(new Response("not-json", { status: 200 }));
    await closing;

    const internal = budget as unknown as { lateRenewalSpend: Map<string, number> };
    expect(internal.lateRenewalSpend.size).toBe(0);
  });
});
