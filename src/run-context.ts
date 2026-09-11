/**
 * Core-side injectable "current run" reader (D4).
 *
 * The edge-safe core reads the active `solwyn.run(...)` scope — if any — through
 * this tiny seam, so `client.ts` has ZERO dependency on Node's `AsyncLocalStorage`
 * (`node:async_hooks`), which does not exist in edge/browser runtimes. The Node
 * entry point (`src/node.ts`) installs a real ALS-backed reader via
 * {@link setCurrentRunReader}; when nothing is installed (edge runtimes, or before
 * `src/node.ts` is imported) {@link getCurrentRun} returns `undefined` — the
 * "no run" resting state.
 *
 * The reader is stored on `globalThis` behind a registered `Symbol.for(...)` key
 * rather than a plain module-level variable. That makes the wiring robust against
 * the dual ESM/CJS package hazard: even if `run-context` is bundled twice (once per
 * entry, once per format), every copy reads and writes the SAME slot, so the reader
 * the Node entry installs is always the one the client sees. `globalThis` and
 * `Symbol.for` are both web-standard — this stays edge-safe.
 *
 * Ported from `solwyn/_run.py::current_run` (consumed here as an interface; the ALS
 * mechanism itself lives Node-side). This module imports NOTHING and never touches
 * prompt/response content — it only moves run identity and explicit attribution tags.
 */

/** Edge-safe run snapshot. Optional fields preserve compatibility with identity-only readers. */
export interface CurrentRun {
  readonly agentRunId: string;
  readonly agentRunName: string;
  readonly tags?: Readonly<Record<string, string>> | null;
  readonly parentAgentRunId?: string | null;
  /** Internal ownership token retained by ALS frames, handles, and admitted streams. */
  readonly lifetime?: object;
}

/** A side-effect-free reader of the currently-active run scope. */
export type CurrentRunReader = () => CurrentRun | undefined;

/** Global-registry key for the installed reader (shared across duplicate module copies). */
const READER_KEY = Symbol.for("@solwyn/sdk.currentRunReader");

interface GlobalWithReader {
  [READER_KEY]?: CurrentRunReader;
}

/**
 * The active run scope, or `undefined` when no scope is active (the default). The
 * client snapshots this ONCE at call entry and threads the snapshot through every
 * downstream metadata-event build, so a streaming call drained after its `run()`
 * scope has exited still tags events with the run that was active when the call was
 * issued.
 */
export function getCurrentRun(): CurrentRun | undefined {
  const reader = (globalThis as GlobalWithReader)[READER_KEY];
  return reader ? reader() : undefined;
}

/**
 * Install the current-run reader (called once by the Node entry point). Replaces any
 * previously-installed reader.
 */
export function setCurrentRunReader(reader: CurrentRunReader): void {
  (globalThis as GlobalWithReader)[READER_KEY] = reader;
}

/** Remove the installed reader, reverting to the "no run" resting state (tests). */
export function resetCurrentRunReader(): void {
  delete (globalThis as GlobalWithReader)[READER_KEY];
}
