import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, type BudgetEnforcerOptions } from "../../src/budget";
import type { LeaseLedger, LeaseState } from "../../src/lease";
import type { ReleaseDispatcher } from "../../src/release-dispatcher";
import { FakeControlPlane } from "../../src/testing/index";
import type { LeaseGrantResponse } from "../../src/types";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const LEASE_URL = `${API_URL}/api/v1/budgets/lease`;
const RENEW_URL = `${API_URL}/api/v1/budgets/lease/renew`;
const SURRENDER_URL = `${API_URL}/api/v1/budgets/lease/surrender`;
const CHECK_URL = `${API_URL}/api/v1/budgets/check`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;
const RUN = "run_widening";

afterEach(() => {
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
    granted_tokens: 100_000,
    refresh_interval_s: 600,
    lease_length_s: 1_200,
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

async function flushUntil(predicate: () => boolean, turns = 300): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) {
    await Promise.resolve();
  }
}

interface Internal {
  leaseLedger: LeaseLedger;
  releases: ReleaseDispatcher;
  renewalOperations: Set<Promise<void>>;
}

function internal(budget: BudgetEnforcer): Internal {
  return budget as unknown as Internal;
}

type Body = Record<string, unknown>;

interface Handlers {
  grant?: (body: Body, index: number) => Response | Promise<Response>;
  renew?: (body: Body, index: number) => Response | Promise<Response>;
  check?: (body: Body, index: number) => Response | Promise<Response>;
}

interface Harness {
  budget: BudgetEnforcer;
  clock: { now: number };
  grants: Body[];
  renewals: Body[];
  surrenders: Body[];
  checks: Body[];
  state(runId?: string): LeaseState | null;
  /** URLs requested since the previous call to `since`. */
  since(): string[];
}

