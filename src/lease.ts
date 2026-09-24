/** Sans-I/O state machine for agent-run token leases. */

import { ConfigurationError, SolwynError } from "./errors";
import { positiveOutputBound } from "./output-bound";
import type {
  BudgetMode,
  LeaseGrantResponse,
  LeaseRenewRequest,
  LeaseSurrenderRequest,
  Modality,
  ProviderName,
} from "./types";

export const DEFAULT_OUTPUT_BOUND = 4096;
export const RESERVATION_MAX_AGE_S = 900;
export const INELIGIBLE_RETRY_AFTER_S = 30;
/**
 * How long a run stays on per-call checks after a grant 409, or after an ineligible renewal whose
 * release was not confirmed. It outlasts the lease an unseen grant may have left behind.
 */
export const LEASE_REFUSAL_LATCH_S = 150;
export const RENEWAL_DEPLETION_NUM = 3;
export const RENEWAL_DEPLETION_DEN = 4;
export const REFRESH_JITTER_MIN = 0.85;
export const REFRESH_JITTER_MAX = 1.15;
export const BACKOFF_BASE_S = 1;
export const BACKOFF_CAP_S = 30;

export interface InstallableLeaseGrantResponse extends LeaseGrantResponse {
  lease_id: string;
  generation: number;
  granted_tokens: number;
  refresh_interval_s: number;
  lease_length_s: number;
  headroom_share_tokens: number;
  posture: NonNullable<LeaseGrantResponse["posture"]>;
}

export function isInstallableLeaseGrantResponse(
  response: LeaseGrantResponse,
): response is InstallableLeaseGrantResponse {
  return (
    response.lease_id !== null &&
    response.lease_id !== undefined &&
    response.lease_id.length <= 64 &&
    positiveOutputBound(response.generation) !== null &&
    response.granted_tokens !== null &&
    response.granted_tokens !== undefined &&
    response.refresh_interval_s !== null &&
    response.refresh_interval_s !== undefined &&
    response.lease_length_s !== null &&
    response.lease_length_s !== undefined &&
    response.headroom_share_tokens !== null &&
    response.headroom_share_tokens !== undefined &&
    response.posture !== null &&
    response.posture !== undefined
  );
}

export const LeaseDecision = {
  LegacyCheck: "legacy_check",
  NeedGrant: "need_grant",
  AdmitLocal: "admit_local",
  AdmitOutageMetered: "admit_outage_metered",
  AdmitUncounted: "admit_uncounted",
  Deny: "deny",
} as const;
export type LeaseDecision = (typeof LeaseDecision)[keyof typeof LeaseDecision];

export const GrantOutcome = {
  Applied: "applied",
  Ineligible: "ineligible",
  Denied: "denied",
  Stale: "stale",
  Malformed: "malformed",
} as const;
export type GrantOutcome = (typeof GrantOutcome)[keyof typeof GrantOutcome];

type Pool = "granted" | "share";
export type OnUnreachable = "fail_open" | "local_enforce";

export interface LeaseAdmission {
  readonly decision: LeaseDecision;
  readonly leaseId: string | null;
  readonly reservedTokens: number;
  readonly warning: string | null;
  readonly renewalDue: boolean;
  readonly mode: BudgetMode | null;
  readonly reason: string | null;
  readonly claimToken: number | null;
  readonly admitted: boolean;
}

export interface LeaseSnapshot {
  readonly projectId: string;
  readonly mode: BudgetMode;
  readonly budgetLimit: number;
  readonly currentUsage: number;
  readonly remainingBudget: number;
}

/** Spend that settled after an in-flight renewal captured its wire snapshot. */
export interface PendingRenewalSpendDelta {
  readonly runId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly spentTokens: number;
}

interface Reservation {
  readonly leaseId: string;
  readonly leaseIncarnation: number;
  readonly tokens: number;
  readonly createdAt: number;
  readonly pool: Pool;
  readonly claimToken: number;
}
interface CallClaim {
  readonly runId: string;
  readonly createdAt: number;
  readonly token: number;
}
interface PendingReport {
  readonly spentTokens: number;
  readonly uncountedCalls: number;
  readonly uncountedTokens: number;
}
interface Expiry {
  readonly at: number;
  readonly token: number;
  readonly callId: string;
}
/** The release owed after an ineligible renewal, pending until its outcome arrives. */
export interface RefusalRelease {
  /** Monotonic seconds when the ineligible renewal was applied. */
  readonly refusedAt: number;
  /** Identifies this refusal; a later refusal or a lapsed latch replaces or clears it. */
  readonly token: number;
  /** Surrender of the lease held when the renewal was refused, at its held generation. */
  readonly request: LeaseSurrenderRequest;
}
/**
 * The declaration a renewal first claimed at one lease and generation. Until that generation is
 * superseded, every retry at the same origin re-sends it: the control plane may answer a retry
 * with its stored result for the first request, so a retry must never declare anything else.
 */
export interface RenewalDeclaration {
  readonly leaseId: string;
  readonly generation: number;
  readonly model: string | null;
  readonly provider: ProviderName | null;
  readonly fallbackProviders: readonly ProviderName[];
  readonly fallbackModels: readonly string[];
  /** The declaration's models the lease did not yet declare; empty for an ordinary renewal. */
  readonly addedModels: readonly string[];
  /**
   * Whether any attempt may have reached the control plane. Set once an attempt is dispatched,
   * or reports an unknown outcome; never cleared while the declaration is owed. A skipped attempt
   * (an open breaker, an invalid request) drops the declaration only while this is false.
   */
  readonly dispatched: boolean;
}

