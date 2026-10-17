import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BudgetEnforcer,
  type BudgetEnforcerOptions,
  type CheckBudgetOptions,
} from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { ConfigurationError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import type { LeaseLedger } from "../../src/lease";
import { noopLogger } from "../../src/logging";
import { Deadline } from "../../src/routing";
import { createTokenDetails } from "../../src/token-details";
import type { LeaseGrantResponse } from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const API_URL = "https://api.solwyn.test";
const PROJECT_ID = `proj_${"0".repeat(24)}`;
const CALL_ID = "00000000-0000-0000-0000-000000000001";
const MAX_DELAY_S = 2_147_483_647 / 1000;

function grant(): LeaseGrantResponse {
  return {
    eligible: true,
    allowed: true,
    lease_id: "lease-preflight",
    generation: 1,
    granted_tokens: 5_000,
    refresh_interval_s: 20,
    lease_length_s: 120,
    headroom_share_tokens: 1_000,
    posture: { mode: "hard_deny", on_unreachable: "local_enforce" },
    final_grant: true,
    project_id: PROJECT_ID,
    mode: "hard_deny",
    budget_limit: 100,
    current_usage: 0,
    remaining_budget: 100,
  };
}

function options(overrides: Partial<CheckBudgetOptions> = {}): CheckBudgetOptions {
  return {
    estimatedInputTokens: 100,
    estimatedOutputBound: 500,
    model: "model-a",
    provider: "openai",
    agentRunId: "run-preflight",
    callId: CALL_ID,
    ...overrides,
  };
}

function enforcer(overrides: Partial<BudgetEnforcerOptions> = {}): BudgetEnforcer {
  return new BudgetEnforcer({ apiKey: API_KEY, apiUrl: API_URL, ...overrides });
}

function ledger(budget: BudgetEnforcer): LeaseLedger {
  return (budget as unknown as { leaseLedger: LeaseLedger }).leaseLedger;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("budget preflight deadline and cancellation", () => {
  it("shares one 500ms deadline across a lease refusal and a stalled per-call fallback", async () => {
    vi.useFakeTimers();
    const paths: string[] = [];
    const budget = enforcer({
      monotonicNow: () => Date.now(),
      fetch: async (url) => {
        paths.push(new URL(url).pathname);
        if (url.endsWith("/lease")) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return new Response(null, { status: 503 });
        }
        return new Promise<Response>(() => {});
      },
    });
    const start = Date.now();
    let elapsed = 0;
    const pending = budget.checkBudget(options({ timeout: 0.5 })).then((result) => {
      elapsed = Date.now() - start;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).allowed).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(550);
    expect(paths).toEqual(["/api/v1/budgets/lease", "/api/v1/budgets/check"]);
  });

  it.each([
    0, 1, 49,
  ])("skips a fallback with only %ims left without changing breaker health", async (remainingMs) => {
    vi.useFakeTimers();
    let monotonic = 0;
    const breaker = new CircuitBreaker();
    const failure = vi.spyOn(breaker, "recordFailure");
    const debug = vi.fn();
    const warn = vi.fn();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/lease")) {
        monotonic = 500 - remainingMs;
        return new Response(null, { status: 503 });
      }
      return new Promise<Response>(() => {});
    });
    const budget = enforcer({
      fetch,
      monotonicNow: () => monotonic,
      controlPlaneBreaker: breaker,
      logger: { ...noopLogger, debug, warn },
    });
    const pending = budget.checkBudget(options({ timeout: 0.5 }));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.allowed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    expect(breaker.getState()).toMatchObject({ state: "closed", lastFailureTime: null });
    expect(debug).toHaveBeenCalledWith("budget.check_skipped_deadline");
    expect(debug).not.toHaveBeenCalledWith("budget.check_skipped_breaker_open");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "budget.preflight_skipped_deadline: applying local policy (fail_open=%s)",
      true,
    );
    expect(result.warning).toBe(
      "Budget preflight deadline exhausted; proceeding in fail-open mode",
    );
    expect(ledger(budget).bookkeepingSize().claims).toBe(0);
  });

  it.each([
    true,
    false,
  ])("skips a short initial grant without an outage episode with failOpen=%s", async (failOpen) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(grant())));
    const warn = vi.fn();
    const debug = vi.fn();
    const breaker = new CircuitBreaker();
    const admit = vi.spyOn(breaker, "admit");
    const budget = enforcer({
      fetch,
      failOpen,
      controlPlaneBreaker: breaker,
      logger: { ...noopLogger, warn, debug },
    });

    const result = await budget.checkBudget(
      options({ timeout: 0.5, deadline: new Deadline(0.049, () => 0) }),
    );
    expect(result.allowed).toBe(failOpen);
    expect(result.warning).toContain("Budget preflight deadline exhausted");
    expect(result.warning).not.toContain("unreachable");
    expect(fetch).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "budget.preflight_skipped_deadline: applying local policy (fail_open=%s)",
      failOpen,
    );
    expect(debug).toHaveBeenCalledWith("lease.grant_skipped_deadline");
    expect(debug).toHaveBeenCalledWith("budget.check_skipped_deadline");
    expect(ledger(budget).bookkeepingSize().claims).toBe(0);
    expect(ledger(budget).stateFor("run-preflight")).toBeNull();
  });

  it.each([
    true,
    false,
  ])("rate-limits exhausted deadline warnings with leases=%s", async (leaseEnabled) => {
    let now = 0;
    const warn = vi.fn();
    const fetch = vi.fn(async () => new Response(JSON.stringify(grant())));
    const budget = enforcer({
      fetch,
      leaseEnabled,
      monotonicNow: () => now,
      logger: { ...noopLogger, warn },
    });
    for (const time of [0, 59_999, 60_000]) {
      now = time;
      const result = await budget.checkBudget(
        options({ callId: crypto.randomUUID(), deadline: new Deadline(0.049, () => 0) }),
      );
      expect(result.warning).toContain("Budget preflight deadline exhausted");
      expect(warn).toHaveBeenCalledTimes(time < 60_000 ? 1 : 2);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still dispatches an initial grant with exactly 50ms remaining", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(grant())));
    const budget = enforcer({ fetch, monotonicNow: () => 0 });
    const result = await budget.checkBudget(options({ timeout: 0.05 }));

    expect(result).toMatchObject({ allowed: true, leaseId: "lease-preflight", warning: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    budget.releaseReservation(CALL_ID, result.leaseClaimToken ?? null);
  });

  it.each([
    true,
    false,
  ])("preserves a live lease's headroom share on a local deadline with failOpen=%s", async (failOpen) => {
    let expiredDeadline = false;
    let deadlineReads = 0;
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ ...grant(), granted_tokens: 600 })),
    );
    const debug = vi.fn();
    const warn = vi.fn();
    const budget = enforcer({
      fetch,
      failOpen,
      monotonicNow: () => (expiredDeadline && ++deadlineReads > 1 ? 500 : 0),
      logger: { ...noopLogger, debug, warn },
    });
    const funded = await budget.checkBudget(options());
    budget.buildConfirmRequest({
      callId: CALL_ID,
      leaseId: funded.leaseId,
      leaseClaimToken: funded.leaseClaimToken,
      provider: "openai",
      model: "model-a",
      tokenDetails: createTokenDetails({ input_tokens: 100, output_tokens: 500 }),
    });
    expiredDeadline = true;
    const result = await budget.checkBudget(
      options({ callId: "00000000-0000-0000-0000-000000000002", timeout: 0.5 }),
    );

    expect(result).toMatchObject({ allowed: true, leaseId: null, reservationId: null });
    expect(result.warning).toContain("Budget preflight deadline exhausted");
    expect(result.warning).not.toContain("unreachable");
    expect(debug).toHaveBeenCalledWith("budget.check_skipped_deadline");
    expect(debug).not.toHaveBeenCalledWith("budget.check_skipped_breaker_open");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "budget.preflight_skipped_deadline: applying local policy (fail_open=%s)",
      failOpen,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ledger(budget).stateFor("run-preflight")).toMatchObject({
      grantedRemainingTokens: 0,
      shareRemainingTokens: 1_000,
      reservedTokens: 0,
      spentTokensSinceReport: 600,
    });
    expect(budget.getLocalCurrentSpend()).toBeCloseTo(0.003);
    expect(ledger(budget).bookkeepingSize().claims).toBe(0);
  });

  it.each([
    true,
    false,
  ])("skips network for an already-aborted signal with leaseEnabled=%s", async (leaseEnabled) => {
    const controller = new AbortController();
    const reason = new Error("cancelled before preflight");
    controller.abort(reason);
    const fetch = vi.fn(async () => new Response(JSON.stringify(grant())));
    const breaker = new CircuitBreaker();
    const failure = vi.spyOn(breaker, "recordFailure");
    const budget = enforcer({ fetch, leaseEnabled, controlPlaneBreaker: breaker });
    await expect(budget.checkBudget(options({ signal: controller.signal }))).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(ledger(budget).bookkeepingSize().claims).toBe(0);
  });

  it.each([
    true,
    false,
  ])("aborts an in-flight preflight neutrally with leaseEnabled=%s", async (leaseEnabled) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("cancelled during preflight");
    let transportSignal: AbortSignal | null | undefined;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      transportSignal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const breaker = new CircuitBreaker();
    const failure = vi.spyOn(breaker, "recordFailure");
    const budget = enforcer({ fetch, leaseEnabled, controlPlaneBreaker: breaker });
    const outcome = budget
      .checkBudget(options({ signal: controller.signal }))
      .catch((error: unknown) => error);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toBe(reason);
    expect(transportSignal?.aborted).toBe(true);
    expect(failure).not.toHaveBeenCalled();
    expect(ledger(budget).bookkeepingSize().claims).toBe(0);
  });

  it.each([
    [true, "before"],
    [false, "before"],
    [true, "during"],
    [false, "during"],
  ] as const)("normalizes a non-Error abort reason %s/%s preflight", async (leaseEnabled, timing) => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Promise<Response>(() => {}));
    const breaker = new CircuitBreaker();
    const budget = enforcer({ fetch, leaseEnabled, controlPlaneBreaker: breaker });
    if (timing === "before") controller.abort("cancelled");
    const outcome = budget
      .checkBudget(options({ signal: controller.signal }))
      .catch((error: unknown) => error);
    if (timing === "during") controller.abort("cancelled");

    const error = await outcome;
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "AbortError", message: "The operation was aborted." });
    expect(fetch).toHaveBeenCalledTimes(timing === "before" ? 0 : 1);
    expect(breaker.getState()).toMatchObject({ failureCount: 0, lastFailureTime: null });
    expect(ledger(budget).bookkeepingSize().claims).toBe(0);
  });

  it.each([
    "chat",
    "responses",
    "media",
  ] as const)("rejects an aborted %s call before budget network admission", async (surface) => {
    const create = vi.fn(
      async (_params: Record<string, unknown>, _options?: { signal?: AbortSignal }) => ({
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const fetch = vi.fn(async () => new Response(JSON.stringify(grant())));
    const client = new Solwyn(
      { chat: { completions: { create } }, responses: { create }, images: { generate: create } },
      {
        apiKey: API_KEY,
        apiUrl: API_URL,
        model: "gpt-4o",
        fetch,
        leaseEnabled: false,
        breakerReportingEnabled: false,
      },
    );
    const controller = new AbortController();
    const reason = new Error("cancelled provider request");
    controller.abort(reason);
    const request =
      surface === "chat"
        ? client.chat.completions.create(
            { model: "gpt-4o", messages: [] },
            { signal: controller.signal },
          )
        : surface === "responses"
          ? client.responses.create(
              { model: "gpt-4o", input: "synthetic" },
              { signal: controller.signal },
            )
          : client.images.generate(
              { model: "gpt-image-1", prompt: "synthetic" },
              { signal: controller.signal },
            );
    await expect(request).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await client.close();
  });
});

describe("direct budget enforcer safety", () => {
  it.each([
    NaN,
    Infinity,
    -1,
    MAX_DELAY_S + 1,
    true,
    false,
    null,
    "5",
  ])("rejects unsafe cacheTtl=%s", (cacheTtl) => {
    expect(() => enforcer({ cacheTtl: cacheTtl as number })).toThrow(
      expect.objectContaining({ name: "ConfigurationError", field: "cacheTtl" }),
    );
  });

  it.each([
    NaN,
    Infinity,
    0,
    0.001,
    0.04,
    0.049,
    -1,
    MAX_DELAY_S + 1,
    true,
    false,
    null,
    "5",
  ])("rejects unsafe timeout=%s before network I/O", async (timeout) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(grant())));
    const budget = enforcer({ fetch });
    await expect(budget.checkBudget(options({ timeout: timeout as number }))).rejects.toEqual(
      expect.objectContaining({ name: "ConfigurationError", field: "timeout" }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a generated call ID that settles its lease reservation", async () => {
    const budget = enforcer({ fetch: async () => new Response(JSON.stringify(grant())) });
    const result = await budget.checkBudget(options({ callId: undefined }));
    expect(result.callId).toMatch(/^[0-9a-f-]{36}$/);
    if (!result.callId)
      throw new ConfigurationError("expected generated call ID", { field: "callId" });
    budget.buildConfirmRequest({
      callId: result.callId,
      leaseId: result.leaseId,
      leaseClaimToken: result.leaseClaimToken,
      provider: "openai",
      model: "model-a",
      tokenDetails: createTokenDetails({ input_tokens: 100, output_tokens: 100 }),
    });
    expect(ledger(budget).stateFor("run-preflight")).toMatchObject({
      reservedTokens: 0,
      grantedRemainingTokens: 4_800,
      spentTokensSinceReport: 200,
    });
    expect(ledger(budget).bookkeepingSize()).toMatchObject({ claims: 0, expiries: 0 });
  });
});
