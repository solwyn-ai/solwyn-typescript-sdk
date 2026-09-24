/// <reference types="node" />
/**
 * `@solwyn/sdk/node` — the Node-only entry point.
 *
 * This is the ONLY module in the SDK permitted to import `node:*`. It provides the
 * `AsyncLocalStorage`-backed run-scope machinery that the edge-safe core cannot
 * (there is no `AsyncLocalStorage` in edge/browser runtimes). Importing this module
 * installs the current-run reader into the core seam (`src/run-context.ts`) as a
 * side effect, so metadata events emitted by the `Solwyn` client automatically pick
 * up the active `run(...)` scope.
 *
 * Per D4 the run API is CALLBACK-BASED (`run(name, fn)` built on
 * `AsyncLocalStorage.run()`) — no `enterWith`, no re-enterable scope objects. Ordinary
 * async work (`await`, `setTimeout`, promises) propagates through `AsyncLocalStorage`
 * automatically, so `run(name, async () => { ... })` tags every event issued inside
 * the callback, including streaming calls drained later within the same async flow.
 * `worker_threads` boundaries never inherit a run — inherent to the runtime, matching
 * Python's OS-thread behavior.
 *
 * Everything from the edge-safe core (`@solwyn/sdk`) is re-exported here, so a Node
 * consumer can import the whole surface — client, config, errors, run scope — from a
 * single entry.
 *
 * Ported from `solwyn/_run.py` (the `run` / `current_run` / `_new_run_id` surface).
 * `run_in_executor` is intentionally NOT ported (no closure-carrying executor exists
 * in Node — see the porting spec). This module never touches prompt/response content.
 */

// `node:async_hooks` is the one Node builtin this entry uses. The project compiles
// with `types: []` (no ambient `@types/node` globals), but this explicit import still
// resolves to the installed `@types/node` module declaration — so `AsyncLocalStorage`
// is fully typed here without leaking Node globals (`setTimeout`/`fetch`/…) into the
// edge-safe core, which keeps its web-standard types.
import { type AsyncHook, AsyncLocalStorage, createHook } from "node:async_hooks";
import { SolwynError } from "./errors";
import type { MetadataReporter } from "./reporter";
import { type CurrentRun, setCurrentRunReader, setOutsideRunRunner } from "./run-context";
import { copyTags, type Tags } from "./tags";

const NODE_REPORTER_REGISTRATION = Symbol.for("@solwyn/sdk/node-reporter-registration");
const NODE_LEASE_REGISTRATION = Symbol.for("@solwyn/sdk/node-lease-registration");
const NODE_REPORTER_REGISTRY = Symbol.for("@solwyn/sdk/node-reporter-registry");
const EXIT_LEASE_BUDGET_MS = 2_000;

type ExitDrainableReporter = Pick<MetadataReporter, "close" | "isShutdown">;
interface ExitDrainableLeaseHolder {
  readonly isClosed: boolean;
  close(timeoutMs?: number): Promise<void>;
}

interface ExitRegistry {
  readonly reporters: Set<WeakRef<ExitDrainableReporter>>;
  leaseHolders: Set<WeakRef<ExitDrainableLeaseHolder>>;
  listenerInstalled: boolean;
}

function exitRegistry(): ExitRegistry {
  const existing = Reflect.get(globalThis, NODE_REPORTER_REGISTRY) as
    | Partial<ExitRegistry>
    | undefined;
  if (existing?.reporters !== undefined) {
    existing.leaseHolders ??= new Set();
    existing.listenerInstalled ??= false;
    return existing as ExitRegistry;
  }
  const created: ExitRegistry = {
    reporters: new Set(),
    leaseHolders: new Set(),
    listenerInstalled: false,
  };
  Reflect.set(globalThis, NODE_REPORTER_REGISTRY, created);
  return created;
}

// Collected participants leave their set through these finalizers, so registration
// never rescans the population. Closed participants that are still reachable are swept
// when a set has doubled since its last sweep, which keeps total registration work
// linear in the number of registrations.
const MIN_SWEEP_SIZE = 64;
const collectedReporters = new FinalizationRegistry<WeakRef<ExitDrainableReporter>>((ref) => {
  exitRegistry().reporters.delete(ref);
});
const collectedLeaseHolders = new FinalizationRegistry<WeakRef<ExitDrainableLeaseHolder>>((ref) => {
  exitRegistry().leaseHolders.delete(ref);
});
let reporterSweepAt = MIN_SWEEP_SIZE;
let leaseHolderSweepAt = MIN_SWEEP_SIZE;