export class LeaseState {
  readonly runId: string;
  leaseId: string | null = null;
  leaseIncarnation = 0;
  generation = 0;
  grantedTokens = 0;
  grantedRemainingTokens = 0;
  shareRemainingTokens = 0;
  refreshDeadline = 0;
  leaseDeadline = 0;
  postureMode: BudgetMode = "alert_only";
  onUnreachable: OnUnreachable = "fail_open";
  finalGrant = false;
  declaredModels = new Set<string>();
  /**
   * Models a widening renewal added and the control plane answered eligible:false. They belong to
   * the run, outlive any lease, and are never declared again in a renewal or a grant.
   */
  readonly refusedModels = new Set<string>();
  readonly reservations = new Map<string, Reservation>();
  renewalInFlight = false;
  /** Owed by every retry at its lease and generation; see {@link RenewalDeclaration}. */
  renewalDeclaration: RenewalDeclaration | null = null;
  consecutiveFailures = 0;
  nextAttemptAt = 0;
  pendingReport: PendingReport | null = null;
  spentTokensSinceReport = 0;
  uncountedCalls = 0;
  uncountedTokens = 0;
  runIneligible = false;
  ineligibleRetryAt = 0;
  /** Not a retirement item: it never blocks retirement or keeps the state alive. */
  releasePending: RefusalRelease | null = null;
  snapshot: LeaseSnapshot | null = null;

  constructor(runId: string) {
    this.runId = runId;
  }

  get hasLease(): boolean {
    return this.leaseId !== null;
  }

  get reservedTokens(): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (
        reservation.leaseId === this.leaseId &&
        reservation.leaseIncarnation === this.leaseIncarnation
      ) {
        total += reservation.tokens;
      }
    }
    return total;
  }

  covers(model: string, fallbackModels: readonly string[]): boolean {
    return (
      this.declaredModels.has(model) &&
      fallbackModels.every((item) => this.declaredModels.has(item))
    );
  }

  /** Whether the chain names a model a refused widening recorded for this run. */
  refuses(model: string, fallbackModels: readonly string[]): boolean {
    if (this.refusedModels.size === 0) return false;
    return (
      this.refusedModels.has(model) || fallbackModels.some((item) => this.refusedModels.has(item))
    );
  }
}

export interface LeaseLedgerOptions {
  holderId: string;
  enabled?: boolean;
  outputBoundDefault?: number;
  rng?: (() => number) | { uniform(min: number, max: number): number };
}
export interface AdmitOptions {
  runId: string;
  callId: string;
  estimatedInputTokens: number;
  model: string;
  now: number;
  breakerOpen: boolean;
  outputBound?: number;
  modality?: Modality;
  hasEstimatedMedia?: boolean;
  fallbackModels?: readonly string[];
  claimToken?: number | null;
}
export interface ApplyGrantResponseOptions {
  now: number;
  declaredModels?: readonly string[];
  expectedLeaseId?: string | null;
  expectedGeneration?: number | null;
  /** The models a widening renewal added; an eligible:false answer records them as refused. */
  wideningModels?: readonly string[];
}
export interface RenewalOptions {
  model?: string | null;
  provider?: ProviderName | null;
  fallbackProviders?: readonly ProviderName[];
  fallbackModels?: readonly string[];
}
export interface WideningOptions {
  now: number;
  model: string;
  provider: ProviderName;
  fallbackProviders: readonly ProviderName[];
  fallbackModels: readonly string[];
}
/**
 * A claimed renewal and the models its declaration adds to the lease. A retry at the same lease
 * and generation carries the first claim's declaration and added models, not the caller's chain.
 */
export interface RenewalClaim {
  readonly request: LeaseRenewRequest;
  readonly addedModels: readonly string[];
  /** Whether the claim re-sends a declaration an earlier attempt owed, not a fresh one. */
  readonly retry: boolean;
}
/**
 * A claimed renewal that re-declares a call's chain, and the models it adds to the lease; or,
 * while a retry is owed, that retry (`retry: true`), which never carries the call's chain.
 */
export type WideningClaim = RenewalClaim;
export interface RenewalFailedOptions {
  now: number;
  expectedLeaseId?: string | null;
  expectedGeneration?: number | null;
  /**
   * Whether this attempt may have reached the control plane. `false` only when it provably never
   * left. The declaration is dropped only if no earlier attempt may have reached the control
   * plane either; otherwise the next claim at the same origin still re-sends it.
   */
  sent?: boolean;
}
export interface ClaimSettlementOptions {
  claimToken: number | null;
  floorAtReservation?: boolean;
}

export class LeaseLedger {
  holderId: string;
  enabled: boolean;
  outputBoundDefault: number;
  readonly #states = new Map<string, LeaseState>();
  readonly #callIndex = new Map<string, string>();
  readonly #callClaims = new Map<string, CallClaim>();
  readonly #callExpiries: Expiry[] = [];
  /** Runs whose aged reservations a sweep released since the owner last took them. */
  readonly #sweptRuns = new Set<string>();
  #nextClaimToken = 0;
  #nextLeaseIncarnation = 0;
  #nextRefusalToken = 0;
  readonly #rng: LeaseLedgerOptions["rng"];

