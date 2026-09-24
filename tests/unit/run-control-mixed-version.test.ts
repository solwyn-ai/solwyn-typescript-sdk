import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunStoppedSource } from "../../src/errors";
import * as current from "../../src/run-control";
import * as rc1 from "../helpers/run-control-rc1";

/**
 * An older copy of the package (the per-handle-cell algorithm published in
 * 0.1.0-rc.1) and the current copy share the registered-symbol slot. Every
 * interleaving must stay exception-free and keep both copies' accounting.
 */

interface Termination {
  readonly reason: string;
  readonly source: RunStoppedSource;
  readonly atMonotonic: number;
}

interface Handle {
  readonly runId: string;
  readonly generation: number;
  readonly termination: Termination | undefined;
  check(): Termination | undefined;
  release(): void;
}

interface CopyApi {
  acquireTerminationHandle(runId: string): Handle;
  markTerminated(runId: string, options: { reason: string; source: RunStoppedSource }): Termination;
  clearRunTermination(runId: string): void;
  clearTerminationIf(runId: string, source: RunStoppedSource): void;
  clearServerTerminationBeforeRequest(runId: string, requestEpoch: number): Termination | undefined;
  outageTermination(runId: string): Termination | undefined;
  postcheckTermination(runId: string): Termination | undefined;
  runObservedAt(runId: string): number | undefined;
  runTermination(runId: string): Termination | undefined;
  resetRunControlForTest(): void;
}

type CopyName = "rc1" | "current";
const copies: Record<CopyName, CopyApi> = { rc1, current };
const other = (name: CopyName): CopyName => (name === "rc1" ? "current" : "rc1");

interface CellView {
  readonly generation: number;
  readonly termination: Termination | undefined;
  readonly owners?: number;
}

interface GroupView {
  readonly generation: number;
  readonly observedAt: number | undefined;
  readonly handles: Set<CellView>;
  readonly epoch?: CellView & { readonly owners: number };
  readonly members?: number;
  readonly epochCells?: number;
}

interface StateView {
  readonly terminations: Map<string, Termination>;
  readonly activeHandles: Map<string, GroupView>;
}

const RUN_CONTROL_KEY = Symbol.for("@solwyn/sdk.runControl");

function slot(): StateView {
  const found = (globalThis as { [RUN_CONTROL_KEY]?: StateView })[RUN_CONTROL_KEY];
  if (found === undefined) throw new Error("run-control state was not initialized");
  return found;
}

function group(runId: string): GroupView {
  const found = slot().activeHandles.get(runId);
  if (found === undefined) throw new Error(`no active group for ${runId}`);
  return found;
}

function evict(copy: CopyApi): void {
  for (let index = 0; index < 256; index += 1) {
    copy.markTerminated(`eviction-${index}`, { reason: "other", source: "server" });
  }
}

interface Live {
  readonly copy: CopyName;
  readonly handle: Handle;
}

/** Both copies' accounting agrees with the handles the test still holds. */
function expectConsistent(live: readonly Live[]): void {
  const runIds = new Set(live.map((entry) => entry.handle.runId));
  for (const runId of slot().activeHandles.keys()) {
    if (runId.startsWith("eviction-")) continue;
    expect(runIds.has(runId), `stale group for ${runId}`).toBe(true);
  }
  for (const runId of runIds) {
    const active = group(runId);
    const mine = live.filter((entry) => entry.handle.runId === runId);
    const olderCells = mine.filter((entry) => entry.copy === "rc1").length;
    const currentHandles = mine.length - olderCells;
    const epochs = [...active.handles].filter((cell) => cell.owners !== undefined);
    expect(active.handles.size - epochs.length).toBe(olderCells);
    expect(active.epochCells ?? 0).toBe(epochs.length);
    expect(active.members ?? 0).toBe(currentHandles);
    expect(epochs.reduce((sum, epoch) => sum + (epoch.owners ?? 0), 0)).toBe(currentHandles);
    expect(epochs.every((epoch) => (epoch.owners ?? 0) > 0)).toBe(true);
  }
}

beforeEach(() => {
  current.resetRunControlForTest();
});

afterEach(() => {
  current.resetRunControlForTest();
});

