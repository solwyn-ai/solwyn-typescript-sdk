/**
 * Edge-safe, process-wide agent-run termination state.
 *
 * The registered-symbol slot keeps ESM and CJS copies on one exact-ID registry.
 * Bounded registry entries may be forgotten, while active stream handles retain
 * their immutable first winner until explicit release.
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

interface TerminationHandleCell {
  readonly runId: string;
  readonly generation: number;
  termination: RunTermination | undefined;
  released: boolean;
}

interface ActiveHandleGroup {
  generation: number;
  observedAt: number | undefined;
  readonly handles: Set<TerminationHandleCell>;
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

interface FinalizerHeldValue {
  readonly runId: string;
  readonly cell: TerminationHandleCell;
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

function activeGroupTermination(
  group: ActiveHandleGroup | undefined,
  source?: RunStoppedSource,
): RunTermination | undefined {
  if (group === undefined) {
    return undefined;
  }
  for (const handle of group.handles) {
    const termination = handle.termination;
    if (
      handle.generation === group.generation &&
      termination !== undefined &&
      (source === undefined || termination.source === source)
    ) {
      return termination;
    }
  }
  return undefined;
}

function advanceActiveGeneration(group: ActiveHandleGroup | undefined): void {
  if (group !== undefined) {
    group.generation += 1;
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

function releaseCell(runId: string, cell: TerminationHandleCell): void {
  if (cell.released) {
    return;
  }
  cell.released = true;
  const group = state().activeHandles.get(runId);
  if (group === undefined || !group.handles.delete(cell)) {
    return;
  }
  if (group.handles.size === 0) {
    state().activeHandles.delete(runId);
  }
}

const handleFinalizer = new FinalizationRegistry<FinalizerHeldValue>(({ runId, cell }) => {
  releaseCell(runId, cell);
});

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
    for (const handle of group.handles) {
      if (handle.generation === group.generation && handle.termination === undefined) {
        handle.termination = termination;
      }
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
    group = { generation: 0, observedAt: undefined, handles: new Set() };
    shared.activeHandles.set(runId, group);
  }

  const termination = shared.terminations.get(runId) ?? activeGroupTermination(group);
  if (termination !== undefined && group.observedAt === undefined) {
    group.observedAt = shared.observedAt.get(runId) ?? termination.atMonotonic;
  }
  const cell: TerminationHandleCell = {
    runId,
    generation: group.generation,
    termination,
    released: false,
  };
  group.handles.add(cell);

  let handle: TerminationHandle;
  handle = Object.freeze({
    runId,
    generation: cell.generation,
    get termination(): RunTermination | undefined {
      return cell.termination;
    },
    check(): RunTermination | undefined {
      return cell.termination;
    },
    release(): void {
      handleFinalizer.unregister(handle);
      releaseCell(runId, cell);
    },
  });
  // The group retains only `cell`; the finalized target is the returned handle shell.
  handleFinalizer.register(handle, { runId, cell }, handle);
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
