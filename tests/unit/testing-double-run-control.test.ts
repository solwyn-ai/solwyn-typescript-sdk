import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { ConfigurationError } from "../../src/errors";
import {
  resetRunControlForTest,
  runTermination,
  setRunControlClockForTest,
} from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing/index";

const CHECK_PATH = "/api/v1/budgets/check";
const GRANT_PATH = "/api/v1/budgets/lease";
const RENEW_PATH = "/api/v1/budgets/lease/renew";

function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    estimated_input_tokens: 1,
    model: "gpt-4o",
    provider: "openai",
    agent_run_id: "run-a",
    run_directive_version: "1",
    ...overrides,
  };
}

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_run_id: "run-a",
    holder_id: "holder-a",
    model: "gpt-4o",
    provider: "openai",
    fail_open: true,
    run_directive_version: "1",
    ...overrides,
  };
}

function renew(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lease_id: "lse_fake1",
    holder_id: "holder-a",
    generation: 1,
    spent_tokens: 0,
    reserved_tokens: 0,
    uncounted_calls: 0,
    uncounted_tokens: 0,
    run_directive_version: "1",
    ...overrides,
  };
}

function budgetOptions(
  runId: string,
  callId: string,
): Parameters<BudgetEnforcer["checkBudget"]>[0] {
  return {
    estimatedInputTokens: 1,
    estimatedOutputBound: 1,
    model: "gpt-4o",
    provider: "openai",
    agentRunId: runId,
    callId,
  };
}

async function flushUntil(predicate: () => boolean, turns = 100): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) await Promise.resolve();
}