describe.each([
  { first: "rc1" as CopyName },
  { first: "current" as CopyName },
])("an older per-handle copy and the current copy on one run ($first acquires first)", ({
  first,
}) => {
  const second = other(first);
  const A = copies[first];
  const B = copies[second];

  it("acquires, looks up and releases across copies without throwing", () => {
    const a = A.acquireTerminationHandle("run");
    const b = B.acquireTerminationHandle("run");
    const live: Live[] = [
      { copy: first, handle: a },
      { copy: second, handle: b },
    ];
    expectConsistent(live);
    for (const copy of [A, B]) {
      expect(copy.outageTermination("run")).toBeUndefined();
      expect(copy.postcheckTermination("run")).toBeUndefined();
      expect(copy.clearServerTerminationBeforeRequest("run", 0)).toBeUndefined();
      expect(copy.runObservedAt("run")).toBeUndefined();
    }
    expect([a.generation, b.generation]).toEqual([0, 0]);

    a.release();
    a.release();
    expectConsistent(live.slice(1));
    b.release();
    b.release();
    expect(slot().activeHandles.has("run")).toBe(false);
  });

  it.each([
    "first",
    "second",
  ] as const)("latches both copies' live handles on a stop from the %s copy", (stopper) => {
    const stopCopy = stopper === "first" ? A : B;
    const a = A.acquireTerminationHandle("run");
    const b = B.acquireTerminationHandle("run");
    const winner = stopCopy.markTerminated("run", { reason: "stop", source: "server" });
    expect(a.check()).toBe(winner);
    expect(b.check()).toBe(winner);
    expect(A.markTerminated("run", { reason: "loser", source: "local_velocity" })).toBe(winner);
    expect(B.markTerminated("run", { reason: "loser", source: "local_velocity" })).toBe(winner);

    // The bounded registry forgets the stop; live siblings in either copy still seed it.
    evict(A);
    expect(A.runTermination("run")).toBeUndefined();
    for (const copy of [A, B]) {
      expect(copy.postcheckTermination("run")).toBe(winner);
      const sibling = copy.acquireTerminationHandle("run");
      expect(sibling.termination).toBe(winner);
      sibling.release();
    }
    expectConsistent([
      { copy: first, handle: a },
      { copy: second, handle: b },
    ]);
    a.release();
    b.release();
    expect(slot().activeHandles.has("run")).toBe(false);
  });

  it.each([
    "first",
    "second",
  ] as const)("shares registry stops with future acquisitions in the other copy (stop from %s)", (stopper) => {
    const stopCopy = stopper === "first" ? A : B;
    const winner = stopCopy.markTerminated("run", { reason: "stop", source: "local_velocity" });
    for (const copy of [A, B]) {
      const handle = copy.acquireTerminationHandle("run");
      expect(handle.termination).toBe(winner);
      expect(copy.outageTermination("run")).toBe(winner);
      handle.release();
    }
    expect(slot().activeHandles.has("run")).toBe(false);
  });

  it.each([
    "first",
    "second",
  ] as const)("keeps a clear from the %s copy forward-only for both copies", (clearer) => {
    const clearCopy = clearer === "first" ? A : B;
    const a = A.acquireTerminationHandle("run");
    const b = B.acquireTerminationHandle("run");
    const oldStop = A.markTerminated("run", { reason: "old", source: "server" });
    const aUnlatched = A.acquireTerminationHandle("other-run");
    const bUnlatched = B.acquireTerminationHandle("other-run");

    clearCopy.clearRunTermination("run");
    clearCopy.clearRunTermination("other-run");
    expect([a.check(), b.check()]).toEqual([oldStop, oldStop]);
    expect(group("run").generation).toBe(1);
    for (const copy of [A, B]) {
      expect(copy.outageTermination("run")).toBeUndefined();
    }

    const aFresh = A.acquireTerminationHandle("run");
    const bFresh = B.acquireTerminationHandle("run");
    expect([aFresh.generation, bFresh.generation]).toEqual([1, 1]);
    expect([aFresh.termination, bFresh.termination]).toEqual([undefined, undefined]);

    // A later stop from either copy latches only post-clear handles.
    const winner = B.markTerminated("run", { reason: "new", source: "local_velocity" });
    const lateStop = A.markTerminated("other-run", { reason: "late", source: "server" });
    expect([aFresh.check(), bFresh.check()]).toEqual([winner, winner]);
    expect([a.check(), b.check()]).toEqual([oldStop, oldStop]);
    expect(lateStop.reason).toBe("late");
    expect([aUnlatched.check(), bUnlatched.check()]).toEqual([undefined, undefined]);

    const live: Live[] = [
      { copy: first, handle: a },
      { copy: second, handle: b },
      { copy: first, handle: aFresh },
      { copy: second, handle: bFresh },
      { copy: first, handle: aUnlatched },
      { copy: second, handle: bUnlatched },
    ];
    expectConsistent(live);
    for (const entry of live) entry.handle.release();
    expect(slot().activeHandles.size).toBe(0);
  });

  it.each([
    "server",
    "local_velocity",
  ] as const)("applies source-filtered clears from either copy to a %s stop", (source) => {
    const otherSource: RunStoppedSource = source === "server" ? "local_velocity" : "server";
    const a = A.acquireTerminationHandle("run");
    const b = B.acquireTerminationHandle("run");
    const winner = A.markTerminated("run", { reason: "stop", source });
    evict(B);
    B.clearTerminationIf("run", otherSource);
    expect(A.postcheckTermination("run")).toBe(winner);
    B.clearTerminationIf("run", source);
    expect(A.postcheckTermination("run")).toBeUndefined();
    expect(B.postcheckTermination("run")).toBeUndefined();
    expect([a.check(), b.check()]).toEqual([winner, winner]);
    a.release();
    b.release();
    expect(slot().activeHandles.size).toBe(0);
  });

  it("keeps the other copy's group alive until its last handle releases", () => {
    const a1 = A.acquireTerminationHandle("run");
    const a2 = A.acquireTerminationHandle("run");
    const b = B.acquireTerminationHandle("run");
    const shared = group("run");
    a1.release();
    a2.release();
    expect(group("run")).toBe(shared);
    expectConsistent([{ copy: second, handle: b }]);
    const winner = A.markTerminated("run", { reason: "stop", source: "server" });
    expect(b.check()).toBe(winner);
    b.release();
    expect(slot().activeHandles.has("run")).toBe(false);
  });

  it("fences a release from before the other copy's test reset", () => {
    const stale = A.acquireTerminationHandle("run");
    B.resetRunControlForTest();
    const successor = B.acquireTerminationHandle("run");
    const successorGroup = group("run");
    const sibling = A.acquireTerminationHandle("run");
    stale.release();
    expect(group("run")).toBe(successorGroup);
    expectConsistent([
      { copy: second, handle: successor },
      { copy: first, handle: sibling },
    ]);
    successor.release();
    sibling.release();
    expect(slot().activeHandles.size).toBe(0);
  });
});