/** Each lease id is its grant's ordinal; a renewal answers the next generation of the same lease. */
function harness(handlers: Handlers = {}, overrides: Partial<BudgetEnforcerOptions> = {}): Harness {
  const clock = { now: 0 };
  const urls: string[] = [];
  const grants: Body[] = [];
  const renewals: Body[] = [];
  const surrenders: Body[] = [];
  const checks: Body[] = [];
  let mark = 0;
  const budget = new BudgetEnforcer({
    apiUrl: API_URL,
    apiKey: API_KEY,
    leaseEnabled: true,
    holderId: "sdk-instance-1",
    monotonicNow: () => clock.now,
    fetch: async (url, init) => {
      urls.push(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Body;
      if (url === LEASE_URL) {
        grants.push(body);
        return handlers.grant
          ? handlers.grant(body, grants.length)
          : json(grant({ lease_id: `lease-${grants.length}` }));
      }
      if (url === RENEW_URL) {
        renewals.push(body);
        return handlers.renew
          ? handlers.renew(body, renewals.length)
          : json(
              grant({
                lease_id: String(body["lease_id"]),
                generation: Number(body["generation"]) + 1,
              }),
            );
      }
      if (url === SURRENDER_URL) {
        surrenders.push(body);
        return new Response(null, { status: 204 });
      }
      if (url === CHECK_URL) {
        checks.push(body);
        return handlers.check ? handlers.check(body, checks.length) : json(CHECK_ALLOW);
      }
      throw new Error("unexpected test URL");
    },
    ...overrides,
  });
  return {
    budget,
    clock,
    grants,
    renewals,
    surrenders,
    checks,
    state: (runId = RUN) => internal(budget).leaseLedger.stateFor(runId),
    since: () => {
      const slice = urls.slice(mark);
      mark = urls.length;
      return slice;
    },
  };
}

type CheckOptions = Parameters<BudgetEnforcer["checkBudget"]>[0];

function check(h: Harness, index: number, overrides: Partial<CheckOptions> = {}) {
  return h.budget.checkBudget({
    callId: callId(index),
    estimatedInputTokens: 100,
    estimatedOutputBound: 500,
    model: "gpt-4o",
    provider: "openai",
    agentRunId: RUN,
    ...overrides,
  });
}

const MINI = { model: "gpt-4o-mini" } as const;
const ZERO = { model: "local-zero" } as const;

/** Every model any grant or renewal declared, in wire order. */
function declared(h: Harness): string[] {
  return [...h.grants, ...h.renewals].flatMap((body) => [
    ...(typeof body["model"] === "string" ? [body["model"]] : []),
    ...((body["fallback_models"] as string[] | undefined) ?? []),
  ]);
}

async function grantFirstModel(h: Harness): Promise<void> {
  await expect(check(h, 1)).resolves.toMatchObject({ leaseId: "lease-1" });
  expect(h.since()).toEqual([LEASE_URL]);
}

async function settleRenewals(h: Harness): Promise<void> {
  await flushUntil(() => internal(h.budget).renewalOperations.size === 0);
  expect(internal(h.budget).renewalOperations.size).toBe(0);
}

describe("lease widening to a newly seen model chain", () => {
  it("puts a second model on the lease after one allowed per-call check and one renewal", async () => {
    const h = harness();
    await grantFirstModel(h);

    await expect(check(h, 2, MINI)).resolves.toMatchObject({ allowed: true, leaseId: null });
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL]);
    expect(h.renewals).toEqual([
      expect.objectContaining({
        lease_id: "lease-1",
        generation: 1,
        model: "gpt-4o-mini",
        provider: "openai",
        fallback_providers: [],
        fallback_models: [],
      }),
    ]);
    expect([...(h.state()?.declaredModels ?? [])]).toEqual(["gpt-4o", "gpt-4o-mini"]);

    for (let index = 3; index <= 22; index += 1) {
      await expect(check(h, index, index % 2 === 0 ? MINI : {})).resolves.toMatchObject({
        leaseId: "lease-1",
      });
    }
    expect(h.since()).toEqual([]);
    expect(h.checks).toHaveLength(1);
    expect(h.grants).toHaveLength(1);
    expect(h.renewals).toHaveLength(1);
  });

  it("re-declares the call's full chain, and an allowed call covered only by the model still widens", async () => {
    const h = harness();
    await grantFirstModel(h);
    const chain: Partial<CheckOptions> = {
      model: "gpt-4o",
      fallbackProviders: ["anthropic", "openai"],
      fallbackModels: ["claude-sonnet-4-5", "gpt-4o-mini"],
    };

    await check(h, 2, chain);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL]);
    expect(h.renewals[0]).toMatchObject({
      model: "gpt-4o",
      provider: "openai",
      fallback_providers: ["anthropic", "openai"],
      fallback_models: ["claude-sonnet-4-5", "gpt-4o-mini"],
    });

    await expect(check(h, 3, chain)).resolves.toMatchObject({ leaseId: "lease-1" });
    await expect(check(h, 4, MINI)).resolves.toMatchObject({ leaseId: "lease-1" });
    expect(h.since()).toEqual([]);
  });

  it("sends one widening for N concurrent first calls, then serves the chain from the lease", async () => {
    const renewAnswer = deferred<Response>();
    const h = harness({ renew: () => renewAnswer.promise });
    await grantFirstModel(h);

    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, offset) => check(h, 10 + offset, MINI)),
    );
    expect(burst.every((result) => result.allowed && result.leaseId === null)).toBe(true);
    expect(h.checks).toHaveLength(8);
    expect(h.renewals).toHaveLength(1);

    renewAnswer.resolve(json(grant({ generation: 2 })));
    await settleRenewals(h);
    h.since();
    const next = await Promise.all(
      Array.from({ length: 8 }, (_, offset) => check(h, 20 + offset, MINI)),
    );
    expect(next.every((result) => result.leaseId === "lease-1")).toBe(true);
    expect(h.since()).toEqual([]);
    expect(h.renewals).toHaveLength(1);
  });

  it("never widens at admission: the renewal waits for the per-call check to allow", async () => {
    const checkAnswer = deferred<Response>();
    const h = harness({ check: () => checkAnswer.promise });
    await grantFirstModel(h);

    const pending = check(h, 2, MINI);
    await flushUntil(() => h.checks.length === 1);
    await Promise.resolve();
    expect(h.renewals).toHaveLength(0);

    checkAnswer.resolve(json(CHECK_ALLOW));
    await pending;
    await settleRenewals(h);
    expect(h.renewals).toHaveLength(1);
  });

  it("re-triggers from the next undeclared allowed call after a widening skipped at the worker cap", async () => {
    const gates: Array<ReturnType<typeof deferred<Response>>> = [];
    const h = harness({
      grant: (body) =>
        json(
          grant({
            lease_id: `${String(body["agent_run_id"])}-lease`,
            refresh_interval_s: body["agent_run_id"] === RUN ? 600 : 0,
          }),
        ),
      renew: (body) => {
        if (body["lease_id"] !== `${RUN}-lease`) {
          const gate = deferred<Response>();
          gates.push(gate);
          return gate.promise;
        }
        return json(grant({ lease_id: `${RUN}-lease`, generation: 2 }));
      },
    });
    await check(h, 1);
    // Four other runs hold every renewal worker (their refresh deadline is already due).
    for (let index = 0; index < 4; index += 1) {
      await check(h, 100 + index, { agentRunId: `run-cap-${index}` });
    }
    expect(internal(h.budget).renewalOperations.size).toBe(4);
    h.since();

    await expect(check(h, 2, MINI)).resolves.toMatchObject({ allowed: true, leaseId: null });
    expect(h.since()).toEqual([CHECK_URL]);
    expect(h.state()?.renewalInFlight).toBe(false);

    gates[0]?.resolve(new Response(null, { status: 503 }));
    await flushUntil(() => internal(h.budget).renewalOperations.size === 3);

    await check(h, 3, MINI);
    await flushUntil(() => h.state()?.declaredModels.has("gpt-4o-mini") === true);
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL]);
    await expect(check(h, 4, MINI)).resolves.toMatchObject({ leaseId: `${RUN}-lease` });
    expect(h.since()).toEqual([]);
    expect(h.checks.filter((body) => body["model"] === "gpt-4o-mini")).toHaveLength(2);
    for (const gate of gates) gate.resolve(new Response(null, { status: 503 }));
  });

  it("re-triggers from the next undeclared allowed call after a widening skipped during backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = harness({
      renew: (body, index) =>
        index === 1
          ? new Response(null, { status: 503 })
          : json(grant({ lease_id: "lease-1", generation: Number(body["generation"]) + 1 })),
    });
    await grantFirstModel(h);

    h.clock.now = 1_000;
    await check(h, 2, MINI);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL]);
    // The failed widening backs off for uniform(0, 1 s) = 0.5 s from t = 1 s.
    expect(h.state()?.nextAttemptAt).toBe(1.5);

    h.clock.now = 1_400;
    await check(h, 3, MINI);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL]);

    h.clock.now = 1_500;
    await check(h, 4, MINI);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL]);
    await expect(check(h, 5, MINI)).resolves.toMatchObject({ leaseId: "lease-1" });
    expect(h.since()).toEqual([]);
    expect(h.renewals).toHaveLength(2);
  });

  it("installs the smaller successor grant a widening to a pricier model returns", async () => {
    const h = harness({
      grant: () => json(grant({ granted_tokens: 1_600_000 })),
      renew: () => json(grant({ generation: 2, granted_tokens: 100_000 })),
    });
    await check(h, 1, MINI);
    expect(h.state()?.grantedTokens).toBe(1_600_000);
    await check(h, 2);
    await settleRenewals(h);
    expect(h.state()).toMatchObject({ generation: 2, grantedTokens: 100_000 });
    // The first call's 600-token reservation is still outstanding against the successor grant.
    expect(h.state()?.grantedRemainingTokens).toBe(100_000 - 600);
  });
});

