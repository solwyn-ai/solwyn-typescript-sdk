import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";

describe("remediation 13: outcomes belong to their admission", () => {
  it.each([
    "success",
    "failure",
  ] as const)("a delayed CLOSED %s cannot take the current recovery probe", (outcome) => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 2,
      now: () => now,
    });
    const delayed = breaker.admit();
    breaker.recordFailure(breaker.admit());
    now = 1_000;
    const probe = breaker.admit();
    const before = breaker.getState();
    if (outcome === "success") breaker.recordSuccess(delayed);
    else breaker.recordFailure(delayed);
    expect(breaker.getState()).toEqual(before);
    expect(breaker.admit().allowed).toBe(false);
    breaker.recordSuccess(probe);
    expect(breaker.getState().successCount).toBe(1);
    expect(breaker.admit().allowed).toBe(true);
  });

  it("consumes an owned outcome once, including after recovery closes", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 0,
      successThreshold: 1,
    });
    const delayed = breaker.admit();
    breaker.recordFailure(breaker.admit());
    const probe = breaker.admit();
    breaker.recordSuccess(probe);
    const recovered = breaker.getState();
    breaker.recordFailure(delayed);
    breaker.recordFailure(probe);
    expect(breaker.getState()).toEqual(recovered);
  });

  it("ignores outcomes from a released probe and a different breaker", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 0 });
    const foreign = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 0 });
    breaker.recordFailure(breaker.admit());
    foreign.recordFailure(foreign.admit());
    const oldProbe = breaker.admit();
    breaker.releaseProbe(oldProbe);
    const current = breaker.admit();
    const before = breaker.getState();
    breaker.recordFailure(oldProbe);
    breaker.recordSuccess(foreign.admit());
    expect(breaker.getState()).toEqual(before);
    expect(breaker.admit().allowed).toBe(false);
    breaker.recordFailure(current);
    expect(breaker.getState().state).toBe("open");
  });
});