describe("randomized cross-copy interleavings", () => {
  /** Deterministic 32-bit LCG so every failure is reproducible from its seed. */
  function random(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      return value / 2 ** 32;
    };
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("stays exception-free and consistent (seed %i)", (seed) => {
    const next = random(seed);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
    const runs = ["r0", "r1"];
    const sources: RunStoppedSource[] = ["server", "local_velocity"];
    let clock = 0;
    current.setRunControlClockForTest(() => {
      clock += 1;
      return clock;
    });
    let live: Live[] = [];
    const liveTerminations = (runId: string) => {
      const active = slot().activeHandles.get(runId);
      return live
        .filter((entry) => entry.handle.runId === runId)
        .filter((entry) => active !== undefined && entry.handle.generation === active.generation)
        .map((entry) => entry.handle.termination);
    };

    for (let step = 0; step < 1500; step += 1) {
      const copyName = pick<CopyName>(["rc1", "current"]);
      const copy = copies[copyName];
      const runId = pick(runs);
      const op = Math.floor(next() * 9);
      if (op <= 2) {
        const expected = slot().terminations.get(runId);
        const siblingStopped = liveTerminations(runId).some((value) => value !== undefined);
        const handle = copy.acquireTerminationHandle(runId);
        live.push({ copy: copyName, handle });
        if (expected !== undefined) {
          expect(handle.termination).toBe(expected);
        } else {
          expect(handle.termination !== undefined).toBe(siblingStopped);
        }
      } else if (op === 3 && live.length > 0) {
        const index = Math.floor(next() * live.length);
        const entry = live[index] as Live;
        const before = entry.handle.check();
        entry.handle.release();
        entry.handle.release();
        expect(entry.handle.check()).toBe(before);
        live = live.filter((_, position) => position !== index);
      } else if (op === 4) {
        const winner = copy.markTerminated(runId, {
          reason: `stop-${step}`,
          source: pick(sources),
        });
        expect(slot().terminations.get(runId)).toBe(winner);
        expect(liveTerminations(runId).every((value) => value !== undefined)).toBe(true);
      } else if (op === 5) {
        const before = live.map((entry) => entry.handle.check());
        const kind = Math.floor(next() * 3);
        if (kind === 0) copy.clearRunTermination(runId);
        else if (kind === 1) copy.clearTerminationIf(runId, pick(sources));
        else copy.clearServerTerminationBeforeRequest(runId, clock + (next() < 0.5 ? -5 : 5));
        // Clearing never rewrites a live handle's latched winner.
        live.forEach((entry, index) => {
          if (before[index] !== undefined) expect(entry.handle.check()).toBe(before[index]);
        });
      } else if (op === 6) {
        copy.outageTermination(runId);
        copy.postcheckTermination(runId);
        copy.runObservedAt(runId);
        copy.runTermination(runId);
      } else if (op === 7 && next() < 0.2) {
        evict(copy);
      }
      expectConsistent(live);
    }

    for (const entry of live) entry.handle.release();
    for (const runId of runs) expect(slot().activeHandles.has(runId)).toBe(false);
  });
});

it("releases abandoned handles of either copy by finalizer without touching the other copy", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "tests/probes/run-control-mixed-version.mts"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
}, 35_000);
