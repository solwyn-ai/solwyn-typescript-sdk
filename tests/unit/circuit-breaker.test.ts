/**
 * Circuit-breaker unit tests covering closed, open, and half-open transitions;
 * concurrent mutation; probe admission and release; state inspection; recovery
 * eligibility; and recovery-timeout jitter.
 *
 * Time is driven through an injected monotonic clock (ms) so nothing ever sleeps.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerAdmission,
  CircuitBreakerManager,
  type CircuitBreakerOptions,
  CircuitBreakerStateSchema,
} from "../../src/circuit-breaker";
import type { Logger } from "../../src/logging";

// ---------------------------------------------------------------------------
// Test harness: a controllable monotonic clock.
// ---------------------------------------------------------------------------

class FakeClock {
  private t: number;
  constructor(start = 1000) {
    this.t = start;
  }
  now = (): number => this.t;
  advanceMs(ms: number): void {
    this.t += ms;
  }
  advanceSeconds(s: number): void {
    this.t += s * 1000;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

function makeBreaker(options: Partial<CircuitBreakerOptions> = {}): {
  breaker: CircuitBreaker;
  clock: FakeClock;
} {
  const clock = new FakeClock();
  const breaker = new CircuitBreaker({ now: clock.now, ...options });
  return { breaker, clock };
}

/** Drive a fresh CLOSED breaker to OPEN by hitting the failure threshold. */
function driveToOpen(breaker: CircuitBreaker, failureThreshold: number): void {
  for (let i = 0; i < failureThreshold; i++) {
    breaker.recordFailure();
  }
}

describe("transition diagnostics", () => {
  it("logs named open, half-open, and recovered transitions with exact shapes", () => {
    const clock = new FakeClock();
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      name: "control-plane",
      logger,
      now: clock.now,
    });

    breaker.recordFailure();
    clock.advanceSeconds(1);
    breaker.admit();
    breaker.recordSuccess();

    expect(logger.warn).toHaveBeenCalledWith(
      "Circuit breaker [%s] opened due to failures",
      "control-plane",
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      1,
      "Circuit breaker [%s] half-open, testing recovery",
      "control-plane",
    );
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      "Circuit breaker [%s] closed, recovered",
      "control-plane",
    );
  });
});

// ---------------------------------------------------------------------------
// State inspection.
// ---------------------------------------------------------------------------

describe("getState", () => {
  it("returns_correct_dataclass — fresh breaker has documented zero/None/CLOSED defaults", () => {
    const { breaker } = makeBreaker();
    const s = breaker.getState();
    expect(s.state).toBe("closed");
    expect(s.failureCount).toBe(0);
    expect(s.successCount).toBe(0);
    expect(s.lastFailureTime).toBeNull();
    expect(s.recoveryEligible).toBe(false);
    expect(typeof s.lastStateChange).toBe("number");
  });

  it("reflects_mutations — snapshot reflects post-failure OPEN state", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    const s = breaker.getState();
    expect(s.state).toBe("open");
    expect(s.failureCount).toBe(1);
    expect(s.lastFailureTime).toBe(clock.now());
  });

  it("is non-mutating: repeated calls do not change state", () => {
    const { breaker } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN
    const a = breaker.getState();
    const b = breaker.getState();
    expect(a).toEqual(b);
    expect(breaker.getState().state).toBe("open");
  });

  it("test_circuit_breaker_state_is_pydantic_model — a validated, closed-shape model", () => {
    const { breaker } = makeBreaker();
    const raw = breaker.getState();
    // Round-trips through the schema (real validated model, not a loose dict).
    expect(() => CircuitBreakerStateSchema.parse(raw)).not.toThrow();
    // extra="forbid": unknown keys are rejected.
    expect(() => CircuitBreakerStateSchema.parse({ ...raw, sneaky: 1 })).toThrow();
    // Frozen (immutable) snapshot.
    expect(Object.isFrozen(raw)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Closed-to-open transition.
// ---------------------------------------------------------------------------

describe("CLOSED → OPEN", () => {
  it("test_opens_after_failure_threshold — stays CLOSED below threshold, OPEN at threshold", () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    expect(breaker.getState().state).toBe("closed");
    breaker.recordFailure();
    expect(breaker.getState().state).toBe("closed");
    breaker.recordFailure(); // third consecutive → OPEN
    expect(breaker.getState().state).toBe("open");
  });

  it("test_success_resets_failure_count — a success zeroes the failure streak", () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState().failureCount).toBe(2);
    breaker.recordSuccess(); // resets streak, does not touch successCount
    expect(breaker.getState().failureCount).toBe(0);
    expect(breaker.getState().successCount).toBe(0);
    // Two more failures no longer reach the threshold of 3.
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState().state).toBe("closed");
    expect(breaker.getState().failureCount).toBe(2);
  });

  it("record_success while CLOSED with failureCount already 0 is a no-op", () => {
    const { breaker } = makeBreaker();
    breaker.recordSuccess();
    const s = breaker.getState();
    expect(s.state).toBe("closed");
    expect(s.failureCount).toBe(0);
    expect(s.successCount).toBe(0);
  });

  it("every recordFailure stamps lastFailureTime, even below threshold", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 5 });
    breaker.recordFailure();
    const t1 = breaker.getState().lastFailureTime;
    expect(t1).toBe(clock.now());
    clock.advanceMs(500);
    breaker.recordFailure();
    expect(breaker.getState().lastFailureTime).toBe(clock.now());
    expect(breaker.getState().lastFailureTime).not.toBe(t1);
  });
});