function liveExitReporters(): ExitDrainableReporter[] {
  const registry = exitRegistry();
  const live: ExitDrainableReporter[] = [];
  for (const reference of registry.reporters) {
    const reporter = reference.deref();
    if (reporter === undefined || reporter.isShutdown) {
      registry.reporters.delete(reference);
      collectedReporters.unregister(reference);
    } else {
      live.push(reporter);
    }
  }
  return live;
}

function liveExitLeaseHolders(): ExitDrainableLeaseHolder[] {
  const registry = exitRegistry();
  const live: ExitDrainableLeaseHolder[] = [];
  for (const reference of registry.leaseHolders) {
    const holder = reference.deref();
    if (holder === undefined || holder.isClosed) {
      registry.leaseHolders.delete(reference);
      collectedLeaseHolders.unregister(reference);
    } else {
      live.push(holder);
    }
  }
  return live;
}

async function drainBeforeExit(): Promise<void> {
  // `process.once` consumed this listener before entering the async drain. Re-arm
  // registration synchronously so either participant population can install the next hook.
  exitRegistry().listenerInstalled = false;
  // Snapshot both populations at listener entry. Participants registered during either
  // phase belong exclusively to the next listener, preserving reporter-before-lease order.
  const reporters = liveExitReporters();
  const leaseHolders = liveExitLeaseHolders();
  await Promise.allSettled(reporters.map((reporter) => reporter.close()));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const leaseDeadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, EXIT_LEASE_BUDGET_MS);
  });
  try {
    const closes = Promise.allSettled(
      leaseHolders.map((holder) =>
        Promise.resolve().then(() => holder.close(EXIT_LEASE_BUDGET_MS)),
      ),
    );
    await Promise.race([closes, leaseDeadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  liveExitReporters();
  liveExitLeaseHolders();
}

function installExitListener(registry: ExitRegistry): void {
  if (registry.listenerInstalled) return;
  registry.listenerInstalled = true;
  process.once("beforeExit", drainBeforeExit);
}

function registerReporterForExit(reporter: ExitDrainableReporter): void {
  const registry = exitRegistry();
  if (registry.reporters.size >= reporterSweepAt) {
    liveExitReporters();
    reporterSweepAt = Math.max(MIN_SWEEP_SIZE, 2 * registry.reporters.size);
  }
  const reference = new WeakRef(reporter);
  registry.reporters.add(reference);
  collectedReporters.register(reporter, reference, reference);
  installExitListener(registry);
}

function registerLeaseHolderForExit(holder: ExitDrainableLeaseHolder): void {
  const registry = exitRegistry();
  if (registry.leaseHolders.size >= leaseHolderSweepAt) {
    liveExitLeaseHolders();
    leaseHolderSweepAt = Math.max(MIN_SWEEP_SIZE, 2 * registry.leaseHolders.size);
  }
  const reference = new WeakRef(holder);
  registry.leaseHolders.add(reference);
  collectedLeaseHolders.register(holder, reference, reference);
  installExitListener(registry);
}

// Private core-to-node seam. No core module imports `node:*` or `process`; a reporter
// sees this callback only when the consumer selected the dedicated Node entry point.
Reflect.set(globalThis, NODE_REPORTER_REGISTRATION, registerReporterForExit);
Reflect.set(globalThis, NODE_LEASE_REGISTRATION, registerLeaseHolderForExit);

/** Max `agent_run_name` length (mirrors the wire cap; enforced eagerly at `run()` time). */
export const AGENT_RUN_NAME_MAX_LENGTH = 255;

/** The single, process-wide run-scope store. Never one per scope (memory-leak guard). */
interface RunFrame extends CurrentRun {
  readonly lifetimeRef: WeakRef<object>;
  readonly tags: Readonly<Tags> | null;
  readonly parentAgentRunId: string | null;
  readonly parent: RunFrame | null;
}

/** Options for a callback-scoped run. */
export interface RunOptions {
  readonly tags?: Record<string, string> | null;
  readonly inheritTags?: boolean;
}

interface RunIdentity {
  readonly runId: string;
  readonly name: string;
  readonly tags: Readonly<Tags> | null;
  readonly parentRunId: string | null;
}

let constructRunHandle!: (identity: RunIdentity) => RunHandle;

/** A detached run identity that can be activated explicitly in later call stacks. */
export class RunHandle {
  #lifetime: object | undefined = {};
  readonly runId!: string;
  readonly #identity: RunIdentity;
  #activeActivations = 0;
  #finished = false;

  private constructor(identity: RunIdentity) {
    this.#identity = identity;
    Object.defineProperty(this, "runId", {
      configurable: false,
      enumerable: true,
      value: identity.runId,
      writable: false,
    });
  }

  static {
    constructRunHandle = (identity) => new RunHandle(identity);
  }

  /**
   * Activate this run for the lifetime represented by the callback's exact return value.
   * Accounting follows returned promise-like work only. Callers must return/await any
   * background work whose lifetime must continue to block {@link finish}.
   */
  activate<T>(fn: () => T): T {
    if (this.#finished) {
      throw new SolwynError(`run handle '${this.runId}' already finished`);
    }
    const activationParent = runStore.getStore() ?? null;
    const lifetime = this.#lifetime;
    if (lifetime === undefined) throw new SolwynError("run handle has no lifetime owner");
    for (let ancestor = activationParent; ancestor !== null; ancestor = ancestor.parent) {
      if (ancestor.agentRunId === this.#identity.runId) {
        throw new SolwynError(`run handle '${this.runId}' is already active in this context`);
      }
    }
    const frame: RunFrame = {
      agentRunId: this.#identity.runId,
      agentRunName: this.#identity.name,
      tags: this.#identity.tags,
      parentAgentRunId: this.#identity.parentRunId,
      parent: activationParent,
      lifetimeRef: new WeakRef(lifetime),
    };
    this.#activeActivations += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (this.#activeActivations <= 0) {
        throw new SolwynError("run handle activation count is inconsistent");
      }
      this.#activeActivations -= 1;
    };

    let result: T;
    try {
      result = inRunFrame(frame, lifetime, fn);
    } catch (error) {
      release();
      throw error;
    }

    let then: unknown;
    try {
      if ((typeof result === "object" && result !== null) || typeof result === "function") {
        then = Reflect.get(result as object, "then");
      }
    } catch (error) {
      release();
      throw error;
    }

    if (typeof then === "function") {
      try {
        Reflect.apply(then, result, [release, release]);
      } catch (error) {
        release();
        throw error;
      }
    } else {
      release();
    }
    return result;
  }

  /** Permanently finish this detached run handle. */
  finish(): void {
    if (this.#finished) {
      throw new SolwynError(`run handle '${this.runId}' already finished`);
    }
    if (this.#activeActivations > 0) {
      throw new SolwynError(
        `run handle '${this.runId}' cannot finish while activations are still active`,
      );
    }
    this.#finished = true;
    // Already-created async frames/streams retain their own copy. A kept finished
    // handle alone must not retain historical accounting forever.
    this.#lifetime = undefined;
  }
}

