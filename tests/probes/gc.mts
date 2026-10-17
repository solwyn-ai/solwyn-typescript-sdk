import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { debuglog } from "node:util";

const exposedGc = (globalThis as { gc?: () => void }).gc;
assert.ok(exposedGc, "run with --expose-gc");
const forceGc: () => void = exposedGc;
// NODE_DEBUG=solwyn-gc reports each wait's cycle count without changing probe output.
const debug = debuglog("solwyn-gc");

export function alive(refs: readonly WeakRef<object>[]): number {
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

/** Allow finalizers and asynchronous cleanup to advance without retaining dereferenced values. */
export async function settle(cycles: number): Promise<void> {
  for (let cycle = 0; cycle < cycles; cycle++) {
    await setImmediate();
    forceGc();
    await setImmediate();
  }
}

/** Wait for the release condition itself; a stable nonzero population is still a leak. */
export async function collectUntil(
  predicate: () => boolean,
  describe: () => string,
  maxCycles = 100,
): Promise<number> {
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    await settle(1);
    if (predicate()) {
      if (debug.enabled) debug("cycles=%d %s", cycle, describe());
      return cycle;
    }
  }
  assert.fail(`Release condition unmet after ${maxCycles} GC cycles: ${describe()}`);
}
