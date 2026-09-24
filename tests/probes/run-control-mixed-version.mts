import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import * as current from "../../src/run-control";
import * as rc1 from "../helpers/run-control-rc1";

interface GroupView {
  readonly handles: Set<object>;
  readonly epoch?: { readonly owners: number };
  readonly members?: number;
  readonly epochCells?: number;
}

interface CopyApi {
  acquireTerminationHandle(runId: string): object;
  resetRunControlForTest(): void;
}

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.ok(forceGc, "run with --expose-gc");
const RUN_CONTROL_KEY = Symbol.for("@solwyn/sdk.runControl");

function activeHandles(): Map<string, GroupView> {
  const slot = (globalThis as { [RUN_CONTROL_KEY]?: { activeHandles: Map<string, GroupView> } })[
    RUN_CONTROL_KEY
  ];
  assert.ok(slot, "run-control state was not initialized");
  return slot.activeHandles;
}

/** [cells in the shared Set, current-copy members, current-copy epoch cells]. */
function accounting(runId: string): [number, number, number] | undefined {
  const group = activeHandles().get(runId);
  return group === undefined
    ? undefined
    : [group.handles.size, group.members ?? 0, group.epochCells ?? 0];
}

/** Acquire and drop one handle without an explicit release; return only a weak observer. */
function abandonHandle(copy: CopyApi, runId: string): WeakRef<object> {
  return new WeakRef(copy.acquireTerminationHandle(runId));
}

async function collect(ref: WeakRef<object>): Promise<void> {
  for (let attempt = 0; attempt < 50 && ref.deref() !== undefined; attempt++) {
    await setImmediate();
    forceGc?.();
  }
  assert.equal(ref.deref(), undefined, "abandoned handle shell was not collected");
  for (let turn = 0; turn < 8; turn++) {
    await setImmediate();
    forceGc?.();
  }
}

const copies: Record<"rc1" | "current", CopyApi> = { rc1, current };

for (const [abandoning, keeping] of [
  ["rc1", "current"],
  ["current", "rc1"],
] as const) {
  // An abandoned handle's finalizer releases only its own copy's share of the group.
  current.resetRunControlForTest();
  const kept = copies[keeping].acquireTerminationHandle("run") as { release(): void };
  const keptCurrent = keeping === "current" ? 1 : 0;
  const ref = abandonHandle(copies[abandoning], "run");
  // One per-handle cell plus the current copy's single epoch cell.
  assert.deepEqual(accounting("run"), [2, 1, 1]);
  await collect(ref);
  assert.deepEqual(accounting("run"), [1, keptCurrent, keptCurrent]);
  kept.release();
  assert.equal(activeHandles().size, 0);

  // A late finalizer from before the other copy's reset cannot touch the successor group.
  current.resetRunControlForTest();
  const staleRef = abandonHandle(copies[abandoning], "late");
  copies[keeping].resetRunControlForTest();
  const successor = copies[keeping].acquireTerminationHandle("late") as { release(): void };
  const successorGroup = activeHandles().get("late");
  await collect(staleRef);
  assert.equal(activeHandles().get("late"), successorGroup);
  assert.deepEqual(accounting("late"), [1, keptCurrent, keptCurrent]);
  successor.release();
  assert.equal(activeHandles().size, 0);
}
current.resetRunControlForTest();

process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