/** Public defensive snapshot of the current run frame. */
export interface RunContext {
  readonly agentRunId: string | null;
  readonly agentRunName: string | null;
  readonly tags: Tags | null;
  readonly parentAgentRunId: string | null;
}

// The store itself must be shared: replacing only a global reader would hide runs
// created by the previously loaded format. Keep Node-specific state in this entry.
const RUN_STORE_KEY = Symbol.for("@solwyn/sdk.node.runStore");
const RUN_OWNERS_KEY = Symbol.for("@solwyn/sdk.node.runOwners");
interface RunOwners {
  readonly resources: Map<number, object>;
  readonly synchronous: Set<object>;
  readonly hook: AsyncHook;
}
interface GlobalWithRunStore {
  [RUN_STORE_KEY]?: AsyncLocalStorage<RunFrame>;
  [RUN_OWNERS_KEY]?: RunOwners;
}
const sharedRunState = globalThis as GlobalWithRunStore;
sharedRunState[RUN_STORE_KEY] ??= new AsyncLocalStorage<RunFrame>();
const runStore = sharedRunState[RUN_STORE_KEY];

function installRunOwners(): RunOwners {
  // Node 20 lazily caches a MessageChannel for structuredClone. Initialize that
  // process-owned resource outside run context before observing user resources,
  // so the first completed native Responses clone cannot pin its run forever.
  runStore.exit(() => structuredClone(null));
  const resources = new Map<number, object>();
  const synchronous = new Set<object>();
  const hook = createHook({
    init(asyncId) {
      const owner = runStore.getStore()?.lifetimeRef.deref();
      if (owner !== undefined) resources.set(asyncId, owner);
    },
    promiseResolve(asyncId) {
      resources.delete(asyncId);
    },
    destroy(asyncId) {
      resources.delete(asyncId);
    },
  });
  hook.enable();
  return { resources, synchronous, hook };
}
sharedRunState[RUN_OWNERS_KEY] ??= installRunOwners();
const runOwners = sharedRunState[RUN_OWNERS_KEY];

