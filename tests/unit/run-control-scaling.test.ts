import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunStoppedSource } from "../../src/errors";
import {
  acquireTerminationHandle,
  clearRunTermination,
  clearServerTerminationBeforeRequest,
  clearTerminationIf,
  markTerminated,
  outageTermination,
  postcheckTermination,
  type RunTermination,
  resetRunControlForTest,
  runObservedAt,
  runTermination,
  type TerminationHandle,
} from "../../src/run-control";

/**
 * Structural view of the registered-symbol run-control slot. These tests assert
 * owner and epoch accounting directly; they never measure time.
 */
interface EpochView {
  readonly generation: number;
  readonly termination: RunTermination | undefined;
  readonly owners: number;
}

interface GroupView {
  readonly epoch: EpochView;
  readonly members: number;
  readonly observedAt: number | undefined;
}

interface StateView {
  readonly activeHandles: Map<string, GroupView>;
}

const RUN_CONTROL_KEY = Symbol.for("@solwyn/sdk.runControl");
const MAX_TERMINATED_RUNS = 256;

function runControlState(): StateView {
  const slot = (globalThis as { [RUN_CONTROL_KEY]?: StateView })[RUN_CONTROL_KEY];
  if (slot === undefined) throw new Error("run-control state was not initialized");
  return slot;
}

function group(runId: string): GroupView {
  const found = runControlState().activeHandles.get(runId);
  if (found === undefined) throw new Error(`no active group for ${runId}`);
  return found;
}

function evict(runId: string): void {
  for (let index = 0; index < MAX_TERMINATED_RUNS; index += 1) {
    markTerminated(`eviction-${index}`, { reason: "other", source: "server" });
  }
  expect(runTermination(runId)).toBeUndefined();
}

/** Count every element any Set iterator yields while `body` runs synchronously. */
function countSetVisits(body: () => void): number {
  const proto = Set.prototype as unknown as Record<PropertyKey, unknown>;
  const originalIterator = proto[Symbol.iterator] as (this: Set<unknown>) => Iterator<unknown>;
  const originalValues = proto["values"] as (this: Set<unknown>) => Iterator<unknown>;
  const originalForEach = proto["forEach"] as (
    this: Set<unknown>,
    callback: (value: unknown, key: unknown, set: Set<unknown>) => void,
  ) => void;
  let visits = 0;
  const counted = function (this: Set<unknown>): Iterator<unknown> {
    const inner = originalValues.call(this);
    return {
      next(): IteratorResult<unknown> {
        const step = inner.next();
        if (step.done !== true) visits += 1;
        return step;
      },
      [Symbol.iterator]() {
        return this;
      },
    } as Iterator<unknown>;
  };
  proto[Symbol.iterator] = counted;
  proto["values"] = counted;
  proto["forEach"] = function (
    this: Set<unknown>,
    callback: (value: unknown, key: unknown, set: Set<unknown>) => void,
  ): void {
    originalForEach.call(this, (value, key, set) => {
      visits += 1;
      callback(value, key, set);
    });
  };
  try {
    body();
  } finally {
    proto[Symbol.iterator] = originalIterator;
    proto["values"] = originalValues;
    proto["forEach"] = originalForEach;
  }
  return visits;
}

beforeEach(() => {
  resetRunControlForTest();
});

afterEach(() => {
  resetRunControlForTest();
});