// ---------------------------------------------------------------------------
// Open-to-half-open transition.
// ---------------------------------------------------------------------------

describe("OPEN → HALF_OPEN", () => {
  it("test_transitions_after_timeout — first admit past window flips to HALF_OPEN and grants the probe", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN
    expect(breaker.getState().state).toBe("open");
    clock.advanceSeconds(60); // boundary-inclusive
    const adm = breaker.admit();
    expect(adm.allowed).toBe(true);
    expect(adm.ownsProbe).toBe(true);
    expect(adm.probeToken).not.toBeNull();
    expect(breaker.getState().state).toBe("half_open");
  });

  it("test_stays_open_before_timeout — before the window, admit refuses and grants no probe", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(59.999);
    const adm = breaker.admit();
    expect(adm.allowed).toBe(false);
    expect(adm.ownsProbe).toBe(false);
    expect(adm.probeToken).toBeNull();
    expect(breaker.getState().state).toBe("open");
  });

  it("OPEN→HALF_OPEN only happens inside admit(), never via record_* or recoveryEligible", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(120); // well past window
    // Reads never transition.
    expect(breaker.recoveryEligible).toBe(true);
    expect(breaker.getState().state).toBe("open");
    // record_success while OPEN does not transition.
    breaker.recordSuccess();
    expect(breaker.getState().state).toBe("open");
    // Only admit consumes eligibility.
    expect(breaker.admit().allowed).toBe(true);
    expect(breaker.getState().state).toBe("half_open");
  });
});

// ---------------------------------------------------------------------------
// Half-open-to-closed transition.
// ---------------------------------------------------------------------------