describe("FakeControlPlane run control", () => {
  beforeEach(() => resetRunControlForTest());
  afterEach(() => resetRunControlForTest());
  it("holds one validated stop independently of denial scripts and returns a snapshot", () => {
    const plane = new FakeControlPlane();
    plane.denyNext();
    plane.stopRun("__proto__", { reason: "operator_stop" });
    const snapshot = plane.stoppedRuns;
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.hasOwn(snapshot, "__proto__")).toBe(true);
    expect(Reflect.get(snapshot, "__proto__")).toBe("operator_stop");
    Reflect.set(snapshot, "__proto__", "mutated");
    expect(Reflect.get(plane.stoppedRuns, "__proto__")).toBe("operator_stop");
    plane.clearDenials();
    plane.resetRecording();
    expect(Object.entries(plane.stoppedRuns)).toEqual([["__proto__", "operator_stop"]]);
    expect(() => plane.stopRun("run-a", { reason: "" })).toThrow(ConfigurationError);
    expect(() => plane.stopRun("run-a", { reason: "x".repeat(65) })).toThrow(ConfigurationError);
    plane.stopRun("run-a");
    expect(() => plane.stopRun("run-a", { reason: "other" })).toThrow(ConfigurationError);
  });

  it("puts a fresh held stop ahead of a queued denial and emits its opted-in directive only", () => {
    const plane = new FakeControlPlane();
    plane.denyNext();
    plane.stopRun("run-a", { reason: "operator_stop" });
    expect(plane.handle("POST", CHECK_PATH, check()).body).toMatchObject({
      allowed: false,
      mode: "hard_deny",
      denied_by_period: "run_stopped",
      remaining_budget: 0,
      run_control: {
        version: "1",
        action: "terminate",
        agent_run_id: "run-a",
        reason: "operator_stop",
      },
    });
    expect(plane.handle("POST", CHECK_PATH, check({ agent_run_id: "run-b" })).body).toMatchObject({
      denied_by_period: "monthly",
    });
    expect(
      plane.handle(
        "POST",
        CHECK_PATH,
        check({ agent_run_id: "run-c", model: "solwyn-test/deny-stopped" }),
      ).body,
    ).toMatchObject({ denied_by_period: "run_stopped" });
    expect(
      plane.handle(
        "POST",
        CHECK_PATH,
        check({ agent_run_id: "run-c", model: "solwyn-test/deny-stopped" }),
      ).body,
    ).not.toHaveProperty("run_control");
  });

  it("replays pre-stop lease authority before evaluating a fresh stopped renewal", () => {
    const plane = new FakeControlPlane();
    expect(plane.handle("POST", GRANT_PATH, grant()).body).toMatchObject({ generation: 1 });
    plane.stopRun("run-a");
    expect(plane.handle("POST", GRANT_PATH, grant()).body).toMatchObject({
      allowed: true,
      generation: 1,
    });
    expect(plane.handle("POST", RENEW_PATH, renew()).body).toMatchObject({
      allowed: false,
      denied_by_period: "run_stopped",
      remaining_budget: 0,
      run_control: { agent_run_id: "run-a", reason: "manual_kill" },
    });
    expect(plane.handle("POST", RENEW_PATH, renew()).body).toMatchObject({
      denied_by_period: "run_stopped",
    });
  });

  it("freezes a fresh stopped lease directive across clearing its stop and misroute window", () => {
    const plane = new FakeControlPlane();
    plane.handle("POST", GRANT_PATH, grant());
    plane.stopRun("run-a", { reason: "operator_stop" });
    const window = plane.misrouteStops({ requests: 1 });
    const stopped = plane.handle("POST", RENEW_PATH, renew());
    expect(stopped.body).toMatchObject({
      run_control: { agent_run_id: "solwyn-test-misrouted-run", reason: "operator_stop" },
    });
    plane.clearStop("run-a");
    window.end();
    expect(plane.handle("POST", RENEW_PATH, renew()).body).toEqual(stopped.body);
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 2 })).body).toMatchObject({
      allowed: true,
      generation: 3,
    });
  });

  it("does not advance kill sightings on grant or renewal replay", () => {
    const grantPlane = new FakeControlPlane();
    expect(
      grantPlane.handle("POST", GRANT_PATH, grant({ model: "solwyn-test/kill" })).body,
    ).toMatchObject({
      allowed: true,
      generation: 1,
    });
    expect(
      grantPlane.handle("POST", GRANT_PATH, grant({ model: "solwyn-test/kill" })).body,
    ).toMatchObject({ allowed: true, generation: 1 });
    expect(grantPlane.stoppedRuns).toEqual({});
    expect(grantPlane.handle("POST", RENEW_PATH, renew()).body).toMatchObject({
      allowed: false,
      denied_by_period: "run_stopped",
      run_control: { agent_run_id: "run-a", reason: "manual_kill" },
    });
    expect(grantPlane.stoppedRuns).toEqual({ "run-a": "manual_kill" });

    const renewalPlane = new FakeControlPlane();
    renewalPlane.handle("POST", GRANT_PATH, grant());
    expect(
      renewalPlane.handle(
        "POST",
        RENEW_PATH,
        renew({ model: "solwyn-test/kill", provider: "openai" }),
      ).body,
    ).toMatchObject({ allowed: true, generation: 2 });
    expect(
      renewalPlane.handle(
        "POST",
        RENEW_PATH,
        renew({ model: "solwyn-test/kill", provider: "openai", spent_tokens: 99 }),
      ).body,
    ).toMatchObject({ allowed: true, generation: 2 });
    expect(renewalPlane.stoppedRuns).toEqual({});
    expect(renewalPlane.handle("POST", RENEW_PATH, renew({ generation: 2 })).body).toMatchObject({
      allowed: false,
      denied_by_period: "run_stopped",
      run_control: { agent_run_id: "run-a", reason: "manual_kill" },
    });
    expect(renewalPlane.stoppedRuns).toEqual({ "run-a": "manual_kill" });
  });

  it("does not spend a newly active misroute window on grant or frozen renewal replay", () => {
    const plane = new FakeControlPlane();
    const preStopGrant = plane.handle("POST", GRANT_PATH, grant());
    plane.stopRun("run-a", { reason: "operator_stop" });

    const firstWindow = plane.misrouteStops({ requests: 1 });
    expect(plane.handle("POST", GRANT_PATH, grant())).toEqual(preStopGrant);
    const firstStopped = plane.handle("POST", RENEW_PATH, renew());
    expect(firstStopped.body).toMatchObject({
      run_control: { agent_run_id: "solwyn-test-misrouted-run", reason: "operator_stop" },
    });

    const secondWindow = plane.misrouteStops({ requests: 1 });
    expect(plane.handle("POST", RENEW_PATH, renew())).toEqual(firstStopped);
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 2 })).body).toMatchObject({
      run_control: { agent_run_id: "solwyn-test-misrouted-run", reason: "operator_stop" },
    });
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 3 })).body).toMatchObject({
      run_control: { agent_run_id: "run-a", reason: "operator_stop" },
    });
    firstWindow.end();
    secondWindow.end();
  });

  it("rejects a raw kill without a run as a typed testing configuration error", () => {
    const plane = new FakeControlPlane();
    expect(() =>
      plane.handle("POST", CHECK_PATH, check({ agent_run_id: null, model: "solwyn-test/kill" })),
    ).toThrow(ConfigurationError);
    expect(() =>
      plane.handle("POST", CHECK_PATH, check({ agent_run_id: null, model: "solwyn-test/kill" })),
    ).toThrow(/^solwyn\.testing: run-scoped denial 'run_stopped' requires an agent_run_id$/);
  });

  it("misroutes only fresh opted-in stop directives within its bounded window", () => {
    const plane = new FakeControlPlane();
    plane.stopRun("run-a");
    const window = plane.misrouteStops({ requests: 1 });
    expect(plane.handle("POST", CHECK_PATH, check()).body).toMatchObject({
      run_control: { agent_run_id: "solwyn-test-misrouted-run" },
    });
    expect(plane.handle("POST", CHECK_PATH, check()).body).toMatchObject({
      run_control: { agent_run_id: "run-a" },
    });
    window.end();
    expect(() => plane.misrouteStops({ requests: -1 })).toThrow(ConfigurationError);
    expect(() => plane.misrouteStops({ requests: 1.5 })).toThrow(ConfigurationError);
  });

  it("degrades a fake misrouted stopped check without tripping the breaker or stopping either run", async () => {
    const plane = new FakeControlPlane();
    const breaker = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1 });
    const errors: string[] = [];
    plane.stopRun("b3-misroute-run");
    plane.misrouteStops({ requests: 1 });
    const enforcer = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch: plane.fetch,
      leaseEnabled: false,
      cacheTtl: 0,
      controlPlaneBreaker: breaker,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message) => errors.push(message),
      },
    });

    try {
      await expect(
        enforcer.checkBudget(budgetOptions("b3-misroute-run", "call-a")),
      ).resolves.toMatchObject({ allowed: true });
      expect(runTermination("b3-misroute-run")).toBeUndefined();
      expect(runTermination("solwyn-test-misrouted-run")).toBeUndefined();
      expect(breaker.getState()).toMatchObject({ state: "closed", failureCount: 0 });
      expect(errors).toContain(
        "budget.check_directive_misrouted: request_agent_run_id=%s directive_agent_run_id=%s — possible server contract drift; enforcement degraded (fail_open=%s)",
      );
    } finally {
      await enforcer.close();
    }
  });

  it("drops a held lease and marks termination when the fake stops its fresh renewal", async () => {
    let now = 0;
    setRunControlClockForTest(() => now);
    const plane = new FakeControlPlane({ refreshIntervalS: 1, leaseLengthS: 3 });
    const enforcer = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch: plane.fetch,
      cacheTtl: 0,
      monotonicNow: () => now,
    });

    try {
      await enforcer.checkBudget(
        budgetOptions("b3-renew-run", "00000000-0000-0000-0000-000000000001"),
      );
      plane.stopRun("b3-renew-run", { reason: "operator_stop" });
      // Both clocks use milliseconds. At two seconds the jittered 1-second refresh
      // deadline (0.85–1.15s) is due, while the 3-second lease remains live.
      now = 2_000;
      await enforcer.checkBudget(
        budgetOptions("b3-renew-run", "00000000-0000-0000-0000-000000000002"),
      );
      await flushUntil(() => plane.leaseRenewals.length === 1);
      await flushUntil(
        () =>
          (enforcer as unknown as { renewalOperations: Set<Promise<void>> }).renewalOperations
            .size === 0,
      );

      expect(plane.leaseRenewals).toHaveLength(1);
      expect(runTermination("b3-renew-run")).toMatchObject({
        reason: "operator_stop",
        source: "server",
      });
      expect(
        (
          enforcer as unknown as { leaseLedger: { leaseIdFor(runId: string): string | null } }
        ).leaseLedger.leaseIdFor("b3-renew-run"),
      ).toBeNull();
    } finally {
      await enforcer.close();
    }
  });
});