/**
 * Node 20/22 retain ALS stores on fulfilled promises. Frames therefore weakly reference
 * their token; only executing callbacks, unresolved async resources, unfinished handles,
 * and active call snapshots own it. Keeping a completed promise is not continuing a run.
 */
function inRunFrame<T>(frame: RunFrame, owner: object, fn: () => T): T {
  const alreadyPinned = runOwners.synchronous.has(owner);
  runOwners.synchronous.add(owner);
  try {
    return runStore.run(frame, fn);
  } finally {
    if (!alreadyPinned) runOwners.synchronous.delete(owner);
  }
}

// Install the reader into the core seam as an import side effect. From now on the
// edge-safe `getCurrentRun()` consults this ALS; outside any `run()` it returns
// `undefined` (empty store), exactly like "no scope active".
setCurrentRunReader(() => {
  const frame = runStore.getStore();
  if (frame === undefined) return undefined;
  return Object.defineProperty(
    {
      agentRunId: frame.agentRunId,
      agentRunName: frame.agentRunName,
      tags: copyFrameTags(frame.tags),
      parentAgentRunId: frame.parentAgentRunId,
    },
    "lifetime",
    { value: frame.lifetimeRef.deref() },
  );
});

// Long-lived SDK loops (the reporter's flush timer) start outside any run, so a client
// constructed inside `run(...)` never makes that run's lifetime token outlive the run.
setOutsideRunRunner((fn) => runStore.exit(fn));

/**
 * Rejects any character in the Unicode general categories Cc (control), Cf (format),
 * Zl (line separator), or Zp (paragraph separator) — the exact ban Python enforces
 * via `unicodedata.category`, expressed as a single native property-escape regex.
 */
const DISALLOWED_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Generate a fresh run id: `"run_"` + a canonical lowercase hyphenated UUIDv4 (exactly
 * 40 characters, `-` at index 12). Unique per call (backed by `crypto.randomUUID()`,
 * web-standard, no `node:crypto` import needed). Independently testable, mirroring
 * Python's `_new_run_id`.
 */
export function newRunId(): string {
  return `run_${crypto.randomUUID()}`;
}

/**
 * Validate a run name eagerly (before any scope state is touched), returning it
 * unchanged on success. Rejections (all throw a typed {@link SolwynError}):
 *  - not a string → "requires a string";
 *  - empty or whitespace-only → "must be non-empty";
 *  - longer than {@link AGENT_RUN_NAME_MAX_LENGTH} → "max length" (255 is accepted,
 *    256 is not);
 *  - contains a Unicode control/format/separator character → "control characters".
 */
function validateRunName(name: unknown): string {
  if (typeof name !== "string") {
    throw new SolwynError("run name requires a string");
  }
  if (name.trim().length === 0) {
    throw new SolwynError("run name must be non-empty");
  }
  if (name.length > AGENT_RUN_NAME_MAX_LENGTH) {
    throw new SolwynError(`run name exceeds the max length of ${AGENT_RUN_NAME_MAX_LENGTH}`);
  }
  if (DISALLOWED_NAME_CHARS.test(name)) {
    throw new SolwynError("run name must not contain control characters");
  }
  return name;
}

