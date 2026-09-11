import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, type BudgetEnforcerOptions, budgetCheckResult } from "../../src/budget";
import {
  CircuitBreaker,
  type CircuitBreakerAdmission,
  type CircuitBreakerOptions,
} from "../../src/circuit-breaker";
import { RunStoppedError } from "../../src/errors";
import type { LeaseLedger, LeaseState } from "../../src/lease";
import type { Logger } from "../../src/logging";
import {
  acquireTerminationHandle,
  clearRunTermination,
  markTerminated,
  resetRunControlForTest,
  runObservedAt,
  runTermination,
  setRunControlClockForTest,
} from "../../src/run-control";
import type { BudgetCheckResponse, LeaseGrantResponse } from "../../src/types";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const CHECK_URL = `${API_URL}/api/v1/budgets/check`;
const LEASE_URL = `${API_URL}/api/v1/budgets/lease`;
const RENEW_URL = `${API_URL}/api/v1/budgets/lease/renew`;
const SURRENDER_URL = `${API_URL}/api/v1/budgets/lease/surrender`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;

interface CapturedLog {
  readonly message: string;
  readonly args: readonly unknown[];
}

function capturingLogger(): { logger: Logger; warn: CapturedLog[]; error: CapturedLog[] } {
  const warn: CapturedLog[] = [];
  const error: CapturedLog[] = [];
  return {
    warn,
    error,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message, ...args) => warn.push({ message, args }),
      error: (message, ...args) => error.push({ message, args }),
    },
  };
}

function checkResponse(overrides: Partial<BudgetCheckResponse> = {}): BudgetCheckResponse {
  return {
    allowed: true,
    remaining_budget: 90,
    reservation_id: "reservation-1",
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 10,
    denied_by_period: null,
    project_id: PROJECT_ID,
    price_hints: null,
    ...overrides,
  };
}

function leaseResponse(overrides: Partial<LeaseGrantResponse> = {}): LeaseGrantResponse {
  return {
    eligible: true,
    allowed: true,
    lease_id: "lease-a",
    generation: 1,
    granted_tokens: 10_000,
    refresh_interval_s: 300,
    lease_length_s: 600,
    headroom_share_tokens: 2_000,
    posture: { mode: "alert_only", on_unreachable: "fail_open" },
    final_grant: false,
    project_id: PROJECT_ID,
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 10,
    remaining_budget: 90,
    ...overrides,
  };
}

function leaseDenial(overrides: Partial<LeaseGrantResponse> = {}): LeaseGrantResponse {
  return leaseResponse({
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

async function flushUntil(predicate: () => boolean, turns = 100): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) await Promise.resolve();
}

function callId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function checkOptions(runId = "run-a", index = 1) {
  return {
    estimatedInputTokens: 100,
    estimatedOutputBound: 500,
    model: "gpt-5.5",
    provider: "openai" as const,
    fallbackProviders: ["anthropic" as const],
    fallbackModels: ["claude-opus-4"],
    agentRunId: runId,
    callId: callId(index),
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
    leaseEnabled: false,
    cacheTtl: 0,
    holderId: "holder-1",
    ...overrides,
  });
}

interface InternalBudget {
  allowCache: Map<string, unknown>;
  leaseLedger: LeaseLedger;
  runHardDenyResponses: Map<string, { response: BudgetCheckResponse; observedAt: number }>;
  renewalOperations: Set<Promise<void>>;
}

