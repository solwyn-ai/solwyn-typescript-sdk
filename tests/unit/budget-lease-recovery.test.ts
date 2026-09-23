import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, type BudgetEnforcerOptions } from "../../src/budget";
import type { LeaseLedger, LeaseState } from "../../src/lease";
import type { ReleaseDispatcher } from "../../src/release-dispatcher";
import { FakeControlPlane } from "../../src/testing/index";
import { createTokenDetails } from "../../src/token-details";
import type { LeaseGrantResponse } from "../../src/types";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const LEASE_URL = `${API_URL}/api/v1/budgets/lease`;
const RENEW_URL = `${API_URL}/api/v1/budgets/lease/renew`;
const SURRENDER_URL = `${API_URL}/api/v1/budgets/lease/surrender`;
const CHECK_URL = `${API_URL}/api/v1/budgets/check`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;
const RUN = "run_recovery";
const LATCH_MS = 150_000;

afterEach(() => {
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
    refresh_interval_s: 10,
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

/** A terminal answer with no lease block, as the control plane sends for an ineligible run. */
const INELIGIBLE: LeaseGrantResponse = {
  eligible: false,
  allowed: true,
  ineligible_reason: "zero_rate_model",
  project_id: PROJECT_ID,
  mode: "alert_only",
  budget_limit: 100,
  current_usage: 20,
  remaining_budget: 80,
};

const CHECK_ALLOW = {
  allowed: true,
  remaining_budget: 70,
  reservation_id: null,
  mode: "alert_only",
  budget_limit: 100,
  current_usage: 30,
  denied_by_period: null,
  project_id: PROJECT_ID,
  price_hints: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function flushUntil(predicate: () => boolean, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) {
    await Promise.resolve();
  }
}

interface Internal {
  leaseLedger: LeaseLedger;
  releases: ReleaseDispatcher;
  orphanedRuns: Set<string>;
  onRunOwnerCollected(runId: string): void;
  surrenderLateSuccessor(response: LeaseGrantResponse, spentTokens: number): void;
}

function internal(budget: BudgetEnforcer): Internal {
  return budget as unknown as Internal;
}

interface Harness {
  budget: BudgetEnforcer;
  clock: { now: number };
  urls: string[];
  renewals: Array<Record<string, unknown>>;
  surrenders: Array<Record<string, unknown>>;
  state(runId?: string): LeaseState | null;
  /** URLs requested since the previous call to `since`. */
  since(): string[];
}

interface Handlers {
  grant?: (index: number) => Response | Promise<Response>;
  renew?: (index: number) => Response | Promise<Response>;
  surrender?: (
    index: number,
    body: Record<string, unknown>,
    init?: RequestInit,
  ) => Response | Promise<Response>;
}

function harness(handlers: Handlers, overrides: Partial<BudgetEnforcerOptions> = {}): Harness {
  const clock = { now: 0 };
  const urls: string[] = [];
  const renewals: Array<Record<string, unknown>> = [];
  const surrenders: Array<Record<string, unknown>> = [];
  let grants = 0;
  let mark = 0;
  const budget = new BudgetEnforcer({
    apiUrl: API_URL,
    apiKey: API_KEY,
    leaseEnabled: true,
    holderId: "sdk-instance-1",
    monotonicNow: () => clock.now,
    fetch: async (url, init) => {
      urls.push(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url === LEASE_URL) {
        grants += 1;
        return handlers.grant ? handlers.grant(grants) : json(grant());
      }
      if (url === RENEW_URL) {
        renewals.push(body);
        return handlers.renew ? handlers.renew(renewals.length) : json(INELIGIBLE);
      }
      if (url === SURRENDER_URL) {
        surrenders.push(body);
        return handlers.surrender
          ? handlers.surrender(surrenders.length, body, init)
          : new Response(null, { status: 204 });
      }
      if (url === CHECK_URL) return json(CHECK_ALLOW);
      throw new Error("unexpected test URL");
    },
    ...overrides,
  });
  return {
    budget,
    clock,
    urls,
    renewals,
    surrenders,
    state: (runId = RUN) => internal(budget).leaseLedger.stateFor(runId),
    since: () => {
      const slice = urls.slice(mark);
      mark = urls.length;
      return slice;
    },
  };
}

function check(
  h: Harness,
  index: number,
  overrides: Partial<Parameters<BudgetEnforcer["checkBudget"]>[0]> = {},
) {
  return h.budget.checkBudget({
    callId: callId(index),
    estimatedInputTokens: 100,
    estimatedOutputBound: 500,
    model: "gpt-5.5",
    provider: "openai",
    agentRunId: RUN,
    ...overrides,
  });
}

function settle(
  h: Harness,
  index: number,
  result: { leaseId?: string | null; leaseClaimToken?: number | null },
  tokens: number,
) {
  h.budget.buildConfirmRequest({
    leaseId: result.leaseId ?? null,
    leaseClaimToken: result.leaseClaimToken ?? null,
    model: "gpt-5.5",
    tokenDetails: createTokenDetails({ input_tokens: tokens }),
    provider: "openai",
    callId: callId(index),
  });
}

/**
 * Grant lease-1 at t=0, settle 200 tokens and one uncounted call (50 tokens) before the renewal
 * captures its report at t=20 s, then settle 300 more tokens while the renewal is in flight, and
 * answer it eligible:false. Returns once the ineligible answer has been applied.
 */
async function refuseRenewal(
  h: Harness,
  renewAnswer: { resolve(value: Response): void },
  beforeAnswer: () => void = () => {},
): Promise<void> {
  h.clock.now = 0;
  const first = await check(h, 1);
  expect(first.leaseId).toBe("lease-1");
  internal(h.budget).leaseLedger.recordUncounted(RUN, 50);
  settle(h, 1, first, 200);
  h.clock.now = 20_000;
  const second = await check(h, 2);
  expect(second.leaseId).toBe("lease-1");
  await flushUntil(() => h.renewals.length === 1);
  expect(h.renewals[0]).toMatchObject({
    lease_id: "lease-1",
    generation: 1,
    spent_tokens: 200,
    uncounted_calls: 1,
    uncounted_tokens: 50,
  });
  settle(h, 2, second, 300);
  beforeAnswer();
  renewAnswer.resolve(json(INELIGIBLE));
  await flushUntil(() => h.state()?.leaseId === null);
}

describe("lease recovery after a grant 409", () => {
  it("keeps per-call checks for 150 seconds from the refusal, then grants again", async () => {
    const h = harness({
      grant: (index) =>
        index <= 2 ? new Response(null, { status: 409 }) : json(grant({ lease_id: "lease-3" })),
    });
    h.clock.now = 1_000;
    await check(h, 1);
    expect(h.since()).toEqual([LEASE_URL, CHECK_URL]);
    h.clock.now = 1_000 + LATCH_MS - 1;
    await check(h, 2);
    expect(h.since()).toEqual([CHECK_URL]);

    // A repeated 409 re-latches for another 150 s; one grant attempt per call, never a loop.
    h.clock.now = 1_000 + LATCH_MS;
    await check(h, 3);
    expect(h.since()).toEqual([LEASE_URL, CHECK_URL]);
    h.clock.now = 1_000 + 2 * LATCH_MS - 1;
    await check(h, 4);
    expect(h.since()).toEqual([CHECK_URL]);

    h.clock.now = 1_000 + 2 * LATCH_MS;
    await expect(check(h, 5)).resolves.toMatchObject({ leaseId: "lease-3" });
    expect(h.since()).toEqual([LEASE_URL]);
  });

  it("keeps the 30-second retry for a 503 grant refusal", async () => {
    const h = harness({ grant: () => new Response(null, { status: 503 }) });
    await check(h, 1);
    h.clock.now = 29_999;
    await check(h, 2);
    h.clock.now = 30_000;
    await check(h, 3);
    expect(h.urls).toEqual([LEASE_URL, CHECK_URL, CHECK_URL, LEASE_URL, CHECK_URL]);
  });
});

describe("lease recovery after an eligible:false renewal", () => {
  it("surrenders the held generation once, checks per call while pending, and re-grants after it is sent", async () => {
    const renewAnswer = deferred<Response>();
    const surrenderAnswer = deferred<Response>();
    const h = harness({
      grant: (index) =>
        json(
          index === 1
            ? grant()
            : grant({ lease_id: "lease-2", refresh_interval_s: 10, granted_tokens: 15_000 }),
        ),
      renew: (index) => (index === 1 ? renewAnswer.promise : json(grant({ lease_id: "lease-2" }))),
      surrender: () => surrenderAnswer.promise,
    });
    await refuseRenewal(h, renewAnswer);

    await flushUntil(() => h.surrenders.length === 1);
    expect(h.surrenders).toEqual([
      { lease_id: "lease-1", holder_id: "sdk-instance-1", generation: 1, spent_tokens: 300 },
    ]);
    // The refused renewal's report is settled and the surrender's spend is cleared at once.
    expect(h.state()).toMatchObject({
      leaseId: null,
      spentTokensSinceReport: 0,
      uncountedCalls: 0,
      uncountedTokens: 0,
      pendingReport: null,
    });

    // While the release is pending: per-call checks only, no grant, never a local allow.
    h.since();
    for (let index = 3; index <= 5; index++) {
      await expect(check(h, index)).resolves.toMatchObject({ leaseId: null });
    }
    expect(h.since()).toEqual([CHECK_URL, CHECK_URL, CHECK_URL]);

    surrenderAnswer.resolve(new Response(null, { status: 204 }));
    await internal(h.budget).releases.whenIdle();
    await expect(check(h, 6)).resolves.toMatchObject({ leaseId: "lease-2" });
    expect(h.since()).toEqual([LEASE_URL]);
    expect(h.surrenders).toHaveLength(1);

    // The re-granted lease's first renewal carries nothing from the old lease.
    h.clock.now = 60_000;
    await check(h, 7);
    await flushUntil(() => h.renewals.length === 2);
    expect(h.renewals[1]).toMatchObject({
      lease_id: "lease-2",
      generation: 1,
      spent_tokens: 0,
      uncounted_calls: 0,
      uncounted_tokens: 0,
    });
  });

  it.each([
    ["refused 409", () => new Response(null, { status: 409 })],
    ["refused 503", () => new Response(null, { status: 503 })],
    [
      "unreachable",
      () => {
        throw new TypeError("offline");
      },
    ],
  ] as const)("latches for 150 seconds from the refusal when the surrender is %s", async (_name, answer) => {
    const renewAnswer = deferred<Response>();
    const h = harness({
      grant: (index) => json(index === 1 ? grant() : grant({ lease_id: "lease-2" })),
      renew: () => renewAnswer.promise,
      surrender: answer,
    });
    await refuseRenewal(h, renewAnswer);
    await internal(h.budget).releases.whenIdle();
    expect(h.surrenders).toHaveLength(1);
    expect(internal(h.budget).releases.counts().sent).toBe(0);

    h.since();
    h.clock.now = 20_000 + LATCH_MS - 1;
    await check(h, 3);
    expect(h.since()).toEqual([CHECK_URL]);
    h.clock.now = 20_000 + LATCH_MS;
    await expect(check(h, 4)).resolves.toMatchObject({ leaseId: "lease-2" });
    expect(h.since()).toEqual([LEASE_URL]);
    expect(h.surrenders).toHaveLength(1);
  });

  it("latches for 150 seconds when the surrender times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const renewAnswer = deferred<Response>();
    const h = harness({
      grant: (index) => json(index === 1 ? grant() : grant({ lease_id: "lease-2" })),
      renew: () => renewAnswer.promise,
      surrender: (_index, _body, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await refuseRenewal(h, renewAnswer);
    await flushUntil(() => h.surrenders.length === 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushUntil(() => h.surrenders.length === 2);
    await vi.advanceTimersByTimeAsync(1_000);
    await internal(h.budget).releases.whenIdle();
    expect(internal(h.budget).releases.counts().dropped.timeout).toBe(1);

    h.since();
    h.clock.now = 20_000 + LATCH_MS - 1;
    await check(h, 3);
    expect(h.since()).toEqual([CHECK_URL]);
    h.clock.now = 20_000 + LATCH_MS;
    await expect(check(h, 4)).resolves.toMatchObject({ leaseId: "lease-2" });
  });

  it("latches for 150 seconds when the surrender overflows the release queue", async () => {
    const renewAnswer = deferred<Response>();
    const gate = deferred<Response>();
    const h = harness({
      grant: (index) => json(index === 1 ? grant() : grant({ lease_id: "lease-2" })),
      renew: () => renewAnswer.promise,
      surrender: () => gate.promise,
    });
    // Four requests in flight and 64 waiting when the refusal arrives.
    await refuseRenewal(h, renewAnswer, () => {
      for (let index = 0; index < 68; index++) {
        internal(h.budget).surrenderLateSuccessor(grant({ lease_id: `filler-${index}` }), 0);
      }
    });
    expect(h.surrenders.filter(({ lease_id }) => lease_id === "lease-1")).toEqual([]);
    expect(internal(h.budget).releases.counts().dropped.queue_full).toBe(1);

    h.since();
    h.clock.now = 20_000 + LATCH_MS - 1;
    await check(h, 3);
    expect(h.since()).toEqual([CHECK_URL]);
    h.clock.now = 20_000 + LATCH_MS;
    await expect(check(h, 4)).resolves.toMatchObject({ leaseId: "lease-2" });
    gate.resolve(new Response(null, { status: 204 }));
  });

  it("releases the run after 150 seconds when the outcome never arrives, and ignores the late outcome", async () => {
    const renewAnswer = deferred<Response>();
    const secondRenewAnswer = deferred<Response>();
    const hung = deferred<Response>();
    const secondSurrender = deferred<Response>();
    const h = harness({
      grant: (index) => json(index === 1 ? grant() : grant({ lease_id: "lease-2" })),
      renew: (index) => (index === 1 ? renewAnswer.promise : secondRenewAnswer.promise),
      // Ignores abort: the request keeps its dispatcher slot until it settles.
      surrender: (index) => (index === 1 ? hung.promise : secondSurrender.promise),
    });
    await refuseRenewal(h, renewAnswer);
    await flushUntil(() => h.surrenders.length === 1);
    expect(internal(h.budget).releases.active).toBe(1);

    h.since();
    h.clock.now = 20_000 + LATCH_MS - 1;
    await check(h, 3);
    expect(h.since()).toEqual([CHECK_URL]);
    h.clock.now = 20_000 + LATCH_MS;
    await expect(check(h, 4)).resolves.toMatchObject({ leaseId: "lease-2" });
    expect(h.since()).toEqual([LEASE_URL]);
    expect(internal(h.budget).releases.active).toBe(1);

    // First renewal on the re-granted lease: nothing from the old lease.
    h.clock.now = 20_000 + LATCH_MS + 20_000;
    await check(h, 5);
    await flushUntil(() => h.renewals.length === 2);
    expect(h.renewals[1]).toMatchObject({
      lease_id: "lease-2",
      spent_tokens: 0,
      uncounted_calls: 0,
      uncounted_tokens: 0,
    });

    // A newer refusal on lease-2: the old surrender's late success must not release it.
    secondRenewAnswer.resolve(json(INELIGIBLE));
    await flushUntil(() => h.surrenders.length === 2);
    const pending = h.state();
    expect(pending).toMatchObject({ leaseId: null, runIneligible: true });
    expect(internal(h.budget).releases.active).toBe(2);
    hung.resolve(new Response(null, { status: 204 }));
    await flushUntil(() => internal(h.budget).releases.active === 1);
    expect(internal(h.budget).releases.active).toBe(1);
    expect(h.state()).toBe(pending);
    expect(h.state()).toMatchObject({ leaseId: null, runIneligible: true });
    h.since();
    await check(h, 6);
    expect(h.since()).toEqual([CHECK_URL]);

    // The newer surrender is sent, so the next call re-grants at once.
    secondSurrender.resolve(new Response(null, { status: 204 }));
    await internal(h.budget).releases.whenIdle();
    await check(h, 7);
    expect(h.since()).toEqual([LEASE_URL]);
  });

  it("retires an orphaned run while its surrender is pending; the late outcome creates no state", async () => {
    const renewAnswer = deferred<Response>();
    const surrenderAnswer = deferred<Response>();
    const h = harness({
      renew: () => renewAnswer.promise,
      surrender: () => surrenderAnswer.promise,
    });
    const owner = {};
    h.budget.observeRun({ agentRunId: RUN, agentRunName: "recovery", lifetime: owner });
    const first = await check(h, 1, { runLifetime: owner });
    settle(h, 1, first, 200);
    h.clock.now = 20_000;
    const second = await check(h, 2, { runLifetime: owner });
    await flushUntil(() => h.renewals.length === 1);
    settle(h, 2, second, 300);
    internal(h.budget).onRunOwnerCollected(RUN);
    expect(h.state()).not.toBeNull();

    renewAnswer.resolve(json(INELIGIBLE));
    await flushUntil(() => h.surrenders.length === 1);
    expect(h.surrenders[0]).toMatchObject({ lease_id: "lease-1", generation: 1 });
    expect(h.state()).toBeNull();
    expect(internal(h.budget).orphanedRuns.has(RUN)).toBe(false);

    surrenderAnswer.resolve(new Response(null, { status: 204 }));
    await internal(h.budget).releases.whenIdle();
    expect(h.state()).toBeNull();
  });

  it("ignores an outcome that arrives after close() began", async () => {
    const renewAnswer = deferred<Response>();
    const surrenderAnswer = deferred<Response>();
    const h = harness({
      renew: () => renewAnswer.promise,
      surrender: () => surrenderAnswer.promise,
    });
    await refuseRenewal(h, renewAnswer);
    await flushUntil(() => h.surrenders.length === 1);
    const closing = h.budget.close();
    surrenderAnswer.resolve(new Response(null, { status: 204 }));
    await closing;
    expect(h.state()).toBeNull();
    expect(h.surrenders).toHaveLength(1);
  });

  it("keeps an eligible:false initial grant permanent without a surrender", async () => {
    const debug: unknown[][] = [];
    const h = harness(
      { grant: () => json(INELIGIBLE) },
      { logger: { debug: (...args) => debug.push(args), info() {}, warn() {}, error() {} } },
    );
    await check(h, 1);
    h.clock.now = Number.MAX_SAFE_INTEGER;
    await check(h, 2);
    expect(h.urls).toEqual([LEASE_URL, CHECK_URL, CHECK_URL]);
    expect(h.surrenders).toEqual([]);
    expect(debug).toContainEqual(["lease.grant_ineligible: reason=%s", "zero_rate_model"]);
  });

  it("logs the renewal's ineligible_reason at debug", async () => {
    const debug: unknown[][] = [];
    const renewAnswer = deferred<Response>();
    const h = harness(
      { renew: () => renewAnswer.promise },
      { logger: { debug: (...args) => debug.push(args), info() {}, warn() {}, error() {} } },
    );
    await refuseRenewal(h, renewAnswer);
    expect(debug).toContainEqual(["lease.renew_ineligible: reason=%s", "zero_rate_model"]);
  });
});

describe("lease recovery against FakeControlPlane", () => {
  it("surrenders the held generation after an ineligible renewal and re-grants a new lease", async () => {
    const plane = new FakeControlPlane({ grantedTokens: 15_000, refreshIntervalS: 10 });
    const clock = { now: 0 };
    // The plane counts an unknown model inside a renewal as zero-rate and answers eligible:false;
    // the wrapper makes this run's renewal name one, so the refusal comes from the plane itself.
    const fetch: typeof plane.fetch = (input, init) => {
      if (String(input).endsWith("/lease/renew") && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        body["model"] = "solwyn-test/lease-ineligible";
        return plane.fetch(input, { ...init, body: JSON.stringify(body) });
      }
      return plane.fetch(input, init);
    };
    const budget = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch,
      leaseEnabled: true,
      holderId: "sdk-instance-1",
      monotonicNow: () => clock.now,
    });
    const call = (index: number) =>
      budget.checkBudget({
        callId: callId(index),
        estimatedInputTokens: 100,
        estimatedOutputBound: 500,
        model: "gpt-4o",
        provider: "openai",
        agentRunId: RUN,
      });

    await expect(call(1)).resolves.toMatchObject({ leaseId: "lse_fake1" });
    clock.now = 20_000;
    await call(2);
    await flushUntil(() => plane.leaseRenewals.length === 1);
    await flushUntil(() => plane.leaseSurrenders.length === 1, 500);
    await internal(budget).releases.whenIdle();
    expect(plane.leaseSurrenders).toEqual([
      { lease_id: "lse_fake1", holder_id: "sdk-instance-1", generation: 1, spent_tokens: 0 },
    ]);
    expect(internal(budget).releases.counts().sent).toBe(1);

    await expect(call(3)).resolves.toMatchObject({ leaseId: "lse_fake2" });
    expect(plane.leaseGrants).toHaveLength(2);
    await budget.close();
  });
});