describe("same-run cohort scaling", () => {
  it("acquires, stops, looks up and releases 1,000 same-run handles without visiting siblings", () => {
    const count = 1000;
    const handles: TerminationHandle[] = [];
    let winner: RunTermination | undefined;
    const visits = countSetVisits(() => {
      for (let index = 0; index < count; index += 1) {
        handles.push(acquireTerminationHandle("cohort"));
      }
      expect(outageTermination("cohort")).toBeUndefined();
      expect(postcheckTermination("cohort")).toBeUndefined();
      expect(clearServerTerminationBeforeRequest("cohort", 0)).toBeUndefined();
      winner = markTerminated("cohort", { reason: "stop", source: "local_velocity" });
      for (const handle of handles) handle.release();
    });

    expect(visits).toBe(0);
    expect(handles.every((handle) => handle.check() === winner)).toBe(true);
    expect(runControlState().activeHandles.size).toBe(0);
  });

  it.each([
    { size: 1, independent: false },
    { size: 32, independent: false },
    { size: 512, independent: false },
    { size: 1, independent: true },
    { size: 32, independent: true },
    { size: 512, independent: true },
  ])("keeps scalar owner accounting for $size healthy handles (independent runs: $independent)", ({
    size,
    independent,
  }) => {
    const handles: TerminationHandle[] = [];
    for (let index = 0; index < size; index += 1) {
      handles.push(acquireTerminationHandle(independent ? `run-${index}` : "run-0"));
    }
    const state = runControlState();
    expect(state.activeHandles.size).toBe(independent ? size : 1);
    for (const [runId, active] of state.activeHandles) {
      const owned = handles.filter((handle) => handle.runId === runId).length;
      expect(active.members).toBe(owned);
      expect(active.epoch.owners).toBe(owned);
      expect(active.epoch.generation).toBe(0);
      expect(active.epoch.termination).toBeUndefined();
      expect(active.observedAt).toBeUndefined();
    }
    expect(handles.every((handle) => handle.termination === undefined)).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      expect(postcheckTermination("run-0")).toBeUndefined();
      expect(outageTermination("run-0")).toBeUndefined();
    }

    for (const handle of handles) {
      clearRunTermination(handle.runId);
      const active = group(handle.runId);
      // A clear installs a fresh epoch; the live handle keeps its own.
      expect(active.epoch.generation).toBeGreaterThan(handle.generation);
      expect(active.epoch.owners).toBe(0);
      const membersBefore = active.members;
      handle.release();
      handle.release();
      if (membersBefore > 1) {
        expect(group(handle.runId).members).toBe(membersBefore - 1);
      } else {
        expect(state.activeHandles.has(handle.runId)).toBe(false);
      }
    }
    expect(state.activeHandles.size).toBe(0);
  });

  it.each([
    1, 32, 512,
  ])("latches one shared epoch for %i current handles and retires it with the last owner", (size) => {
    const old = acquireTerminationHandle("run");
    clearRunTermination("run");
    const handles = Array.from({ length: size }, () => acquireTerminationHandle("run"));
    const active = group("run");
    const epoch = active.epoch;
    expect(handles.every((handle) => handle.generation === epoch.generation)).toBe(true);
    expect(old.generation).not.toBe(epoch.generation);
    expect([active.members, epoch.owners]).toEqual([size + 1, size]);

    const winner = markTerminated("run", { reason: "current", source: "local_velocity" });
    // One write to the shared epoch is the whole latch; the obsolete handle's
    // frozen epoch never learns it.
    expect(epoch.termination).toBe(winner);
    expect(handles.every((handle) => handle.termination === winner)).toBe(true);
    expect(old.termination).toBeUndefined();

    evict("run");
    handles.forEach((handle, index) => {
      expect(postcheckTermination("run")).toBe(winner);
      expect(handle.check()).toBe(winner);
      handle.release();
      handle.release();
      expect(active.members).toBe(size - index);
      expect(epoch.owners).toBe(size - index - 1);
    });
    expect(group("run").epoch.termination).toBeUndefined();
    expect(group("run").epoch.owners).toBe(0);
    expect(postcheckTermination("run")).toBeUndefined();
    expect(old.termination).toBeUndefined();
    old.release();
    expect(runControlState().activeHandles.size).toBe(0);
  });

  it("retains only live handles on a fresh epoch across generation churn", () => {
    const old = acquireTerminationHandle("run");
    const active = group("run");
    const oldEpoch = active.epoch;
    expect([active.members, oldEpoch.owners]).toEqual([1, 1]);
    for (let round = 1; round <= 512; round += 1) {
      clearRunTermination("run");
      expect(active.epoch).not.toBe(oldEpoch);
      expect(active.epoch.generation).toBe(round);
      expect(active.epoch.owners).toBe(0);
      const fresh = acquireTerminationHandle("run");
      expect(fresh.termination).toBeUndefined();
      expect(fresh.generation).toBe(round);
      expect([active.members, active.epoch.owners]).toEqual([2, 1]);
      fresh.release();
      expect([active.members, active.epoch.owners]).toEqual([1, 0]);
      expect(group("run")).toBe(active);
    }
    // The obsolete owner never migrated onto a later epoch, and the superseded
    // epoch it still reads was never written after the clear.
    expect(old.generation).toBe(0);
    expect(old.termination).toBeUndefined();
    expect(oldEpoch.owners).toBe(1);
    old.release();
    expect(runControlState().activeHandles.size).toBe(0);
  });
});