function internal(value: BudgetEnforcer): InternalBudget {
  return value as unknown as InternalBudget;
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

beforeEach(() => resetRunControlForTest());
afterEach(() => {
  resetRunControlForTest();
  vi.restoreAllMocks();
});

describe("BudgetEnforcer run-directive transaction", () => {
  it("sends the v1 run-directive opt-in on an actual budget check", async () => {
    let body: Record<string, unknown> | undefined;
    const budget = enforcer(async (url, init) => {
      expect(String(url)).toBe(CHECK_URL);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(checkResponse());
    });

    await budget.checkBudget(checkOptions());

    expect(body?.["run_directive_version"]).toBe("1");
  });

  it.each([
    ["allow", {}],
    ["alert-only deny", { allowed: false, mode: "alert_only", denied_by_period: "monthly" }],
    ["hard deny", { allowed: false, mode: "hard_deny", denied_by_period: "monthly" }],
  ] as const)("normalizes a matching directive on a %s and shares one observation stamp", async (_label, overrides) => {
    let clockReads = 0;
    setRunControlClockForTest(() => {
      clockReads += 1;
      return 41;
    });
    const budget = enforcer(async () =>
      jsonResponse(
        checkResponse({
          ...overrides,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-a",
            reason: "manual_kill",
          },
        }),
      ),
    );

    const result = await budget.checkBudget(checkOptions());
    const sticky = internal(budget).runHardDenyResponses.get("run-a");

    expect(result).toMatchObject({
      allowed: false,
      reservationId: null,
      mode: "hard_deny",
      deniedByPeriod: "run_stopped",
      denySource: "server",
      denyReason: "manual_kill",
    });
    expect(runTermination("run-a")).toMatchObject({
      reason: "manual_kill",
      source: "server",
    });
    expect(sticky?.observedAt).toBe(41);
    expect(runObservedAt("run-a")).toBe(41);
    expect(clockReads).toBe(1);
  });

  it("keeps the first server reason on repeated matching directives", async () => {
    let reason = "first_reason";
    const budget = enforcer(async () =>
      jsonResponse(
        checkResponse({
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-a",
            reason,
          },
        }),
      ),
    );

    const first = await budget.checkBudget(checkOptions("run-a", 1));
    reason = "second_reason";
    const second = await budget.checkBudget(checkOptions("run-a", 2));

    expect([first.denyReason, second.denyReason]).toEqual(["first_reason", "first_reason"]);
    expect(internal(budget).runHardDenyResponses.get("run-a")?.response.run_control?.reason).toBe(
      "first_reason",
    );
  });

  it("preserves a local first writer while retaining the matching server reason in the sticky", async () => {
    markTerminated("run-a", { reason: "velocity:repeat_size", source: "local_velocity" });
    const budget = enforcer(async () =>
      jsonResponse(
        checkResponse({
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-a",
            reason: "manual_kill",
          },
        }),
      ),
    );

    const result = await budget.checkBudget(checkOptions());

    expect(runTermination("run-a")).toMatchObject({
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    expect(result).toMatchObject({ denySource: "server", denyReason: "manual_kill" });
    expect(internal(budget).runHardDenyResponses.get("run-a")?.response.run_control?.reason).toBe(
      "manual_kill",
    );
  });

  it.each([
    [true, true, "Cloud API unreachable; proceeding in fail-open mode"],
    [
      false,
      false,
      "Cloud unreachable and no prior budget limit known; denying request (fail-closed)",
    ],
  ] as const)("treats a misrouted stopped check as drift under failOpen=%s without state mutation", async (failOpen, allowed, warning) => {
    const log = capturingLogger();
    const breaker = new CountingBreaker({ failureThreshold: 1, successThreshold: 1 });
    const budget = enforcer(
      async () =>
        jsonResponse(
          checkResponse({
            allowed: false,
            mode: "hard_deny",
            denied_by_period: "run_stopped",
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-other",
              reason: "foreign",
            },
          }),
        ),
      { failOpen, logger: log.logger, controlPlaneBreaker: breaker },
    );

    const result = await budget.checkBudget(checkOptions());

    expect(result).toMatchObject({ allowed, warning });
    expect(runTermination("run-a")).toBeUndefined();
    expect(runTermination("run-other")).toBeUndefined();
    expect(budget.hasStickyHardDeny).toBe(false);
    expect(breaker.getState()).toMatchObject({ state: "closed", failureCount: 0 });
    expect([breaker.successes, breaker.failures, breaker.releases]).toEqual([1, 0, 1]);
    expect(log.warn).toContainEqual({
      message:
        "run_control.directive_run_mismatch: request_agent_run_id=%s directive_agent_run_id=%s",
      args: ["run-a", "run-other"],
    });
    expect(log.error).toEqual([
      {
        message:
          "budget.check_directive_misrouted: request_agent_run_id=%s directive_agent_run_id=%s — possible server contract drift; enforcement degraded (fail_open=%s)",
        args: ["run-a", "run-other", failOpen],
      },
    ]);
  });

  it.each([
    [
      "scoped",
      "run-request",
      "allow",
      {
        allowed: true,
        mode: "alert_only",
        denied_by_period: null,
        reservation_id: "ordinary-allow",
      },
      { allowed: true, mode: "alert_only", deniedByPeriod: null, denySource: null },
    ],
    [
      "unscoped",
      undefined,
      "allow",
      {
        allowed: true,
        mode: "alert_only",
        denied_by_period: null,
        reservation_id: "ordinary-allow",
      },
      { allowed: true, mode: "alert_only", deniedByPeriod: null, denySource: null },
    ],
    [
      "scoped",
      "run-request",
      "alert-only deny",
      {
        allowed: false,
        mode: "alert_only",
        denied_by_period: "weekly",
        budget_limit: 211,
        current_usage: 210,
        remaining_budget: 1,
      },
      { allowed: true, mode: "alert_only", deniedByPeriod: null, denySource: null },
    ],
    [
      "unscoped",
      undefined,
      "alert-only deny",
      {
        allowed: false,
        mode: "alert_only",
        denied_by_period: "weekly",
        budget_limit: 211,
        current_usage: 210,
        remaining_budget: 1,
      },
      { allowed: true, mode: "alert_only", deniedByPeriod: null, denySource: null },
    ],
    [
      "scoped",
      "run-request",
      "hard deny",
      {
        allowed: false,
        mode: "hard_deny",
        denied_by_period: "monthly",
        budget_limit: 311,
        current_usage: 311,
        remaining_budget: 0,
      },
      {
        allowed: false,
        mode: "hard_deny",
        deniedByPeriod: "monthly",
        denySource: "server",
      },
    ],
    [
      "unscoped",
      undefined,
      "hard deny",
      {
        allowed: false,
        mode: "hard_deny",
        denied_by_period: "monthly",
        budget_limit: 311,
        current_usage: 311,
        remaining_budget: 0,
      },
      {
        allowed: false,
        mode: "hard_deny",
        deniedByPeriod: "monthly",
        denySource: "server",
      },
    ],
  ] as const)("projects an ordinary foreign %s/%s only for its current check, without retained authority", async (_scope, agentRunId, _label, ordinary, expected) => {
    let calls = 0;
    const log = capturingLogger();
    const budget = enforcer(
      async (url, init) => {
        calls += 1;
        expect(String(url)).toBe(CHECK_URL);
        const request = JSON.parse(String(init?.body)) as { agent_run_id?: string };
        expect(request.agent_run_id).toBe(agentRunId);
        if (calls === 1) {
          return jsonResponse(
            checkResponse({
              ...ordinary,
              run_control: {
                version: "1",
                action: "terminate",
                agent_run_id: "run-other",
                reason: "foreign",
              },
            }),
          );
        }
        throw new TypeError("offline");
      },
      { cacheTtl: 60, logger: log.logger },
    );
    const options = { ...checkOptions("run-request", 1), agentRunId };

    try {
      expect(await budget.checkBudget(options)).toMatchObject(expected);
      expect(budget.lastKnownBudget).toBeNull();
      expect(budget.lastKnownUsage).toBeNull();
      expect(internal(budget).allowCache).toHaveLength(0);
      expect(budget.hasStickyHardDeny).toBe(false);
      expect(runTermination("run-request")).toBeUndefined();
      expect(runTermination("run-other")).toBeUndefined();

      expect(await budget.checkBudget({ ...options, callId: callId(2) })).toMatchObject({
        allowed: true,
        warning: "Cloud API unreachable; proceeding in fail-open mode",
        deniedByPeriod: null,
        denySource: null,
      });
      expect(calls).toBe(2);
      expect(runTermination("run-request")).toBeUndefined();
      expect(runTermination("run-other")).toBeUndefined();
      expect(log.warn).toContainEqual({
        message:
          "run_control.directive_run_mismatch: request_agent_run_id=%s directive_agent_run_id=%s",
        args: [agentRunId, "run-other"],
      });
      expect(log.warn).toContainEqual({
        message: "Cloud API budget check failed: %s",
        args: ["TransportNetworkError"],
      });
    } finally {
      await budget.close();
    }
  });

  it.each([
    [
      "global",
      undefined,
      "allow",
      { allowed: true, mode: "alert_only" },
      { allowed: true, mode: "alert_only", deniedByPeriod: null, denySource: null },
    ],
    [
      "global",
      undefined,
      "alert-only deny",
      { allowed: false, mode: "alert_only", denied_by_period: "weekly" },
      { allowed: true, mode: "alert_only", deniedByPeriod: null, denySource: null },
    ],
    [
      "global",
      undefined,
      "hard deny",
      { allowed: false, mode: "hard_deny", denied_by_period: "daily" },
      { allowed: false, mode: "hard_deny", deniedByPeriod: "daily", denySource: "server" },
    ],
    [
      "run-scoped",
      "run-a",
      "allow",
      { allowed: true, mode: "alert_only" },
      { allowed: true, mode: "alert_only", deniedByPeriod: null, denySource: null },
    ],
    [
      "run-scoped",
      "run-a",
      "alert-only deny",
      { allowed: false, mode: "alert_only", denied_by_period: "weekly" },
      { allowed: true, mode: "alert_only", deniedByPeriod: null, denySource: null },
    ],
    [
      "run-scoped",
      "run-a",
      "hard deny",
      { allowed: false, mode: "hard_deny", denied_by_period: "daily" },
      { allowed: false, mode: "hard_deny", deniedByPeriod: "daily", denySource: "server" },
    ],
  ] as const)("preserves a valid %s hard deny across an ordinary foreign %s and outage", async (_scope, agentRunId, _label, ordinary, currentExpected) => {
    const retained = checkResponse(
      agentRunId === undefined
        ? {
            allowed: false,
            mode: "hard_deny",
            denied_by_period: "monthly",
            budget_limit: 701,
            current_usage: 701,
            remaining_budget: 0,
          }
        : {
            allowed: false,
            mode: "hard_deny",
            denied_by_period: "agent_run",
            budget_limit: 801,
            current_usage: 801,
            remaining_budget: 0,
          },
    );
    const deniedByPeriod = retained.denied_by_period;
    let calls = 0;
    const budget = enforcer(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(retained);
      if (calls === 2) {
        return jsonResponse(
          checkResponse({
            ...ordinary,
            budget_limit: 401,
            current_usage: 400,
            remaining_budget: 1,
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-other",
              reason: "foreign",
            },
          }),
        );
      }
      throw new TypeError("offline");
    });
    const options = { ...checkOptions("run-a", 1), agentRunId };

    try {
      expect(await budget.checkBudget(options)).toMatchObject({
        allowed: false,
        deniedByPeriod,
        denySource: "server",
        budgetLimit: retained.budget_limit,
        currentUsage: retained.current_usage,
      });
      expect(await budget.checkBudget({ ...options, callId: callId(2) })).toMatchObject({
        ...currentExpected,
        budgetLimit: 401,
        currentUsage: 400,
      });
      expect(budget.lastKnownBudget).toBe(retained.budget_limit);
      expect(budget.lastKnownUsage).toBe(retained.current_usage);
      expect(budget.hasStickyHardDeny).toBe(true);
      expect(runTermination("run-other")).toBeUndefined();

      expect(await budget.checkBudget({ ...options, callId: callId(3) })).toMatchObject({
        allowed: false,
        deniedByPeriod,
        denySource: "sticky_replay",
        budgetLimit: retained.budget_limit,
        currentUsage: retained.current_usage,
      });
      expect(calls).toBe(3);
    } finally {
      await budget.close();
    }
  });

  it("keeps a valid allow cache and budget snapshot when a different key receives a foreign directive", async () => {
    const requestModels: string[] = [];
    let foreignCalls = 0;
    const budget = enforcer(
      async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { model: string };
        requestModels.push(request.model);
        if (request.model === "gpt-5.5") {
          return jsonResponse(
            checkResponse({
              reservation_id: "seeded-reservation",
              budget_limit: 501,
              current_usage: 111,
              remaining_budget: 390,
            }),
          );
        }
        if (request.model === "gpt-5.6") {
          foreignCalls += 1;
          return jsonResponse(
            checkResponse({
              reservation_id: `foreign-reservation-${foreignCalls}`,
              budget_limit: 600 + foreignCalls,
              current_usage: 221 + foreignCalls,
              remaining_budget: 379 - foreignCalls,
              run_control: {
                version: "1",
                action: "terminate",
                agent_run_id: "run-other",
                reason: "foreign",
              },
            }),
          );
        }
        throw new Error(`unexpected model ${request.model}`);
      },
      { cacheTtl: 60 },
    );
    const seededOptions = { ...checkOptions("run-a", 1), agentRunId: undefined };

    try {
      expect(await budget.checkBudget(seededOptions)).toMatchObject({
        reservationId: "seeded-reservation",
        budgetLimit: 501,
        currentUsage: 111,
      });
      expect(
        await budget.checkBudget({ ...seededOptions, model: "gpt-5.6", callId: callId(2) }),
      ).toMatchObject({
        reservationId: "foreign-reservation-1",
        budgetLimit: 601,
        currentUsage: 222,
      });
      expect(
        await budget.checkBudget({ ...seededOptions, model: "gpt-5.6", callId: callId(3) }),
      ).toMatchObject({
        reservationId: "foreign-reservation-2",
        budgetLimit: 602,
        currentUsage: 223,
      });
      expect(requestModels).toEqual(["gpt-5.5", "gpt-5.6", "gpt-5.6"]);
      expect(budget.lastKnownBudget).toBe(501);
      expect(budget.lastKnownUsage).toBe(111);

      expect(await budget.checkBudget({ ...seededOptions, callId: callId(4) })).toMatchObject({
        reservationId: null,
        budgetLimit: 501,
        currentUsage: 111,
      });
      expect(requestModels).toEqual(["gpt-5.5", "gpt-5.6", "gpt-5.6"]);
      expect(runTermination("run-other")).toBeUndefined();
    } finally {
      await budget.close();
    }
  });

  it("keeps an exact-run server termination and its observation stamp across an ordinary foreign check", async () => {
    let calls = 0;
    let clockReads = 0;
    setRunControlClockForTest(() => {
      clockReads += 1;
      return 91;
    });
    const budget = enforcer(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          checkResponse({
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-a",
              reason: "server-winner",
            },
          }),
        );
      }
      return jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "weekly",
          budget_limit: 601,
          current_usage: 601,
          remaining_budget: 0,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-other",
            reason: "foreign",
          },
        }),
      );
    });

    try {
      await budget.checkBudget(checkOptions("run-a", 1));
      expect(await budget.checkBudget(checkOptions("run-a", 2))).toMatchObject({
        allowed: false,
        deniedByPeriod: "weekly",
        denySource: "server",
        denyReason: "weekly",
      });
      expect(runTermination("run-a")).toMatchObject({ reason: "server-winner", source: "server" });
      expect(runObservedAt("run-a")).toBe(91);
      expect(internal(budget).runHardDenyResponses.get("run-a")?.observedAt).toBe(91);
      expect(runTermination("run-other")).toBeUndefined();
      expect(clockReads).toBe(1);
    } finally {
      await budget.close();
    }
  });

  it("keeps a local exact-run registry winner across an ordinary foreign check", async () => {
    let clockReads = 0;
    setRunControlClockForTest(() => {
      clockReads += 1;
      return 101;
    });
    markTerminated("run-a", { reason: "local-winner", source: "local_velocity" });
    const budget = enforcer(async () =>
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "daily",
          budget_limit: 701,
          current_usage: 701,
          remaining_budget: 0,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-other",
            reason: "foreign",
          },
        }),
      ),
    );

    try {
      expect(await budget.checkBudget(checkOptions("run-a", 1))).toMatchObject({
        allowed: false,
        deniedByPeriod: "daily",
        denySource: "server",
        denyReason: "daily",
      });
      expect(runTermination("run-a")).toMatchObject({
        reason: "local-winner",
        source: "local_velocity",
      });
      expect(runObservedAt("run-a")).toBe(101);
      expect(runTermination("run-other")).toBeUndefined();
      expect(clockReads).toBe(1);
    } finally {
      await budget.close();
    }
  });

  it("warns once when an unscoped check receives a foreign directive", async () => {
    const log = capturingLogger();
    const budget = enforcer(
      async () =>
        jsonResponse(
          checkResponse({
            allowed: false,
            mode: "hard_deny",
            denied_by_period: "run_stopped",
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-other",
              reason: "foreign",
            },
          }),
        ),
      { logger: log.logger },
    );

    expect(await budget.checkBudget({ ...checkOptions(), agentRunId: undefined })).toMatchObject({
      allowed: true,
    });
    expect(log.warn).toEqual([
      {
        message:
          "run_control.directive_run_mismatch: request_agent_run_id=%s directive_agent_run_id=%s",
        args: [undefined, "run-other"],
      },
    ]);
  });

  it("escapes control bytes in directive mismatch diagnostics", async () => {
    const log = capturingLogger();
    const budget = enforcer(
      async () =>
        jsonResponse(
          checkResponse({
            allowed: false,
            mode: "hard_deny",
            denied_by_period: "run_stopped",
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-other\n\x1b",
              reason: "foreign",
            },
          }),
        ),
      { logger: log.logger },
    );

    await budget.checkBudget(checkOptions("run-request\r\x7f"));

    expect(log.warn).toContainEqual({
      message:
        "run_control.directive_run_mismatch: request_agent_run_id=%s directive_agent_run_id=%s",
      args: ["run-request\\r\\x7f", "run-other\\n\\x1b"],
    });
    expect(log.error).toEqual([
      {
        message:
          "budget.check_directive_misrouted: request_agent_run_id=%s directive_agent_run_id=%s — possible server contract drift; enforcement degraded (fail_open=%s)",
        args: ["run-request\\r\\x7f", "run-other\\n\\x1b", true],
      },
    ]);
  });

  it("closes and releases a HALF_OPEN probe after a misrouted stopped check", async () => {
    let breakerNow = 0;
    const breaker = new CountingBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      now: () => breakerNow,
    });
    breaker.recordFailure();
    breakerNow = 1_000;
    const budget = enforcer(
      async () =>
        jsonResponse(
          checkResponse({
            allowed: false,
            mode: "hard_deny",
            denied_by_period: "run_stopped",
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-other",
              reason: "foreign",
            },
          }),
        ),
      { controlPlaneBreaker: breaker },
    );

    await budget.checkBudget(checkOptions());

    expect(breaker.getState().state).toBe("closed");
    expect([breaker.successes, breaker.releases]).toEqual([1, 1]);
  });

  it.each([
    ["older", 10, 20],
    ["equal", 10, 10],
  ] as const)("suppresses an %s allow with a same/newer same-run directive", async (_label, requestEpoch, stopEpoch) => {
    const allow = deferred<Response>();
    let calls = 0;
    let now: number = requestEpoch;
    setRunControlClockForTest(() => now);
    const budget = enforcer(
      async () => {
        calls += 1;
        if (calls === 1) return allow.promise;
        if (calls === 2) {
          return jsonResponse(
            checkResponse({
              allowed: false,
              mode: "hard_deny",
              denied_by_period: "monthly",
              failover_directive: { version: "1", failover_tuning_allowed: false },
              run_control: {
                version: "1",
                action: "terminate",
                agent_run_id: "run-a",
                reason: "manual_kill",
              },
            }),
          );
        }
        throw new TypeError("offline");
      },
      { monotonicNow: () => now },
    );

    const older = budget.checkBudget(checkOptions("run-a", 1));
    now = stopEpoch;
    await budget.checkBudget(checkOptions("run-a", 2));
    allow.resolve(
      jsonResponse(checkResponse({ budget_limit: 250, current_usage: 125, remaining_budget: 125 })),
    );
    const result = await older;

    expect(result).toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denySource: "server",
      denyReason: "manual_kill",
      failoverTuningAllowed: false,
    });
    expect(budget.lastKnownBudget).toBe(250);
    expect(budget.lastKnownUsage).toBe(125);
    expect(await budget.checkBudget(checkOptions("run-a", 3))).toMatchObject({
      allowed: false,
      denySource: "sticky_replay",
      denyReason: "manual_kill",
      failoverTuningAllowed: null,
    });
  });

  it("clears older project authority while a matching directive suppresses the allow", async () => {
    const allow = deferred<Response>();
    let calls = 0;
    let now = 1;
    setRunControlClockForTest(() => now);
    const budget = enforcer(
      async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse(
            checkResponse({
              allowed: false,
              mode: "hard_deny",
              denied_by_period: "monthly",
              remaining_budget: 0,
              budget_limit: 100,
              current_usage: 100,
            }),
          );
        }
        if (calls === 2) return allow.promise;
        if (calls === 3) {
          return jsonResponse(
            checkResponse({
              run_control: {
                version: "1",
                action: "terminate",
                agent_run_id: "run-a",
                reason: "manual_kill",
              },
            }),
          );
        }
        throw new TypeError("offline");
      },
      { monotonicNow: () => now },
    );

    await budget.checkBudget({ ...checkOptions(), agentRunId: undefined });
    now = 10;
    const older = budget.checkBudget(checkOptions("run-a", 2));
    now = 20;
    await budget.checkBudget(checkOptions("run-a", 3));
    allow.resolve(jsonResponse(checkResponse()));

    expect(await older).toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denyReason: "manual_kill",
    });
    expect(budget.lastKnownBudget).toBe(100);
    expect(budget.lastKnownUsage).toBe(10);
    expect(await budget.checkBudget(checkOptions("run-other", 4))).toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it.each([
    ["older", 10, 20],
    ["equal", 10, 10],
  ] as const)("does not let an %s alert-only response clear a newer run sticky", async (_label, requestEpoch, stopEpoch) => {
    const alert = deferred<Response>();
    let calls = 0;
    let now: number = requestEpoch;
    setRunControlClockForTest(() => now);
    const budget = enforcer(
      async () => {
        calls += 1;
        if (calls === 1) return alert.promise;
        if (calls === 2) {
          return jsonResponse(
            checkResponse({
              run_control: {
                version: "1",
                action: "terminate",
                agent_run_id: "run-a",
                reason: "manual_kill",
              },
            }),
          );
        }
        throw new TypeError("offline");
      },
      { monotonicNow: () => now },
    );

    const pendingAlert = budget.checkBudget(checkOptions("run-a", 1));
    now = stopEpoch;
    await budget.checkBudget(checkOptions("run-a", 2));
    alert.resolve(
      jsonResponse(
        checkResponse({
          allowed: false,
          mode: "alert_only",
          denied_by_period: "agent_run",
        }),
      ),
    );

    expect(await pendingAlert).toMatchObject({ allowed: true, mode: "alert_only" });
    expect(internal(budget).runHardDenyResponses.get("run-a")?.observedAt).toBe(stopEpoch);
    for (let index = 0; index < 256; index += 1) {
      markTerminated(`registry-alert-${index}`, { reason: "churn", source: "server" });
    }
    expect(runTermination("run-a")).toBeUndefined();
    expect(await budget.checkBudget(checkOptions("run-a", 3))).toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denySource: "sticky_replay",
      denyReason: "manual_kill",
    });
  });

  it("uses the process-wide stamp to suppress equal/older allows across enforcers and clears on a later allow", async () => {
    let now = 10;
    setRunControlClockForTest(() => now);
    const delayed = deferred<Response>();
    const older = enforcer(async () => delayed.promise, { monotonicNow: () => now });
    const marker = enforcer(
      async () =>
        jsonResponse(
          checkResponse({
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-a",
              reason: "cross_enforcer",
            },
          }),
        ),
      { monotonicNow: () => now },
    );

    const oldRequest = older.checkBudget(checkOptions("run-a", 1));
    now = 20;
    await marker.checkBudget(checkOptions("run-a", 2));
    delayed.resolve(
      jsonResponse(
        checkResponse({
          failover_directive: { version: "1", failover_tuning_allowed: true },
        }),
      ),
    );
    expect(await oldRequest).toMatchObject({
      allowed: false,
      denySource: "server",
      denyReason: "cross_enforcer",
      deniedByPeriod: "run_stopped",
      failoverTuningAllowed: true,
    });

    const allows = enforcer(async () => jsonResponse(checkResponse()), {
      monotonicNow: () => now,
    });
    expect(await allows.checkBudget(checkOptions("run-a", 3))).toMatchObject({
      allowed: false,
      denySource: "server",
    });
    now = 21;
    expect(await allows.checkBudget(checkOptions("run-a", 4))).toMatchObject({ allowed: true });
    expect(runTermination("run-a")).toBeUndefined();
    expect(internal(allows).runHardDenyResponses.has("run-a")).toBe(false);
  });

  it("replays a registry-only stop after both sticky caches miss", async () => {
    markTerminated("run-a", { reason: "velocity:repeat_size", source: "local_velocity" });
    const log = capturingLogger();
    const budget = enforcer(async () => Promise.reject(new TypeError("offline")), {
      failOpen: true,
      logger: log.logger,
    });

    const result = await budget.checkBudget(checkOptions());

    expect(result).toEqual({
      allowed: false,
      remainingBudget: 0,
      projectId: null,
      reservationId: null,
      leaseId: null,
      leaseClaimToken: null,
      mode: "hard_deny",
      warning: "Cloud API unreachable; preserving retained run stop",
      budgetLimit: 0,
      currentUsage: 0,
      priceHints: null,
      failoverTuningAllowed: null,
      deniedByPeriod: "run_stopped",
      denySource: "sticky_replay",
      denyReason: "velocity:repeat_size",
    });
    expect(log.warn).toContainEqual({
      message: "Cloud API unreachable; preserving retained run stop",
      args: [],
    });
  });

  it("keeps terminationFor as an injectable outage-lookup seam", async () => {
    const budget = enforcer(async () => Promise.reject(new TypeError("offline")), {
      terminationFor: () => ({ reason: "injected_stop", source: "server" }),
    });

    expect(await budget.checkBudget(checkOptions())).toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denySource: "sticky_replay",
      denyReason: "injected_stop",
    });
  });

  it("replays a directive sticky after registry eviction, then fails open after both LRUs forget it", async () => {
    let online = true;
    const budget = enforcer(async (_url, init) => {
      if (!online) throw new TypeError("offline");
      const request = JSON.parse(String(init?.body)) as { agent_run_id?: string };
      return jsonResponse(
        checkResponse({
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: request.agent_run_id ?? "missing",
            reason: request.agent_run_id === "run-victim" ? "manual_kill" : "churn",
          },
        }),
      );
    });

    await budget.checkBudget(checkOptions("run-victim", 1));
    for (let index = 0; index < 256; index += 1) {
      markTerminated(`registry-${index}`, { reason: "churn", source: "server" });
    }
    expect(runTermination("run-victim")).toBeUndefined();
    online = false;
    expect(await budget.checkBudget(checkOptions("run-victim", 2))).toMatchObject({
      allowed: false,
      denyReason: "manual_kill",
      denySource: "sticky_replay",
    });

    online = true;
    for (let index = 0; index < 128; index += 1) {
      await budget.checkBudget(checkOptions(`sticky-${index}`, index + 3));
    }
    online = false;
    expect(await budget.checkBudget(checkOptions("run-victim", 200))).toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
  });

  it("builds a stopped error from registry reason, then result reason, then the literal fallback", () => {
    const budget = enforcer(async () => jsonResponse(checkResponse()));
    const result = budgetCheckResult({
      allowed: false,
      remainingBudget: 0,
      mode: "hard_deny",
      deniedByPeriod: "run_stopped",
      denyReason: "result_reason",
    });

    markTerminated("run-a", { reason: "registry_reason", source: "local_velocity" });
    expect(budget.buildDenialError(result, 1, "run-a")).toMatchObject({
      reason: "registry_reason",
      source: "local_velocity",
    });
    clearRunTermination("run-a");
    expect(budget.buildDenialError(result, 1, "run-a")).toMatchObject({
      reason: "result_reason",
      source: "server",
    });
    expect(budget.buildDenialError({ ...result, denyReason: null }, 1, "run-a")).toMatchObject({
      reason: "run_stopped",
      source: "server",
    });
    expect(budget.buildDenialError(result, 1, "run-a")).toBeInstanceOf(RunStoppedError);
  });
});

