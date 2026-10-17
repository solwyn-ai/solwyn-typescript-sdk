import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { debuglog } from "node:util";

const forceGc = globalThis.gc;
const realNow = performance.now.bind(performance);
assert.ok(forceGc, "run with --expose-gc");
// NODE_DEBUG=solwyn-gc reports each wait's cycle count without changing probe output.
const debug = debuglog("solwyn-gc");

export function alive(refs) {
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

/** Allow finalizers and asynchronous cleanup to advance without retaining dereferenced values. */
export async function settle(cycles) {
  for (let cycle = 0; cycle < cycles; cycle++) {
    await setImmediate();
    forceGc();
    await setImmediate();
  }
}

/** Wait for release; allow at least one second for timers before exhausting the cycle budget. */
export async function collectUntil(predicate, describe, maxCycles = 100) {
  const earliestFailure = realNow() + 1000;
  let cycle = 0;
  while (cycle < maxCycles || realNow() < earliestFailure) {
    cycle++;
    await settle(1);
    if (predicate()) {
      if (debug.enabled) debug("cycles=%d %s", cycle, describe());
      return cycle;
    }
  }
  assert.fail(`Release condition unmet after ${cycle} GC cycles: ${describe()}`);
}