describe("lease widening never fires outside an allowed per-call check", () => {
  it.each([
    [
      "an alert_only denial",
      () => json({ ...CHECK_ALLOW, allowed: false, denied_by_period: "monthly" }),
    ],
    [
      "a tag-scoped hard denial",
      () => json({ ...CHECK_ALLOW, allowed: false, mode: "hard_deny", denied_by_period: "tag" }),
    ],
    [
      "a 422 unknown model",
      () => json({ detail: { code: "unknown_model", message: "unknown" } }, 422),
    ],
    ["a 503 outage", () => new Response(null, { status: 503 })],
    ["an unreadable answer", () => new Response("not json", { status: 200 })],
  ] as const)("never widens after %s and leaves the lease intact", async (_name, answer) => {
    const h = harness({ check: answer });
    await grantFirstModel(h);

    await check(h, 2, MINI);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL]);
    expect(h.renewals).toHaveLength(0);
    expect(h.state()).toMatchObject({ leaseId: "lease-1", generation: 1, renewalInFlight: false });
    expect([...(h.state()?.declaredModels ?? [])]).toEqual(["gpt-4o"]);
    await expect(check(h, 3)).resolves.toMatchObject({ leaseId: "lease-1" });
  });

  it("never widens for a tagged call on an undeclared model", async () => {
    const h = harness();
    await grantFirstModel(h);

    await expect(check(h, 2, { ...MINI, tags: { team: "search" } })).resolves.toMatchObject({
      allowed: true,
    });
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL]);
    expect([...(h.state()?.declaredModels ?? [])]).toEqual(["gpt-4o"]);
  });

  it("never widens for a media call on an undeclared model", async () => {
    const h = harness();
    await grantFirstModel(h);

    await check(h, 2, { ...MINI, modality: "image" });
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL]);
  });

  it("never widens a final grant", async () => {
    const h = harness({ grant: () => json(grant({ final_grant: true })) });
    await grantFirstModel(h);

    await check(h, 2, MINI);
    await check(h, 3, MINI);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, CHECK_URL]);
  });
});