describe("stop authority lifetimes", () => {
  it.each([
    { source: "server" as RunStoppedSource, releaseOldFirst: false },
    { source: "server" as RunStoppedSource, releaseOldFirst: true },
    { source: "local_velocity" as RunStoppedSource, releaseOldFirst: false },
    { source: "local_velocity" as RunStoppedSource, releaseOldFirst: true },
  ])("expires $source authority with the last current owner (release old first: $releaseOldFirst)", ({
    source,
    releaseOldFirst,
  }) => {
    const old = acquireTerminationHandle("run");
    const oldStop = markTerminated("run", { reason: "old", source: "server" });
    clearRunTermination("run");
    const current = acquireTerminationHandle("run");
    const winner = markTerminated("run", { reason: "current", source });
    evict("run");
    const sibling = acquireTerminationHandle("run");
    expect(sibling.termination).toBe(winner);
    expect(postcheckTermination("run")).toBe(winner);
    expect(old.termination).toBe(oldStop);

    if (releaseOldFirst) old.release();
    current.release();
    current.release(); // Double cleanup cannot retire the remaining sibling.
    expect(postcheckTermination("run")).toBe(winner);
    sibling.release();
    expect(postcheckTermination("run")).toBeUndefined();
    const fresh = acquireTerminationHandle("run");
    expect(fresh.termination).toBeUndefined();
    expect(old.termination).toBe(oldStop);
    fresh.release();
    old.release();
    expect(runControlState().activeHandles.size).toBe(0);
  });

  it.each([
    "server",
    "local_velocity",
  ] as const)("never gives a %s stop without current owners active-only authority", (source) => {
    const old = acquireTerminationHandle("run");
    markTerminated("run", { reason: "old", source: "server" });
    clearRunTermination("run");
    markTerminated("run", { reason: "no_current_owner", source });
    evict("run");
    expect(postcheckTermination("run")).toBeUndefined();
    const fresh = acquireTerminationHandle("run");
    expect(fresh.termination).toBeUndefined();
    fresh.release();
    old.release();
    expect(runControlState().activeHandles.size).toBe(0);
  });

  it("keeps global authority and the group observation after the last current release", () => {
    const old = acquireTerminationHandle("run");
    clearRunTermination("run");
    const current = acquireTerminationHandle("run");
    const winner = markTerminated("run", { reason: "current", source: "server" });
    const stamp = runObservedAt("run");
    current.release();
    expect(runTermination("run")).toBe(winner);
    expect(postcheckTermination("run")).toBe(winner);
    evict("run");
    expect(postcheckTermination("run")).toBeUndefined();
    expect(runObservedAt("run")).toBe(stamp);
    old.release();
    expect(runObservedAt("run")).toBeUndefined();
  });

  it.each([
    "server",
    "local_velocity",
  ] as const)("filters %s by source and keeps the first writer after clear and eviction", (source) => {
    const other: RunStoppedSource = source === "server" ? "local_velocity" : "server";
    const old = acquireTerminationHandle("run");
    markTerminated("run", { reason: "obsolete", source: other });
    clearRunTermination("run");
    const current = acquireTerminationHandle("run");
    const winner = markTerminated("run", { reason: "winner", source });
    evict("run");
    clearTerminationIf("run", other);
    expect(postcheckTermination("run")).toBe(winner);
    expect(markTerminated("run", { reason: "loser", source: other })).toBe(winner);
    evict("run");
    clearTerminationIf("run", source);
    expect(postcheckTermination("run")).toBeUndefined();
    expect(current.termination).toBe(winner);
    current.release();
    old.release();
  });

  it("never overwrites the current epoch's first winner on a repeated stop", () => {
    const first = acquireTerminationHandle("run");
    const winner = markTerminated("run", { reason: "first", source: "server" });
    const second = acquireTerminationHandle("run");
    expect(second.generation).toBe(first.generation);
    expect(second.termination).toBe(winner);
    evict("run");
    expect(markTerminated("run", { reason: "loser", source: "local_velocity" })).toBe(winner);
    expect(group("run").epoch.termination).toBe(winner);
    expect([first.termination, second.termination]).toEqual([winner, winner]);
    first.release();
    expect(second.termination).toBe(winner);
    expect(postcheckTermination("run")).toBe(winner);
    second.release();
    expect(runControlState().activeHandles.size).toBe(0);
  });

  it("keeps a released handle's winner fixed while its epoch stays current", () => {
    const released = acquireTerminationHandle("run");
    const live = acquireTerminationHandle("run");
    released.release();
    const winner = markTerminated("run", { reason: "after_release", source: "server" });
    expect(live.check()).toBe(winner);
    expect(released.check()).toBeUndefined();
    expect(released.termination).toBeUndefined();
    live.release();
    expect(live.check()).toBe(winner);
    expect(runControlState().activeHandles.size).toBe(0);
  });

  it("fences a pre-reset handle's release by group identity", () => {
    const stale = acquireTerminationHandle("run");
    const staleGroup = group("run");
    resetRunControlForTest();
    const successor = acquireTerminationHandle("run");
    const successorGroup = group("run");
    expect(successorGroup).not.toBe(staleGroup);
    const winner = markTerminated("run", { reason: "successor", source: "server" });
    evict("run");

    stale.release();
    expect(group("run")).toBe(successorGroup);
    expect([successorGroup.members, successorGroup.epoch.owners]).toEqual([1, 1]);
    expect(postcheckTermination("run")).toBe(winner);
    const sibling = acquireTerminationHandle("run");
    expect(sibling.termination).toBe(winner);
    successor.release();
    expect(postcheckTermination("run")).toBe(winner);
    sibling.release();
    expect(runControlState().activeHandles.size).toBe(0);
  });
});
