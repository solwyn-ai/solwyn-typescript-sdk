import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  acquireTerminationHandle,
  markTerminated,
  postcheckTermination,
  resetRunControlForTest,
  runTermination,
} from "../../src/run-control";

interface GroupView {
  readonly epoch: { readonly owners: number };
  readonly members: number;
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

/** Acquire and drop one handle without an explicit release; return only a weak observer. */
function abandonHandle(runId: string): WeakRef<object> {
  return new WeakRef(acquireTerminationHandle(runId));
}

/**
 * Collect until the abandoned shell is gone, then give finalization cleanup
 * tasks several more turns. The control scenario proves the window is enough
 * for the SDK's own finalizer to run.
 */
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

// Control: an abandoned handle's finalizer releases its own group ownership.
resetRunControlForTest();
const kept = acquireTerminationHandle("control");
const controlRef = abandonHandle("control");
assert.deepEqual(
  [activeHandles().get("control")?.members, activeHandles().get("control")?.epoch.owners],
  [2, 2],
);
await collect(controlRef);
assert.deepEqual(
  [activeHandles().get("control")?.members, activeHandles().get("control")?.epoch.owners],
  [1, 1],
);
kept.release();
assert.equal(activeHandles().size, 0);

// A late finalizer from before a reset cannot decrement the successor group.
resetRunControlForTest();
const staleRef = abandonHandle("run");
resetRunControlForTest();
const successor = acquireTerminationHandle("run");
const successorGroup = activeHandles().get("run");
assert.ok(successorGroup);
const winner = markTerminated("run", { reason: "successor", source: "server" });
for (let index = 0; index < 256; index++) {
  markTerminated(`eviction-${index}`, { reason: "other", source: "server" });
}
assert.equal(runTermination("run"), undefined);
await collect(staleRef);
assert.equal(activeHandles().get("run"), successorGroup);
assert.deepEqual([successorGroup.members, successorGroup.epoch.owners], [1, 1]);
assert.equal(postcheckTermination("run"), winner);
assert.equal(successor.check(), winner);
successor.release();
assert.equal(activeHandles().size, 0);
resetRunControlForTest();

process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