describe("BudgetEnforcer lease directive fences", () => {
  it("handles a matching grant directive before a newer global authority fence", async () => {
    let clockReads = 0;
    setRunControlClockForTest(() => {
      clockReads += 1;
      return 51;
    });
    let now = 10;
    const grantGate = deferred<Response>();
    let grantBody: Record<string, unknown> | undefined;
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (String(url) === LEASE_URL) {
          grantBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return grantGate.promise;
        }
        if (String(url) === CHECK_URL) {
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
        throw new Error(`unexpected URL ${String(url)}`);
      },
      { leaseEnabled: true, monotonicNow: () => now },
    );

    const pendingGrant = budget.checkBudget(checkOptions());
    now = 20;
    await budget.checkBudget({ ...checkOptions("run-other", 2), agentRunId: undefined });
    now = 30;
    grantGate.resolve(
      jsonResponse(
        leaseResponse({
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-a",
            reason: "manual_kill",
          },
        }),
      ),
    );
    const result = await pendingGrant;

    expect(grantBody?.["run_directive_version"]).toBe("1");
    expect(result).toMatchObject({
      allowed: false,
      leaseId: null,
      reservationId: null,
      deniedByPeriod: "run_stopped",
      denySource: "server",
      denyReason: "manual_kill",
    });
    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBeNull();
    expect(runTermination("run-a")).toMatchObject({ reason: "manual_kill", source: "server" });
    expect(internal(budget).runHardDenyResponses.get("run-a")?.observedAt).toBe(51);
    expect(runObservedAt("run-a")).toBe(51);
    expect(clockReads).toBe(1);
    await expect(
      budget.checkBudget({ ...checkOptions("run-other", 3), agentRunId: undefined }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("normalizes an alert-only grant directive while preserving unrelated run authority", async () => {
    const budget = enforcer(
      async (url) => {
        expect(String(url)).toBe(LEASE_URL);
        return jsonResponse(
          leaseDenial({
            mode: "alert_only",
            denied_by_period: "monthly",
            budget_limit: 250,
            current_usage: 75,
            remaining_budget: 175,
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-a",
              reason: "grant_manual_stop",
            },
          }),
        );
      },
      { leaseEnabled: true },
    );
    expect(
      internal(budget).leaseLedger.applyGrantResponse(
        "run-b",
        leaseResponse({ lease_id: "lease-b", generation: 3 }),
        { now: 1, declaredModels: ["gpt-5.5"] },
      ),
    ).toBe("applied");
    markTerminated("run-b", { reason: "unrelated_local_stop", source: "local_velocity" });
    let clockReads = 0;
    setRunControlClockForTest(() => {
      clockReads += 1;
      return 71;
    });

    const result = await budget.checkBudget(checkOptions("run-a", 1));

    expect(result).toEqual({
      allowed: false,
      remainingBudget: 175,
      projectId: PROJECT_ID,
      reservationId: null,
      leaseId: null,
      leaseClaimToken: 1,
      mode: "hard_deny",
      warning: "Budget exceeded: $75.00/$250.00 used",
      budgetLimit: 250,
      currentUsage: 75,
      priceHints: null,
      failoverTuningAllowed: null,
      deniedByPeriod: "run_stopped",
      denySource: "server",
      denyReason: "grant_manual_stop",
    });
    expect(internal(budget).runHardDenyResponses.get("run-a")?.observedAt).toBe(71);
    expect(runObservedAt("run-a")).toBe(71);
    expect(clockReads).toBe(1);
    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBeNull();
    expect(internal(budget).leaseLedger.leaseIdFor("run-b")).toBe("lease-b");
    expect(runTermination("run-b")).toMatchObject({
      reason: "unrelated_local_stop",
      source: "local_velocity",
    });
  });

  it("warns on a foreign grant directive but installs an ordinary non-stopped grant", async () => {
    const log = capturingLogger();
    const budget = enforcer(
      async () =>
        jsonResponse(
          leaseResponse({
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-other",
              reason: "foreign",
            },
          }),
        ),
      { leaseEnabled: true, logger: log.logger },
    );

    const result = await budget.checkBudget(checkOptions());

    expect(result).toMatchObject({ allowed: true, leaseId: "lease-a" });
    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBe("lease-a");
    expect(runTermination("run-other")).toBeUndefined();
    expect(log.warn).toEqual([
      {
        message:
          "run_control.directive_run_mismatch: request_agent_run_id=%s directive_agent_run_id=%s",
        args: ["run-a", "run-other"],
      },
    ]);
  });

  it("strips a foreign directive from an alert-only grant denial and applies its ordinary posture", async () => {
    const budget = enforcer(
      async () =>
        jsonResponse(
          leaseResponse({
            allowed: false,
            mode: "alert_only",
            denied_by_period: "agent_run",
            lease_id: null,
            generation: null,
            granted_tokens: null,
            refresh_interval_s: null,
            lease_length_s: null,
            headroom_share_tokens: null,
            posture: null,
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-other",
              reason: "foreign",
            },
          }),
        ),
      { leaseEnabled: true },
    );

    const result = await budget.checkBudget(checkOptions());

    expect(result).toMatchObject({
      allowed: true,
      mode: "alert_only",
      deniedByPeriod: null,
      denySource: null,
      denyReason: null,
    });
    expect(runTermination("run-other")).toBeUndefined();
  });

  it("treats a foreign stopped grant as drift and installs no authority", async () => {
    const log = capturingLogger();
    const breaker = new CountingBreaker();
    const budget = enforcer(
      async () =>
        jsonResponse(
          leaseResponse({
            allowed: false,
            mode: "hard_deny",
            denied_by_period: "run_stopped",
            lease_id: null,
            generation: null,
            granted_tokens: null,
            refresh_interval_s: null,
            lease_length_s: null,
            headroom_share_tokens: null,
            posture: null,
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: "run-other",
              reason: "foreign",
            },
          }),
        ),
      {
        leaseEnabled: true,
        failOpen: true,
        logger: log.logger,
        controlPlaneBreaker: breaker,
      },
    );

    const result = await budget.checkBudget(checkOptions());

    expect(result).toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
      leaseId: null,
    });
    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBeNull();
    expect(runTermination("run-a")).toBeUndefined();
    expect([breaker.successes, breaker.failures, breaker.releases]).toEqual([1, 0, 1]);
    expect(log.error).toEqual([
      {
        message:
          "lease.grant_directive_misrouted: request_agent_run_id=%s directive_agent_run_id=%s — possible server contract drift; enforcement degraded (fail_open=%s)",
        args: ["run-a", "run-other", true],
      },
    ]);
  });

  it("uses a retained sibling stop to bypass lease admission after exact registry eviction", async () => {
    const handle = acquireTerminationHandle("run-a");
    markTerminated("run-a", { reason: "manual_kill", source: "server" });
    for (let index = 0; index < 256; index += 1) {
      markTerminated(`registry-${index}`, { reason: "churn", source: "server" });
    }
    expect(runTermination("run-a")).toBeUndefined();
    const urls: string[] = [];
    const budget = enforcer(
      async (url) => {
        urls.push(String(url));
        return jsonResponse(checkResponse());
      },
      { leaseEnabled: true },
    );

    await budget.checkBudget(checkOptions());

    expect(urls).toEqual([CHECK_URL]);
    handle.release();
  });

  it("uses an exact registry stop to bypass lease admission without creating lease state", async () => {
    markTerminated("run-a", { reason: "velocity:repeat_size", source: "local_velocity" });
    const urls: string[] = [];
    const budget = enforcer(
      async (url) => {
        urls.push(String(url));
        return jsonResponse(checkResponse());
      },
      { leaseEnabled: true },
    );

    await budget.checkBudget(checkOptions());

    expect(urls).toEqual([CHECK_URL]);
    expect(internal(budget).leaseLedger.stateFor("run-a")).toBeNull();
    expect(runTermination("run-a")).toMatchObject({
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
  });

  it("surrenders a directive-free grant that lands after a local stop", async () => {
    const grantGate = deferred<Response>();
    const surrenders: Record<string, unknown>[] = [];
    let grantStarted = false;
    const budget = enforcer(
      async (url, init) => {
        if (String(url) === LEASE_URL) {
          grantStarted = true;
          return grantGate.promise;
        }
        if (String(url) === CHECK_URL) throw new TypeError("offline");
        if (String(url) === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected URL ${String(url)}`);
      },
      { leaseEnabled: true },
    );

    const checking = budget.checkBudget(checkOptions());
    await flushUntil(() => grantStarted);
    markTerminated("run-a", { reason: "velocity:repeat_size", source: "local_velocity" });
    grantGate.resolve(jsonResponse(leaseResponse()));
    expect(await checking).toMatchObject({
      allowed: false,
      deniedByPeriod: "run_stopped",
      denyReason: "velocity:repeat_size",
    });
    await flushUntil(() => surrenders.length === 1);

    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBeNull();
    expect(surrenders.map((body) => body["lease_id"])).toEqual(["lease-a"]);
  });

  it("handles a matching renewal directive before a newer global authority fence", async () => {
    let clockReads = 0;
    setRunControlClockForTest(() => {
      clockReads += 1;
      return 61;
    });
    let now = 10;
    const renewGate = deferred<Response>();
    let renewBody: Record<string, unknown> | undefined;
    let checkCalls = 0;
    const budget = enforcer(
      async (url, init) => {
        if (String(url) === LEASE_URL) {
          return jsonResponse(leaseResponse({ refresh_interval_s: 0 }));
        }
        if (String(url) === RENEW_URL) {
          renewBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return renewGate.promise;
        }
        if (String(url) === CHECK_URL) {
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
        throw new Error(`unexpected URL ${String(url)}`);
      },
      { leaseEnabled: true, monotonicNow: () => now },
    );

    await budget.checkBudget(checkOptions());
    await flushUntil(() => renewBody !== undefined);
    now = 20;
    await budget.checkBudget({ ...checkOptions("run-other", 2), agentRunId: undefined });
    now = 30;
    renewGate.resolve(
      jsonResponse(
        leaseResponse({
          lease_id: "lease-b",
          generation: 2,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-a",
            reason: "manual_kill",
          },
        }),
      ),
    );
    await flushUntil(() => internal(budget).renewalOperations.size === 0);

    expect(renewBody?.["run_directive_version"]).toBe("1");
    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBeNull();
    expect(runTermination("run-a")).toMatchObject({ reason: "manual_kill", source: "server" });
    expect(internal(budget).runHardDenyResponses.get("run-a")?.observedAt).toBe(61);
    expect(runObservedAt("run-a")).toBe(61);
    expect(clockReads).toBe(1);
    await expect(
      budget.checkBudget({ ...checkOptions("run-other", 3), agentRunId: undefined }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
    });
  });

  it("folds a stale renewal run denial without replacing newer project authority", async () => {
    let now = 10;
    const renewGate = deferred<Response>();
    let renewalStarted = false;
    let checkCalls = 0;
    const budget = enforcer(
      async (url) => {
        if (String(url) === LEASE_URL) {
          return jsonResponse(leaseResponse({ refresh_interval_s: 0 }));
        }
        if (String(url) === RENEW_URL) {
          renewalStarted = true;
          return renewGate.promise;
        }
        if (String(url) === CHECK_URL) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return jsonResponse(
              checkResponse({
                allowed: false,
                mode: "hard_deny",
                denied_by_period: "monthly",
                budget_limit: 200,
                current_usage: 190,
                remaining_budget: 10,
              }),
            );
          }
          throw new TypeError("offline");
        }
        throw new Error(`unexpected URL ${String(url)}`);
      },
      { leaseEnabled: true, monotonicNow: () => now },
    );

    await budget.checkBudget(checkOptions());
    await flushUntil(() => renewalStarted);
    now = 20;
    await budget.checkBudget({ ...checkOptions("run-other", 2), agentRunId: undefined });
    now = 30;
    renewGate.resolve(
      jsonResponse(
        leaseDenial({
          mode: "hard_deny",
          denied_by_period: "agent_run",
          budget_limit: 300,
          current_usage: 275,
          remaining_budget: 25,
        }),
      ),
    );
    await flushUntil(() => internal(budget).renewalOperations.size === 0);

    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBeNull();
    expect(internal(budget).runHardDenyResponses.get("run-a")?.response).toMatchObject({
      denied_by_period: "agent_run",
      budget_limit: 300,
      current_usage: 275,
    });
    expect(budget.lastKnownBudget).toBe(300);
    expect(budget.lastKnownUsage).toBe(275);
    await expect(
      budget.checkBudget({ ...checkOptions("run-other", 3), agentRunId: undefined }),
    ).resolves.toMatchObject({
      allowed: false,
      deniedByPeriod: "monthly",
      denySource: "sticky_replay",
      budgetLimit: 200,
      currentUsage: 190,
    });
  });

  it("normalizes an alert-only renewal directive while preserving a local first reason", async () => {
    const renewGate = deferred<Response>();
    const budget = enforcer(
      async (url) => {
        if (String(url) === LEASE_URL) {
          return jsonResponse(leaseResponse({ refresh_interval_s: 0 }));
        }
        if (String(url) === RENEW_URL) return renewGate.promise;
        throw new Error(`unexpected URL ${String(url)}`);
      },
      { leaseEnabled: true },
    );
    let observedAt = 70;
    setRunControlClockForTest(() => {
      observedAt += 1;
      return observedAt;
    });

    await budget.checkBudget(checkOptions());
    await flushUntil(() => internal(budget).renewalOperations.size === 1);
    markTerminated("run-a", { reason: "velocity:repeat_size", source: "local_velocity" });
    renewGate.resolve(
      jsonResponse(
        leaseDenial({
          mode: "alert_only",
          denied_by_period: "monthly",
          budget_limit: 300,
          current_usage: 90,
          remaining_budget: 210,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-a",
            reason: "renew_manual_stop",
          },
        }),
      ),
    );
    await flushUntil(() => internal(budget).renewalOperations.size === 0);

    expect(runTermination("run-a")).toMatchObject({
      reason: "velocity:repeat_size",
      source: "local_velocity",
      atMonotonic: 71,
    });
    expect(internal(budget).runHardDenyResponses.get("run-a")).toEqual({
      observedAt: 72,
      response: {
        allowed: false,
        remaining_budget: 210,
        reservation_id: null,
        mode: "hard_deny",
        budget_limit: 300,
        current_usage: 90,
        denied_by_period: "run_stopped",
        project_id: PROJECT_ID,
        price_hints: null,
        run_control: {
          version: "1",
          action: "terminate",
          agent_run_id: "run-a",
          reason: "renew_manual_stop",
        },
      },
    });
    expect(runObservedAt("run-a")).toBe(72);
    expect(budget.lastKnownBudget).toBe(300);
    expect(budget.lastKnownUsage).toBe(90);
    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBeNull();
  });

  it("strips a foreign non-stopped renewal directive and installs its ordinary successor", async () => {
    const renewGate = deferred<Response>();
    const log = capturingLogger();
    const budget = enforcer(
      async (url) => {
        if (String(url) === LEASE_URL) {
          return jsonResponse(leaseResponse({ refresh_interval_s: 0 }));
        }
        if (String(url) === RENEW_URL) return renewGate.promise;
        throw new Error(`unexpected URL ${String(url)}`);
      },
      { leaseEnabled: true, logger: log.logger },
    );

    await budget.checkBudget(checkOptions());
    await flushUntil(() => internal(budget).renewalOperations.size === 1);
    renewGate.resolve(
      jsonResponse(
        leaseResponse({
          lease_id: "lease-b",
          generation: 2,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-other",
            reason: "foreign",
          },
        }),
      ),
    );
    await flushUntil(() => internal(budget).renewalOperations.size === 0);

    expect(internal(budget).leaseLedger.stateFor("run-a")).toMatchObject({
      leaseId: "lease-b",
      generation: 2,
      renewalInFlight: false,
    });
    expect(runTermination("run-a")).toBeUndefined();
    expect(runTermination("run-other")).toBeUndefined();
    expect(internal(budget).runHardDenyResponses.size).toBe(0);
    expect(log.warn).toEqual([
      {
        message:
          "run_control.directive_run_mismatch: request_agent_run_id=%s directive_agent_run_id=%s",
        args: ["run-a", "run-other"],
      },
    ]);
  });

  it("identity-fences a replaced renewal before observing its directive and surrenders its successor", async () => {
    const renewGate = deferred<Response>();
    const surrenderBodies: Record<string, unknown>[] = [];
    const budget = enforcer(
      async (url, init) => {
        if (String(url) === LEASE_URL) {
          return jsonResponse(leaseResponse({ refresh_interval_s: 0 }));
        }
        if (String(url) === RENEW_URL) return renewGate.promise;
        if (String(url) === SURRENDER_URL) {
          surrenderBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse({ released_tokens: 1 });
        }
        throw new Error(`unexpected URL ${String(url)}`);
      },
      { leaseEnabled: true },
    );

    await budget.checkBudget(checkOptions());
    await flushUntil(() => internal(budget).renewalOperations.size === 1);
    expect(
      internal(budget).leaseLedger.applyGrantResponse(
        "run-a",
        leaseResponse({ lease_id: "lease-current", generation: 7, refresh_interval_s: 300 }),
        { now: 1, declaredModels: ["gpt-5.5", "claude-opus-4"] },
      ),
    ).toBe("applied");
    renewGate.resolve(
      jsonResponse(
        leaseResponse({
          lease_id: "lease-stale-successor",
          generation: 2,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-a",
            reason: "must-not-land",
          },
        }),
      ),
    );
    await flushUntil(() => internal(budget).renewalOperations.size === 0);
    await flushUntil(() => surrenderBodies.length === 1);

    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBe("lease-current");
    expect(runTermination("run-a")).toBeUndefined();
    expect(surrenderBodies).toEqual([
      {
        lease_id: "lease-stale-successor",
        holder_id: "holder-1",
        generation: 2,
        spent_tokens: 0,
      },
    ]);
  });

  it("backs off a foreign stopped renewal without dropping current authority", async () => {
    const renewGate = deferred<Response>();
    const log = capturingLogger();
    const breaker = new CountingBreaker();
    const budget = enforcer(
      async (url) => {
        if (String(url) === LEASE_URL) {
          return jsonResponse(leaseResponse({ refresh_interval_s: 0 }));
        }
        if (String(url) === RENEW_URL) return renewGate.promise;
        throw new Error(`unexpected URL ${String(url)}`);
      },
      {
        leaseEnabled: true,
        logger: log.logger,
        monotonicNow: () => 1_000,
        controlPlaneBreaker: breaker,
      },
    );

    await budget.checkBudget(checkOptions());
    expect(breaker.successes).toBe(1);
    renewGate.resolve(
      jsonResponse(
        leaseResponse({
          allowed: false,
          mode: "hard_deny",
          denied_by_period: "run_stopped",
          lease_id: null,
          generation: null,
          granted_tokens: null,
          refresh_interval_s: null,
          lease_length_s: null,
          headroom_share_tokens: null,
          posture: null,
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: "run-other",
            reason: "foreign",
          },
        }),
      ),
    );
    await flushUntil(() => internal(budget).renewalOperations.size === 0);
    const state = internal(budget).leaseLedger.stateFor("run-a") as LeaseState;

    expect(state).toMatchObject({
      leaseId: "lease-a",
      generation: 1,
      renewalInFlight: false,
      consecutiveFailures: 1,
    });
    expect(runTermination("run-a")).toBeUndefined();
    expect([breaker.successes, breaker.failures, breaker.releases]).toEqual([2, 0, 2]);
    expect(log.error).toEqual([
      {
        message:
          "lease.renew_directive_misrouted: request_agent_run_id=%s directive_agent_run_id=%s — possible server contract drift; enforcement degraded (fail_open=%s)",
        args: ["run-a", "run-other", true],
      },
    ]);
  });

  it("drops and surrenders a directive-free renewal successor that lands after a stop", async () => {
    const renewGate = deferred<Response>();
    const surrenders: Record<string, unknown>[] = [];
    const budget = enforcer(
      async (url, init) => {
        if (String(url) === LEASE_URL) {
          return jsonResponse(leaseResponse({ refresh_interval_s: 0 }));
        }
        if (String(url) === RENEW_URL) return renewGate.promise;
        if (String(url) === SURRENDER_URL) {
          surrenders.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected URL ${String(url)}`);
      },
      { leaseEnabled: true },
    );

    await budget.checkBudget(checkOptions());
    await flushUntil(() => internal(budget).renewalOperations.size === 1);
    markTerminated("run-a", { reason: "velocity:repeat_size", source: "local_velocity" });
    renewGate.resolve(jsonResponse(leaseResponse({ lease_id: "lease-successor", generation: 2 })));
    await flushUntil(() => internal(budget).renewalOperations.size === 0);
    await flushUntil(() => surrenders.length === 1);

    expect(internal(budget).leaseLedger.leaseIdFor("run-a")).toBeNull();
    expect(surrenders.map((body) => body["lease_id"])).toEqual(["lease-successor"]);
  });
});
