import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as publicApi from "../../src/index";
import { resetCurrentRunReader, setCurrentRunReader } from "../../src/run-context";
import {
  acquireTerminationHandle,
  clearRunTermination,
  clearServerTerminationBeforeRequest,
  clearTerminationIf,
  currentRunTerminated,
  markTerminated,
  markTerminatedWithObservation,
  outageTermination,
  postcheckTermination,
  RunTermination,
  resetRunControlForTest,
  runObservedAt,
  runTermination,
  setRunControlClockForTest,
} from "../../src/run-control";

beforeEach(() => {
  resetRunControlForTest();
  resetCurrentRunReader();
});

afterEach(() => {
  resetRunControlForTest();
  resetCurrentRunReader();
});

describe("run termination registry public surface", () => {
  it("reports only the exact ambient run and exports no superseded error alias", () => {
    expect(runTermination("run_missing")).toBeUndefined();
    expect(currentRunTerminated()).toBe(false);

    setCurrentRunReader(() => ({ agentRunId: "run_current", agentRunName: "current" }));
    expect(currentRunTerminated()).toBe(false);

    markTerminated("run_current", { reason: "manual_kill", source: "server" });
    expect(currentRunTerminated()).toBe(true);

    setCurrentRunReader(() => ({ agentRunId: "run_current-near", agentRunName: "near" }));
    expect(currentRunTerminated()).toBe(false);

    expect(publicApi.RunTermination).toBe(RunTermination);
    expect(publicApi.runTermination).toBe(runTermination);
    expect(publicApi.clearRunTermination).toBe(clearRunTermination);
    expect(publicApi.currentRunTerminated).toBe(currentRunTerminated);
    expect(publicApi).not.toHaveProperty("RunTerminatedError");
  });
});