describe("a refused widening", () => {
  it("records only the added models and never declares them again, while the first model re-grants", async () => {
    const h = harness({
      renew: (body) =>
        declaredChain(body).includes("local-zero")
          ? json(INELIGIBLE)
          : json(grant({ lease_id: String(body["lease_id"]), generation: 2 })),
    });
    await grantFirstModel(h);

    // The chain's model is declared; only its fallback is added, and only it is refused.
    await check(h, 2, {
      model: "gpt-4o",
      fallbackProviders: ["openai"],
      fallbackModels: ["local-zero"],
    });
    await settleRenewals(h);
    await internal(h.budget).releases.whenIdle();
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL, SURRENDER_URL]);
    expect(h.surrenders).toEqual([
      { lease_id: "lease-1", holder_id: "sdk-instance-1", generation: 1, spent_tokens: 0 },
    ]);
    expect([...(h.state()?.refusedModels ?? [])]).toEqual(["local-zero"]);

    // The first model re-grants on its next call: it left the lease for no call at all.
    await expect(check(h, 3)).resolves.toMatchObject({ leaseId: "lease-2" });
    expect(h.since()).toEqual([LEASE_URL]);

    // Every chain naming the refused model stays per-call and triggers neither widening nor grant.
    await check(h, 4, ZERO);
    await check(h, 5, {
      model: "gpt-4o-mini",
      fallbackProviders: ["openai"],
      fallbackModels: ["local-zero"],
    });
    await check(h, 6, {
      model: "gpt-4o",
      fallbackProviders: ["openai"],
      fallbackModels: ["local-zero"],
    });
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, CHECK_URL, CHECK_URL]);

    // Other new chains still widen.
    await check(h, 7, MINI);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL]);
    await expect(check(h, 8, MINI)).resolves.toMatchObject({ leaseId: "lease-2" });

    expect(declared(h).filter((model) => model === "local-zero")).toHaveLength(1);
    expect(h.renewals.at(-1)).toMatchObject({ model: "gpt-4o-mini", fallback_models: [] });
  });

  it("keeps a refused chain off the grant while the run has no lease", async () => {
    const renewAnswer = deferred<Response>();
    const h = harness({ renew: () => renewAnswer.promise });
    await grantFirstModel(h);

    await check(h, 2, ZERO);
    renewAnswer.resolve(json(INELIGIBLE));
    await settleRenewals(h);
    await internal(h.budget).releases.whenIdle();
    expect(h.state()).toMatchObject({ leaseId: null, runIneligible: false });
    h.since();

    // No lease and no latch: a refused chain still never grants.
    await expect(check(h, 3, ZERO)).resolves.toMatchObject({ leaseId: null });
    expect(h.since()).toEqual([CHECK_URL]);
    await expect(check(h, 4)).resolves.toMatchObject({ leaseId: "lease-2" });
    expect(h.grants.map((body) => declaredChain(body))).toEqual([["gpt-4o"], ["gpt-4o"]]);
  });

  it("logs the refusal at debug", async () => {
    const debug: unknown[][] = [];
    const h = harness(
      { renew: () => json(INELIGIBLE) },
      { logger: { debug: (...args) => debug.push(args), info() {}, warn() {}, error() {} } },
    );
    await grantFirstModel(h);
    await check(h, 2, ZERO);
    await settleRenewals(h);
    expect(debug).toContainEqual(["lease.widen: added_models=%d", 1]);
    expect(debug).toContainEqual(["lease.renew_ineligible: reason=%s", "zero_rate_model"]);
    expect(debug).toContainEqual(["lease.widen_refused: models=%d", 1]);
  });
});

