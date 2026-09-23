import { describe, expect, it } from "vitest";
import { ConfigurationError, SolwynError } from "../../src/errors";
import {
  BACKOFF_BASE_S,
  BACKOFF_CAP_S,
  backoffCeiling,
  DEFAULT_OUTPUT_BOUND,
  GrantOutcome,
  INELIGIBLE_RETRY_AFTER_S,
  LEASE_REFUSAL_LATCH_S,
  LeaseDecision,
  LeaseLedger,
  RESERVATION_MAX_AGE_S,
} from "../../src/lease";
import type { LeaseGrantResponse } from "../../src/types";
import { LeaseRenewRequestSchema } from "../../src/validation";

const RUN = "run-lease";
const HOLDER = "holder-1";

function grant(overrides: Partial<LeaseGrantResponse> = {}): LeaseGrantResponse {
  return {
    eligible: true,
    allowed: true,
    lease_id: "lse-1",
    generation: 1,
    granted_tokens: 15_000,
    refresh_interval_s: 20,
    lease_length_s: 120,
    headroom_share_tokens: 5_000,
    posture: { mode: "alert_only", on_unreachable: "fail_open" },
    final_grant: false,
    project_id: "project-1",
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 20,
    remaining_budget: 80,
    ...overrides,
  };
}

function ledger(rng = () => 1): LeaseLedger {
  return new LeaseLedger({ holderId: HOLDER, rng });
}

function installed(
  response: LeaseGrantResponse = grant(),
  declaredModels = ["gpt-5"],
): LeaseLedger {
  const value = ledger();
  expect(value.applyGrantResponse(RUN, response, { now: 1_000, declaredModels })).toBe("applied");
  return value;
}

function admit(value: LeaseLedger, options: Partial<Parameters<LeaseLedger["admit"]>[0]> = {}) {
  return value.admit({
    runId: RUN,
    callId: "call-1",
    estimatedInputTokens: 1_000,
    model: "gpt-5",
    now: 1_001,
    breakerOpen: false,
    outputBound: 500,
    ...options,
  });
}

