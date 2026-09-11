import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import type { SolwynOptions } from "../../src/client";
import { BudgetExceededError, RunStoppedError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { currentRun, run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import {
  currentRunTerminated,
  resetRunControlForTest,
  runTermination,
  setRunControlClockForTest,
} from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing/index";
import { zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";

const callId = (index: number): string =>
  `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;

function checkOptions(agentRunId?: string) {
  return {
    estimatedInputTokens: 10,
    model: "gpt-4o",
    provider: "openai" as const,
    ...(agentRunId === undefined ? {} : { agentRunId }),
  };
}

function clientOptions(plane: FakeControlPlane, options: SolwynOptions = {}): SolwynOptions {
  return { apiKey: plane.apiKey, apiUrl: plane.apiUrl, fetch: plane.fetch, ...options };
}

function openAIClient(impl: (_kwargs: Record<string, unknown>) => unknown) {
  const create = vi.fn(impl);
  return { chat: { completions: { create } } };
}

function inHandConfirmCount(reporter: MetadataReporter): number {
  return (reporter as unknown as { readonly inHandConfirms: ReadonlyMap<number, unknown> })
    .inHandConfirms.size;
}

function expectSerializedConfirm(
  recorded: BudgetConfirmRequest | undefined,
  confirm: BudgetConfirmRequest,
): void {
  expect(recorded).toMatchObject({
    reservation_id: confirm.reservation_id,
    call_id: confirm.call_id,
    token_details: confirm.token_details,
  });
}

async function flushUntil(predicate: () => boolean, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetRunControlForTest();
});

describe("non-lease game days", () => {
  // Mutation caught: dropping rejected denial receipts instead of folding them, replaying
  // before an ordinary clean delivery cycle, or losing their velocity/input attribution.
  it("folds rejected denial receipts and replays one aggregate after an ordinary clean cycle", async () => {
    vi.useFakeTimers();
    const plane = new FakeControlPlane();
    const client = openAIClient(() => ({ usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    const solwyn = plane.wrap(client, {
      leaseEnabled: false,
      velocityMode: "warn",
      velocityRepeatCount: 2,
      reporterBatchSize: 1,
      reporterFlushInterval: 0.01,
      reportUntrackedSurfaces: false,
    });
    const rejection = plane.rejectIngest({ indices: [0], requests: null });
    let rejectedReceipts: MetadataEvent[] = [];

    try {
      try {
        await run("gameday-receipt-replay", async () => {
          const request = {
            model: "solwyn-test/deny",
            messages: [{ role: "user", content: "repeat this nonempty request" }],
          };
          await expect(solwyn.chat.completions.create(request)).rejects.toBeInstanceOf(
            BudgetExceededError,
          );
          // The fake also deduplicates by timestamp + SDK instance. Give distinct
          // calls distinct timestamps while keeping their run/model/input fold key.
          await vi.advanceTimersByTimeAsync(1);
          await expect(solwyn.chat.completions.create(request)).rejects.toBeInstanceOf(
            BudgetExceededError,
          );
        });

        for (let turn = 0; turn < 20 && plane.denialReceipts.length < 2; turn += 1) {
          await vi.advanceTimersByTimeAsync(10);
          await Promise.resolve();
        }

        rejectedReceipts = plane.denialReceipts;
        expect(rejectedReceipts).toHaveLength(2);
        expect(plane.aggregateReplays).toEqual([]);
        expect(client.chat.completions.create).not.toHaveBeenCalled();
        expect(rejectedReceipts.map((receipt) => receipt.status)).toEqual([
          "budget_denied",
          "budget_denied",
        ]);
        expect(rejectedReceipts.map((receipt) => receipt.model)).toEqual([
          "solwyn-test/deny",
          "solwyn-test/deny",
        ]);
        expect(rejectedReceipts[0]?.agent_run_id).toBeTruthy();
        expect(rejectedReceipts[1]?.agent_run_id).toBe(rejectedReceipts[0]?.agent_run_id);
        expect(rejectedReceipts.map((receipt) => receipt.denied_by_period)).toEqual([
          "monthly",
          "monthly",
        ]);
        expect(rejectedReceipts.map((receipt) => receipt.input_tokens)).toEqual([
          rejectedReceipts[0]?.input_tokens,
          rejectedReceipts[0]?.input_tokens,
        ]);
        expect(rejectedReceipts[0]?.input_tokens).toBeGreaterThan(0);
        expect(rejectedReceipts.map((receipt) => receipt.velocity_flags ?? null)).toEqual([
          null,
          ["repeat_size"],
        ]);
      } finally {
        rejection.end();
      }

      expect(plane.denialReceipts).toEqual(rejectedReceipts);
      await vi.advanceTimersByTimeAsync(20);
      expect(plane.aggregateReplays).toEqual([]);
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
      for (let turn = 0; turn < 20 && plane.aggregateReplays.length === 0; turn += 1) {
        await vi.advanceTimersByTimeAsync(10);
        await Promise.resolve();
      }

      await vi.advanceTimersByTimeAsync(30);
      expect(plane.aggregateReplays).toHaveLength(1);
      expect(plane.ingested.filter((event) => event.status === "success")).toHaveLength(1);
      expect(plane.ingested.findIndex((event) => event.status === "success")).toBeLessThan(
        plane.ingested.findIndex((event) => event.deny_source === "aggregate_replay"),
      );
      const replay = plane.aggregateReplays[0];
      expect(
        plane.denialReceipts.filter((receipt) => receipt.deny_source !== "aggregate_replay"),
      ).toEqual(rejectedReceipts);
      expect(replay).toMatchObject({
        status: "budget_denied",
        deny_source: "aggregate_replay",
        receipt_aggregate_count: 2,
        deny_reason: "monthly",
        denied_by_period: "monthly",
        velocity_flags: ["repeat_size"],
      });
      expect(replay?.input_tokens).toBe(
        (rejectedReceipts[0]?.input_tokens ?? 0) + (rejectedReceipts[1]?.input_tokens ?? 0),
      );
      expect(replay?.input_tokens).toBeGreaterThan(0);
      expect(replay?.call_id).not.toBe(rejectedReceipts[0]?.call_id);
      expect(replay?.call_id).not.toBe(rejectedReceipts[1]?.call_id);
      expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(plane.unmatchedRequests).toEqual([]);
    } finally {
      rejection.end();
      const closing = solwyn.close();
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await closing;
    }
  });

  // Mutation caught: failing to retain a server run stop through a check-path outage
  // would either reopen provider traffic or lose the sticky-replay denial receipt.
  it("keeps an operator kill terminal through a control-plane check outage", async () => {
    vi.useFakeTimers();
    const plane = new FakeControlPlane();
    const baseFetch = plane.fetch;
    const fetch = vi
      .spyOn(plane, "fetch")
      .mockImplementation((input, init) => baseFetch(input, init));
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const wrapped = plane.wrap(provider, { leaseEnabled: false, reporterFlushInterval: 0.001 });
    let actualRunId = "";
    let killed: RunStoppedError | undefined;
    let replayed: RunStoppedError | undefined;

    try {
      await run("gameday-kill", async () => {
        actualRunId = currentRun()?.agentRunId ?? "";
        expect(actualRunId).not.toBe("");
        await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });

        plane.stopRun(actualRunId);
        try {
          await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
        } catch (error) {
          killed = error as RunStoppedError;
        }
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        expect(plane.denialReceipts).toHaveLength(1);

        const checkAttemptsBeforeOutage = fetch.mock.calls.filter(
          ([input]) => new URL(input).pathname === "/api/v1/budgets/check",
        ).length;
        const outage = plane.outage({ path: "/api/v1/budgets/check", requests: 1 });
        try {
          try {
            await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
          } catch (error) {
            replayed = error as RunStoppedError;
          }
        } finally {
          outage.end();
        }
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        expect(plane.denialReceipts).toHaveLength(2);
        expect(
          fetch.mock.calls.filter(([input]) => new URL(input).pathname === "/api/v1/budgets/check"),
        ).toHaveLength(checkAttemptsBeforeOutage + 1);
      });
    } finally {
      const closing = wrapped.close();
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await closing;
    }

    expect(killed).toBeInstanceOf(RunStoppedError);
    expect(killed).toMatchObject({
      agentRunId: actualRunId,
      reason: "manual_kill",
      source: "server",
    });
    expect(replayed).toBeInstanceOf(RunStoppedError);
    expect(replayed).toMatchObject({ agentRunId: actualRunId, reason: "manual_kill" });
    expect(provider.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(plane.denialReceipts).toHaveLength(2);
    expect(plane.denialReceipts.map((receipt) => receipt.deny_source)).toEqual([
      "server",
      "sticky_replay",
    ]);
    expect(plane.denialReceipts.every((receipt) => receipt.deny_reason === "manual_kill")).toBe(
      true,
    );
    expect(
      plane.denialReceipts.every((receipt) => receipt.denied_by_period === "run_stopped"),
    ).toBe(true);
    expect(plane.unmatchedRequests).toEqual([]);
  });

  // Mutation caught: letting a permissive direct check clear a local velocity stop
  // would dispatch the third call or erase the run-terminated receipt.
  it("does not let a permissive plane check lift a local velocity stop", async () => {
    vi.useFakeTimers();
    const plane = new FakeControlPlane();
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const wrapped = plane.wrap(provider, {
      leaseEnabled: false,
      velocityMode: "deny",
      velocityRepeatCount: 2,
      reporterFlushInterval: 0.001,
    });
    let actualRunId = "";
    let stopped: RunStoppedError | undefined;
    let afterAllow: RunStoppedError | undefined;
    let checksAtStop = 0;

    try {
      await run("gameday-velocity", async () => {
        actualRunId = currentRun()?.agentRunId ?? "";
        expect(actualRunId).not.toBe("");
        await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
        try {
          await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
        } catch (error) {
          stopped = error as RunStoppedError;
        }
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        expect(plane.denialReceipts).toHaveLength(1);
        checksAtStop = plane.checks.length;

        const probe = plane.handle("POST", "/api/v1/budgets/check", {
          estimated_input_tokens: 10,
          model: "gpt-5.5",
          provider: "openai",
          fallback_providers: [],
          fallback_models: [],
          agent_run_id: actualRunId,
          run_directive_version: "1",
        });
        expect(probe.body).toMatchObject({ allowed: true });

        try {
          await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
        } catch (error) {
          afterAllow = error as RunStoppedError;
        }
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        expect(plane.denialReceipts).toHaveLength(2);
      });
    } finally {
      const closing = wrapped.close();
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await closing;
    }

    expect(stopped).toBeInstanceOf(RunStoppedError);
    expect(stopped).toMatchObject({
      agentRunId: actualRunId,
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    expect(afterAllow).toBeInstanceOf(RunStoppedError);
    expect(afterAllow).toMatchObject({
      agentRunId: actualRunId,
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    expect(plane.checks).toHaveLength(checksAtStop + 1);
    expect(plane.stoppedRuns).toEqual({});
    expect(provider.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(plane.denialReceipts.map((receipt) => receipt.deny_source)).toEqual([
      "local_velocity",
      "run_terminated",
    ]);
    expect(
      plane.denialReceipts.every((receipt) => receipt.deny_reason === "velocity:repeat_size"),
    ).toBe(true);
    expect(
      plane.denialReceipts.every((receipt) => receipt.denied_by_period === "run_stopped"),
    ).toBe(true);
    expect(plane.denialReceipts[0]?.velocity_flags).toEqual(["repeat_size"]);
    expect(plane.unmatchedRequests).toEqual([]);
  });

  // Mutation caught: removing run-scoped sticky replay lets an outage reopen a run that
  // the control plane already hard-denied.
  it("preserves a sticky run denial through an outage and clears it after cloud recovery", async () => {
    let wallNow = Date.UTC(2026, 8, 3);
    let monotonicNow = 0;
    const plane = new FakeControlPlane({
      mode: "hard_deny",
      budgetLimit: 5,
      currentUsage: 6,
      remainingBudget: -1,
    });
    plane.denyRun("gameday-sticky-run");
    const warnings: string[] = [];
    const enforcer = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch: plane.fetch,
      budgetMode: "alert_only",
      failOpen: true,
      cacheTtl: 0,
      leaseEnabled: false,
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
    });

    const denied = await enforcer.checkBudget(checkOptions("gameday-sticky-run"));
    expect(denied).toMatchObject({ allowed: false, deniedByPeriod: "agent_run" });

    plane.clearDenials();
    const firstOutage = plane.outage({ path: "/api/v1/budgets/check", requests: 1 });
    monotonicNow += 1;
    const preserved = await enforcer.checkBudget(checkOptions("gameday-sticky-run"));
    firstOutage.end();
    expect(preserved).toMatchObject({ allowed: false, deniedByPeriod: "agent_run" });
    expect(preserved.warning).toContain("preserving prior hard deny");
    expect(warnings.join("\n")).toContain("preserving prior hard deny");

    wallNow += 1;
    monotonicNow += 1;
    const recovered = await enforcer.checkBudget(checkOptions("gameday-sticky-run"));
    expect(recovered.allowed).toBe(true);

    const secondOutage = plane.outage({ path: "/api/v1/budgets/check", requests: 1 });
    monotonicNow += 1;
    const failOpen = await enforcer.checkBudget(checkOptions("gameday-sticky-run"));
    secondOutage.end();
    expect(failOpen).toMatchObject({ allowed: true, reservationId: null });
    expect(plane.checks).toHaveLength(2);
    expect(plane.unmatchedRequests).toEqual([]);
    await enforcer.close();
  });

  // Mutation caught: leaving an in-hand confirm owned after the shutdown deadline leaks
  // queued work or lets a late completion record its drop twice.
  it("bounds a frozen confirmation by shutdown deadline and counts it once", async () => {
    vi.useFakeTimers();
    let now = 0;
    const plane = new FakeControlPlane();
    const enforcer = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch: plane.fetch,
      leaseEnabled: false,
      now: () => Date.UTC(2026, 8, 3),
      monotonicNow: () => now,
    });
    const reservation = await enforcer.checkBudget(checkOptions());
    const confirm = enforcer.buildConfirmRequest({
      reservationId: reservation.reservationId,
      model: "gpt-4o",
      provider: "openai",
      callId: callId(1),
      tokenDetails: zeroTokenDetails(),
    });
    const reporter = new MetadataReporter(plane.apiUrl, plane.apiKey, {
      fetch: plane.fetch,
      flushInterval: 1_000_000,
      shutdownDeadline: 10,
      monotonicClock: () => now,
    });
    reporter.reportConfirm(confirm);
    const slow = plane.slow(1_000, { path: "/api/v1/budgets/confirm", requests: 1 });
    const closing = reporter.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    for (let turn = 0; turn < 10 && plane.confirms.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(plane.confirms).toHaveLength(1);
    expectSerializedConfirm(plane.confirms[0], confirm);
    expect(inHandConfirmCount(reporter)).toBe(1);

    now = 9;
    await vi.advanceTimersByTimeAsync(9);
    expect(closeSettled).toBe(false);
    expect(reporter.inFlightCount).toBe(1);
    expect(inHandConfirmCount(reporter)).toBe(1);

    now = 10;
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(reporter.confirmQueueSize).toBe(0);
    expect(reporter.inFlightCount).toBe(0);
    expect(inHandConfirmCount(reporter)).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "confirm.shutdown_deadline": 1 });

    await reporter.close();
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plane.confirms).toHaveLength(1);
    expect(reporter.droppedCounts).toEqual({ "confirm.shutdown_deadline": 1 });
    expect(plane.unmatchedRequests).toEqual([]);
    slow.end();
    await enforcer.close();
  });

  // Mutation caught: treating an OPEN breaker as a transport failure either drops the
  // confirm or duplicates it once recovery starts.
  it("holds a queued confirmation behind an open breaker then drains it exactly once", async () => {
    let now = 0;
    const plane = new FakeControlPlane();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      recoveryTimeoutJitter: 0,
      now: () => now,
      random: () => 0,
    });
    const enforcer = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch: plane.fetch,
      leaseEnabled: false,
      cacheTtl: 0,
      controlPlaneBreaker: breaker,
      now: () => Date.UTC(2026, 8, 3),
      monotonicNow: () => now,
    });
    const reservation = await enforcer.checkBudget(checkOptions());
    const outage = plane.outage({ path: "/api/v1/budgets/check", requests: 1 });
    await enforcer.checkBudget(checkOptions());
    outage.end();
    expect(breaker.getState().state).toBe("open");

    const reporter = new MetadataReporter(plane.apiUrl, plane.apiKey, {
      fetch: plane.fetch,
      flushInterval: 1_000_000,
      retryBackoffBase: 1,
      controlPlaneBreaker: breaker,
      monotonicClock: () => now,
    });
    const confirm = enforcer.buildConfirmRequest({
      reservationId: reservation.reservationId,
      model: "gpt-4o",
      provider: "openai",
      callId: callId(2),
      tokenDetails: zeroTokenDetails(),
    });
    reporter.reportConfirm(confirm);
    await reporter._flushRemaining();
    expect(reporter.confirmQueueSize).toBe(1);
    expect(plane.confirms).toEqual([]);
    expect(reporter.droppedCounts).toEqual({});

    now = 1_000;
    await reporter._flushRemaining();
    expect(breaker.getState().state).toBe("closed");
    expect(reporter.confirmQueueSize).toBe(0);
    expect(plane.confirms).toHaveLength(1);
    expectSerializedConfirm(plane.confirms[0], confirm);
    await reporter._flushRemaining();
    await reporter.close();
    expect(plane.confirms).toHaveLength(1);
    expectSerializedConfirm(plane.confirms[0], confirm);
    expect(reporter.droppedCounts).toEqual({});
    expect(plane.unmatchedRequests).toEqual([]);
    await enforcer.close();
  });

  it("preserves the hard deny across a subsequent budget-API outage even with failOpen=true (invariant 9)", async () => {
    const plane = new FakeControlPlane();
    plane.denyNext();
    const ingested: MetadataEvent[] = [];
    const confirms: BudgetConfirmRequest[] = [];
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      if (typeof init?.body === "string" && path === "/api/v1/metadata/ingest") {
        ingested.push(...(JSON.parse(init.body) as MetadataEvent[]));
      }
      if (typeof init?.body === "string" && path === "/api/v1/budgets/confirm") {
        confirms.push(JSON.parse(init.body) as BudgetConfirmRequest);
      }
      return plane.fetch(input, init);
    };
    const fetchMock = vi.fn<FetchLike>(fetch);
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const solwyn = new Solwyn(
      client,
      clientOptions(plane, { fetch: fetchMock, failOpen: true, budgetCheckCacheTtl: 0 }),
    );
    try {
      await expect(
        solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      const outage = plane.outage({ path: "/api/v1/budgets/check", requests: 1 });
      await expect(
        solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      outage.end();
    } finally {
      await solwyn.close();
    }
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(([input]) => new URL(input).pathname === "/api/v1/budgets/check"),
    ).toHaveLength(2);
    expect(plane.checks).toHaveLength(1);
    expect(ingested.map((event) => event.status)).toEqual(["budget_denied", "budget_denied"]);
    expect(confirms).toHaveLength(0);
    expect(plane.unmatchedRequests).toEqual([]);
  });
});

describe("lease game days", () => {
  // Mutation caught: losing a stopped renewal's directive or retaining its lease would
  // dispatch after operator stop, and surrendering the dropped lease would hit a route
  // the control plane intentionally does not implement.
  it("receives an operator stop through a detached lease renewal", async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    setRunControlClockForTest(() => nowMs);
    const plane = new FakeControlPlane({ refreshIntervalS: 0.001, leaseLengthS: 60 });
    const baseFetch = plane.fetch;
    const leaseSurrenders: unknown[] = [];
    vi.spyOn(plane, "fetch").mockImplementation((input, init) => {
      if (new URL(input).pathname === "/api/v1/budgets/lease/surrender") {
        leaseSurrenders.push(init?.body ?? null);
      }
      return baseFetch(input, init);
    });
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const wrapped = plane.wrap(provider, { reporterFlushInterval: 0.001 });
    let actualRunId = "";
    let stopped: RunStoppedError | undefined;

    try {
      await run("gameday-lease-kill", async () => {
        actualRunId = currentRun()?.agentRunId ?? "";
        expect(actualRunId).not.toBe("");
        await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
        plane.stopRun(actualRunId, { reason: "operator_stop" });

        // Two milliseconds exceeds the 0.85–1.15 ms jittered deadline but is well
        // before the 60-second lease expiry. The second call may itself see the stop.
        nowMs = 2;
        try {
          await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
        } catch (error) {
          stopped = error as RunStoppedError;
        }
        for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();

        expect(plane.leaseRenewals.length).toBeGreaterThan(0);
        expect(runTermination(actualRunId)).toMatchObject({
          reason: "operator_stop",
          source: "server",
        });
        expect(currentRunTerminated()).toBe(true);

        if (stopped === undefined) {
          try {
            await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
          } catch (error) {
            stopped = error as RunStoppedError;
          }
        }
        expect(leaseSurrenders).toEqual([]);
      });
    } finally {
      const closing = wrapped.close();
      await Promise.resolve();
      await vi.runAllTimersAsync();
      await closing;
    }

    expect(plane.leaseGrants).toHaveLength(1);
    expect(plane.leaseRenewals.length).toBeGreaterThan(0);
    expect(plane.leaseRenewals.every((renewal) => renewal.run_directive_version === "1")).toBe(
      true,
    );
    expect(stopped).toBeInstanceOf(RunStoppedError);
    expect(stopped).toMatchObject({
      agentRunId: actualRunId,
      reason: "operator_stop",
      source: "server",
    });
    expect(provider.chat.completions.create.mock.calls.length).toBeLessThanOrEqual(3);
    expect(leaseSurrenders).toEqual([]);
    expect(plane.denialReceipts.length).toBeGreaterThan(0);
    expect(
      plane.denialReceipts.every((receipt) => receipt.denied_by_period === "run_stopped"),
    ).toBe(true);
    expect(plane.denialReceipts.every((receipt) => receipt.deny_reason === "operator_stop")).toBe(
      true,
    );
    expect(plane.unmatchedRequests).toEqual([]);
  });

  // Mutations caught: treating a reachable lease refusal as an outage would skip its legacy
  // check; admitting a second post-outage call from exhausted headroom would reopen the run;
  // and sending close-time surrender while OPEN would make an unmatched fake request.
  it("falls back from lease refusals, spends outage headroom, then locally hard-denies", async () => {
    const wallNow = Date.UTC(2026, 8, 3);
    const monotonicNow = 0;
    const plane = new FakeControlPlane({
      mode: "hard_deny",
      grantedTokens: 30,
      refreshIntervalS: 60,
      leaseLengthS: 120,
    });
    const attemptedUrls: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      attemptedUrls.push(new URL(input).pathname);
      return plane.fetch(input, init);
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60,
      successThreshold: 1,
      recoveryTimeoutJitter: 0,
      now: () => monotonicNow,
      random: () => 0,
    });
    const enforcer = new BudgetEnforcer({
      apiUrl: plane.apiUrl,
      apiKey: plane.apiKey,
      fetch,
      failOpen: true,
      cacheTtl: 0,
      holderId: "gameday-holder",
      controlPlaneBreaker: breaker,
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
    });
    setRunControlClockForTest(() => monotonicNow);
    const check = (index: number, agentRunId: string) =>
      enforcer.checkBudget({
        callId: callId(index),
        estimatedInputTokens: 10,
        estimatedOutputBound: 20,
        model: "gpt-5.5",
        provider: "openai",
        agentRunId,
      });
    let attemptedBeforeClose = 0;

    try {
      const unavailable = plane.refuseLeases({
        status: 503,
        code: "lease_unavailable",
        requests: 1,
      });
      const legacyAfterUnavailable = await check(10, "gameday-unavailable");
      unavailable.end();
      expect(legacyAfterUnavailable).toMatchObject({ allowed: true, leaseId: null });

      const holderCap = plane.refuseLeases({
        status: 409,
        code: "lease_holder_cap_exceeded",
        requests: 1,
      });
      const legacyAfterHolderCap = await check(11, "gameday-holder-cap");
      holderCap.end();
      expect(legacyAfterHolderCap).toMatchObject({ allowed: true, leaseId: null });

      // The grant request is prepared before this one-request outage starts. Its real,
      // detached renewal then consumes the outage, opening the shared breaker before the
      // next two admissions draw from the retained headroom share.
      const granting = check(12, "gameday-outage");
      expect(plane.leaseGrants).toHaveLength(1);
      const outage = plane.outage({ requests: 1 });
      try {
        const granted = await granting;
        expect(granted).toMatchObject({ allowed: true, leaseId: "lse_fake1" });
        await flushUntil(() => breaker.getState().state === "open");
        expect(breaker.getState().state).toBe("open");

        const shared = await check(13, "gameday-outage");
        expect(shared).toMatchObject({ allowed: true, leaseId: "lse_fake1" });
        expect(shared.warning).toContain("headroom share");

        const exhausted = await check(14, "gameday-outage");
        expect(exhausted).toMatchObject({ allowed: false, deniedByPeriod: "agent_run" });
      } finally {
        outage.end();
      }

      expect(breaker.getState().state).toBe("open");
      expect(plane.leaseGrants).toHaveLength(1);
      expect(plane.checks).toHaveLength(2);
      expect(attemptedUrls).toEqual([
        "/api/v1/budgets/lease",
        "/api/v1/budgets/check",
        "/api/v1/budgets/lease",
        "/api/v1/budgets/check",
        "/api/v1/budgets/lease",
        "/api/v1/budgets/lease/renew",
      ]);
      attemptedBeforeClose = attemptedUrls.length;
    } finally {
      await enforcer.close();
    }

    expect(breaker.getState().state).toBe("open");
    expect(attemptedUrls).toHaveLength(attemptedBeforeClose);
    expect(attemptedUrls).not.toContain("/api/v1/budgets/lease/surrender");
    expect(plane.unmatchedRequests).toEqual([]);
  });
});