describe("first-writer and observation semantics", () => {
  it("freezes the first winner while a repeated mark refreshes one separate stamp", () => {
    const now = vi.fn().mockReturnValueOnce(12.5).mockReturnValueOnce(42);
    setRunControlClockForTest(now);

    const first = markTerminated("run_first", {
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    const repeated = markTerminatedWithObservation("run_first", {
      reason: "manual_kill",
      source: "server",
    });

    expectTypeOf(first).toEqualTypeOf<RunTermination>();
    expect(first).toBeInstanceOf(RunTermination);
    expect(Object.keys(first).sort()).toEqual(["atMonotonic", "reason", "source"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, "reason", "changed")).toBe(false);
    expect(first).toEqual({
      reason: "velocity:repeat_size",
      source: "local_velocity",
      atMonotonic: 12.5,
    });
    expect(repeated.termination).toBe(first);
    expect(repeated.observedAt).toBe(42);
    expect(runObservedAt("run_first")).toBe(42);
    expect(runTermination("run_first")).toBe(first);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("keeps RunTermination fields readonly at compile time", () => {
    const assertReadonly = (termination: RunTermination): void => {
      // @ts-expect-error RunTermination values are readonly.
      termination.reason = "changed";
      // @ts-expect-error RunTermination values are readonly.
      termination.source = "server";
      // @ts-expect-error RunTermination values are readonly.
      termination.atMonotonic = 0;
    };
    expect(assertReadonly).toBeTypeOf("function");
  });
});

describe("exact-ID bounded LRU", () => {
  it("holds exactly 256 runs, refreshes lookup recency, and never matches a near ID", () => {
    let now = 0;
    setRunControlClockForTest(() => ++now);
    for (let index = 0; index < 256; index += 1) {
      markTerminated(`run_${index}`, { reason: "manual_kill", source: "server" });
    }

    expect(runTermination("run_0")).toBeDefined();
    markTerminated("run_256", { reason: "manual_kill", source: "server" });

    expect(runTermination("run_0")).toBeDefined();
    expect(runTermination("run_1")).toBeUndefined();
    expect(runObservedAt("run_1")).toBeUndefined();
    expect(runTermination("run_256")).toBeDefined();
    expect(runTermination("run_25")).toBeDefined();
    expect(runTermination("run_25-near")).toBeUndefined();
  });

  it("refreshes repeated-mark recency in both exact maps", () => {
    let now = 0;
    setRunControlClockForTest(() => ++now);
    for (let index = 0; index < 256; index += 1) {
      markTerminated(`repeat_${index}`, { reason: "manual_kill", source: "server" });
    }

    markTerminated("repeat_0", { reason: "ignored", source: "local_velocity" });
    markTerminated("repeat_256", { reason: "manual_kill", source: "server" });

    expect(runTermination("repeat_0")?.reason).toBe("manual_kill");
    expect(runObservedAt("repeat_0")).toBe(257);
    expect(runTermination("repeat_1")).toBeUndefined();
    expect(runObservedAt("repeat_1")).toBeUndefined();
  });
});

describe("active termination handles", () => {
  it("latches one immutable winner into handles acquired before and after a mark", () => {
    const first = acquireTerminationHandle("run_stream");
    const second = acquireTerminationHandle("run_stream");

    expect(first.runId).toBe("run_stream");
    expect(first.generation).toBe(0);
    expect(first.check()).toBeUndefined();

    const winner = markTerminated("run_stream", { reason: "manual_kill", source: "server" });
    const third = acquireTerminationHandle("run_stream");

    expect(first.termination).toBe(winner);
    expect(first.check()).toBe(winner);
    expect(second.termination).toBe(winner);
    expect(third.termination).toBe(winner);
    expect(Object.isFrozen(winner)).toBe(true);

    first.release();
    first.release();
    second.release();
    third.release();
  });

  it("deletes an active group only after its last explicit release", () => {
    const first = acquireTerminationHandle("run_release");
    const second = acquireTerminationHandle("run_release");
    clearRunTermination("run_release");

    first.release();
    const whileSecondLives = acquireTerminationHandle("run_release");
    expect(whileSecondLives.generation).toBe(1);

    second.release();
    whileSecondLives.release();
    const afterLastRelease = acquireTerminationHandle("run_release");
    expect(afterLastRelease.generation).toBe(0);
    afterLastRelease.release();
  });

  it("retains an evicted sibling winner and reinstalls it on a repeated mark", () => {
    let now = 0;
    setRunControlClockForTest(() => ++now);
    const firstHandle = acquireTerminationHandle("run_live");
    const firstWinner = markTerminated("run_live", { reason: "first_stop", source: "server" });
    for (let index = 0; index < 256; index += 1) {
      markTerminated(`churn_${index}`, { reason: "later", source: "server" });
    }
    expect(runTermination("run_live")).toBeUndefined();

    const sibling = acquireTerminationHandle("run_live");
    const restored = markTerminatedWithObservation("run_live", {
      reason: "later_loser",
      source: "local_velocity",
    });

    expect(sibling.termination).toBe(firstWinner);
    expect(restored.termination).toBe(firstWinner);
    expect(runTermination("run_live")).toBe(firstWinner);
    expect(runObservedAt("run_live")).toBe(restored.observedAt);

    sibling.release();
    firstHandle.release();
  });
});

describe("clear semantics", () => {
  it("makes public clear forward-looking while an old latched handle keeps aborting", () => {
    const old = acquireTerminationHandle("run_clear");
    const oldWinner = markTerminated("run_clear", { reason: "old_stop", source: "server" });

    clearRunTermination("run_clear");
    const fresh = acquireTerminationHandle("run_clear");

    expect(old.termination).toBe(oldWinner);
    expect(old.check()).toBe(oldWinner);
    expect(fresh.generation).toBe(old.generation + 1);
    expect(fresh.check()).toBeUndefined();
    expect(runTermination("run_clear")).toBeUndefined();

    const newWinner = markTerminated("run_clear", { reason: "new_stop", source: "server" });
    expect(newWinner).not.toBe(oldWinner);
    expect(old.check()).toBe(oldWinner);
    expect(fresh.check()).toBe(newWinner);

    fresh.release();
    old.release();
  });

  it("clears only a matching first-writer source, including after exact eviction", () => {
    const localHandle = acquireTerminationHandle("run_local");
    markTerminated("run_local", {
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    clearTerminationIf("run_local", "server");
    expect(runTermination("run_local")?.source).toBe("local_velocity");

    for (let index = 0; index < 256; index += 1) {
      markTerminated(`source_churn_${index}`, { reason: "later", source: "server" });
    }
    expect(runTermination("run_local")).toBeUndefined();
    clearTerminationIf("run_local", "server");
    const stillStopped = acquireTerminationHandle("run_local");
    expect(stillStopped.termination?.source).toBe("local_velocity");

    clearTerminationIf("run_local", "local_velocity");
    const clean = acquireTerminationHandle("run_local");
    expect(clean.termination).toBeUndefined();

    clean.release();
    stillStopped.release();
    localHandle.release();
  });
});

describe("ordered server allow", () => {
  it.each([
    { requestEpoch: 19, boundary: "newer" },
    { requestEpoch: 20, boundary: "equal" },
  ])("preserves a $boundary stop observation", ({ requestEpoch }) => {
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20);
    setRunControlClockForTest(now);
    const winner = markTerminated("run_ordered", { reason: "first_stop", source: "server" });
    markTerminated("run_ordered", { reason: "repeated_stop", source: "server" });

    const ordered = clearServerTerminationBeforeRequest("run_ordered", requestEpoch);

    expect(ordered).toEqual({ reason: "first_stop", source: "server", atMonotonic: 20 });
    expect(Object.isFrozen(ordered)).toBe(true);
    expect(runTermination("run_ordered")).toBe(winner);
    expect(runObservedAt("run_ordered")).toBe(20);
  });

  it("clears only a strictly older server stop and fences old-generation handles", () => {
    setRunControlClockForTest(() => 10);
    const old = acquireTerminationHandle("run_old_server");
    const oldWinner = markTerminated("run_old_server", {
      reason: "old_stop",
      source: "server",
    });

    expect(clearServerTerminationBeforeRequest("run_old_server", 10.001)).toBeUndefined();
    const fresh = acquireTerminationHandle("run_old_server");

    expect(runTermination("run_old_server")).toBeUndefined();
    expect(old.termination).toBe(oldWinner);
    expect(fresh.generation).toBe(old.generation + 1);
    expect(fresh.termination).toBeUndefined();

    fresh.release();
    old.release();
  });

  it("never clears a local-velocity winner", () => {
    setRunControlClockForTest(() => 10);
    const winner = markTerminated("run_local_allow", {
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });

    expect(clearServerTerminationBeforeRequest("run_local_allow", 100)).toBeUndefined();
    expect(runTermination("run_local_allow")).toBe(winner);
  });

  it("recovers the newest sibling stamp after eviction for ordering and outage gates", () => {
    let now = 9;
    setRunControlClockForTest(() => ++now);
    const handle = acquireTerminationHandle("run_evicted_order");
    const winner = markTerminated("run_evicted_order", { reason: "first_stop", source: "server" });
    const repeated = markTerminatedWithObservation("run_evicted_order", {
      reason: "ignored",
      source: "server",
    });
    for (let index = 0; index < 256; index += 1) {
      markTerminated(`ordered_churn_${index}`, { reason: "later", source: "server" });
    }
    expect(runTermination("run_evicted_order")).toBeUndefined();

    expect(runObservedAt("run_evicted_order")).toBe(repeated.observedAt);
    expect(outageTermination("run_evicted_order")).toBe(winner);
    expect(postcheckTermination("run_evicted_order")).toBe(winner);
    expect(clearServerTerminationBeforeRequest("run_evicted_order", repeated.observedAt)).toEqual({
      reason: "first_stop",
      source: "server",
      atMonotonic: repeated.observedAt,
    });
    expect(runTermination("run_evicted_order")).toBe(winner);

    handle.release();
  });
});