describe("a lease renewal retried after an unknown outcome", () => {
  const OTHER = { model: "claude-sonnet-4-5", provider: "anthropic" } as const;
  /** The first renewal reaches the plane, which applies it; its answer is lost. */
  const lostThenAnswer = (answer: (body: Body) => Response) => (body: Body, index: number) => {
    if (index === 1) throw new TypeError("fetch failed");
    return answer(body);
  };
  /** A retry of generation 1 gets the answer the plane stored for the first request. */
  const replayApplied = (body: Body) =>
    json(grant({ lease_id: "lease-1", generation: Number(body["generation"]) + 1 }));

  it("never covers a chain the plane was not sent, and the retry re-declares the first chain", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = harness({ renew: lostThenAnswer(replayApplied) });
    await grantFirstModel(h);

    h.clock.now = 1_000;
    await check(h, 2, MINI);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL]);
    expect(h.state()).toMatchObject({ generation: 1, renewalInFlight: false });

    // Past the backoff, a call on another undeclared chain is allowed per call.
    h.clock.now = 2_000;
    await expect(check(h, 3, OTHER)).resolves.toMatchObject({ allowed: true, leaseId: null });
    await settleRenewals(h);
    // That chain is not on the lease: the next call on it still takes a per-call check.
    await expect(check(h, 4, OTHER)).resolves.toMatchObject({ allowed: true, leaseId: null });
    expect(h.state()?.covers(OTHER.model, [])).toBe(false);
    // Its models never ride on the owed retry: it claims nothing.
    expect(h.renewals.map((body) => [body["generation"], declaredChain(body)])).toEqual([
      [1, ["gpt-4o-mini"]],
    ]);
    expect(h.since()).toEqual([CHECK_URL, CHECK_URL]);

    // The next renewal at the same generation, claimed by a gpt-4o call, re-sends the first chain.
    h.clock.now = 601_000;
    await expect(check(h, 5)).resolves.toMatchObject({ leaseId: "lease-1" });
    await settleRenewals(h);
    expect(h.since()).toEqual([RENEW_URL]);
    expect(h.renewals[1]).toMatchObject({
      lease_id: "lease-1",
      generation: 1,
      model: "gpt-4o-mini",
      provider: "openai",
      fallback_providers: [],
      fallback_models: [],
    });
    expect(h.state()?.generation).toBe(2);
    expect([...(h.state()?.declaredModels ?? [])]).toEqual(["gpt-4o", "gpt-4o-mini"]);
    await expect(check(h, 6, MINI)).resolves.toMatchObject({ leaseId: "lease-1" });
    expect(h.since()).toEqual([]);

    // The other chain now widens on its own, at the new generation.
    await check(h, 7, OTHER);
    await settleRenewals(h);
    expect(h.since()).toEqual([CHECK_URL, RENEW_URL]);
    expect(h.renewals[2]).toMatchObject({
      generation: 2,
      model: "claude-sonnet-4-5",
      provider: "anthropic",
    });
    await expect(check(h, 8, OTHER)).resolves.toMatchObject({ leaseId: "lease-1" });
  });

  it("records the retried widening's added models when the retry is refused", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = harness({ renew: lostThenAnswer(() => json(INELIGIBLE)) });
    await grantFirstModel(h);

    h.clock.now = 1_000;
    await check(h, 2, MINI);
    await settleRenewals(h);

    // An ordinary renewal claimed by a gpt-4o call retries the widening, and is refused.
    h.clock.now = 601_000;
    await check(h, 3);
    await settleRenewals(h);
    await internal(h.budget).releases.whenIdle();
    expect(h.renewals.map((body) => [body["generation"], declaredChain(body)])).toEqual([
      [1, ["gpt-4o-mini"]],
      [1, ["gpt-4o-mini"]],
    ]);
    expect([...(h.state()?.refusedModels ?? [])]).toEqual(["gpt-4o-mini"]);
    expect(h.surrenders).toEqual([expect.objectContaining({ lease_id: "lease-1", generation: 1 })]);
  });
});

