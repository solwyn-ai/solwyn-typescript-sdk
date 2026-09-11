/**
 * Process-local, per-provider circuit breaker.
 *
 * A pure in-memory CLOSED/OPEN/HALF_OPEN state machine that tracks one provider's
 * health inside a single SDK instance so the router can skip a failing provider and
 * retry it later without hammering it. It owns exactly one concern — the state
 * transitions plus a single-slot HALF_OPEN "probe" admission protocol — and exposes
 * a strictly non-mutating read (`recoveryEligible`) so routing can *order* failover
 * candidates without flipping breaker state as a side effect of merely inspecting it.
 * Only {@link CircuitBreaker.admit} may consume eligibility and flip OPEN→HALF_OPEN.
 *
 * Ported from `solwyn/circuit_breaker.py` (+ the `CircuitState` enum in
 * `solwyn/_types.py`). Never touches the wire, never sees prompt/response content,
 * never prices or meters calls, and holds no resources (no `close()`/`Symbol.asyncDispose`).
 *
 * ## Concurrency invariant (Python `threading.Lock` → single-threaded event loop)
 *
 * The Python implementation serializes every mutating method behind one mutex so that
 * under N racing threads the internal transition helpers fire *exactly once*. JavaScript
 * has no preemptive threading: a synchronous method body on one object always runs to
 * completion before any other callback can interleave. Therefore the lock has no TS
 * equivalent and is intentionally NOT ported. The property it preserved is upheld by a
 * hard rule enforced here:
 *
 *   **Every public method (`recordSuccess`, `recordFailure`, `admit`, `releaseProbe`,
 *   `getState`) and the `recoveryEligible` getter MUST stay fully synchronous — no
 *   `async`, no `await`, no microtask-yielding operation anywhere in their bodies.**
 *
 * As long as that holds, "exactly one transition fires under concurrent callers" is
 * automatically true (there is no instruction-level interleaving within one JS realm),
 * and interleaved async callers cannot double-admit the single HALF_OPEN probe slot.
 * Do NOT add `async` to any of these methods even under a future refactor.
 *
 * ## Time
 *
 * Python uses `time.monotonic()` (seconds). The web-standard, edge-safe equivalent is
 * `performance.now()` (milliseconds) — available in Node and browsers with no `node:*`
 * import. All internal time math is kept in **milliseconds**; `recoveryTimeout` (config
 * seconds) is converted to ms once at construction. `lastFailureTime` / `lastStateChange`
 * in {@link CircuitBreakerState} are therefore documented as monotonic **ms** via the
 * injected clock (default `performance.now`). The clock is injectable so tests never sleep.
 */

import { z } from "zod";
import type { Logger } from "./logging";
import { noopLogger } from "./logging";
import { CIRCUIT_STATES, type CircuitState } from "./types";