describe("LeaseLedger admission ladder", () => {
  it("gates before claiming, then claims before ineligibility and declared-model gates", () => {
    const disabled = installed();
    disabled.enabled = false;
    expect(admit(disabled, { callId: "disabled" })).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      reason: "lease_disabled",
      claimToken: null,
    });

    const media = installed();
    expect(admit(media, { callId: "media", modality: "image" })).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      reason: "call_lease_ineligible",
      claimToken: null,
    });

    const ineligible = ledger();
    ineligible.markIneligible(RUN, { now: 1_000, retryAfter: INELIGIBLE_RETRY_AFTER_S });
    const blocked = admit(ineligible, { callId: "retry", now: 1_029 });
    expect(blocked).toMatchObject({ decision: LeaseDecision.LegacyCheck, claimToken: 1 });
    expect(admit(ineligible, { callId: "retry-next", now: 1_030 }).decision).toBe(
      LeaseDecision.NeedGrant,
    );
    ineligible.markIneligible(RUN, { now: 1_030 });
    expect(admit(ineligible, { callId: "permanent", now: 1_000_000 }).decision).toBe(
      LeaseDecision.LegacyCheck,
    );

    const mismatch = installed();
    expect(admit(mismatch, { callId: "outside", model: "other" })).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      reason: "model_outside_declared_set",
      claimToken: 1,
    });
    expect(
      admit(mismatch, { callId: "fallback-outside", fallbackModels: ["other"] }).decision,
    ).toBe(LeaseDecision.LegacyCheck);
    const chain = installed(grant(), ["gpt-5", "other"]);
    expect(admit(chain, { callId: "fallback-covered", fallbackModels: ["other"] }).decision).toBe(
      LeaseDecision.AdmitLocal,
    );
  });

  it("uses the live and expired outage ladders without treating expiry as exhaustion", () => {
    const live = installed(grant({ granted_tokens: 1_000, headroom_share_tokens: 2_000 }));
    expect(
      admit(live, { callId: "plane-up", estimatedInputTokens: 1_000, outputBound: 500 }),
    ).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      leaseId: "lse-1",
      reason: "granted_exhausted_plane_up",
    });
    expect(live.stateFor(RUN)?.shareRemainingTokens).toBe(2_000);
    expect(admit(live, { callId: "plane-down", breakerOpen: true })).toEqual(
      expect.objectContaining({
        decision: LeaseDecision.AdmitOutageMetered,
        leaseId: "lse-1",
        reservedTokens: 1_500,
        mode: null,
        warning:
          "Solwyn unreachable; lease grant exhausted — drawing down this holder's headroom share",
      }),
    );
    const alert = installed(grant({ granted_tokens: 0, headroom_share_tokens: 1_000 }));
    expect(admit(alert, { callId: "alert-over", breakerOpen: true })).toMatchObject({
      decision: LeaseDecision.AdmitOutageMetered,
      leaseId: "lse-1",
      mode: "alert_only",
      warning:
        "Budget lease exhausted and Solwyn unreachable; alert_only mode continues past the share",
    });
    expect(alert.stateFor(RUN)?.shareRemainingTokens).toBe(-500);
    const liveHard = installed(
      grant({
        granted_tokens: 0,
        headroom_share_tokens: 1_000,
        posture: { mode: "hard_deny", on_unreachable: "fail_open" },
      }),
    );
    expect(admit(liveHard, { callId: "hard-over", breakerOpen: true })).toMatchObject({
      decision: LeaseDecision.Deny,
      leaseId: "lse-1",
      mode: "hard_deny",
      warning: "Budget lease exhausted and Solwyn unreachable; hard_deny mode denies the call",
    });

    const expired = installed(grant({ granted_tokens: 15_000, lease_length_s: 1 }));
    const decision = admit(expired, { callId: "expired", now: 1_001, breakerOpen: true });
    expect(decision).toMatchObject({
      decision: LeaseDecision.AdmitUncounted,
      leaseId: null,
      warning:
        "Budget lease expired and Solwyn unreachable; proceeding UNCOUNTED in fail-open mode",
      reason: "expired_fail_open",
    });
    expect(expired.stateFor(RUN)).toMatchObject({
      grantedRemainingTokens: 15_000,
      uncountedCalls: 1,
      uncountedTokens: 1_500,
    });
    const planeUp = installed(grant({ lease_length_s: 1 }));
    expect(admit(planeUp, { callId: "expired-up", now: 1_001 }).decision).toBe(
      LeaseDecision.NeedGrant,
    );
    expect(planeUp.leaseIdFor(RUN)).toBeNull();
    const locallyMetered = installed(
      grant({
        granted_tokens: 0,
        lease_length_s: 1,
        headroom_share_tokens: 2_000,
        posture: { mode: "hard_deny", on_unreachable: "local_enforce" },
      }),
    );
    expect(
      admit(locallyMetered, { callId: "expired-fit", now: 1_001, breakerOpen: true }),
    ).toMatchObject({
      decision: LeaseDecision.AdmitOutageMetered,
      leaseId: "lse-1",
      mode: null,
      warning:
        "Budget lease expired and Solwyn unreachable; metering locally against the last known headroom share",
      reason: "expired_local_enforce",
    });

    const hard = installed(
      grant({
        granted_tokens: 0,
        lease_length_s: 1,
        headroom_share_tokens: 1_000,
        posture: { mode: "hard_deny", on_unreachable: "local_enforce" },
      }),
    );
    expect(admit(hard, { callId: "expired-hard", now: 1_001, breakerOpen: true })).toMatchObject({
      decision: LeaseDecision.Deny,
      leaseId: "lse-1",
      mode: "hard_deny",
      warning:
        "Budget lease expired, Solwyn unreachable and the last known headroom share is exhausted; hard_deny mode denies the call",
    });

    const expiredAlert = installed(
      grant({
        granted_tokens: 0,
        lease_length_s: 1,
        headroom_share_tokens: 1_000,
        posture: { mode: "alert_only", on_unreachable: "local_enforce" },
      }),
    );
    expect(
      admit(expiredAlert, { callId: "expired-alert", now: 1_001, breakerOpen: true }),
    ).toMatchObject({
      decision: LeaseDecision.AdmitOutageMetered,
      leaseId: "lse-1",
      mode: "alert_only",
      warning:
        "Budget lease expired, Solwyn unreachable and the last known headroom share is exhausted; alert_only mode continues",
    });

    const renewalDue = installed(
      grant({ granted_tokens: 1_000, refresh_interval_s: 1, lease_length_s: 120 }),
    );
    expect(
      admit(renewalDue, {
        callId: "exhausted-after-refresh",
        now: 1_002,
        estimatedInputTokens: 1_000,
        outputBound: 500,
      }),
    ).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      leaseId: "lse-1",
      renewalDue: true,
    });
  });

  it("reserves exactly 10 × 1,500 against a 15,000 grant and honors default bounds", () => {
    const value = installed();
    for (let i = 0; i < 10; i++) {
      expect(admit(value, { callId: `burst-${i}` }).decision).toBe(LeaseDecision.AdmitLocal);
    }
    expect(value.stateFor(RUN)?.grantedRemainingTokens).toBe(0);
    expect(admit(value, { callId: "eleven" }).decision).toBe(LeaseDecision.LegacyCheck);

    const defaults = installed(grant({ granted_tokens: DEFAULT_OUTPUT_BOUND + 10 }));
    expect(
      admit(defaults, { callId: "default", estimatedInputTokens: 10, outputBound: 0 }),
    ).toMatchObject({
      reservedTokens: DEFAULT_OUTPUT_BOUND + 10,
    });
    expect(() => new LeaseLedger({ holderId: HOLDER, outputBoundDefault: 0 })).toThrow(
      ConfigurationError,
    );
  });

  it.each([
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects unsafe outputBoundDefault=%s with its configuration field", (outputBoundDefault) => {
    let caught: unknown;
    try {
      new LeaseLedger({ holderId: HOLDER, outputBoundDefault });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).field).toBe("outputBoundDefault");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["fraction", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["boolean", true],
    ["numeric string", "512"],
  ] as const)("normalizes a direct live admission %s to the configured default", (_label, bound) => {
    const value = new LeaseLedger({ holderId: HOLDER, outputBoundDefault: 2_048 });
    expect(
      value.applyGrantResponse(RUN, grant({ granted_tokens: 10_000 }), {
        now: 1_000,
        declaredModels: ["gpt-5"],
      }),
    ).toBe("applied");

    expect(
      admit(value, {
        callId: `malformed-${_label}`,
        estimatedInputTokens: 1_000,
        outputBound: bound as number,
      }),
    ).toMatchObject({
      decision: LeaseDecision.AdmitLocal,
      reservedTokens: 3_048,
    });
    expect(value.stateFor(RUN)).toMatchObject({
      grantedRemainingTokens: 6_952,
      reservedTokens: 3_048,
    });
  });

  it("claims cold calls for exactly one grant-owner reentry, sweeps at 900 seconds, and never scans open reservations", () => {
    const cold = ledger();
    const grantOwner = admit(cold, { callId: "cold" });
    expect(grantOwner).toMatchObject({ decision: LeaseDecision.NeedGrant, claimToken: 1 });
    expect(Object.isFrozen(grantOwner)).toBe(true);
    expect(() => admit(cold, { callId: "cold" })).toThrow(SolwynError);
    cold.applyGrantResponse(RUN, grant(), { now: 1_002, declaredModels: ["gpt-5"] });
    const reentry = admit(cold, {
      callId: "cold",
      now: 1_003,
      claimToken: grantOwner.claimToken,
    });
    expect(reentry.decision).toBe(LeaseDecision.AdmitLocal);
    expect(Object.isFrozen(reentry)).toBe(true);
    expect(() =>
      admit(cold, { callId: "cold", now: 1_004, claimToken: grantOwner.claimToken }),
    ).toThrow("reservation");

    const value = installed(grant({ granted_tokens: 50_000, lease_length_s: 10_000 }));
    const old = admit(value, { callId: "old" });
    expect(value.sweep(1_001 + RESERVATION_MAX_AGE_S - 0.001)).toBe(0);
    expect(value.sweep(1_001 + RESERVATION_MAX_AGE_S)).toBe(1);
    expect(admit(value, { callId: "old", now: 1_002 + RESERVATION_MAX_AGE_S }).claimToken).not.toBe(
      old.claimToken,
    );

    const state = value.stateFor(RUN);
    expect(state).not.toBeNull();
    const guard = new Proxy(state?.reservations ?? new Map(), {
      get(target, property) {
        if (property === "values" || property === "entries" || property === Symbol.iterator) {
          throw new Error("admission scanned reservations");
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    Object.defineProperty(state, "reservations", { value: guard });
    expect(admit(value, { callId: "scan-free", now: 1_003 + RESERVATION_MAX_AGE_S }).decision).toBe(
      LeaseDecision.AdmitLocal,
    );
  });
});

describe("LeaseLedger grants and accounting", () => {
  it("treats a generation-zero allow as malformed without installing lease authority", () => {
    const value = ledger();

    expect(
      value.applyGrantResponse(RUN, grant({ generation: 0 }), {
        now: 1_000,
        declaredModels: ["gpt-5"],
      }),
    ).toBe(GrantOutcome.Malformed);
    expect(value.activeRunIds()).toEqual([]);
    expect(value.leaseIdFor(RUN)).toBeNull();
    expect(value.buildRenewalRequest(RUN)).toBeNull();
    expect(value.buildSurrenderRequest(RUN)).toBeNull();
    expect(admit(value, { callId: "generation-zero", now: 1_001 })).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      reason: "run_lease_ineligible",
    });
  });

  it("rejects positive generations outside the safe-integer range at the install boundary", () => {
    const value = ledger();

    expect(
      value.applyGrantResponse(RUN, grant({ generation: Number.MAX_SAFE_INTEGER + 1 }), {
        now: 1_000,
      }),
    ).toBe(GrantOutcome.Malformed);
    expect(value.activeRunIds()).toEqual([]);
  });

  it("installs jittered fields, honors origin/generation fences, denial, ineligibility, and malformed IDs", () => {
    const explicitNullOrigin = ledger();
    expect(
      explicitNullOrigin.applyGrantResponse(RUN, grant(), {
        now: 1_000,
        expectedLeaseId: null,
        expectedGeneration: null,
      }),
    ).toBe("applied");

    const unseen = ledger();
    expect(
      unseen.applyGrantResponse(RUN, grant({ generation: 2 }), {
        now: 1_000,
        expectedLeaseId: "lse-origin",
        expectedGeneration: 1,
      }),
    ).toBe("stale");
    expect(unseen.stateFor(RUN)).toBeNull();

    const incompleteOrigin = installed();
    expect(
      incompleteOrigin.applyGrantResponse(RUN, grant({ generation: 2 }), {
        now: 1_010,
        expectedLeaseId: "lse-1",
        expectedGeneration: null,
      }),
    ).toBe("stale");
    expect(incompleteOrigin.stateFor(RUN)?.generation).toBe(1);

    const value = ledger(() => 1);
    expect(value.applyGrantResponse(RUN, grant(), { now: 1_000, declaredModels: ["gpt-5"] })).toBe(
      "applied",
    );
    expect(value.stateFor(RUN)).toMatchObject({
      generation: 1,
      refreshDeadline: 1_023,
      leaseDeadline: 1_120,
      grantedRemainingTokens: 15_000,
    });
    expect(
      value.applyGrantResponse(RUN, grant({ generation: 2 }), {
        now: 1_010,
        expectedLeaseId: "wrong",
        expectedGeneration: 1,
      }),
    ).toBe("stale");
    expect(value.applyGrantResponse(RUN, grant({ generation: 1 }), { now: 1_010 })).toBe("stale");
    expect(
      value.applyGrantResponse(RUN, grant({ lease_id: "x".repeat(65), generation: 2 }), {
        now: 1_010,
      }),
    ).toBe("malformed");
    expect(value.leaseIdFor(RUN)).toBeNull();
    expect(admit(value, { callId: "malformed-29", now: 1_039 }).decision).toBe(
      LeaseDecision.LegacyCheck,
    );
    expect(admit(value, { callId: "malformed-30", now: 1_040 }).decision).toBe(
      LeaseDecision.NeedGrant,
    );

    expect(
      value.applyGrantResponse(RUN, grant({ eligible: false, generation: null, lease_id: null }), {
        now: 1_050,
      }),
    ).toBe("ineligible");
    expect(
      value.applyGrantResponse(
        RUN,
        grant({
          allowed: false,
          lease_id: null,
          generation: null,
          granted_tokens: null,
          refresh_interval_s: null,
          lease_length_s: null,
          headroom_share_tokens: null,
          posture: null,
          current_usage: 90,
          remaining_budget: 10,
        }),
        { now: 1_060 },
      ),
    ).toBe("denied");
    expect(value.snapshotFor(RUN)).toMatchObject({ currentUsage: 90, remainingBudget: 10 });
  });

  it("unions same-lease models and nets pending report plus current reservations, while replacement resets", () => {
    const value = installed(grant({ granted_tokens: 10_000 }));
    const settled = admit(value, {
      callId: "settled",
      estimatedInputTokens: 300,
      outputBound: 200,
    });
    value.trueUp("settled", 400, { claimToken: settled.claimToken });
    value.claimRenewalRequest(RUN);
    admit(value, { callId: "open", estimatedInputTokens: 600, outputBound: 400 });
    expect(
      value.applyGrantResponse(RUN, grant({ generation: 2, granted_tokens: 10_000 }), {
        now: 1_010,
        declaredModels: ["claude"],
      }),
    ).toBe("applied");
    expect(value.stateFor(RUN)).toMatchObject({
      grantedRemainingTokens: 9_000,
      declaredModels: new Set(["gpt-5", "claude"]),
      spentTokensSinceReport: 0,
    });
    expect(
      value.applyGrantResponse(RUN, grant({ lease_id: "lse-2", generation: 3 }), {
        now: 1_020,
        declaredModels: ["new"],
      }),
    ).toBe("applied");
    expect(value.stateFor(RUN)?.declaredModels).toEqual(new Set(["new"]));
  });

  it("preserves an empty spec-valid lease id across reservation, renewal, and surrender", () => {
    const value = installed(grant({ lease_id: "" }));
    const admission = admit(value, { callId: "empty-id" });
    expect(admission).toMatchObject({
      decision: LeaseDecision.AdmitLocal,
      leaseId: "",
      reservedTokens: 1_500,
    });
    value.trueUp("empty-id", 900, { claimToken: admission.claimToken });
    expect(value.claimRenewalRequest(RUN)).toMatchObject({ lease_id: "", spent_tokens: 900 });
    expect(value.buildSurrenderRequest(RUN)).toMatchObject({ lease_id: "", spent_tokens: 900 });
  });

  it("nets only same-lease post-snapshot settlement and never nets a replacement or a response without a pending report", () => {
    const same = installed(grant({ granted_tokens: 10_000 }));
    const first = admit(same, { callId: "first", estimatedInputTokens: 400, outputBound: 100 });
    same.trueUp("first", 500, { claimToken: first.claimToken });
    same.claimRenewalRequest(RUN);
    const later = admit(same, { callId: "later", estimatedInputTokens: 700, outputBound: 100 });
    same.trueUp("later", 800, { claimToken: later.claimToken });
    same.applyGrantResponse(RUN, grant({ generation: 2, granted_tokens: 10_000 }), { now: 1_010 });
    expect(same.stateFor(RUN)?.grantedRemainingTokens).toBe(9_200);

    const replacement = installed(grant({ granted_tokens: 10_000 }));
    const funded = admit(replacement, {
      callId: "old-lease",
      estimatedInputTokens: 500,
      outputBound: 500,
    });
    replacement.claimRenewalRequest(RUN);
    replacement.applyGrantResponse(
      RUN,
      grant({ lease_id: "lse-new", generation: 2, granted_tokens: 10_000 }),
      {
        now: 1_010,
      },
    );
    expect(replacement.stateFor(RUN)?.grantedRemainingTokens).toBe(10_000);
    replacement.trueUp("old-lease", 9_000, { claimToken: funded.claimToken });
    expect(replacement.stateFor(RUN)?.grantedRemainingTokens).toBe(10_000);

    const noReport = installed(grant({ granted_tokens: 10_000 }));
    const settledWithoutSnapshot = admit(noReport, {
      callId: "settled-without-snapshot",
      estimatedInputTokens: 500,
      outputBound: 500,
    });
    noReport.trueUp("settled-without-snapshot", 1_500, {
      claimToken: settledWithoutSnapshot.claimToken,
    });
    noReport.applyGrantResponse(RUN, grant({ generation: 2, granted_tokens: 10_000 }), {
      now: 1_010,
    });
    expect(noReport.stateFor(RUN)?.grantedRemainingTokens).toBe(10_000);
  });

  it("carries a same-lease SHARE reservation through renewal so release restores the refreshed share pool", () => {
    const value = installed(grant({ granted_tokens: 0, headroom_share_tokens: 5_000 }));
    const reservation = admit(value, { callId: "share-carry", breakerOpen: true });
    expect(reservation).toMatchObject({
      decision: LeaseDecision.AdmitOutageMetered,
      leaseId: "lse-1",
      reservedTokens: 1_500,
    });
    expect(
      value.applyGrantResponse(
        RUN,
        grant({ generation: 2, granted_tokens: 0, headroom_share_tokens: 5_000 }),
        { now: 1_010 },
      ),
    ).toBe("applied");
    expect(value.stateFor(RUN)?.shareRemainingTokens).toBe(3_500);

    value.release("share-carry", { claimToken: reservation.claimToken });
    expect(value.stateFor(RUN)?.shareRemainingTokens).toBe(5_000);
  });

  it("does not let a true-up from a dropped same-id lease incarnation charge its replacement", () => {
    const value = installed(grant({ granted_tokens: 5_000 }));
    const old = admit(value, { callId: "dropped-true-up" });

    value.drop(RUN);
    expect(
      value.applyGrantResponse(RUN, grant({ generation: 2, granted_tokens: 5_000 }), {
        now: 1_010,
      }),
    ).toBe("applied");

    value.trueUp("dropped-true-up", 3_500, { claimToken: old.claimToken });
    expect(value.stateFor(RUN)?.grantedRemainingTokens).toBe(5_000);
  });

  it("does not let a release from a dropped same-id lease incarnation refill its replacement", () => {
    const value = installed(grant({ granted_tokens: 5_000 }));
    const old = admit(value, { callId: "dropped-release" });

    value.drop(RUN);
    expect(
      value.applyGrantResponse(RUN, grant({ generation: 2, granted_tokens: 5_000 }), {
        now: 1_010,
      }),
    ).toBe("applied");

    value.release("dropped-release", { claimToken: old.claimToken });
    expect(value.stateFor(RUN)?.grantedRemainingTokens).toBe(5_000);
  });

  it("true-ups and releases use exact claim capability, preserve overshoot, floor unmeasured calls, and ignore dead funding", () => {
    const value = installed(grant({ granted_tokens: 2_000 }));
    const first = admit(value, { callId: "a", estimatedInputTokens: 1_000, outputBound: 500 });
    value.trueUp("a", 9_000, { claimToken: first.claimToken, floorAtReservation: true });
    expect(value.stateFor(RUN)).toMatchObject({
      grantedRemainingTokens: -7_000,
      spentTokensSinceReport: 9_000,
    });
    const fresh = installed(grant({ granted_tokens: 2_000 }));
    const reserved = admit(fresh, {
      callId: "floor",
      estimatedInputTokens: 1_000,
      outputBound: 500,
    });
    fresh.trueUp("floor", 1_000, { claimToken: reserved.claimToken, floorAtReservation: true });
    expect(fresh.stateFor(RUN)?.grantedRemainingTokens).toBe(500);
    const release = admit(fresh, {
      callId: "release",
      estimatedInputTokens: 100,
      outputBound: 100,
    });
    fresh.release("release", { claimToken: release.claimToken });
    expect(fresh.stateFor(RUN)?.grantedRemainingTokens).toBe(500);
    fresh.drop(RUN);
    fresh.trueUp("release", 10_000, { claimToken: release.claimToken });
    expect(fresh.stateFor(RUN)?.spentTokensSinceReport).toBe(1_500);

    const share = installed(grant({ granted_tokens: 0, headroom_share_tokens: 5_000 }));
    const shareReservation = admit(share, { callId: "share", breakerOpen: true });
    share.trueUp("share", 900, { claimToken: shareReservation.claimToken });
    expect(share.stateFor(RUN)).toMatchObject({
      shareRemainingTokens: 4_100,
      grantedRemainingTokens: 0,
    });
  });

  it("retains display snapshots across deny/ineligibility and applies conditional drop/discard/uncounted semantics", () => {
    const value = installed();
    value.applyGrantResponse(RUN, grant({ eligible: false, lease_id: null, generation: null }), {
      now: 1_010,
    });
    expect(value.snapshotFor(RUN)).toMatchObject({ projectId: "project-1", remainingBudget: 80 });
    expect(value.dropIfCurrent(RUN, { leaseId: "wrong", generation: 1 })).toBe(false);
    value.recordUncounted(RUN, 25);
    expect(value.stateFor(RUN)).toMatchObject({ uncountedCalls: 1, uncountedTokens: 25 });
    value.discard(RUN);
    expect(value.stateFor(RUN)).toBeNull();
  });
});