describe("HALF_OPEN → CLOSED", () => {
  it("test_closes_after_success_threshold — one success is insufficient when threshold is 2", () => {
    const { breaker, clock } = makeBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60,
      successThreshold: 2,
    });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60);
    breaker.admit(); // HALF_OPEN + probe
    breaker.recordSuccess(); // 1 success — not enough
    expect(breaker.getState().state).toBe("half_open");
    expect(breaker.getState().successCount).toBe(1);
    // Probe slot freed → a fresh probe, then the closing success.
    breaker.admit();
    breaker.recordSuccess(); // 2nd success → CLOSED
    const s = breaker.getState();
    expect(s.state).toBe("closed");
    expect(s.successCount).toBe(0);
    expect(s.failureCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Half-open failure.
// ---------------------------------------------------------------------------

describe("HALF_OPEN failure", () => {
  it("test_reopens_on_failure — a single failure immediately reopens, no partial credit", () => {
    const { breaker, clock } = makeBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60,
      successThreshold: 3,
    });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60);
    breaker.admit(); // HALF_OPEN
    breaker.recordSuccess(); // successCount 1 (below threshold 3)
    breaker.recordFailure(); // any failure → OPEN
    const s = breaker.getState();
    expect(s.state).toBe("open");
    expect(s.successCount).toBe(0); // reset on transition to OPEN
    // Probe slot cleared: before the (new) window, admit refuses.
    expect(breaker.admit().allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admission.
// ---------------------------------------------------------------------------

describe("admit", () => {
  it("test_allows_without_probe_when_closed — CLOSED admits freely, ownsProbe=false", () => {
    const { breaker } = makeBreaker();
    const adm = breaker.admit();
    expect(adm.allowed).toBe(true);
    expect(adm.ownsProbe).toBe(false);
    expect(adm.probeToken).toBeNull();
    expect(breaker.getState().state).toBe("closed");
  });

  it("test_refuses_without_probe_when_open_before_recovery", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(10);
    const adm = breaker.admit();
    expect(adm.allowed).toBe(false);
    expect(adm.ownsProbe).toBe(false);
    expect(breaker.getState().state).toBe("open");
  });

  it("test_half_open_single_probe_slot — winner probes, in-flight second is refused, freed slot re-probes", () => {
    const { breaker, clock } = makeBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60,
      successThreshold: 2,
    });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60);

    // First caller wins and transitions.
    const first = breaker.admit();
    expect(first.allowed).toBe(true);
    expect(first.ownsProbe).toBe(true);
    expect(breaker.getState().state).toBe("half_open");

    // Concurrent second caller — probe in flight → refused, no state change.
    const second = breaker.admit();
    expect(second.allowed).toBe(false);
    expect(second.ownsProbe).toBe(false);
    expect(breaker.getState().state).toBe("half_open");

    // A non-closing success frees the slot (successCount 1 < threshold 2).
    breaker.recordSuccess();
    expect(breaker.getState().state).toBe("half_open");

    // Third caller can probe again with a NEW token.
    const third = breaker.admit();
    expect(third.allowed).toBe(true);
    expect(third.ownsProbe).toBe(true);
    expect(third.probeToken).not.toBe(first.probeToken);
  });
});

// ---------------------------------------------------------------------------
// Probe release.
// ---------------------------------------------------------------------------

