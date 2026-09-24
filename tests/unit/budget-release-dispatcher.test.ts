import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, type BudgetEnforcerOptions } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import type { LeaseLedger, LeaseState } from "../../src/lease";
import type { Logger } from "../../src/logging";
import type { ReleaseDispatcher } from "../../src/release-dispatcher";
import { createTokenDetails } from "../../src/token-details";
import type { LeaseGrantResponse, LeaseSurrenderRequest } from "../../src/types";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const LEASE_URL = `${API_URL}/api/v1/budgets/lease`;
const SURRENDER_URL = `${API_URL}/api/v1/budgets/lease/surrender`;
const CHECK_URL = `${API_URL}/api/v1/budgets/check`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;

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
  retiringRuns: Map<string, object>;
  retirementBacklog: Set<string>;
  onRunOwnerCollected(runId: string): void;
  retireOrphanedRun(runId: string): void;
  queueSurrender(request: LeaseSurrenderRequest): void;
  surrenderLateSuccessor(response: LeaseGrantResponse, spentTokens: number): void;
}

function internal(budget: BudgetEnforcer): Internal {
  return budget as unknown as Internal;
}

/** Surrender handler plus the structural counters every test asserts. */
interface Harness {
  budget: BudgetEnforcer;
  surrenders: Array<Record<string, unknown>>;
  checks: number;
  grants: number;
  active: number;
  peak: number;
  warnings: Array<{ message: string; args: unknown[] }>;
}

function harness(
  surrender: (body: Record<string, unknown>, init?: RequestInit) => Promise<Response>,
  overrides: Partial<BudgetEnforcerOptions> = {},
): Harness {
  const warnings: Array<{ message: string; args: unknown[] }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, ...args) => warnings.push({ message, args }),
    error: () => {},
  };
  const state: Harness = {
    budget: undefined as unknown as BudgetEnforcer,
    surrenders: [],
    checks: 0,
    grants: 0,
    active: 0,
    peak: 0,
    warnings,
  };
  state.budget = new BudgetEnforcer({
    apiUrl: API_URL,
    apiKey: API_KEY,
    leaseEnabled: true,
    holderId: "sdk-instance-1",
    logger,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url === LEASE_URL) {
        state.grants += 1;
        return new Response(
          JSON.stringify(grant({ lease_id: `lease-${String(body["agent_run_id"])}` })),
        );
      }
      if (url === CHECK_URL) {
        state.checks += 1;
        return new Response(JSON.stringify(CHECK_ALLOW));
      }
      if (url === SURRENDER_URL) {
        state.surrenders.push(body);
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        try {
          return await surrender(body, init);
        } finally {
          state.active -= 1;
        }
      }
      throw new Error("unexpected test URL");
    },
    ...overrides,
  });
  return state;
}

/** A managed run that settled `spent` tokens on its lease and whose owner was then collected. */
async function orphan(budget: BudgetEnforcer, index: number, spent = 7): Promise<string> {
  const runId = `run-${index}`;
  const owner = {};
  budget.observeRun({ agentRunId: runId, agentRunName: "release", lifetime: owner });
  const result = await budget.checkBudget({
    callId: callId(index),
    estimatedInputTokens: 1,
    estimatedOutputBound: 1,
    model: "gpt-5.5",
    provider: "openai",
    agentRunId: runId,
    runLifetime: owner,
  });
  expect(result.leaseId).toBe(`lease-${runId}`);
  if (spent > 0) {
    budget.buildConfirmRequest({
      leaseId: result.leaseId,
      leaseClaimToken: result.leaseClaimToken,
      model: "gpt-5.5",
      tokenDetails: createTokenDetails({ input_tokens: spent }),
      provider: "openai",
      callId: callId(index),
    });
  } else {
    budget.releaseReservation(callId(index), result.leaseClaimToken ?? null);
  }
  return runId;
}

