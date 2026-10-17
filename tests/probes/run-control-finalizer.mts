import assert from "node:assert/strict";
import {
  acquireTerminationHandle,
  markTerminated,
  postcheckTermination,
  resetRunControlForTest,
  runTermination,
} from "../../src/run-control";
import { collectUntil, settle } from "./gc.mjs";

interface GroupView {
  readonly epoch: { readonly owners: number };
  readonly members: number;
}

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

// Control: an abandoned handle's finalizer releases its own group ownership.
resetRunControlForTest();
const kept = acquireTerminationHandle("control");
const controlRef = abandonHandle("control");
assert.deepEqual(
  [activeHandles().get("control")?.members, activeHandles().get("control")?.epoch.owners],
  [2, 2],
);
await collectUntil(
  () =>
    controlRef.deref() === undefined &&
    activeHandles().get("control")?.members === 1 &&
    activeHandles().get("control")?.epoch.owners === 1,
  () =>
    `control: shells=${Number(controlRef.deref() !== undefined)}, members=${activeHandles().get("control")?.members}, owners=${activeHandles().get("control")?.epoch.owners}`,
);
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
await collectUntil(
  () => staleRef.deref() === undefined,
  () => `stale handle shells=${Number(staleRef.deref() !== undefined)}`,
);
// The successor's ownership must stay intact across further finalizer turns.
await settle(8);
assert.equal(activeHandles().get("run"), successorGroup);
assert.deepEqual([successorGroup.members, successorGroup.epoch.owners], [1, 1]);
assert.equal(postcheckTermination("run"), winner);
assert.equal(successor.check(), winner);
successor.release();
assert.equal(activeHandles().size, 0);
resetRunControlForTest();

process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
