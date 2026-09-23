/**
 * Edge-safe, process-wide agent-run termination state.
 *
 * The registered-symbol slot keeps ESM and CJS copies on one exact-ID registry.
 * Bounded registry entries may be forgotten, while active stream handles retain
 * their immutable first winner until explicit release.
 *
 * Active streams share termination authority through one epoch per clear
 * generation rather than per-handle cells: every handle acquired since the
 * run's last clear reads the same epoch, so acquire, release and stop are O(1)
 * regardless of how many streams one run has open. A clear installs a fresh
 * epoch and leaves the old one frozen for the streams that still hold it.
 */

import type { RunStoppedSource } from "./errors";
import { getCurrentRun } from "./run-context";

const MAX_TERMINATED_RUNS = 256;
const RUN_CONTROL_KEY = Symbol.for("@solwyn/sdk.runControl");

/** Immutable reason that an agent run may not dispatch further provider calls. */
export class RunTermination {
  readonly reason: string;
  readonly source: RunStoppedSource;
  readonly atMonotonic: number;

  constructor(options: {
    reason: string;
    source: RunStoppedSource;
    atMonotonic: number;
  }) {
    this.reason = options.reason;
    this.source = options.source;
    this.atMonotonic = options.atMonotonic;
    Object.freeze(this);
  }
}

export interface MarkTerminatedOptions {
  readonly reason: string;
  readonly source: RunStoppedSource;
}

/** One registry mark and the single clock reading used to order it. */
export interface ObservedRunTermination {
  readonly termination: RunTermination;
  readonly observedAt: number;
}

/** Stable one-stream watcher cell. */
export interface TerminationHandle {
  readonly runId: string;
  readonly generation: number;
  readonly termination: RunTermination | undefined;
  check(): RunTermination | undefined;
  release(): void;
}

/**
 * Termination authority shared by every watcher of one clear generation.
 *
 * Only a group's current epoch is ever written: a stop latches the first winner
 * while it has owners. A clear replaces the group's epoch instead of mutating
 * it, so a superseded epoch is frozen by construction. When the last current
 * owner releases a latched epoch, the group moves to a fresh epoch of the same
 * generation, so a later stream re-seeds from the bounded registry rather than
 * inheriting a winner that no live stream still owns.
 */
interface Epoch {
  readonly generation: number;
  termination: RunTermination | undefined;
  owners: number;
}

/**
 * Live watcher ownership for one run ID. `members` counts every live handle
 * across all generations so the group is dropped exactly when its last handle
 * releases; `epoch.owners` alone bounds the current winner's lifetime.
 */
interface ActiveHandleGroup {
  epoch: Epoch;
  observedAt: number | undefined;
  members: number;
}

/**
 * One handle's ownership record and the finalizer's held value. It never
 * references the handle shell, which stays the registration target. A released
 * handle keeps the winner it held at release instead of following its epoch.
 */
interface HandleOwnership {
  readonly runId: string;
  readonly group: ActiveHandleGroup;
  readonly epoch: Epoch;
  released: boolean;
  releasedTermination: RunTermination | undefined;
}

interface RunControlState {
  readonly terminations: Map<string, RunTermination>;
  readonly observedAt: Map<string, number>;
  readonly activeHandles: Map<string, ActiveHandleGroup>;
  now: () => number;
}

interface GlobalWithRunControl {
  [RUN_CONTROL_KEY]?: RunControlState;
}

const defaultNow = (): number => performance.now();

function createState(): RunControlState {
  return {
    terminations: new Map(),
    observedAt: new Map(),
    activeHandles: new Map(),
    now: defaultNow,
  };
}