/** Create a detached run without changing the current async-local context. */
export function createRun(name: string, options?: RunOptions): RunHandle {
  const runName = validateRunName(name);
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new SolwynError("createRun requires an options object");
  }
  const definition = options ?? {};
  if (definition.inheritTags !== undefined && typeof definition.inheritTags !== "boolean") {
    throw new SolwynError("solwyn.run(inheritTags) requires a boolean");
  }
  const creationParent = runStore.getStore() ?? null;
  const ownTags = copyTags(definition.tags, "solwyn.run(tags)");
  const identity: RunIdentity = Object.freeze({
    runId: newRunId(),
    name: runName,
    tags: scopeTags(ownTags, creationParent?.tags ?? null, definition.inheritTags ?? true),
    parentRunId: creationParent?.agentRunId ?? null,
  });
  return constructRunHandle(identity);
}

/**
 * Open an agent-run scope for the duration of `fn`. A fresh `(agentRunId,
 * agentRunName)` pair is bound to the async context and observable via
 * {@link currentRun} anywhere within `fn`'s synchronous body AND across any `await`
 * it performs; it is cleared automatically when `fn` settles (even on throw).
 *
 * Returns whatever `fn` returns (its value, or its promise for an `async` callback).
 * Two sequential `run(...)` calls with the same name get DIFFERENT ids (freshly
 * generated per entry). Concurrent async tasks each in their own `run(...)` are fully
 * isolated — `AsyncLocalStorage.run()` gives sound propagation with no cross-task
 * bleed.
 */
function copyFrameTags(tags: Readonly<Tags> | null): Tags | null {
  return tags === null ? null : Object.fromEntries(Object.entries(tags));
}

function scopeTags(
  ownTags: Tags | undefined,
  parentTags: Readonly<Tags> | null,
  inheritTags: boolean,
): Readonly<Tags> | null {
  if (ownTags === undefined && inheritTags) return parentTags;

  const entries: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  for (const layer of [ownTags, inheritTags ? parentTags : null]) {
    if (layer === undefined || layer === null) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push([key, value]);
    }
  }
  if (entries.length === 0) return null;
  const tags: Tags = {};
  for (const [key, value] of entries) {
    Object.defineProperty(tags, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
  return Object.freeze(tags);
}

export function run<T>(name: string, fn: () => T): T;
export function run<T>(name: string, options: RunOptions, fn: () => T): T;
export function run<T>(name: string, optionsOrFn: RunOptions | (() => T), callback?: () => T): T {
  const agentRunName = validateRunName(name);
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : callback;
  if (options === null || typeof options !== "object" || typeof fn !== "function") {
    throw new SolwynError("run requires an options object and callback");
  }
  if (options.inheritTags !== undefined && typeof options.inheritTags !== "boolean") {
    throw new SolwynError("solwyn.run(inheritTags) requires a boolean");
  }

  const parent = runStore.getStore() ?? null;
  const ownTags = copyTags(options.tags, "solwyn.run(tags)");
  const lifetime = {};
  const frame: RunFrame = {
    agentRunId: newRunId(),
    agentRunName,
    tags: scopeTags(ownTags, parent?.tags ?? null, options.inheritTags ?? true),
    parentAgentRunId: parent?.agentRunId ?? null,
    parent,
    lifetimeRef: new WeakRef(lifetime),
  };
  return inRunFrame(frame, lifetime, fn);
}

/**
 * The active run scope, or `undefined` when none is active. Side-effect-free,
 * synchronous, cheap, and deliberately identity-only for legacy callers. The widened
 * core reader and `currentRunContext()` provide defensive attribution snapshots.
 */
export function currentRun(): CurrentRun | undefined {
  const frame = runStore.getStore();
  if (frame === undefined) return undefined;
  return { agentRunId: frame.agentRunId, agentRunName: frame.agentRunName };
}

/** Return the current run's public context without exposing the internal frame chain. */
export function currentRunContext(): RunContext {
  const frame = runStore.getStore();
  if (frame === undefined) {
    return {
      agentRunId: null,
      agentRunName: null,
      tags: null,
      parentAgentRunId: null,
    };
  }
  return {
    agentRunId: frame.agentRunId,
    agentRunName: frame.agentRunName,
    tags: copyFrameTags(frame.tags),
    parentAgentRunId: frame.parentAgentRunId,
  };
}

export * from "./index";