function declaredChain(body: Body): string[] {
  return [
    ...(typeof body["model"] === "string" ? [body["model"]] : []),
    ...((body["fallback_models"] as string[] | undefined) ?? []),
  ];
}

describe("lease widening against FakeControlPlane", () => {
  it("surrenders the held generation after a widening to a zero-rate model, then re-grants", async () => {
    const plane = new FakeControlPlane({ grantedTokens: 15_000 });
    const budget = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch: plane.fetch,
      leaseEnabled: true,
      holderId: "sdk-instance-1",
      monotonicNow: () => 0,
    });
    const call = (index: number, model: string) =>
      budget.checkBudget({
        callId: callId(index),
        estimatedInputTokens: 100,
        estimatedOutputBound: 500,
        model,
        provider: "openai",
        agentRunId: RUN,
      });
    const settled = async () => {
      await flushUntil(() => internal(budget).renewalOperations.size === 0);
      await internal(budget).releases.whenIdle();
    };

    await expect(call(1, "gpt-4o")).resolves.toMatchObject({ leaseId: "lse_fake1" });
    // The per-call check allows the model; the plane refuses it inside the lease.
    await expect(call(2, "solwyn-test/lease-ineligible")).resolves.toMatchObject({
      allowed: true,
      leaseId: null,
    });
    await settled();
    expect(plane.leaseRenewals).toHaveLength(1);
    expect(plane.leaseRenewals[0]).toMatchObject({ model: "solwyn-test/lease-ineligible" });
    expect(plane.leaseSurrenders).toEqual([
      { lease_id: "lse_fake1", holder_id: "sdk-instance-1", generation: 1, spent_tokens: 0 },
    ]);
    expect(internal(budget).releases.counts().sent).toBe(1);

    await expect(call(3, "gpt-4o")).resolves.toMatchObject({ leaseId: "lse_fake2" });
    await call(4, "solwyn-test/lease-ineligible");
    await call(5, "gpt-4o-mini");
    await settled();
    await expect(call(6, "gpt-4o-mini")).resolves.toMatchObject({ leaseId: "lse_fake2" });

    expect(plane.leaseGrants).toHaveLength(2);
    expect(plane.leaseRenewals).toHaveLength(2);
    expect(
      [...plane.leaseGrants, ...plane.leaseRenewals.slice(1)].flatMap((body) => [
        body.model,
        ...(body.fallback_models ?? []),
      ]),
    ).not.toContain("solwyn-test/lease-ineligible");
    expect(plane.checks.map((body) => body.model)).toEqual([
      "solwyn-test/lease-ineligible",
      "solwyn-test/lease-ineligible",
      "gpt-4o-mini",
    ]);
    await budget.close();
  });
});