  constructor({
    holderId,
    enabled = true,
    outputBoundDefault = DEFAULT_OUTPUT_BOUND,
    rng,
  }: LeaseLedgerOptions) {
    if (positiveOutputBound(outputBoundDefault) === null) {
      throw new ConfigurationError("outputBoundDefault must be a positive safe integer", {
        field: "outputBoundDefault",
      });
    }
    this.holderId = holderId;
    this.enabled = enabled;
    this.outputBoundDefault = outputBoundDefault;
    this.#rng = rng;
  }

  stateFor(runId: string): LeaseState | null {
    return this.#states.get(runId) ?? null;
  }
  leaseIdFor(runId: string): string | null {
    return this.#states.get(runId)?.leaseId ?? null;
  }
  snapshotFor(runId: string): LeaseSnapshot | null {
    return this.#states.get(runId)?.snapshot ?? null;
  }
  isCurrentOrigin(
    runId: string,
    { leaseId, generation }: { leaseId: string; generation: number },
  ): boolean {
    const state = this.#states.get(runId);
    return state?.leaseId === leaseId && state.generation === generation;
  }
  /** The run holding a live reservation for this call, if any. */
  runIdForCall(callId: string): string | null {
    return this.#callIndex.get(callId) ?? null;
  }
  /** Hand over (and forget) the runs whose reservations a sweep released. */
  takeSweptRuns(): string[] {
    if (this.#sweptRuns.size === 0) return [];
    const runs = [...this.#sweptRuns];
    this.#sweptRuns.clear();
    return runs;
  }
  /** Uncounted fail-open tallies held by every state, e.g. before close drains them. */
  uncountedTallies(): { runs: number; calls: number; tokens: number } {
    let runs = 0;
    let calls = 0;
    let tokens = 0;
    for (const state of this.#states.values()) {
      if (state.uncountedCalls <= 0 && state.uncountedTokens <= 0) continue;
      runs += 1;
      calls += Math.max(0, state.uncountedCalls);
      tokens += Math.max(0, state.uncountedTokens);
    }
    return { runs, calls, tokens };
  }
  activeRunIds(): string[] {
    return [...this.#states].flatMap(([runId, state]) => (state.hasLease ? [runId] : []));
  }

  admit(options: AdmitOptions): LeaseAdmission {
    const {
      runId,
      callId,
      estimatedInputTokens,
      model,
      now,
      breakerOpen,
      outputBound,
      modality = "text",
      hasEstimatedMedia = false,
      fallbackModels = [],
      claimToken = null,
    } = options;
    if (!this.enabled)
      return this.#admission(LeaseDecision.LegacyCheck, { reason: "lease_disabled" });
    if (modality !== "text" || hasEstimatedMedia) {
      return this.#admission(LeaseDecision.LegacyCheck, { reason: "call_lease_ineligible" });
    }
    this.sweep(now);
    const ownedClaimToken = this.#claimCall(runId, callId, now, claimToken);
    const state = this.#states.get(runId);
    if (state?.runIneligible) {
      if (now < state.ineligibleRetryAt) {
        return this.#admission(LeaseDecision.LegacyCheck, {
          reason: state.releasePending ? "lease_release_pending" : "run_lease_ineligible",
          claimToken: ownedClaimToken,
        });
      }
      // A release outcome that never arrived cannot hold the run beyond the latch.
      state.runIneligible = false;
      state.ineligibleRetryAt = 0;
      state.releasePending = null;
    }
    if (state?.refuses(model, fallbackModels)) {
      // Never declared again: no widening and no grant for a chain with a refused model.
      return this.#admission(LeaseDecision.LegacyCheck, {
        reason: "model_refused_for_lease",
        claimToken: ownedClaimToken,
      });
    }
    if (state?.hasLease && !state.covers(model, fallbackModels)) {
      if (now >= state.leaseDeadline && !breakerOpen) {
        // An expired lease cannot widen, and only this call's chain can drive its re-grant:
        // drop it and re-grant for that chain, as a covered chain's call does at expiry.
        this.#dropLease(state);
        return this.#admission(LeaseDecision.NeedGrant, {
          reason: "lease_expired",
          claimToken: ownedClaimToken,
        });
      }
      return this.#admission(LeaseDecision.LegacyCheck, {
        reason: "model_outside_declared_set",
        claimToken: ownedClaimToken,
      });
    }
    const reserve = Math.max(0, estimatedInputTokens) + this.#outputBound(outputBound);
    if (!state?.hasLease)
      return this.#admission(LeaseDecision.NeedGrant, {
        reason: "no_lease",
        claimToken: ownedClaimToken,
      });
    const decision =
      now < state.leaseDeadline
        ? this.#admitLive(state, callId, reserve, now, breakerOpen)
        : this.#admitExpired(state, callId, reserve, now, breakerOpen);
    return Object.freeze({ ...decision, claimToken: ownedClaimToken });
  }

  applyGrantResponse(
    runId: string,
    response: LeaseGrantResponse,
    options: ApplyGrantResponseOptions,
  ): GrantOutcome {
    const {
      now,
      declaredModels = [],
      expectedLeaseId,
      expectedGeneration,
      wideningModels = [],
    } = options;
    let state = this.#states.get(runId);
    if (this.#originFenceRejects(state, expectedLeaseId, expectedGeneration)) {
      return GrantOutcome.Stale;
    }
    state ??= this.#state(runId);
    if (!response.eligible) {
      // Only a renewal names its origin; the fence above proved this state still holds it.
      const renewal =
        expectedLeaseId !== null &&
        expectedLeaseId !== undefined &&
        expectedGeneration !== null &&
        expectedGeneration !== undefined;
      const release = renewal ? this.#releaseRefusedLease(state) : null;
      if (renewal) for (const model of wideningModels) state.refusedModels.add(model);
      this.#dropLease(state);
      this.#storeSnapshot(state, response);
      state.runIneligible = true;
      if (release === null) {
        // An ineligible initial grant keeps the run on per-call checks for its lifetime.
        state.ineligibleRetryAt = Infinity;
        state.releasePending = null;
      } else {
        state.ineligibleRetryAt = now + LEASE_REFUSAL_LATCH_S;
        state.releasePending = Object.freeze({
          refusedAt: now,
          token: ++this.#nextRefusalToken,
          request: release,
        });
      }
      return GrantOutcome.Ineligible;
    }
    if (!response.allowed) {
      this.#dropLease(state);
      this.#storeSnapshot(state, response);
      return GrantOutcome.Denied;
    }
    if (!isInstallableLeaseGrantResponse(response)) {
      this.#dropLease(state);
      state.runIneligible = true;
      state.ineligibleRetryAt = now + INELIGIBLE_RETRY_AFTER_S;
      return GrantOutcome.Malformed;
    }
    const {
      lease_id: leaseId,
      generation,
      granted_tokens: grantedTokens,
      refresh_interval_s: refreshInterval,
      lease_length_s: leaseLength,
      headroom_share_tokens: shareTokens,
      posture,
    } = response;
    if (state.hasLease && generation <= state.generation) return GrantOutcome.Stale;
    const sameLease = state.leaseId === leaseId;
    const carriedGranted = sameLease ? this.#carriedGrantedDrawdown(state) : 0;
    const carriedShare = sameLease ? this.#carriedShareDrawdown(state) : 0;
    if (!sameLease) this.#rotateLeaseIncarnation(state);
    state.leaseId = leaseId;
    state.generation = generation;
    state.grantedTokens = Math.max(0, grantedTokens);
    state.grantedRemainingTokens = state.grantedTokens - carriedGranted;
    state.shareRemainingTokens = Math.max(0, shareTokens) - carriedShare;
    state.refreshDeadline =
      now + refreshInterval * this.#uniform(REFRESH_JITTER_MIN, REFRESH_JITTER_MAX);
    state.leaseDeadline = now + leaseLength;
    state.postureMode = posture.mode;
    state.onUnreachable = posture.on_unreachable;
    state.finalGrant = Boolean(response.final_grant);
    if (sameLease) for (const model of declaredModels) state.declaredModels.add(model);
    else state.declaredModels = new Set(declaredModels);
    state.renewalInFlight = false;
    state.renewalDeclaration = null;
    state.consecutiveFailures = 0;
    state.nextAttemptAt = 0;
    state.runIneligible = false;
    state.ineligibleRetryAt = 0;
    state.releasePending = null;
    this.#storeSnapshot(state, response);
    this.#settlePendingReport(state);
    return GrantOutcome.Applied;
  }

  markIneligible(
    runId: string,
    { now, retryAfter }: { now: number; retryAfter?: number | null },
  ): void {
    const state = this.#state(runId);
    this.#dropLease(state);
    state.runIneligible = true;
    state.ineligibleRetryAt =
      retryAfter === null || retryAfter === undefined ? Infinity : now + retryAfter;
    state.releasePending = null;
  }
  /**
   * Record the outcome of the release owed by one ineligible renewal. A sent release lets the
   * next eligible call grant again; any other outcome leaves the latch counted from the refusal.
   * Never creates state, and ignores an outcome for a refusal that is no longer pending.
   */
  resolveRefusalRelease(runId: string, token: number, sent: boolean): boolean {
    const state = this.#states.get(runId);
    if (state?.releasePending?.token !== token) return false;
    state.releasePending = null;
    if (sent) {
      state.runIneligible = false;
      state.ineligibleRetryAt = 0;
    }
    return true;
  }
  recordUncounted(
    runId: string,
    tokens: number,
    options: { callId?: string; claimToken?: number | null } = {},
  ): void {
    const { callId, claimToken } = options;
    if (callId !== undefined) {
      const claim = this.#callClaims.get(callId);
      if (
        !claim ||
        claim.runId !== runId ||
        claimToken === null ||
        claimToken === undefined ||
        claim.token !== claimToken
      ) {
        throw new SolwynError("uncounted call_id was not claimed by this run");
      }
    }
    const state = this.#state(runId);
    state.uncountedCalls++;
    state.uncountedTokens += Math.max(0, tokens);
  }
  drop(runId: string): void {
    const state = this.#states.get(runId);
    if (state) this.#dropLease(state);
  }
  dropIfCurrent(
    runId: string,
    { leaseId, generation }: { leaseId: string; generation: number },
  ): boolean {
    const state = this.#states.get(runId);
    if (!state || state.leaseId !== leaseId || state.generation !== generation) return false;
    this.#dropLease(state);
    return true;
  }
  discard(runId: string): void {
    const state = this.#states.get(runId);
    if (!state) return;
    for (const callId of state.reservations.keys()) this.#callIndex.delete(callId);
    this.#states.delete(runId);
  }
  /** A completed surrender cannot leave reusable local authority on a revived identity. */
  acknowledgeSurrender(runId: string, request: LeaseSurrenderRequest): void {
    const state = this.#states.get(runId);
    if (!state || state.leaseId !== request.lease_id || state.generation !== request.generation)
      return;
    state.spentTokensSinceReport = Math.max(
      0,
      state.spentTokensSinceReport - (request.spent_tokens ?? 0),
    );
    this.#dropLease(state);
  }
  drainSurrenderRequests(excludeRuns: ReadonlySet<string> = new Set()): LeaseSurrenderRequest[] {
    const requests = [...this.#states.keys()].flatMap((runId) => {
      if (excludeRuns.has(runId)) return [];
      const request = this.buildSurrenderRequest(runId);
      return request ? [request] : [];
    });
    this.#states.clear();
    this.#callIndex.clear();
    this.#callClaims.clear();
    this.#callExpiries.length = 0;
    this.#sweptRuns.clear();
    return requests;
  }
  pendingRenewalSpendDeltas(): readonly PendingRenewalSpendDelta[] {
    const deltas: PendingRenewalSpendDelta[] = [];
    for (const [runId, state] of this.#states) {
      if (state.renewalInFlight && state.pendingReport && state.leaseId !== null) {
        deltas.push(
          Object.freeze({
            runId,
            leaseId: state.leaseId,
            generation: state.generation,
            spentTokens: Math.max(
              0,
              state.spentTokensSinceReport - state.pendingReport.spentTokens,
            ),
          }),
        );
      }
    }
    return Object.freeze(deltas);
  }
  onForkReset(): void {
    this.#sweptRuns.clear();
    this.#states.clear();
    this.#callIndex.clear();
    this.#callClaims.clear();
    this.#callExpiries.length = 0;
  }
  trueUp(
    callId: string,
    actualTokens: number,
    { claimToken, floorAtReservation = false }: ClaimSettlementOptions,
  ): void {
    const taken = this.#takeReservation(callId, claimToken);
    if (
      !taken ||
      taken.reservation.leaseId !== taken.state.leaseId ||
      taken.reservation.leaseIncarnation !== taken.state.leaseIncarnation
    )
      return;
    const actual = floorAtReservation
      ? Math.max(Math.max(0, actualTokens), taken.reservation.tokens)
      : Math.max(0, actualTokens);
    const delta = actual - taken.reservation.tokens;
    if (taken.reservation.pool === "granted") taken.state.grantedRemainingTokens -= delta;
    else taken.state.shareRemainingTokens -= delta;
    taken.state.spentTokensSinceReport += actual;
  }
  release(callId: string, { claimToken }: ClaimSettlementOptions): void {
    const taken = this.#takeReservation(callId, claimToken);
    if (
      !taken ||
      taken.reservation.leaseId !== taken.state.leaseId ||
      taken.reservation.leaseIncarnation !== taken.state.leaseIncarnation
    )
      return;
    if (taken.reservation.pool === "granted")
      taken.state.grantedRemainingTokens += taken.reservation.tokens;
    else taken.state.shareRemainingTokens += taken.reservation.tokens;
  }
  sweep(now: number): number {
    let swept = 0;
    while (this.#callExpiries[0] && this.#callExpiries[0].at <= now) {
      const expiry = this.#popExpiry();
      if (!expiry) break;
      const claim = this.#callClaims.get(expiry.callId);
      if (!claim || claim.token !== expiry.token || claim.createdAt + RESERVATION_MAX_AGE_S > now)
        continue;
      const runId = this.#callIndex.get(expiry.callId);
      if (runId !== undefined) {
        this.release(expiry.callId, { claimToken: expiry.token });
        this.#sweptRuns.add(runId);
        swept++;
      }
      this.#callClaims.delete(expiry.callId);
    }
    return swept;
  }
  renewalDue(state: LeaseState, now: number): boolean {
    if (!state.hasLease || state.renewalInFlight || now < state.nextAttemptAt || state.finalGrant)
      return false;
    if (state.grantedTokens <= 0) return false;
    if (now >= state.refreshDeadline) return true;
    return (
      (state.grantedTokens - state.grantedRemainingTokens) * RENEWAL_DEPLETION_DEN >=
      state.grantedTokens * RENEWAL_DEPLETION_NUM
    );
  }
  buildRenewalRequest(runId: string, options: RenewalOptions = {}): LeaseRenewRequest | null {
    const state = this.#states.get(runId);
    if (!state || state.leaseId === null) return null;
    state.pendingReport = {
      spentTokens: state.spentTokensSinceReport,
      uncountedCalls: state.uncountedCalls,
      uncountedTokens: state.uncountedTokens,
    };
    return {
      lease_id: state.leaseId,
      holder_id: this.holderId,
      generation: state.generation,
      spent_tokens: state.spentTokensSinceReport,
      reserved_tokens: state.reservedTokens,
      uncounted_calls: state.uncountedCalls,
      uncounted_tokens: state.uncountedTokens,
      model: options.model ?? null,
      provider: options.provider ?? null,
      fallback_providers: [...(options.fallbackProviders ?? [])],
      fallback_models: [...(options.fallbackModels ?? [])],
      run_directive_version: "1",
    };
  }
  claimRenewalRequest(runId: string, options: RenewalOptions = {}): LeaseRenewRequest | null {
    return this.claimRenewal(runId, options)?.request ?? null;
  }
  /**
   * Claim one renewal. The first claim at a lease and generation records its declaration; a retry
   * at the same origin re-sends that declaration and reports its added models, whatever chain the
   * retrying call uses. Spend, reservations and uncounted tallies are always current.
   */
  claimRenewal(runId: string, options: RenewalOptions = {}): RenewalClaim | null {
    const state = this.#states.get(runId);
    if (!state || state.leaseId === null || state.renewalInFlight) return null;
    const owed = this.#owedDeclaration(state);
    const declaration = owed ?? this.#newDeclaration(state, state.leaseId, options);
    const request = this.buildRenewalRequest(runId, {
      model: declaration.model,
      provider: declaration.provider,
      fallbackProviders: declaration.fallbackProviders,
      fallbackModels: declaration.fallbackModels,
    });
    if (request === null) return null;
    state.renewalInFlight = true;
    state.renewalDeclaration = declaration;
    return Object.freeze({ request, addedModels: declaration.addedModels, retry: owed !== null });
  }
  /** The declaration a retry at the state's current lease and generation must re-send. */
  owedRenewalDeclaration(runId: string): RenewalDeclaration | null {
    const state = this.#states.get(runId);
    return state ? this.#owedDeclaration(state) : null;
  }
  /**
   * Record that the claimed renewal at this origin was handed to the transport, so its declaration
   * may have reached the control plane. From then on only a superseding generation drops it.
   */
  renewalDispatched(
    runId: string,
    { expectedLeaseId, expectedGeneration }: Omit<RenewalFailedOptions, "now" | "sent">,
  ): boolean {
    const state = this.#states.get(runId);
    if (!state || this.#originFenceRejects(state, expectedLeaseId, expectedGeneration))
      return false;
    const owed = this.#owedDeclaration(state);
    if (owed === null) return false;
    this.#markDispatched(state, owed);
    return true;
  }
  /**
   * Claim one out-of-cycle renewal that re-declares a call's full chain, after that call's
   * per-call check allowed it. Applies the gates renewalDue applies to an ordinary renewal (a live
   * lease with a positive grant, no renewal in flight, past any backoff, not a final grant), and
   * never claims for a chain that is already covered or names a refused model. While a retry of
   * another declaration is owed at this lease and generation, the call claims that retry instead,
   * unchanged: its own chain never rides on it and stays on per-call checks, and the next
   * undeclared allowed call widens for that chain once the retry resolves.
   */
  claimWideningRequest(runId: string, options: WideningOptions): WideningClaim | null {
    const { now, model, fallbackModels } = options;
    const state = this.#states.get(runId);
    if (
      !state?.hasLease ||
      state.runIneligible ||
      state.renewalInFlight ||
      state.finalGrant ||
      state.grantedTokens <= 0 ||
      now >= state.leaseDeadline ||
      now < state.nextAttemptAt ||
      state.refuses(model, fallbackModels)
    )
      return null;
    const addedModels = [...new Set([model, ...fallbackModels])].filter(
      (item) => !state.declaredModels.has(item),
    );
    if (addedModels.length === 0) return null;
    return this.claimRenewal(runId, options);
  }
  buildSurrenderRequest(runId: string): LeaseSurrenderRequest | null {
    const state = this.#states.get(runId);
    if (!state || state.leaseId === null) return null;
    return {
      lease_id: state.leaseId,
      holder_id: this.holderId,
      generation: state.generation,
      spent_tokens: state.spentTokensSinceReport,
    };
  }
  renewalSent(runId: string): void {
    const state = this.#states.get(runId);
    if (state) state.renewalInFlight = true;
  }
  renewalFailed(
    runId: string,
    { now, expectedLeaseId, expectedGeneration, sent = true }: RenewalFailedOptions,
  ): boolean {
    const state = this.#states.get(runId);
    if (!state || this.#originFenceRejects(state, expectedLeaseId, expectedGeneration))
      return false;
    const owed = this.#owedDeclaration(state);
    if (owed !== null) {
      // Only a declaration no attempt may have delivered is dropped by a skipped attempt.
      if (sent) this.#markDispatched(state, owed);
      else if (!owed.dispatched) state.renewalDeclaration = null;
    }
    state.renewalInFlight = false;
    state.pendingReport = null;
    state.consecutiveFailures++;
    state.nextAttemptAt = now + this.#uniform(0, backoffCeiling(state.consecutiveFailures));
    return true;
  }

  #admitLive(
    state: LeaseState,
    callId: string,
    reserve: number,
    now: number,
    breakerOpen: boolean,
  ): LeaseAdmission {
    if (state.grantedRemainingTokens >= reserve) {
      state.grantedRemainingTokens -= reserve;
      this.#reserve(state, callId, reserve, now, "granted");
      return this.#admission(LeaseDecision.AdmitLocal, {
        leaseId: state.leaseId,
        reservedTokens: reserve,
        renewalDue: this.renewalDue(state, now),
      });
    }
    if (!breakerOpen)
      return this.#admission(LeaseDecision.LegacyCheck, {
        leaseId: state.leaseId,
        renewalDue: this.renewalDue(state, now),
        reason: "granted_exhausted_plane_up",
      });
    if (state.shareRemainingTokens >= reserve) {
      state.shareRemainingTokens -= reserve;
      this.#reserve(state, callId, reserve, now, "share");
      return this.#admission(LeaseDecision.AdmitOutageMetered, {
        leaseId: state.leaseId,
        reservedTokens: reserve,
        warning:
          "Solwyn unreachable; lease grant exhausted — drawing down this holder's headroom share",
        reason: "share_drawdown",
      });
    }
    if (state.postureMode === "hard_deny")
      return this.#admission(LeaseDecision.Deny, {
        leaseId: state.leaseId,
        mode: state.postureMode,
        warning: "Budget lease exhausted and Solwyn unreachable; hard_deny mode denies the call",
        reason: "lease_share_exhausted",
      });
    state.shareRemainingTokens -= reserve;
    this.#reserve(state, callId, reserve, now, "share");
    return this.#admission(LeaseDecision.AdmitOutageMetered, {
      leaseId: state.leaseId,
      reservedTokens: reserve,
      mode: state.postureMode,
      warning:
        "Budget lease exhausted and Solwyn unreachable; alert_only mode continues past the share",
      reason: "lease_share_exhausted",
    });
  }
  #admitExpired(
    state: LeaseState,
    callId: string,
    reserve: number,
    now: number,
    breakerOpen: boolean,
  ): LeaseAdmission {
    if (!breakerOpen) {
      this.#dropLease(state);
      return this.#admission(LeaseDecision.NeedGrant, { reason: "lease_expired" });
    }
    if (state.onUnreachable === "fail_open") {
      state.uncountedCalls++;
      state.uncountedTokens += reserve;
      return this.#admission(LeaseDecision.AdmitUncounted, {
        warning:
          "Budget lease expired and Solwyn unreachable; proceeding UNCOUNTED in fail-open mode",
        reason: "expired_fail_open",
      });
    }
    if (state.shareRemainingTokens >= reserve) {
      state.shareRemainingTokens -= reserve;
      this.#reserve(state, callId, reserve, now, "share");
      return this.#admission(LeaseDecision.AdmitOutageMetered, {
        leaseId: state.leaseId,
        reservedTokens: reserve,
        warning:
          "Budget lease expired and Solwyn unreachable; metering locally against the last known headroom share",
        reason: "expired_local_enforce",
      });
    }
    if (state.postureMode === "hard_deny")
      return this.#admission(LeaseDecision.Deny, {
        leaseId: state.leaseId,
        mode: state.postureMode,
        warning:
          "Budget lease expired, Solwyn unreachable and the last known headroom share is exhausted; hard_deny mode denies the call",
        reason: "local_enforce_bound_exceeded",
      });
    state.shareRemainingTokens -= reserve;
    this.#reserve(state, callId, reserve, now, "share");
    return this.#admission(LeaseDecision.AdmitOutageMetered, {
      leaseId: state.leaseId,
      reservedTokens: reserve,
      mode: state.postureMode,
      warning:
        "Budget lease expired, Solwyn unreachable and the last known headroom share is exhausted; alert_only mode continues",
      reason: "local_enforce_bound_exceeded",
    });
  }
  #admission(
    decision: LeaseDecision,
    fields: Partial<Omit<LeaseAdmission, "decision" | "admitted">> = {},
  ): LeaseAdmission {
    return Object.freeze({
      decision,
      leaseId: null,
      reservedTokens: 0,
      warning: null,
      renewalDue: false,
      mode: null,
      reason: null,
      claimToken: null,
      ...fields,
      admitted:
        decision === LeaseDecision.AdmitLocal ||
        decision === LeaseDecision.AdmitOutageMetered ||
        decision === LeaseDecision.AdmitUncounted,
    });
  }
  #state(runId: string): LeaseState {
    const existing = this.#states.get(runId);
    if (existing) return existing;
    const state = new LeaseState(runId);
    this.#states.set(runId, state);
    return state;
  }
  #originFenceRejects(
    state: LeaseState | undefined,
    expectedLeaseId: string | null | undefined,
    expectedGeneration: number | null | undefined,
  ): boolean {
    const hasLeaseId = expectedLeaseId !== null && expectedLeaseId !== undefined;
    const hasGeneration = expectedGeneration !== null && expectedGeneration !== undefined;
    if (!hasLeaseId && !hasGeneration) return false;
    return (
      !hasLeaseId ||
      !hasGeneration ||
      !state ||
      state.leaseId !== expectedLeaseId ||
      state.generation !== expectedGeneration
    );
  }
  #owedDeclaration(state: LeaseState): RenewalDeclaration | null {
    const declaration = state.renewalDeclaration;
    return declaration !== null &&
      declaration.leaseId === state.leaseId &&
      declaration.generation === state.generation
      ? declaration
      : null;
  }
  #newDeclaration(state: LeaseState, leaseId: string, options: RenewalOptions): RenewalDeclaration {
    const model = options.model ?? null;
    const fallbackModels = Object.freeze([...(options.fallbackModels ?? [])]);
    const chain = model === null ? fallbackModels : [model, ...fallbackModels];
    return Object.freeze({
      leaseId,
      generation: state.generation,
      model,
      provider: options.provider ?? null,
      fallbackProviders: Object.freeze([...(options.fallbackProviders ?? [])]),
      fallbackModels,
      addedModels: Object.freeze(
        [...new Set(chain)].filter((item) => !state.declaredModels.has(item)),
      ),
      dispatched: false,
    });
  }
  #markDispatched(state: LeaseState, declaration: RenewalDeclaration): void {
    if (declaration.dispatched) return;
    state.renewalDeclaration = Object.freeze({ ...declaration, dispatched: true });
  }
  #outputBound(value: number | undefined): number {
    return positiveOutputBound(value) ?? this.outputBoundDefault;
  }
  #reserve(state: LeaseState, callId: string, tokens: number, now: number, pool: Pool): void {
    if (state.leaseId === null) throw new SolwynError("cannot reserve against a run with no lease");
    if (this.#callIndex.has(callId) || state.reservations.has(callId))
      throw new SolwynError("claim already owns a reservation");
    const claim = this.#callClaims.get(callId);
    if (!claim || claim.runId !== state.runId)
      throw new SolwynError("reservation call_id was not claimed by this run");
    state.reservations.set(callId, {
      leaseId: state.leaseId,
      leaseIncarnation: state.leaseIncarnation,
      tokens,
      createdAt: now,
      pool,
      claimToken: claim.token,
    });
    this.#callIndex.set(callId, state.runId);
  }
  #claimCall(runId: string, callId: string, now: number, claimToken: number | null): number {
    const existing = this.#callClaims.get(callId);
    if (claimToken !== null) {
      if (!existing || existing.runId !== runId || existing.token !== claimToken)
        throw new SolwynError("call_id re-entry does not own the original claim");
      if (this.#callIndex.has(callId)) throw new SolwynError("claim already owns a reservation");
      return existing.token;
    }
    if (existing) throw new SolwynError("call_id has already been used by this SDK client");
    const token = ++this.#nextClaimToken;
    this.#callClaims.set(callId, { runId, createdAt: now, token });
    this.#pushExpiry({ at: now + RESERVATION_MAX_AGE_S, token, callId });
    return token;
  }
  #takeReservation(
    callId: string,
    claimToken: number | null,
  ): { state: LeaseState; reservation: Reservation } | null {
    if (claimToken === null) return null;
    const runId = this.#callIndex.get(callId);
    const state = runId ? this.#states.get(runId) : undefined;
    const reservation = state?.reservations.get(callId);
    if (!state || !reservation || reservation.claimToken !== claimToken) return null;
    this.#callIndex.delete(callId);
    state.reservations.delete(callId);
    return { state, reservation };
  }
  #dropLease(state: LeaseState): void {
    this.#rotateLeaseIncarnation(state);
    state.leaseId = null;
    state.generation = 0;
    state.grantedTokens = 0;
    state.grantedRemainingTokens = 0;
    state.shareRemainingTokens = 0;
    state.refreshDeadline = 0;
    state.leaseDeadline = 0;
    state.finalGrant = false;
    state.renewalInFlight = false;
    state.renewalDeclaration = null;
    state.pendingReport = null;
  }
  /**
   * Settle the refused renewal's report (the control plane applied its tallies and its spend is
   * advisory), then build the surrender for the held generation and clear its spend now: a
   * surrender is never retried, and a later outcome must not touch a successor lease's spend.
   */
  #releaseRefusedLease(state: LeaseState): LeaseSurrenderRequest | null {
    if (state.leaseId === null) return null;
    this.#settlePendingReport(state);
    const request = Object.freeze({
      lease_id: state.leaseId,
      holder_id: this.holderId,
      generation: state.generation,
      spent_tokens: state.spentTokensSinceReport,
    });
    state.spentTokensSinceReport = Math.max(0, state.spentTokensSinceReport - request.spent_tokens);
    return request;
  }
  #storeSnapshot(state: LeaseState, response: LeaseGrantResponse): void {
    state.snapshot = Object.freeze({
      projectId: response.project_id,
      mode: response.mode,
      budgetLimit: response.budget_limit,
      currentUsage: response.current_usage,
      remainingBudget: response.remaining_budget,
    });
  }
  #carriedGrantedDrawdown(state: LeaseState): number {
    const settled = state.pendingReport
      ? Math.max(0, state.spentTokensSinceReport - state.pendingReport.spentTokens)
      : 0;
    let reserved = 0;
    for (const reservation of state.reservations.values())
      if (
        reservation.leaseId === state.leaseId &&
        reservation.leaseIncarnation === state.leaseIncarnation &&
        reservation.pool === "granted"
      )
        reserved += reservation.tokens;
    return settled + reserved;
  }
  #carriedShareDrawdown(state: LeaseState): number {
    let reserved = 0;
    for (const reservation of state.reservations.values())
      if (
        reservation.leaseId === state.leaseId &&
        reservation.leaseIncarnation === state.leaseIncarnation &&
        reservation.pool === "share"
      )
        reserved += reservation.tokens;
    return reserved;
  }
  #settlePendingReport(state: LeaseState): void {
    const pending = state.pendingReport;
    if (!pending) return;
    state.spentTokensSinceReport = Math.max(0, state.spentTokensSinceReport - pending.spentTokens);
    state.uncountedCalls = Math.max(0, state.uncountedCalls - pending.uncountedCalls);
    state.uncountedTokens = Math.max(0, state.uncountedTokens - pending.uncountedTokens);
    state.pendingReport = null;
  }
  #uniform(min: number, max: number): number {
    if (typeof this.#rng === "function") return min + (max - min) * this.#rng();
    return this.#rng ? this.#rng.uniform(min, max) : min + (max - min) * Math.random();
  }
  #rotateLeaseIncarnation(state: LeaseState): void {
    state.leaseIncarnation = ++this.#nextLeaseIncarnation;
  }
  #pushExpiry(item: Expiry): void {
    const heap = this.#callExpiries;
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentItem = heap[parent];
      if (!parentItem || parentItem.at <= item.at) break;
      heap[index] = parentItem;
      index = parent;
    }
    heap[index] = item;
  }
  #popExpiry(): Expiry | null {
    const heap = this.#callExpiries;
    const first = heap[0];
    const last = heap.pop();
    if (!first) return null;
    if (!last || heap.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      const right = child + 1;
      if ((heap[right]?.at ?? Infinity) < (heap[child]?.at ?? Infinity)) child = right;
      const childItem = heap[child];
      if (!childItem || last.at <= childItem.at) break;
      heap[index] = childItem;
      index = child;
    }
    heap[index] = last;
    return first;
  }
}

export function backoffCeiling(consecutiveFailures: number): number {
  return consecutiveFailures <= 0
    ? 0
    : Math.min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** (consecutiveFailures - 1));
}