function state(): RunControlState {
  const shared = globalThis as GlobalWithRunControl;
  const existing = shared[RUN_CONTROL_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const created = createState();
  shared[RUN_CONTROL_KEY] = created;
  return created;
}

function freshEpoch(generation: number): Epoch {
  return { generation, termination: undefined, owners: 0 };
}

/** Return a winner only from the active group's current clear epoch. */
function activeGroupTermination(
  group: ActiveHandleGroup | undefined,
  source?: RunStoppedSource,
): RunTermination | undefined {
  const termination = group?.epoch.termination;
  if (termination !== undefined && (source === undefined || termination.source === source)) {
    return termination;
  }
  return undefined;
}

/** Fence obsolete sibling winners; the old epoch stays with the handles that hold it. */
function advanceActiveGeneration(group: ActiveHandleGroup | undefined): void {
  if (group !== undefined) {
    group.epoch = freshEpoch(group.epoch.generation + 1);
    group.observedAt = undefined;
  }
}

function installExact(
  shared: RunControlState,
  runId: string,
  termination: RunTermination,
  observedAt: number,
): void {
  shared.terminations.delete(runId);
  shared.observedAt.delete(runId);
  shared.terminations.set(runId, termination);
  shared.observedAt.set(runId, observedAt);
  trimRegistry(shared);
}

function trimRegistry(shared: RunControlState): void {
  while (shared.terminations.size > MAX_TERMINATED_RUNS) {
    const oldest = shared.terminations.keys().next();
    if (oldest.done) {
      return;
    }
    shared.terminations.delete(oldest.value);
    shared.observedAt.delete(oldest.value);
  }
}

function releaseOwnership(ownership: HandleOwnership): void {
  if (ownership.released) {
    return;
  }
  ownership.released = true;
  ownership.releasedTermination = ownership.epoch.termination;
  const shared = state();
  const { runId, group, epoch } = ownership;
  // Group identity is the fence: after a test reset, a late release or
  // finalizer for a replaced group must never account against its successor.
  if (shared.activeHandles.get(runId) !== group) {
    return;
  }
  group.members -= 1;
  if (epoch === group.epoch) {
    epoch.owners -= 1;
    if (epoch.owners === 0 && epoch.termination !== undefined) {
      group.epoch = freshEpoch(epoch.generation);
    }
  }
  if (group.members === 0) {
    shared.activeHandles.delete(runId);
  }
}

const handleFinalizer = new FinalizationRegistry<HandleOwnership>(releaseOwnership);

/**
 * Record a stop and return both its preserved first winner and this mark's stamp.
 * Directive callers use the returned stamp so registry and sticky ordering share
 * exactly one clock reading.
 */
export function markTerminatedWithObservation(
  runId: string,
  options: MarkTerminatedOptions,
): ObservedRunTermination {
  const shared = state();
  const observedAt = shared.now();
  const group = shared.activeHandles.get(runId);
  let termination = shared.terminations.get(runId);
  if (termination === undefined) {
    termination = activeGroupTermination(group);
  }
  if (termination === undefined) {
    termination = new RunTermination({ ...options, atMonotonic: observedAt });
  }

  installExact(shared, runId, termination, observedAt);
  if (group !== undefined) {
    group.observedAt = observedAt;
    // One write latches every current-generation watcher. An ownerless epoch
    // never gains a winner that no live stream could hold.
    const epoch = group.epoch;
    if (epoch.owners > 0 && epoch.termination === undefined) {
      epoch.termination = termination;
    }
  }

  return Object.freeze({ termination, observedAt });
}

/** Record a stop while preserving and returning the first winner. */
export function markTerminated(runId: string, options: MarkTerminatedOptions): RunTermination {
  return markTerminatedWithObservation(runId, options).termination;
}

/** Register one active stream and seed it from the exact or current sibling winner. */
export function acquireTerminationHandle(runId: string): TerminationHandle {
  const shared = state();
  let group = shared.activeHandles.get(runId);
  if (group === undefined) {
    group = { epoch: freshEpoch(0), observedAt: undefined, members: 0 };
    shared.activeHandles.set(runId, group);
  }

  const termination = shared.terminations.get(runId) ?? activeGroupTermination(group);
  if (termination !== undefined && group.observedAt === undefined) {
    group.observedAt = shared.observedAt.get(runId) ?? termination.atMonotonic;
  }
  const epoch = group.epoch;
  if (epoch.termination === undefined) {
    epoch.termination = termination;
  }
  epoch.owners += 1;
  group.members += 1;
  const ownership: HandleOwnership = {
    runId,
    group,
    epoch,
    released: false,
    releasedTermination: undefined,
  };

  let handle: TerminationHandle;
  handle = Object.freeze({
    runId,
    generation: epoch.generation,
    get termination(): RunTermination | undefined {
      return ownership.released ? ownership.releasedTermination : epoch.termination;
    },
    check(): RunTermination | undefined {
      return ownership.released ? ownership.releasedTermination : epoch.termination;
    },
    release(): void {
      handleFinalizer.unregister(handle);
      releaseOwnership(ownership);
    },
  });
  // Neither the group nor the held value references the handle shell, which is
  // the finalized target; the per-handle `released` flag makes an explicit
  // release racing the finalizer idempotent.
  handleFinalizer.register(handle, ownership, handle);
  return handle;
}

/** Return the exact termination and refresh both registry maps' LRU recency. */
export function runTermination(runId: string): RunTermination | undefined {
  const shared = state();
  const termination = shared.terminations.get(runId);
  if (termination === undefined) {
    return undefined;
  }
  const observedAt = shared.observedAt.get(runId) ?? termination.atMonotonic;
  installExact(shared, runId, termination, observedAt);
  return termination;
}

/** Return the latest exact or active-group observation stamp. */
export function runObservedAt(runId: string): number | undefined {
  const shared = state();
  return shared.observedAt.get(runId) ?? shared.activeHandles.get(runId)?.observedAt;
}

/** Return an exact termination or a current-generation active sibling winner. */
export function outageTermination(runId: string): RunTermination | undefined {
  const shared = state();
  return shared.terminations.get(runId) ?? activeGroupTermination(shared.activeHandles.get(runId));
}

/** Return a stop that is authoritative after a live budget check. */
export function postcheckTermination(runId: string): RunTermination | undefined {
  return outageTermination(runId);
}

/**
 * Preserve a same-epoch or newer server stop, otherwise clear the older stop.
 * A preserved return value carries the latest observation stamp in `atMonotonic`.
 */
export function clearServerTerminationBeforeRequest(
  runId: string,
  requestEpoch: number,
): RunTermination | undefined {
  const shared = state();
  const group = shared.activeHandles.get(runId);
  const activeServer = activeGroupTermination(group, "server");
  const termination = shared.terminations.get(runId) ?? activeServer;
  if (termination === undefined || termination.source !== "server") {
    return undefined;
  }

  const observedAt =
    activeServer !== undefined && group?.observedAt !== undefined
      ? group.observedAt
      : (shared.observedAt.get(runId) ?? termination.atMonotonic);
  if (observedAt >= requestEpoch) {
    installExact(shared, runId, termination, observedAt);
    return new RunTermination({
      reason: termination.reason,
      source: termination.source,
      atMonotonic: observedAt,
    });
  }

  shared.terminations.delete(runId);
  shared.observedAt.delete(runId);
  advanceActiveGeneration(group);
  return undefined;
}

/** Clear only when the exact or current sibling first-writer source matches. */
export function clearTerminationIf(runId: string, source: RunStoppedSource): void {
  const shared = state();
  const group = shared.activeHandles.get(runId);
  const exact = shared.terminations.get(runId);
  const matchingSibling = activeGroupTermination(group, source);
  const clearsCurrent =
    exact?.source === source || (exact === undefined && matchingSibling !== undefined);
  if (!clearsCurrent) {
    return;
  }
  shared.terminations.delete(runId);
  shared.observedAt.delete(runId);
  advanceActiveGeneration(group);
}

/**
 * Clear any termination source for an exact run ID.
 *
 * Clearing is forward-looking. A stream whose handle already latched the stop
 * keeps aborting; its immutable winner is not removed. Restart the stream to
 * continue under the cleared state.
 */
export function clearRunTermination(runId: string): void {
  const shared = state();
  const group = shared.activeHandles.get(runId);
  shared.terminations.delete(runId);
  shared.observedAt.delete(runId);
  advanceActiveGeneration(group);
}

/** Return whether the exact ambient agent-run scope has a registry termination. */
export function currentRunTerminated(): boolean {
  const currentRun = getCurrentRun();
  return currentRun !== undefined && runTermination(currentRun.agentRunId) !== undefined;
}

/** Install a deterministic monotonic clock for focused tests. */
export function setRunControlClockForTest(now: () => number): void {
  state().now = now;
}

/** Clear process-wide registry state and restore the default monotonic clock. */
export function resetRunControlForTest(): void {
  const shared = state();
  shared.terminations.clear();
  shared.observedAt.clear();
  shared.activeHandles.clear();
  shared.now = defaultNow;
}