describe("LeaseLedger recovery after an ineligible renewal", () => {
  const INELIGIBLE = grant({
    eligible: false,
    lease_id: null,
    generation: null,
    granted_tokens: null,
    refresh_interval_s: null,
    lease_length_s: null,
    headroom_share_tokens: null,
    posture: null,
    ineligible_reason: "zero_rate_model",
  });

  it("settles the refused report and owes one held-generation release with the later spend", () => {
    const value = installed();
    const first = admit(value, { callId: "before" });
    value.trueUp("before", 200, { claimToken: first.claimToken });
    value.recordUncounted(RUN, 50);
    expect(value.claimRenewalRequest(RUN)).toMatchObject({
      spent_tokens: 200,
      uncounted_calls: 1,
      uncounted_tokens: 50,
    });
    const second = admit(value, { callId: "after", now: 1_002 });
    value.trueUp("after", 300, { claimToken: second.claimToken });

    expect(
      value.applyGrantResponse(RUN, INELIGIBLE, {
        now: 1_010,
        expectedLeaseId: "lse-1",
        expectedGeneration: 1,
      }),
    ).toBe(GrantOutcome.Ineligible);
    const state = value.stateFor(RUN);
    expect(state).toMatchObject({
      leaseId: null,
      generation: 0,
      pendingReport: null,
      spentTokensSinceReport: 0,
      uncountedCalls: 0,
      uncountedTokens: 0,
      runIneligible: true,
      ineligibleRetryAt: 1_010 + LEASE_REFUSAL_LATCH_S,
      releasePending: {
        refusedAt: 1_010,
        token: expect.any(Number),
        request: { lease_id: "lse-1", holder_id: HOLDER, generation: 1, spent_tokens: 300 },
      },
    });
    expect(admit(value, { callId: "pending", now: 1_011 })).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      reason: "lease_release_pending",
    });
  });

  it("re-grants after a sent release, latches from the refusal otherwise, and never creates state", () => {
    const refused = (value: LeaseLedger) => {
      value.applyGrantResponse(RUN, INELIGIBLE, {
        now: 1_010,
        expectedLeaseId: "lse-1",
        expectedGeneration: 1,
      });
      return value.stateFor(RUN)?.releasePending?.token ?? -1;
    };

    const sent = installed();
    const sentToken = refused(sent);
    expect(sent.resolveRefusalRelease(RUN, sentToken + 1, true)).toBe(false);
    expect(sent.resolveRefusalRelease(RUN, sentToken, true)).toBe(true);
    expect(sent.resolveRefusalRelease(RUN, sentToken, true)).toBe(false);
    expect(admit(sent, { callId: "sent", now: 1_011 }).decision).toBe(LeaseDecision.NeedGrant);

    const dropped = installed();
    const droppedToken = refused(dropped);
    expect(dropped.resolveRefusalRelease(RUN, droppedToken, false)).toBe(true);
    expect(admit(dropped, { callId: "latched", now: 1_159 })).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      reason: "run_lease_ineligible",
    });
    expect(admit(dropped, { callId: "lapsed", now: 1_160 }).decision).toBe(LeaseDecision.NeedGrant);

    const missing = installed();
    const missingToken = refused(missing);
    expect(admit(missing, { callId: "cap", now: 1_160 }).decision).toBe(LeaseDecision.NeedGrant);
    expect(missing.stateFor(RUN)?.releasePending).toBeNull();
    expect(missing.resolveRefusalRelease(RUN, missingToken, false)).toBe(false);
    expect(missing.stateFor(RUN)?.runIneligible).toBe(false);

    const retired = installed();
    const retiredToken = refused(retired);
    retired.discard(RUN);
    expect(retired.resolveRefusalRelease(RUN, retiredToken, true)).toBe(false);
    expect(retired.stateFor(RUN)).toBeNull();
  });

  it("keeps an ineligible initial grant permanent with no release owed", () => {
    const value = ledger();
    expect(value.applyGrantResponse(RUN, INELIGIBLE, { now: 1_000 })).toBe(GrantOutcome.Ineligible);
    expect(value.stateFor(RUN)).toMatchObject({
      runIneligible: true,
      ineligibleRetryAt: Number.POSITIVE_INFINITY,
      releasePending: null,
    });
  });
});