describe("releaseProbe", () => {
  function openThenHalfOpen(): { breaker: CircuitBreaker; clock: FakeClock } {
    const h = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60, successThreshold: 2 });
    h.breaker.recordFailure();
    h.clock.advanceSeconds(60);
    return h;
  }

  it("test_release_probe_frees_slot_without_state_change — frees slot, no verdict recorded", () => {
    const { breaker } = openThenHalfOpen();
    const adm = breaker.admit();
    expect(adm.ownsProbe).toBe(true);
    const before = breaker.getState();

    breaker.releaseProbe(adm);
    const after = breaker.getState();
    expect(after.state).toBe("half_open");
    expect(after.successCount).toBe(before.successCount);
    expect(after.failureCount).toBe(before.failureCount);

    // Slot is free → a fresh probe is admitted.
    const again = breaker.admit();
    expect(again.allowed).toBe(true);
    expect(again.ownsProbe).toBe(true);
    expect(again.probeToken).not.toBe(adm.probeToken);
  });

  it("test_release_probe_is_noop_when_no_probe_active — None/absent is always safe (incl. CLOSED)", () => {
    const { breaker } = makeBreaker();
    expect(() => breaker.releaseProbe()).not.toThrow();
    expect(() => breaker.releaseProbe(null)).not.toThrow();
    expect(breaker.getState().state).toBe("closed");

    // Even in HALF_OPEN, a null admission never frees the live slot.
    const h = openThenHalfOpen();
    const adm = h.breaker.admit();
    h.breaker.releaseProbe(null);
    // Slot still occupied → a new admit is refused.
    expect(h.breaker.admit().allowed).toBe(false);
    expect(adm.ownsProbe).toBe(true);
  });

  it("test_stale_closed_admission_cannot_release_active_probe", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    // Admission minted while CLOSED (no probe ownership).
    const closedAdm = breaker.admit();
    expect(closedAdm.ownsProbe).toBe(false);

    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60);
    breaker.admit(); // HALF_OPEN with a live probe

    breaker.releaseProbe(closedAdm); // must NOT free the live probe
    expect(breaker.admit().allowed).toBe(false); // slot still occupied
  });

  it("test_stale_probe_admission_cannot_release_new_active_probe — token identity gates release", () => {
    const { breaker } = openThenHalfOpen();
    const staleAdm = breaker.admit(); // token t1
    breaker.releaseProbe(staleAdm); // frees t1
    const freshAdm = breaker.admit(); // token t2 (new live probe)
    expect(freshAdm.probeToken).not.toBe(staleAdm.probeToken);

    // The stale t1 admission cannot release the new t2 probe.
    breaker.releaseProbe(staleAdm);
    expect(breaker.admit().allowed).toBe(false); // t2 still in flight
  });

  it("release does not fire from a different (OPEN) state with a matching-looking token", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure();
    clock.advanceSeconds(60);
    const adm = breaker.admit(); // HALF_OPEN
    breaker.recordFailure(); // back to OPEN, probe cleared
    // Releasing the now-stale probe admission while OPEN is a no-op (not HALF_OPEN).
    expect(() => breaker.releaseProbe(adm)).not.toThrow();
    expect(breaker.getState().state).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Recovery eligibility through non-mutating inspection.
// ---------------------------------------------------------------------------

describe("recoveryEligible", () => {
  it("test_false_when_closed", () => {
    const { breaker } = makeBreaker();
    expect(breaker.recoveryEligible).toBe(false);
  });

  it("test_false_when_open_before_timeout — false and non-mutating before the window", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(30);
    expect(breaker.recoveryEligible).toBe(false);
    expect(breaker.getState().state).toBe("open"); // unchanged
  });

  it("test_true_when_open_after_timeout_without_mutating — flips true, idempotent, never mutates", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60);
    // Repeated reads: idempotent, never transition.
    expect(breaker.recoveryEligible).toBe(true);
    expect(breaker.recoveryEligible).toBe(true);
    expect(breaker.getState().state).toBe("open");
    // Only a subsequent admit actually transitions.
    expect(breaker.admit().allowed).toBe(true);
    expect(breaker.getState().state).toBe("half_open");
  });

  it("test_false_when_half_open — eligibility concept applies only to OPEN", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60);
    breaker.admit(); // HALF_OPEN
    expect(breaker.recoveryEligible).toBe(false);
  });

  it("boundary is inclusive (>=): eligible exactly at the window edge", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure(); // OPEN at t0
    clock.advanceMs(59_999);
    expect(breaker.recoveryEligible).toBe(false);
    clock.advanceMs(1); // exactly 60_000 ms elapsed
    expect(breaker.recoveryEligible).toBe(true);
  });

  it("getState.recoveryEligible matches the property at snapshot time", () => {
    const { breaker, clock } = makeBreaker({ failureThreshold: 1, recoveryTimeout: 60 });
    breaker.recordFailure();
    clock.advanceSeconds(30);
    expect(breaker.getState().recoveryEligible).toBe(false);
    clock.advanceSeconds(30);
    expect(breaker.getState().recoveryEligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recovery-timeout jitter.
// ---------------------------------------------------------------------------

describe("recovery timeout jitter", () => {
  it("test_default_jitter_is_deterministic — jitter 0 ⇒ exactly recoveryTimeout, boundary tested", () => {
    const { breaker, clock } = makeBreaker({
      failureThreshold: 1,
      recoveryTimeout: 10,
      recoveryTimeoutJitter: 0.0,
    });
    breaker.recordFailure(); // OPEN, effective = exactly 10_000 ms
    clock.advanceMs(9_999); // just below
    expect(breaker.recoveryEligible).toBe(false);
    clock.advanceMs(1); // exactly at
    expect(breaker.recoveryEligible).toBe(true);
  });

  it("class default jitter is 0.0 (deterministic) — no randomness even with a hostile random source", () => {
    // A random source that would push the window off 10s IF jitter were applied.
    const { breaker, clock } = makeBreaker({
      failureThreshold: 1,
      recoveryTimeout: 10,
      random: () => 0.0, // would map to U=-jitter if jitter>0
      // recoveryTimeoutJitter omitted → class default 0.0
    });
    breaker.recordFailure();
    clock.advanceMs(9_999);
    expect(breaker.recoveryEligible).toBe(false);
    clock.advanceMs(1);
    expect(breaker.recoveryEligible).toBe(true);
  });

  it("jitter extremes: random 0 ⇒ (1-jitter)·base, random 1 ⇒ (1+jitter)·base, 0.5 ⇒ base", () => {
    // random=0 → U=-0.2 → effective 8_000 ms.
    {
      const { breaker, clock } = makeBreaker({
        failureThreshold: 1,
        recoveryTimeout: 10,
        recoveryTimeoutJitter: 0.2,
        random: () => 0,
      });
      breaker.recordFailure();
      clock.advanceMs(7_999);
      expect(breaker.recoveryEligible).toBe(false);
      clock.advanceMs(1); // 8_000
      expect(breaker.recoveryEligible).toBe(true);
    }
    // random just below 1 → U≈+0.2 → effective ≈ 12_000 ms.
    {
      const { breaker, clock } = makeBreaker({
        failureThreshold: 1,
        recoveryTimeout: 10,
        recoveryTimeoutJitter: 0.2,
        random: () => 0.999999,
      });
      breaker.recordFailure();
      clock.advanceMs(11_999);
      expect(breaker.recoveryEligible).toBe(false);
      clock.advanceMs(2); // ~12_000
      expect(breaker.recoveryEligible).toBe(true);
    }
    // random=0.5 → U=0 → effective 10_000 ms.
    {
      const { breaker, clock } = makeBreaker({
        failureThreshold: 1,
        recoveryTimeout: 10,
        recoveryTimeoutJitter: 0.2,
        random: () => 0.5,
      });
      breaker.recordFailure();
      clock.advanceMs(9_999);
      expect(breaker.recoveryEligible).toBe(false);
      clock.advanceMs(1);
      expect(breaker.recoveryEligible).toBe(true);
    }
  });

  it("test_effective_window_within_jitter_bounds — 200 independent OPEN episodes stay within [8, 12]s", () => {
    for (let i = 0; i < 200; i++) {
      const clock = new FakeClock();
      // Fresh breaker per episode; real Math.random drives the jitter draw.
      const breaker = new CircuitBreaker({
        now: clock.now,
        failureThreshold: 1,
        recoveryTimeout: 10,
        recoveryTimeoutJitter: 0.2,
      });
      breaker.recordFailure(); // OPEN, samples effective window
      const t0 = clock.now();
      // Lower bound: window >= 8_000 ms ⇒ NOT eligible just below 8s.
      clock.set(t0 + 7_999.9);
      expect(breaker.recoveryEligible).toBe(false);
      // Upper bound: window < 12_000 ms ⇒ eligible by 12s.
      clock.set(t0 + 12_000);
      expect(breaker.recoveryEligible).toBe(true);
    }
  });

  it("re-samples the window on every fresh OPEN episode", () => {
    // First OPEN samples with random=0 (→8s); reopen re-samples with random=1 (→12s).
    const randoms = [0, 0.999999];
    let idx = 0;
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({
      now: clock.now,
      failureThreshold: 1,
      recoveryTimeout: 10,
      recoveryTimeoutJitter: 0.2,
      successThreshold: 1,
      random: () => randoms[idx++ % randoms.length] as number,
    });
    breaker.recordFailure(); // OPEN #1, effective 8_000
    clock.advanceMs(8_000);
    expect(breaker.recoveryEligible).toBe(true);
    breaker.admit(); // HALF_OPEN
    breaker.recordSuccess(); // successThreshold 1 → CLOSED
    expect(breaker.getState().state).toBe("closed");
    breaker.recordFailure(); // OPEN #2, effective ~12_000 (re-sampled)
    const t0 = clock.now();
    clock.set(t0 + 11_999);
    expect(breaker.recoveryEligible).toBe(false);
    clock.set(t0 + 12_000);
    expect(breaker.recoveryEligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Removed API guard.
// ---------------------------------------------------------------------------

describe("removed API", () => {
  it("test_can_proceed_boolean_api_is_removed — no bare-boolean admission shortcut exists", () => {
    const { breaker } = makeBreaker();
    expect((breaker as unknown as Record<string, unknown>)["canProceed"]).toBeUndefined();
    // Admission always exposes probe ownership, never a bare boolean.
    const adm = breaker.admit();
    expect(adm).toBeInstanceOf(CircuitBreakerAdmission);
    expect(typeof adm.ownsProbe).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Concurrent state mutation: methods are synchronous, so repeated calls in a
// plain loop (and interleaved async callers) yield exactly one transition.
// ---------------------------------------------------------------------------

describe("concurrent state mutation (single-threaded event-loop equivalent)", () => {
  it("all mutating methods + recoveryEligible are synchronous (never async / no Promise)", () => {
    const { breaker } = makeBreaker();
    // None of the methods are AsyncFunction, and none return a thenable.
    const methods: Array<() => unknown> = [
      () => breaker.recordSuccess(),
      () => breaker.recordFailure(),
      () => breaker.admit(),
      () => breaker.releaseProbe(),
      () => breaker.getState(),
      () => breaker.recoveryEligible,
    ];
    expect(CircuitBreaker.prototype.admit.constructor.name).toBe("Function");
    expect(CircuitBreaker.prototype.recordFailure.constructor.name).toBe("Function");
    expect(CircuitBreaker.prototype.recordSuccess.constructor.name).toBe("Function");
    expect(CircuitBreaker.prototype.releaseProbe.constructor.name).toBe("Function");
    expect(CircuitBreaker.prototype.getState.constructor.name).toBe("Function");
    for (const m of methods) {
      const r = m();
      // Not a thenable.
      expect(r == null || typeof (r as { then?: unknown }).then !== "function").toBe(true);
    }
  });

  it("test_concurrent_half_open_successes_close_once — 32 successes ⇒ exactly one CLOSED transition, successCount 0", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({
      now: clock.now,
      failureThreshold: 1,
      recoveryTimeout: 60,
      successThreshold: 1,
    });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60);
    breaker.admit(); // HALF_OPEN

    // First success closes; capture the CLOSED transition timestamp.
    clock.advanceMs(1);
    breaker.recordSuccess();
    expect(breaker.getState().state).toBe("closed");
    const closeTime = breaker.getState().lastStateChange;

    // 31 further successes while CLOSED must NOT transition again (clock advances each,
    // so any new transition would move lastStateChange).
    for (let i = 0; i < 31; i++) {
      clock.advanceMs(1);
      breaker.recordSuccess();
    }
    expect(breaker.getState().state).toBe("closed");
    expect(breaker.getState().successCount).toBe(0);
    expect(breaker.getState().lastStateChange).toBe(closeTime); // exactly one transition
  });

  it("test_concurrent_closed_failures_open_once — 32 failures ⇒ exactly one OPEN transition, failureCount 1", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ now: clock.now, failureThreshold: 1 });

    clock.advanceMs(1);
    breaker.recordFailure(); // OPEN
    expect(breaker.getState().state).toBe("open");
    const openTime = breaker.getState().lastStateChange;

    for (let i = 0; i < 31; i++) {
      clock.advanceMs(1);
      breaker.recordFailure();
    }
    expect(breaker.getState().state).toBe("open");
    expect(breaker.getState().failureCount).toBe(1); // not 32
    expect(breaker.getState().lastStateChange).toBe(openTime); // exactly one transition
  });

  it("test_concurrent_recovery_probe_transitions_half_open_once — 32 admits ⇒ one winner, 31 refused", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({
      now: clock.now,
      failureThreshold: 1,
      recoveryTimeout: 60,
    });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60); // recovery-eligible

    const admissions = Array.from({ length: 32 }, () => breaker.admit());
    const winners = admissions.filter((a) => a.allowed);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.ownsProbe).toBe(true);
    expect(winners[0]?.probeToken).not.toBeNull();
    expect(admissions.filter((a) => !a.allowed)).toHaveLength(31);
    expect(breaker.getState().state).toBe("half_open");
  });

  it("interleaved async callers cannot double-admit the single HALF_OPEN probe", async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({
      now: clock.now,
      failureThreshold: 1,
      recoveryTimeout: 60,
    });
    breaker.recordFailure(); // OPEN
    clock.advanceSeconds(60);

    // 32 async callers race on the same recovery boundary. Because admit() is fully
    // synchronous, each runs to completion before the next; exactly one wins the probe.
    const results = await Promise.all(
      Array.from({ length: 32 }, () => Promise.resolve().then(() => breaker.admit())),
    );
    const winners = results.filter((a) => a.allowed && a.ownsProbe);
    expect(winners).toHaveLength(1);
    // No two winners share a token; the single winner holds a non-null token.
    expect(winners[0]?.probeToken).not.toBeNull();
    expect(breaker.getState().state).toBe("half_open");
  });
});

// ---------------------------------------------------------------------------
// Live tuning replacement — entitlement directives must preserve breaker identity/state.
// ---------------------------------------------------------------------------

describe("replaceTuning", () => {
  it("retunes CLOSED without drawing randomness or changing state/counters/timestamps", () => {
    const clock = new FakeClock();
    let draws = 0;
    const breaker = new CircuitBreaker({
      now: clock.now,
      random: () => {
        draws += 1;
        return 0.5;
      },
      failureThreshold: 3,
      recoveryTimeout: 60,
      successThreshold: 2,
      recoveryTimeoutJitter: 0.2,
    });
    breaker.recordFailure();
    const before = breaker.getState();

    breaker.replaceTuning({
      failureThreshold: 2,
      recoveryTimeout: 77,
      successThreshold: 4,
      recoveryTimeoutJitter: 0.1,
    });

    expect(draws).toBe(0);
    expect(breaker.getState()).toEqual(before);
    breaker.recordFailure();
    expect(breaker.getState().state).toBe("open");
    expect(draws).toBe(1);
  });

  it("retunes OPEN in place and immediately resamples the effective recovery window", () => {
    const clock = new FakeClock();
    let draws = 0;
    const breaker = new CircuitBreaker({
      now: clock.now,
      random: () => {
        draws += 1;
        return 0;
      },
      failureThreshold: 1,
      recoveryTimeout: 100,
      successThreshold: 2,
      recoveryTimeoutJitter: 0,
    });
    breaker.recordFailure();
    const before = breaker.getState();
    const failedAt = before.lastFailureTime;
    if (failedAt === null) throw new Error("OPEN breaker must carry a failure timestamp");

    breaker.replaceTuning({
      failureThreshold: 8,
      recoveryTimeout: 77,
      successThreshold: 6,
      recoveryTimeoutJitter: 0.2,
    });

    expect(draws).toBe(1);
    expect(breaker.getState()).toEqual(before);
    clock.set(failedAt + 61_599);
    expect(breaker.recoveryEligible).toBe(false);
    clock.set(failedAt + 61_600);
    expect(breaker.recoveryEligible).toBe(true);
  });

  it("retunes HALF_OPEN without resampling and preserves the owned probe", () => {
    const clock = new FakeClock();
    let draws = 0;
    const breaker = new CircuitBreaker({
      now: clock.now,
      random: () => {
        draws += 1;
        return 0.5;
      },
      failureThreshold: 1,
      recoveryTimeout: 10,
      successThreshold: 2,
      recoveryTimeoutJitter: 0,
    });
    breaker.recordFailure();
    clock.advanceSeconds(10);
    const owned = breaker.admit();
    const before = breaker.getState();
    expect(owned.ownsProbe).toBe(true);

    breaker.replaceTuning({
      failureThreshold: 8,
      recoveryTimeout: 77,
      successThreshold: 6,
      recoveryTimeoutJitter: 0.2,
    });

    expect(draws).toBe(0);
    expect(breaker.getState()).toEqual(before);
    expect(breaker.admit().allowed).toBe(false);
    breaker.releaseProbe(owned);
    expect(breaker.admit().allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CircuitBreakerManager — per-provider-NAME registry (invariant 5).
// ---------------------------------------------------------------------------

describe("CircuitBreakerManager", () => {
  it("retunes existing breakers in place and applies the new defaults to future breakers", () => {
    const clock = new FakeClock();
    const mgr = new CircuitBreakerManager({
      now: clock.now,
      failureThreshold: 3,
      recoveryTimeout: 60,
      successThreshold: 2,
      recoveryTimeoutJitter: 0,
    });
    const openai = mgr.get("openai");
    const anthropic = mgr.get("anthropic");
    const namesBefore = mgr.names();

    mgr.replaceTuning({
      failureThreshold: 1,
      recoveryTimeout: 77,
      successThreshold: 6,
      recoveryTimeoutJitter: 0,
    });

    expect(mgr.get("openai")).toBe(openai);
    expect(mgr.get("anthropic")).toBe(anthropic);
    expect(mgr.names()).toEqual(namesBefore);
    openai.recordFailure();
    anthropic.recordFailure();
    expect(openai.getState().state).toBe("open");
    expect(anthropic.getState().state).toBe("open");

    const future = mgr.get("google");
    future.recordFailure();
    expect(future.getState().state).toBe("open");
    expect(mgr.names()).toEqual(["openai", "anthropic", "google"]);
  });

  it("returns one breaker per provider name, shared across lookups", () => {
    const mgr = new CircuitBreakerManager({ now: new FakeClock().now });
    const a1 = mgr.get("openai");
    const a2 = mgr.get("openai");
    const b = mgr.get("anthropic");
    expect(a1).toBe(a2); // same instance for same name
    expect(a1).not.toBe(b); // distinct instance for a distinct name
  });

  it("breaker domains are isolated per name — opening one does not affect another", () => {
    const clock = new FakeClock();
    const mgr = new CircuitBreakerManager({ now: clock.now, failureThreshold: 1 });
    driveToOpen(mgr.get("openai"), 1);
    expect(mgr.get("openai").getState().state).toBe("open");
    expect(mgr.get("anthropic").getState().state).toBe("closed");
  });

  it("constructs every breaker with the passed-through shared config", () => {
    const clock = new FakeClock();
    // failureThreshold 2 must apply to breakers the manager mints.
    const mgr = new CircuitBreakerManager({ now: clock.now, failureThreshold: 2 });
    const b = mgr.get("groq");
    b.recordFailure();
    expect(b.getState().state).toBe("closed"); // 1 < 2
    b.recordFailure();
    expect(b.getState().state).toBe("open"); // 2 == threshold
  });

  it("has / names / clear reflect the live registry", () => {
    const mgr = new CircuitBreakerManager();
    expect(mgr.has("openai")).toBe(false);
    mgr.get("openai");
    mgr.get("google");
    expect(mgr.has("openai")).toBe(true);
    expect(mgr.names().sort()).toEqual(["google", "openai"]);
    mgr.clear();
    expect(mgr.names()).toEqual([]);
    expect(mgr.has("openai")).toBe(false);
  });

  it("distinct provider NAMES sharing a dialect still get distinct breakers (name is the axis)", () => {
    // xai/deepseek/etc. share the OpenAI chat dialect but are distinct attribution names.
    const mgr = new CircuitBreakerManager({ now: new FakeClock().now });
    expect(mgr.get("xai")).not.toBe(mgr.get("deepseek"));
  });
});