function unrelatedCheck(budget: BudgetEnforcer) {
  return budget.checkBudget({ provider: "openai", model: "gpt-5.5", estimatedInputTokens: 0 });
}

function totalDrops(budget: BudgetEnforcer): number {
  const counts = internal(budget).releases.counts();
  return Object.values(counts.dropped).reduce((sum, count) => sum + count, 0);
}

describe("bounded lease release dispatcher", () => {
  it("bounds a 128-release burst to 4 in flight and 64 pending, dropping and logging overflow", async () => {
    const gate = deferred<void>();
    const h = harness(async () => {
      await gate.promise;
      return new Response(null, { status: 204 });
    });
    const releases = internal(h.budget).releases;
    for (let index = 0; index < 128; index++) {
      // Late successors: spend-bearing and zero-spend surrenders share the same bounds.
      internal(h.budget).surrenderLateSuccessor(
        grant({ lease_id: `burst-${index}` }),
        index % 2 === 0 ? 100 + index : 0,
      );
    }
    await Promise.resolve();

    expect(h.peak).toBe(4);
    expect(releases.active).toBe(4);
    expect(releases.pending).toBe(64);
    expect(releases.counts().dropped.queue_full).toBe(60);
    expect(
      h.warnings.filter(({ message }) => message.startsWith("lease.surrenders_dropped")),
    ).toEqual([
      {
        message:
          "lease.surrenders_dropped: %s; unspent reserved tokens return when the leases expire",
        args: ["queue_full=60"],
      },
    ]);

    gate.resolve();
    await releases.whenIdle();
    const counts = releases.counts();
    expect(h.peak).toBe(4);
    expect(counts.sent).toBe(68);
    expect(counts.sent + counts.dropped.queue_full).toBe(128);
    expect(counts.enqueued).toBe(counts.sent + totalDrops(h.budget));
    expect(h.surrenders).toHaveLength(68);
    // A queued spend-bearing surrender is sent with its exact snapshot.
    expect(h.surrenders[4]).toEqual({
      lease_id: "burst-4",
      holder_id: "sdk-instance-1",
      generation: 1,
      spent_tokens: 104,
    });
  });

  it("retires a burst of 128 orphaned runs through 4 workers without overflow", async () => {
    const gate = deferred<void>();
    const h = harness(async () => {
      await gate.promise;
      return new Response(null, { status: 204 });
    });
    const runs: string[] = [];
    for (let index = 0; index < 128; index++) runs.push(await orphan(h.budget, index));
    for (const runId of runs) internal(h.budget).onRunOwnerCollected(runId);

    expect(h.peak).toBe(4);
    expect(internal(h.budget).releases.pending).toBe(0);
    expect(internal(h.budget).retirementBacklog.size).toBe(124);
    gate.resolve();
    await flushUntil(() => internal(h.budget).orphanedRuns.size === 0, 5_000);

    const counts = internal(h.budget).releases.counts();
    expect(counts.sent).toBe(128);
    expect(counts.enqueued).toBe(128);
    expect(totalDrops(h.budget)).toBe(0);
    expect(h.peak).toBe(4);
    expect(h.surrenders.every((body) => body["spent_tokens"] === 7)).toBe(true);
    for (const runId of runs) expect(internal(h.budget).leaseLedger.stateFor(runId)).toBeNull();
  });

  it.each([
    [503, 8],
    [503, 64],
    [409, 8],
    [409, 64],
    [404, 8],
    [404, 64],
  ])("drops %i-refused retirements once and keeps admission independent of %i histories", async (status, count) => {
    const breaker = new CircuitBreaker({ name: "control-plane", failureThreshold: 3 });
    const h = harness(async () => new Response(null, { status }), {
      controlPlaneBreaker: breaker,
    });
    for (let index = 0; index < count; index++) {
      internal(h.budget).onRunOwnerCollected(await orphan(h.budget, index));
    }
    await flushUntil(() => internal(h.budget).orphanedRuns.size === 0, 10_000);
    expect(h.surrenders).toHaveLength(count);

    const visits = vi.spyOn(internal(h.budget), "retireOrphanedRun");
    const before = h.surrenders.length;
    for (let call = 0; call < 20; call++) await unrelatedCheck(h.budget);
    await flushUntil(() => false, 200);
    // Per-call work does not depend on the number of refused histories.
    expect(visits).not.toHaveBeenCalled();
    expect(h.surrenders.length - before).toBe(0);
    expect(h.peak).toBeLessThanOrEqual(4);
    expect(internal(h.budget).leaseLedger.activeRunIds()).toEqual([]);
    // D2: an HTTP answer is control-plane reachability.
    expect(breaker.getState().state).toBe("closed");
    const counts = internal(h.budget).releases.counts();
    expect(counts.dropped.refused).toBe(count);
    expect(counts.enqueued).toBe(counts.sent + totalDrops(h.budget));
    await h.budget.close();
  });

  it("retries a timed-out surrender once within 2 s of enqueue and expires a queued item at its deadline", async () => {
    vi.useFakeTimers();
    const started: Array<{ lease: unknown; at: number }> = [];
    const breaker = new CircuitBreaker({ name: "control-plane", failureThreshold: 100 });
    const h = harness(
      (body, init) => {
        started.push({ lease: body["lease_id"], at: performance.now() });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      { monotonicNow: () => performance.now(), controlPlaneBreaker: breaker },
    );
    for (let index = 0; index < 5; index++) {
      internal(h.budget).surrenderLateSuccessor(grant({ lease_id: `slow-${index}` }), 0);
    }
    await vi.advanceTimersByTimeAsync(999);
    expect(started).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(started.filter(({ lease }) => lease === "slow-0").map(({ at }) => at)).toEqual([
      0, 1_000,
    ]);
    expect(started.some(({ lease }) => lease === "slow-4")).toBe(false);
    const counts = internal(h.budget).releases.counts();
    expect(counts.dropped.timeout).toBe(4);
    expect(counts.dropped.expired).toBe(1);
    expect(counts.enqueued).toBe(counts.sent + totalDrops(h.budget));
    expect(breaker.getState().failureCount).toBe(8);
  });

  it("gives a close-time surrender one attempt within the close deadline", async () => {
    vi.useFakeTimers();
    const h = harness(
      (_body, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { monotonicNow: () => performance.now() },
    );
    await h.budget.checkBudget({
      callId: callId(1),
      estimatedInputTokens: 1,
      estimatedOutputBound: 1,
      model: "gpt-5.5",
      provider: "openai",
      agentRunId: "run-close",
    });
    const closing = h.budget.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.surrenders).toHaveLength(1);
    expect(internal(h.budget).releases.counts().dropped.timeout).toBe(1);
  });

  it("drains close through at most 4 workers and reports the remainder in one WARN line", async () => {
    vi.useFakeTimers();
    const h = harness(() => new Promise<Response>(() => {}), {
      monotonicNow: () => performance.now(),
    });
    for (let index = 0; index < 10; index++) {
      await h.budget.checkBudget({
        callId: callId(index),
        estimatedInputTokens: 1,
        estimatedOutputBound: 1,
        model: "gpt-5.5",
        provider: "openai",
        agentRunId: `run-close-${index}`,
      });
    }
    let settled = false;
    const closing = h.budget.close().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    expect(h.surrenders).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(h.peak).toBe(4);
    expect(internal(h.budget).releases.counts().dropped.shutdown_deadline).toBe(6);
    const summaries = h.warnings.filter(({ message }) =>
      message.startsWith("lease.close_release_summary"),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.args.slice(0, 3)).toEqual([6, 4, "shutdown_deadline=6"]);
  });

  it("dispatches a late successor through the bounded dispatcher after close", async () => {
    const grantGate = deferred<Response>();
    const surrenders: Array<Record<string, unknown>> = [];
    const budget = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      holderId: "sdk-instance-1",
      fetch: async (url, init) => {
        if (url === LEASE_URL) return grantGate.promise;
        if (url === CHECK_URL) return new Response(JSON.stringify(CHECK_ALLOW));
        if (url === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected test URL");
      },
    });
    const checking = budget.checkBudget({
      callId: callId(1),
      estimatedInputTokens: 1,
      estimatedOutputBound: 1,
      model: "gpt-5.5",
      provider: "openai",
      agentRunId: "run-late",
    });
    await Promise.resolve();
    await budget.close();
    grantGate.resolve(new Response(JSON.stringify(grant({ lease_id: "late", generation: 3 }))));
    await checking;
    await internal(budget).releases.whenIdle();
    expect(surrenders.map((body) => body["lease_id"])).toEqual(["late"]);
    expect(internal(budget).releases.counts()).toMatchObject({ enqueued: 1, sent: 1 });
  });

  it("keeps a revived identity on per-call checks while its surrender is in the dispatcher", async () => {
    const gate = deferred<void>();
    const h = harness(async () => {
      await gate.promise;
      return new Response(null, { status: 204 });
    });
    const runId = await orphan(h.budget, 1);
    internal(h.budget).onRunOwnerCollected(runId);
    expect(internal(h.budget).retiringRuns.has(runId)).toBe(true);

    const during = await h.budget.checkBudget({
      provider: "openai",
      model: "gpt-5.5",
      estimatedInputTokens: 0,
      agentRunId: runId,
    });
    expect(during.leaseId).toBeNull();
    expect(h.checks).toBe(1);

    gate.resolve();
    await internal(h.budget).releases.whenIdle();
    expect(internal(h.budget).retiringRuns.has(runId)).toBe(false);
    expect(internal(h.budget).leaseLedger.stateFor(runId)?.hasLease).toBe(false);
  });

  it("aggregates, discards and logs uncounted runs without scanning them on admission", async () => {
    let now = 0;
    const h = harness(async () => new Response(null, { status: 204 }), {
      monotonicNow: () => now,
    });
    const ledger = internal(h.budget).leaseLedger;
    // A cold fail-open run holds tallies and no lease; another holds tallies and a live lease.
    const cold = "run-cold";
    ledger.recordUncounted(cold, 600);
    internal(h.budget).orphanedRuns.add(cold);
    const leased = await orphan(h.budget, 2, 0);
    ledger.recordUncounted(leased, 300);
    ledger.recordUncounted(leased, 300);

    const visits = vi.spyOn(internal(h.budget), "retireOrphanedRun");
    for (let call = 0; call < 5; call++) await unrelatedCheck(h.budget);
    expect(visits).not.toHaveBeenCalled();
    visits.mockRestore();

    internal(h.budget).onRunOwnerCollected(cold);
    internal(h.budget).onRunOwnerCollected(leased);
    await internal(h.budget).releases.whenIdle();
    await Promise.resolve();
    expect(ledger.stateFor(cold)).toBeNull();
    expect(ledger.stateFor(leased)).toBeNull();
    expect(h.surrenders.map((body) => body["lease_id"])).toEqual([`lease-${leased}`]);
    const aggregate = () =>
      h.warnings.filter(({ message }) => message.startsWith("lease.uncounted_discarded"));
    expect(aggregate().map(({ args }) => args)).toEqual([[1, 1, 600]]);

    // At most one aggregate WARN per 30 s; the rest carries to the next line and to close().
    await Promise.resolve();
    expect(aggregate().map(({ args }) => args)).toEqual([[1, 1, 600]]);
    now = 29_999;
    const later = "run-later";
    ledger.recordUncounted(later, 50);
    internal(h.budget).orphanedRuns.add(later);
    internal(h.budget).onRunOwnerCollected(later);
    await Promise.resolve();
    expect(aggregate()).toHaveLength(1);
    now = 30_000;
    const last = "run-last";
    ledger.recordUncounted(last, 10);
    internal(h.budget).orphanedRuns.add(last);
    internal(h.budget).onRunOwnerCollected(last);
    await Promise.resolve();
    expect(aggregate().map(({ args }) => args)).toEqual([
      [1, 1, 600],
      [3, 4, 660],
    ]);

    ledger.recordUncounted("run-open", 5);
    await h.budget.close();
    const summaries = h.warnings.filter(({ message }) =>
      message.startsWith("lease.close_release_summary"),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.args.slice(3)).toEqual([5, 6, 1265, 1]);
  });
});