describe("LeaseLedger bounded claims, renewal, and shutdown", () => {
  it("checks the current renewal origin by lease id and generation without mutation", () => {
    const value = installed();
    const before = value.stateFor(RUN);

    expect(value.isCurrentOrigin(RUN, { leaseId: "lse-1", generation: 1 })).toBe(true);
    expect(value.isCurrentOrigin(RUN, { leaseId: "other", generation: 1 })).toBe(false);
    expect(value.isCurrentOrigin(RUN, { leaseId: "lse-1", generation: 2 })).toBe(false);
    expect(value.isCurrentOrigin("other-run", { leaseId: "lse-1", generation: 1 })).toBe(false);
    expect(value.stateFor(RUN)).toBe(before);
  });

  it("builds a v1 renewal request that rejects an unsupported directive version", () => {
    const request = installed().buildRenewalRequest(RUN);
    if (request === null) throw new Error("expected installed lease renewal request");

    expect(request.run_directive_version).toBe("1");
    expect(
      LeaseRenewRequestSchema.safeParse({ ...request, run_directive_version: "2" }).success,
    ).toBe(false);
  });

  it("uses O(1) claim indexing, rejects duplicate/reentry violations, and protects ABA at the 900-second boundary", () => {
    const value = installed(grant({ lease_length_s: 10_000 }));
    const first = admit(value, { callId: "aba" });
    expect(() => admit(value, { callId: "aba" })).toThrow("call_id");
    value.sweep(1_001 + RESERVATION_MAX_AGE_S);
    const successor = admit(value, { callId: "aba", now: 1_002 + RESERVATION_MAX_AGE_S });
    expect(successor.claimToken).not.toBe(first.claimToken);
    const before = value.stateFor(RUN)?.grantedRemainingTokens;
    value.release("aba", { claimToken: first.claimToken });
    expect(value.stateFor(RUN)?.grantedRemainingTokens).toBe(before);
  });

  it("renews at 75%, arms only one request, backs off with the capped schedule, and preserves netted reports", () => {
    const value = installed(grant({ granted_tokens: 10_000 }));
    expect(
      admit(value, { callId: "threshold", estimatedInputTokens: 7_100, outputBound: 400 })
        .renewalDue,
    ).toBe(true);
    const request = value.claimRenewalRequest(RUN, { model: "gpt-5", provider: "openai" });
    expect(request).toMatchObject({ lease_id: "lse-1", holder_id: HOLDER, reserved_tokens: 7_500 });
    expect(request).toHaveProperty("run_directive_version", "1");
    expect(value.claimRenewalRequest(RUN)).toBeNull();
    const state = value.stateFor(RUN);
    expect(state).toBeDefined();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      value.renewalFailed(RUN, { now: i });
      waits.push((state?.nextAttemptAt ?? 0) - i);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30]);
    expect(backoffCeiling(1)).toBe(BACKOFF_BASE_S);
    expect(backoffCeiling(99)).toBe(BACKOFF_CAP_S);

    const explicitNullOrigin = installed();
    explicitNullOrigin.claimRenewalRequest(RUN);
    expect(
      explicitNullOrigin.renewalFailed(RUN, {
        now: 2_000,
        expectedLeaseId: null,
        expectedGeneration: null,
      }),
    ).toBe(true);

    const incompleteOrigin = installed();
    incompleteOrigin.claimRenewalRequest(RUN);
    expect(
      incompleteOrigin.renewalFailed(RUN, {
        now: 2_000,
        expectedLeaseId: "lse-1",
        expectedGeneration: null,
      }),
    ).toBe(false);
    expect(incompleteOrigin.stateFor(RUN)?.renewalInFlight).toBe(true);
  });

  it("suppresses renewal when final_grant is true even after both refresh and depletion triggers", () => {
    const value = installed(
      grant({ final_grant: true, granted_tokens: 10_000, refresh_interval_s: 1 }),
    );

    expect(
      admit(value, {
        callId: "final-grant",
        now: 1_002,
        estimatedInputTokens: 7_100,
        outputBound: 400,
      }).renewalDue,
    ).toBe(false);
  });

  it("does not renew a zero-token alert-only grant after its refresh deadline", () => {
    const value = installed(
      grant({
        granted_tokens: 0,
        refresh_interval_s: 1,
        lease_length_s: 120,
        posture: { mode: "alert_only", on_unreachable: "fail_open" },
      }),
    );

    expect(
      admit(value, {
        callId: "zero-token-after-refresh",
        now: 1_002,
      }),
    ).toMatchObject({
      decision: LeaseDecision.LegacyCheck,
      renewalDue: false,
    });
  });

  it("retains reported tallies after renewal failure and clears only acknowledged tallies after renewal", () => {
    const value = installed(grant({ granted_tokens: 10_000 }));
    const beforeFailure = admit(value, { callId: "before-failure" });
    value.trueUp("before-failure", 900, { claimToken: beforeFailure.claimToken });
    value.recordUncounted(RUN, 100);
    value.claimRenewalRequest(RUN);

    expect(value.renewalFailed(RUN, { now: 1_010 })).toBe(true);
    expect(value.stateFor(RUN)).toMatchObject({
      spentTokensSinceReport: 900,
      uncountedCalls: 1,
      uncountedTokens: 100,
    });

    value.claimRenewalRequest(RUN);
    const afterSnapshot = admit(value, { callId: "after-snapshot" });
    value.trueUp("after-snapshot", 400, { claimToken: afterSnapshot.claimToken });
    value.recordUncounted(RUN, 50);
    expect(
      value.applyGrantResponse(RUN, grant({ generation: 2, granted_tokens: 10_000 }), {
        now: 1_020,
      }),
    ).toBe("applied");
    expect(value.stateFor(RUN)).toMatchObject({
      spentTokensSinceReport: 400,
      uncountedCalls: 1,
      uncountedTokens: 50,
    });
  });

  it("builds surrender/drain payloads and preserves pending-renewal deltas", () => {
    const value = installed();
    const admitted = admit(value, { callId: "delta" });
    value.trueUp("delta", 900, { claimToken: admitted.claimToken });
    value.claimRenewalRequest(RUN);
    const next = admit(value, { callId: "after" });
    value.trueUp("after", 600, { claimToken: next.claimToken });
    const deltas = value.pendingRenewalSpendDeltas();
    expect(deltas).toEqual([{ runId: RUN, leaseId: "lse-1", generation: 1, spentTokens: 600 }]);
    expect(Object.isFrozen(deltas)).toBe(true);
    expect(Object.isFrozen(deltas[0])).toBe(true);
    expect(value.buildSurrenderRequest(RUN)).toEqual({
      lease_id: "lse-1",
      holder_id: HOLDER,
      generation: 1,
      spent_tokens: 1_500,
    });
    expect(value.drainSurrenderRequests()).toHaveLength(1);
    expect(value.activeRunIds()).toEqual([]);
  });
});