// ---------------------------------------------------------------------------
// Value objects.
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of a breaker's observable state (Pydantic `frozen=True,
 * extra="forbid"` → zod `strictObject` + `readonly` fields + `Object.freeze`).
 *
 * `lastFailureTime` / `lastStateChange` are monotonic **milliseconds** (via the
 * breaker's injected clock, default `performance.now`), NOT wall clock / epoch millis.
 */
export const CircuitBreakerStateSchema = z.strictObject({
  state: z.enum(CIRCUIT_STATES),
  failureCount: z.number().int(),
  successCount: z.number().int(),
  /** Monotonic ms of the most recent `recordFailure`, or `null` if none yet. */
  lastFailureTime: z.number().nullable(),
  /** Monotonic ms of the most recent state transition. */
  lastStateChange: z.number(),
  recoveryEligible: z.boolean(),
});

/** Immutable breaker snapshot returned by {@link CircuitBreaker.getState}. */
export type CircuitBreakerState = Readonly<z.infer<typeof CircuitBreakerStateSchema>>;

/**
 * Stored fields of a {@link CircuitBreakerAdmission} (the derived `ownsProbe` is a
 * getter, not a stored/validated field). Defined for parity with the port's
 * Pydantic→zod convention; admissions are minted internally and never parsed from
 * untrusted input, so this schema is not exercised on the hot path.
 */
export const CircuitBreakerAdmissionSchema = z.strictObject({
  allowed: z.boolean(),
  probeToken: z.number().int().nullable(),
});

/**
 * Frozen result of one {@link CircuitBreaker.admit} call.
 *
 * `ownsProbe` is a computed property: `true` iff this admission holds a probe token.
 * The absence of a bare `canProceed()` boolean is deliberate — callers must always go
 * through `admit()` and inspect `.allowed` / `.ownsProbe`, so probe ownership can never
 * be silently collapsed to a boolean.
 */
export class CircuitBreakerAdmission {
  readonly allowed: boolean;
  readonly probeToken: number | null;

  constructor(allowed: boolean, probeToken: number | null = null) {
    this.allowed = allowed;
    this.probeToken = probeToken;
    Object.freeze(this);
  }

  /** `true` iff this admission owns the HALF_OPEN probe slot (holds a token). */
  get ownsProbe(): boolean {
    return this.probeToken !== null;
  }
}

// ---------------------------------------------------------------------------
// Options.
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link CircuitBreaker}. Defaults mirror the Python
 * `CircuitBreaker.__init__` defaults (NOT the config-layer defaults — see the jitter
 * note). `recoveryTimeout` is in **seconds** to match the config/Python surface;
 * everything internal is milliseconds.
 */
export interface CircuitBreakerOptions {
  /** Diagnostic label used in transition logs. Default `"provider"`. */
  name?: string;
  /** Injectable logger for transition diagnostics. */
  logger?: Logger;
  /** Consecutive failures (while CLOSED) before opening. Default `3`. */
  failureThreshold?: number;
  /** Base wait (seconds) before a HALF_OPEN probe is allowed. Default `60`. */
  recoveryTimeout?: number;
  /** Consecutive successes (while HALF_OPEN) before closing. Default `2`. */
  successThreshold?: number;
  /**
   * Anti-stampede jitter fraction. This CLASS defaults it to `0.0` (deterministic —
   * exactly `recoveryTimeout`, no randomness at all). NOTE: `SolwynConfig` defaults it
   * to `0.2` and does not wire it to an env var; the config-driven registry passes the
   * config value through, so breakers built by the client run jittered by default.
   */
  recoveryTimeoutJitter?: number;
  /**
   * Monotonic clock returning **milliseconds** (default `performance.now`). Injectable
   * so tests can drive time without sleeping. Must be monotonic, not wall clock.
   */
  now?: () => number;
  /**
   * Uniform random source on `[0, 1)` for jitter sampling (default `Math.random`).
   * Non-cryptographic anti-stampede jitter — `Math.random` is the correct, sufficient
   * choice. Injectable so tests can pin the sampled recovery window.
   */
  random?: () => number;
}

/** The four live-replaceable tuning values governed by failover entitlement. */
export interface CircuitBreakerTuning {
  failureThreshold: number;
  recoveryTimeout: number;
  successThreshold: number;
  recoveryTimeoutJitter: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RECOVERY_TIMEOUT_SECONDS = 60;
const DEFAULT_SUCCESS_THRESHOLD = 2;
const DEFAULT_RECOVERY_TIMEOUT_JITTER = 0.0;

// ---------------------------------------------------------------------------
// CircuitBreaker.
// ---------------------------------------------------------------------------

/**
 * One provider's health state machine. See the module doc for the concurrency and
 * time invariants. All public methods are synchronous by contract — do not make them
 * async.
 */
export class CircuitBreaker {
  private failureThreshold: number;
  /** Base recovery window in **ms** (converted from `recoveryTimeout` seconds once). */
  private recoveryTimeoutMs: number;
  private successThreshold: number;
  private recoveryTimeoutJitter: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly name: string;
  private readonly logger: Logger;

  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private lastStateChange: number;

  /**
   * Effective recovery window (ms) sampled once at the moment of the most recent
   * transition INTO OPEN. Deterministic (`= recoveryTimeoutMs`) when jitter ≤ 0.
   */
  private effectiveRecoveryTimeoutMs: number;

  /** Whether the single HALF_OPEN probe slot is currently occupied. */
  private halfOpenProbeActive = false;
  /** Token identity of the live probe (gates release), or `null` when the slot is free. */
  private halfOpenProbeToken: number | null = null;
  /** Ever-increasing token minter; tokens are never reused, so stale tokens never collide. */
  private probeTokenCounter = 0;
  /** Outcomes may only update the episode in which this breaker admitted them. */
  private episode = 0;
  private readonly admissions = new WeakMap<CircuitBreakerAdmission, number>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.recoveryTimeoutMs = (options.recoveryTimeout ?? DEFAULT_RECOVERY_TIMEOUT_SECONDS) * 1000;
    this.successThreshold = options.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD;
    this.recoveryTimeoutJitter = options.recoveryTimeoutJitter ?? DEFAULT_RECOVERY_TIMEOUT_JITTER;
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? (() => Math.random());
    this.name = options.name ?? "provider";
    this.logger = options.logger ?? noopLogger;

    this.effectiveRecoveryTimeoutMs = this.recoveryTimeoutMs;
    this.lastStateChange = this.now();
  }

  // -- Non-mutating reads ----------------------------------------------------

  /**
   * Pure, non-mutating eligibility read the router orders candidates on. `true` iff the
   * breaker is currently OPEN AND the recovery window has elapsed; `false` in CLOSED,
   * HALF_OPEN, and OPEN-before-window. Reading it NEVER transitions state and is
   * idempotent — only {@link admit} may consume eligibility and flip OPEN→HALF_OPEN.
   */
  get recoveryEligible(): boolean {
    return this.state === "open" && this.shouldAttemptRecovery();
  }

  /** Immutable, non-mutating snapshot of the current observable state. */
  getState(): CircuitBreakerState {
    return Object.freeze(
      CircuitBreakerStateSchema.parse({
        state: this.state,
        failureCount: this.failureCount,
        successCount: this.successCount,
        lastFailureTime: this.lastFailureTime,
        lastStateChange: this.lastStateChange,
        recoveryEligible: this.recoveryEligible,
      }),
    );
  }

  // -- Mutating outcomes -----------------------------------------------------

  /**
   * Replace only tuning values while preserving the state machine's identity and history.
   * OPEN resamples its active recovery window immediately; CLOSED/HALF_OPEN defer sampling
   * until their next transition to OPEN, so neither state consumes randomness here.
   */
  replaceTuning(tuning: CircuitBreakerTuning): void {
    this.failureThreshold = tuning.failureThreshold;
    this.recoveryTimeoutMs = tuning.recoveryTimeout * 1000;
    this.successThreshold = tuning.successThreshold;
    this.recoveryTimeoutJitter = tuning.recoveryTimeoutJitter;
    if (this.state === "open") {
      this.effectiveRecoveryTimeoutMs = this.sampleEffectiveRecoveryTimeoutMs();
    }
  }

  /**
   * Record a successful call. When supplied, the exact admission must still belong
   * to this episode and (in HALF_OPEN) the live probe; stale outcomes are inert.
   * - CLOSED: resets the consecutive-failure streak (`failureCount → 0`); does NOT
   *   touch `successCount`. A no-op when already `0`.
   * - HALF_OPEN: frees the probe slot, then increments `successCount`; closes the
   *   circuit once `successCount ≥ successThreshold`, otherwise stays HALF_OPEN with a
   *   free slot (a fresh `admit()` may issue a new probe).
   * - OPEN: no-op (requests are rejected in OPEN; a stray success changes nothing).
   */
  recordSuccess(admission?: CircuitBreakerAdmission): void {
    if (!this.consumeAdmission(admission)) return;
    if (this.state === "closed") {
      this.failureCount = 0;
      return;
    }
    if (this.state === "half_open") {
      // Free the probe slot first, then count the success.
      this.halfOpenProbeActive = false;
      this.halfOpenProbeToken = null;
      this.successCount += 1;
      if (this.successCount >= this.successThreshold) {
        this.transitionToClosed();
      }
    }
  }

  /**
   * Record a failed call. An accepted outcome stamps `lastFailureTime` to now,
   * including scalar calls that cause no transition. A stale, foreign, or already
   * consumed admission is entirely inert, including timestamps.
   * - CLOSED: increments `failureCount`; opens once it reaches `failureThreshold`.
   * - HALF_OPEN: any single failure immediately reopens (no partial credit).
   * - OPEN: only the timestamp stamp above (which pushes back the recovery window).
   */
  recordFailure(admission?: CircuitBreakerAdmission): void {
    if (!this.consumeAdmission(admission)) return;
    this.lastFailureTime = this.now();
    if (this.state === "half_open") {
      this.transitionToOpen();
      return;
    }
    if (this.state === "closed") {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) {
        this.transitionToOpen();
      }
    }
  }

  // -- Admission protocol ----------------------------------------------------

  /**
   * The sole admission entry point (there is deliberately no `canProceed()` boolean).
   * - CLOSED: always `{ allowed: true, probeToken: null }` — no probe machinery.
   * - OPEN, window NOT elapsed: `{ allowed: false, probeToken: null }`, stays OPEN.
   * - OPEN, window elapsed: the first such call flips OPEN→HALF_OPEN AND atomically
   *   consumes the single probe slot, returning `{ allowed: true, probeToken: <int> }`.
   * - HALF_OPEN, slot occupied: `{ allowed: false, probeToken: null }`, no state change.
   * - HALF_OPEN, slot free: mints a fresh probe token and admits the caller.
   */
  admit(): CircuitBreakerAdmission {
    if (this.state === "closed") {
      return this.createAdmission();
    }
    if (this.state === "open") {
      if (this.shouldAttemptRecovery()) {
        this.transitionToHalfOpen();
        return this.createAdmission(this.mintProbe());
      }
      return new CircuitBreakerAdmission(false, null);
    }
    // HALF_OPEN.
    if (this.halfOpenProbeActive) {
      return new CircuitBreakerAdmission(false, null);
    }
    return this.createAdmission(this.mintProbe());
  }

  /**
   * A neutral third outcome distinct from success/failure: frees the probe slot ONLY,
   * without recording any verdict — `state`, `successCount`, and `failureCount` are
   * untouched. A safe no-op (never throws, never mutates) when `admission` is absent,
   * does not own a probe, the breaker is not currently HALF_OPEN, or the admission's
   * token is not the live probe token (a stale/foreign token can never release the
   * current probe — token identity gates the release, not "some probe is active").
   */
  releaseProbe(admission?: CircuitBreakerAdmission | null): void {
    if (admission === null || admission === undefined) {
      return;
    }
    if (this.admissions.get(admission) !== this.episode) return;
    this.admissions.delete(admission);
    if (!admission.ownsProbe) {
      return;
    }
    if (this.state !== "half_open" || !this.halfOpenProbeActive) {
      return;
    }
    if (admission.probeToken !== this.halfOpenProbeToken) {
      return;
    }
    this.halfOpenProbeActive = false;
    this.halfOpenProbeToken = null;
  }

  // -- Internals -------------------------------------------------------------

  private createAdmission(probeToken: number | null = null): CircuitBreakerAdmission {
    const admission = new CircuitBreakerAdmission(true, probeToken);
    this.admissions.set(admission, this.episode);
    return admission;
  }

  /** Optional unscoped calls preserve the low-level scalar state-machine API. */
  private consumeAdmission(admission: CircuitBreakerAdmission | undefined): boolean {
    if (admission === undefined) return true;
    const episode = this.admissions.get(admission);
    this.admissions.delete(admission);
    if (episode !== this.episode) return false;
    if (admission.ownsProbe) {
      return (
        this.state === "half_open" &&
        this.halfOpenProbeActive &&
        admission.probeToken === this.halfOpenProbeToken
      );
    }
    return this.state === "closed";
  }

  /** Non-mutating recovery-window check. `null` last-failure ⇒ immediately eligible. */
  private shouldAttemptRecovery(): boolean {
    if (this.lastFailureTime === null) {
      return true;
    }
    // Boundary-inclusive (`>=`).
    return this.now() - this.lastFailureTime >= this.effectiveRecoveryTimeoutMs;
  }

  private mintProbe(): number {
    this.probeTokenCounter += 1;
    const token = this.probeTokenCounter;
    this.halfOpenProbeToken = token;
    this.halfOpenProbeActive = true;
    return token;
  }

  /** Sample the effective recovery window for a fresh OPEN episode. */
  private sampleEffectiveRecoveryTimeoutMs(): number {
    if (this.recoveryTimeoutJitter <= 0.0) {
      // Deterministic: exactly the configured window, no random draw at all.
      return this.recoveryTimeoutMs;
    }
    // Symmetric multiplicative jitter: U ~ uniform[-jitter, +jitter), effective = base*(1+U).
    const u = (this.random() * 2 - 1) * this.recoveryTimeoutJitter;
    return this.recoveryTimeoutMs * (1 + u);
  }

  private logTransition(level: "info" | "warn", message: string): void {
    try {
      this.logger[level](message, this.name);
    } catch {
      // Diagnostics are best-effort; state transitions remain authoritative.
    }
  }

  private transitionToOpen(): void {
    this.episode += 1;
    this.state = "open";
    this.successCount = 0;
    this.halfOpenProbeActive = false;
    this.halfOpenProbeToken = null;
    this.effectiveRecoveryTimeoutMs = this.sampleEffectiveRecoveryTimeoutMs();
    this.lastStateChange = this.now();
    this.logTransition("warn", "Circuit breaker [%s] opened due to failures");
  }

  private transitionToHalfOpen(): void {
    this.state = "half_open";
    this.successCount = 0;
    this.failureCount = 0;
    // Intentionally does NOT touch lastFailureTime.
    this.halfOpenProbeActive = false;
    this.halfOpenProbeToken = null;
    this.lastStateChange = this.now();
    this.logTransition("info", "Circuit breaker [%s] half-open, testing recovery");
  }

  private transitionToClosed(): void {
    this.episode += 1;
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenProbeActive = false;
    this.halfOpenProbeToken = null;
    this.lastStateChange = this.now();
    this.logTransition("info", "Circuit breaker [%s] closed, recovered");
  }
}

// ---------------------------------------------------------------------------
// Registry / manager.
// ---------------------------------------------------------------------------

/**
 * Per-provider-**name** breaker registry (CLAUDE.md invariant 5: `name` is the
 * attribution axis). Holds exactly one {@link CircuitBreaker} per provider name for the
 * lifetime of one SDK instance — shared across same-name failover attempts, never
 * persisted, never shared cross-instance/cross-process. Every breaker is constructed
 * with the same config-resolved thresholds/jitter/clock passed through unchanged.
 *
 * Keyed by the provider `name` string (attribution), never by `dialect` (wire shape).
 */
export class CircuitBreakerManager {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private options: CircuitBreakerOptions;

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = options;
  }

  /** Retune existing breakers in place and update defaults for future provider names. */
  replaceTuning(tuning: CircuitBreakerTuning): void {
    this.options = { ...this.options, ...tuning };
    for (const breaker of this.breakers.values()) {
      breaker.replaceTuning(tuning);
    }
  }

  /**
   * Return the breaker for a provider name, lazily creating it (with the shared
   * config-resolved options) on first request.
   */
  get(providerName: string): CircuitBreaker {
    let breaker = this.breakers.get(providerName);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(this.options);
      this.breakers.set(providerName, breaker);
    }
    return breaker;
  }

  /** Whether a breaker has been created for this provider name. */
  has(providerName: string): boolean {
    return this.breakers.has(providerName);
  }

  /** Provider names that currently have a breaker. */
  names(): string[] {
    return [...this.breakers.keys()];
  }

  /** Immutable current snapshots for provider-state reporting. */
  snapshots(): Array<readonly [providerName: string, state: CircuitBreakerState]> {
    return [...this.breakers.entries()].map(([providerName, breaker]) => [
      providerName,
      breaker.getState(),
    ]);
  }

  /** Drop all breakers (fresh state). Process-local only; no cross-instance effect. */
  clear(): void {
    this.breakers.clear();
  }
}