describe("surrender attempt classification (D2)", () => {
  class CountingBreaker extends CircuitBreaker {
    admits = 0;
    successes = 0;
    failures = 0;
    override admit() {
      this.admits += 1;
      return super.admit();
    }
    override recordSuccess(...args: Parameters<CircuitBreaker["recordSuccess"]>) {
      this.successes += 1;
      super.recordSuccess(...args);
    }
    override recordFailure(...args: Parameters<CircuitBreaker["recordFailure"]>) {
      this.failures += 1;
      super.recordFailure(...args);
    }
  }

  it.each([
    ["network failure", () => Promise.reject(new TypeError("offline")), "unreachable", 0, 1],
    ["500", async () => new Response(null, { status: 500 }), "refused", 0, 1],
    ["503", async () => new Response(null, { status: 503 }), "refused", 1, 0],
    ["429", async () => new Response(null, { status: 429 }), "refused", 1, 0],
    ["409", async () => new Response(null, { status: 409 }), "refused", 1, 0],
    ["404", async () => new Response(null, { status: 404 }), "refused", 1, 0],
    ["204", async () => new Response(null, { status: 204 }), null, 1, 0],
  ] as const)("records %s once and never retries it", async (_label, reply, reason, successes, failures) => {
    const breaker = new CountingBreaker({ name: "control-plane", failureThreshold: 100 });
    const h = harness(reply, { controlPlaneBreaker: breaker });
    internal(h.budget).surrenderLateSuccessor(grant({ lease_id: "classified" }), 5);
    await internal(h.budget).releases.whenIdle();
    expect(h.surrenders).toHaveLength(1);
    expect(breaker.successes).toBe(successes);
    expect(breaker.failures).toBe(failures);
    const counts = internal(h.budget).releases.counts();
    if (reason === null) expect(counts.sent).toBe(1);
    else expect(counts.dropped[reason]).toBe(1);
  });

  it("skips the breaker for a local setup failure", async () => {
    const breaker = new CountingBreaker({ name: "control-plane" });
    const h = harness(async () => new Response(null, { status: 204 }), {
      controlPlaneBreaker: breaker,
    });
    internal(h.budget).queueSurrender({
      lease_id: "x".repeat(65),
      holder_id: "sdk-instance-1",
      generation: 1,
      spent_tokens: 0,
    });
    await internal(h.budget).releases.whenIdle();
    expect(h.surrenders).toHaveLength(0);
    expect(breaker.admits).toBe(0);
    expect(internal(h.budget).releases.counts().dropped.setup_failed).toBe(1);
  });
});

describe("lease state retirement fence", () => {
  it("keeps retirement off the admission path for an unrelated run", async () => {
    const h = harness(async () => new Response(null, { status: 204 }));
    const runId = await orphan(h.budget, 1);
    internal(h.budget).onRunOwnerCollected(runId);
    await internal(h.budget).releases.whenIdle();
    const state: LeaseState | null = internal(h.budget).leaseLedger.stateFor(runId);
    expect(state).toBeNull();
    expect(h.surrenders).toEqual([
      { lease_id: `lease-${runId}`, holder_id: "sdk-instance-1", generation: 1, spent_tokens: 7 },
    ]);
  });
});
