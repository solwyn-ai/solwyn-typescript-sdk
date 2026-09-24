/**
 * The pre-flight budget enforcer.
 *
 * Before every LLM call the SDK asks the Solwyn Cloud API "is this call within
 * budget?" (`POST /api/v1/budgets/check`) and gets back an allow/deny decision plus
 * a reservation id; after the call completes it reports actual token usage to settle
 * that reservation (`POST /api/v1/budgets/confirm`). When the cloud API is
 * unreachable the enforcer uses a fixed-rate, best-effort in-process spend estimate
 * according to the configured outage posture.
 *
 * Solwyn Cloud remains authoritative for actual provider/model pricing. This module's
 * fixed-rate dollar estimate is used only for outage decisions/local accumulation and
 * the `estimatedCost` diagnostic attached to a {@link BudgetExceededError}; it is not a
 * provider/model price.
 *
 * Budget checks use the shared {@link Transport}; reservation settlement is built without
 * I/O by `buildConfirmRequest` and queued through the reporter on every success path.
 *
 * Privacy: this module only ever sees token *counts*, model/provider name strings, and
 * dollar amounts — never prompt/response content. It is a non-privileged module and
 * must stay that way (do not add content fields to the wire shapes it builds).
 *
 * ## Hard-deny retention
 * Project hard denials are remembered globally; `agent_run` hard denials are remembered
 * only for their run. During an outage the global denial is checked first, then the
 * matching run denial, before fail-open / local enforcement. A scoped denial therefore
 * cannot authorize an unrelated run, while an unreachable API can never reopen the scope
 * that was actually denied. Later cloud verdicts clear stickies according to their scope.
 *
 * ## Concurrency
 * In a single JavaScript event loop, each synchronous read-modify-write block below runs
 * to completion without preemption as long as it contains no `await` in the middle of the
 * critical section. Every such block (cache read+write, local-cost
 * read+accumulate+write, hard-deny read+clear/set) is kept `await`-free and annotated —
 * do not split one across an `await` or you reintroduce the race the lock prevented.
 */

import type { CircuitBreaker, CircuitBreakerAdmission } from "./circuit-breaker";
import { safeExceptionType as exceptionName } from "./error-diagnostics";
import {
  BudgetExceededError,
  ConfigurationError,
  RunStoppedError,
  type RunStoppedSource,
  resolveBudgetPeriod,
} from "./errors";
import {
  GrantOutcome,
  INELIGIBLE_RETRY_AFTER_S,
  isInstallableLeaseGrantResponse,
  LEASE_REFUSAL_LATCH_S,
  type LeaseAdmission,
  LeaseDecision,
  LeaseLedger,
  type LeaseSnapshot,
  type LeaseState,
} from "./lease";
import type { Logger } from "./logging";
import { bestEffortLogger, escapeControlChars, noopLogger } from "./logging";
import { positiveOutputBound } from "./output-bound";
import { handleReadOnlyKeyError, isReadOnlyKeyError } from "./read-only-key";
import {
  RELEASE_DROP_REASONS,
  type ReleaseAttempt,
  ReleaseDispatcher,
  type ReleaseDropReason,
  type ReleaseOutcome,
} from "./release-dispatcher";
import type { CurrentRun } from "./run-context";
import {
  clearServerTerminationBeforeRequest,
  markTerminatedWithObservation,
  outageTermination,
  runObservedAt,
} from "./run-control";
import { type TokenDetails, totalTokens } from "./token-details";
import {
  BUDGET_CHECK_PATH,
  type FetchLike,
  LEASE_GRANT_PATH,
  LEASE_RENEW_PATH,
  LEASE_SURRENDER_PATH,
  requireFetchLike,
  Transport,
  TransportHttpError,
  TransportTimeoutError,
  transportErrorLabel,
} from "./transport";
import type {
  BudgetCheckRequest,
  BudgetCheckResponse,
  BudgetConfirmRequest,
  BudgetMode,
  DenySource,
  LeaseGrantRequest,
  LeaseGrantResponse,
  LeaseRenewRequest,
  LeaseSurrenderRequest,
  MediaUsage,
  Modality,
  ProviderName,
  RunControlDirective,
  ServiceTier,
} from "./types";
import { SERVICE_TIERS } from "./types";
import {
  BudgetCheckRequestObjectSchema,
  BudgetCheckRequestSchema,
  BudgetCheckResponseSchema,
  BudgetConfirmRequestObjectSchema,
  BudgetConfirmRequestSchema,
  LeaseGrantRequestSchema,
  LeaseGrantResponseSchema,
  LeaseRenewRequestSchema,
  LeaseSurrenderRequestSchema,
  serializeLeaseGrantRequest,
  serializeLeaseRenewRequest,
  serializeLeaseSurrenderRequest,
} from "./validation";

// ---------------------------------------------------------------------------
// Constants (budget.md — exact values).
// ---------------------------------------------------------------------------

/**
 * USD per estimated input token. Used by the outage decision path and to populate the
 * `estimatedCost` diagnostic on budget-denial errors. It is not a real provider/model
 * price; authoritative pricing remains server-side.
 */
export const DEFAULT_COST_PER_TOKEN = 0.00003;

/** Default per-request timeout for the check POST (Python `httpx timeout=5.0`). */
const DEFAULT_CHECK_TIMEOUT_MS = 5000;

/** Maximum distinct server-priced chains retained in the unscoped allow cache. */
const ALLOW_CACHE_MAX_ENTRIES = 16;

/** Maximum run-scoped hard denials retained for outage replay. */
const MAX_STICKY_RUN_DENIALS = 128;

/** Maximum run-scoped uncounted diagnostic episodes retained by one enforcer. */
const MAX_UNCOUNTED_EPISODES = 128;

/**
 * Minimum interval between continuing diagnostics for one uncounted episode, and between
 * aggregate release diagnostics (dropped surrenders, discarded uncounted tallies).
 */
const UNCOUNTED_WARN_INTERVAL_MS = 30_000;

/** Renewal I/O is always detached from admission and independently bounded. */
const RENEWAL_TIMEOUT_MS = 5_000;

/** One enforcer may hold at most four live renewal operations. */
const MAX_RENEWAL_OPERATIONS = 4;

/** Explicit close shares this deadline across renewal joins and surrender fan-out. */
const DEFAULT_SURRENDER_TIMEOUT_MS = 1_000;

/** A surrender that times out outside close() is retried once, immediately. */
const SURRENDER_ATTEMPTS = 2;

/** Ordinary surrender deadline from enqueue: the per-attempt bound times the attempts. */
const RELEASE_BUDGET_MS = DEFAULT_SURRENDER_TIMEOUT_MS * SURRENDER_ATTEMPTS;

/** Private edge-safe handshake installed only by the dedicated `./node` entry. */
const NODE_LEASE_REGISTRATION = Symbol.for("@solwyn/sdk/node-lease-registration");

/**
 * The contractual set of recognized `service_tier` values, derived from the single
 * {@link SERVICE_TIERS} union (never hand-copied — mirrors the Python comment intent).
 * An echoed tier outside this set is downgraded to absent before hitting the wire so a
 * novel value can never 422 the strict confirm schema and strand the reservation.
 */
const SERVICE_TIER_VALUES: ReadonlySet<string> = new Set(SERVICE_TIERS);

// ---------------------------------------------------------------------------
// BudgetCheckResult — the local-only result value object.
// ---------------------------------------------------------------------------

/**
 * The decision the enforcer hands back to the client for one `checkBudget` call.
 *
 * This is a LOCAL-ONLY value object — it is never serialized to the wire (contrast
 * with `BudgetCheckRequest`/`BudgetCheckResponse`/`BudgetConfirmRequest`). It is a
 * proper typed structure, never a loose object literal (budget.md behavior 21).
 */
export interface BudgetCheckResult {
  /** Whether the call may proceed (an alert-only cloud deny still allows). */
  allowed: boolean;
  /** Remaining budget in the response's units (0 on the outage/fallback paths). */
  remainingBudget: number;
  /** Project id from the cloud response, or `null` when unknown (outage). */
  projectId: string | null;
  /**
   * Reservation id for this call. ALWAYS `null` on a cache hit — each call must get
   * its own reservation, never reuse one across calls (budget.md behavior 2).
   */
  reservationId: string | null;
  /** Lease settlement authority, when this call drew from an installed lease. */
  leaseId?: string | null;
  /** Local capability required to settle or release the lease admission. */
  leaseClaimToken?: number | null;
  /** The mode that produced this decision. */
  mode: BudgetMode;
  /** Human-readable warning (deny / fail-open / local-enforcement); `null` on a clean allow. */
  warning: string | null;
  /** Budget limit verbatim from the response (0 when unknown). */
  budgetLimit: number;
  /** Current usage verbatim from the response (0 when unknown). */
  currentUsage: number;
  /**
   * Server-provided relative price signal per provider name. Cache hits replay their
   * entry's map, empty map, or `null`; the SDK never computes one (D7 / invariant 2).
   */
  priceHints: Record<string, number> | null;
  /** Whether this plan may use constructor-requested failover tuning; null off-cloud/cache. */
  failoverTuningAllowed: boolean | null;
  /**
   * The budget period the cloud denied on (`denied_by_period`), when this result is a
   * hard deny (fresh or sticky). `null` on allows and on the local-enforcement / alert
   * paths (no server-supplied period). Threaded into the typed denial builder, which preserves
   * {@link BudgetExceededError.budgetPeriod} for every ordinary denial (D2).
   */
  deniedByPeriod: string | null;
  /** Structural attribution for a denied call; optional for pre-R2 consumer literals. */
  denySource?: DenySource | null;
  /** Stable machine-readable denial reason; optional for pre-R2 consumer literals. */
  denyReason?: string | null;
}

/** Internal decision shape after lease authority has been normalized at a trust boundary. */
type MaterializedBudgetCheckResult = Omit<
  BudgetCheckResult,
  "leaseId" | "leaseClaimToken" | "denySource" | "denyReason"
> & {
  leaseId: string | null;
  leaseClaimToken: number | null;
  denySource: DenySource | null;
  denyReason: string | null;
};

/** Required fields plus optional overrides for {@link budgetCheckResult}. */
export type BudgetCheckResultInit = { allowed: boolean; remainingBudget: number } & Partial<
  Omit<BudgetCheckResult, "allowed" | "remainingBudget">
>;

/** Copy a cloud-provided hint map so public results never alias cached response state. */
function copyPriceHints(
  priceHints: Record<string, number> | null | undefined,
): Record<string, number> | null {
  return priceHints === null || priceHints === undefined ? null : { ...priceHints };
}

/** Diagnostic only: the SDK never branches on the reason. */
function ineligibleReason(response: LeaseGrantResponse): string {
  const reason = response.ineligible_reason;
  return typeof reason === "string" ? escapeControlChars(reason) : "none";
}

/** Attribute a replayed directive only when it belongs to the run being checked. */
function stickyDenyReason(
  response: BudgetCheckResponse,
  activeAgentRunId: string | undefined,
): string | null {
  const directive = response.run_control;
  return directive !== null &&
    directive !== undefined &&
    directive.agent_run_id === activeAgentRunId
    ? directive.reason
    : (response.denied_by_period ?? null);
}

/**
 * Construct a {@link BudgetCheckResult} applying the settled defaults for every field
 * not supplied: `projectId`/`reservationId`/`warning`/`priceHints` → `null`, `mode` →
 * `"alert_only"`, `budgetLimit`/`currentUsage` → `0`. (budget.md behavior 21 — the
 * result is a real typed structure with these exact defaults.)
 */
export function budgetCheckResult(init: BudgetCheckResultInit): MaterializedBudgetCheckResult {
  return {
    allowed: init.allowed,
    remainingBudget: init.remainingBudget,
    projectId: init.projectId ?? null,
    reservationId: init.reservationId ?? null,
    leaseId: init.leaseId ?? null,
    leaseClaimToken: init.leaseClaimToken ?? null,
    mode: init.mode ?? "alert_only",
    warning: init.warning ?? null,
    budgetLimit: init.budgetLimit ?? 0,
    currentUsage: init.currentUsage ?? 0,
    priceHints: copyPriceHints(init.priceHints),
    failoverTuningAllowed: init.failoverTuningAllowed ?? null,
    deniedByPeriod: init.deniedByPeriod ?? null,
    denySource: init.denySource ?? null,
    denyReason: init.denyReason ?? null,
  };
}

// ---------------------------------------------------------------------------
// BudgetExceededError construction (D2 lands here).
// ---------------------------------------------------------------------------

/**
 * Build the {@link BudgetExceededError} the client throws when a hard-deny result is
 * returned. `budgetLimit`/`currentUsage` are copied VERBATIM from the response's own
 * `budget_limit`/`current_usage` (never from `remaining_budget`, never hardcoded to 0
 * — guards the historical "Bug 1.1" regression). `budgetPeriod` is resolved from
 * `denied_by_period` via {@link resolveBudgetPeriod} (D2 — fixes Python's hardcoded
 * `"unknown"`). `estimatedCost` uses the fallback per-token estimate, matching Python.
 */
export function buildBudgetExceededError(
  response: BudgetCheckResponse,
  estimatedInputTokens: number,
): BudgetExceededError {
  return new BudgetExceededError({
    projectId: response.project_id ?? null,
    budgetLimit: response.budget_limit,
    currentUsage: response.current_usage,
    estimatedCost: DEFAULT_COST_PER_TOKEN * estimatedInputTokens,
    budgetPeriod: resolveBudgetPeriod(response.denied_by_period),
    mode: response.mode,
  });
}

/**
 * Build the {@link BudgetExceededError} the client throws off a deny {@link
 * BudgetCheckResult}. This preserves the ordinary branch of the enforcer-owned typed denial
 * builder. `checkBudget` never throws (it returns a result), so the client turns an
 * `allowed: false` result into an error. Fields are copied VERBATIM from the result's own `budgetLimit`/
 * `currentUsage`/`mode`/`projectId` (which the enforcer copied verbatim from the deny
 * response — Bug 1.1 guard), and `budgetPeriod` is resolved from the result's
 * `deniedByPeriod` via {@link resolveBudgetPeriod} (D2). Handles ALL deny shapes
 * uniformly — a live cloud hard-deny, a sticky-outage deny, AND a fail-closed
 * local-enforcement deny (which carries no server period, so resolves to `"unknown"`).
 */
export function buildBudgetExceededErrorFromResult(
  result: BudgetCheckResult,
  estimatedInputTokens: number,
): BudgetExceededError {
  return new BudgetExceededError({
    projectId: result.projectId,
    budgetLimit: result.budgetLimit,
    currentUsage: result.currentUsage,
    estimatedCost: DEFAULT_COST_PER_TOKEN * estimatedInputTokens,
    budgetPeriod: resolveBudgetPeriod(result.deniedByPeriod),
    mode: result.mode,
  });
}

// ---------------------------------------------------------------------------
// Method option shapes.
// ---------------------------------------------------------------------------

/** Options for {@link BudgetEnforcer.checkBudget}. `provider` is required (invariant 7). */
export interface CheckBudgetOptions {
  estimatedInputTokens: number;
  model: string;
  provider: ProviderName;
  /** Billing modality; omitted here to preserve the legacy builder shape for text calls. */
  modality?: Modality;
  /** Preflight non-token usage basis; outer null is omitted. */
  estimatedMedia?: MediaUsage | null;
  /** Failover provider chain (default `[]`); the caller's array is never mutated. */
  fallbackProviders?: ProviderName[];
  /** Failover model chain (default `[]`); the caller's array is never mutated. */
  fallbackModels?: string[];
  /** Per-call timeout override in SECONDS (Python parity); falls back to the 5s default. */
  timeout?: number;
  /** Active agent-run attribution. Scoped checks bypass the global allow cache. */
  agentRunId?: string;
  /** Internal ownership evidence; omitted by identity-only/direct callers. */
  runLifetime?: object;
  /** Captured spend-tag attribution; present (including `{}`) forces a live check. */
  tags?: Record<string, string> | null;
  /** Reconciliation identity used by lease admission; minted when omitted. */
  callId?: string;
  /** Positive structural output cap reserved in addition to the input estimate. */
  estimatedOutputBound?: number;
}

/** Validate then defensively copy raw tag attribution before any authority decision. */
function copyCheckTags(
  tags: CheckBudgetOptions["tags"],
): Record<string, string> | null | undefined {
  const parsed = BudgetCheckRequestObjectSchema.shape.tags.safeParse(tags);
  if (!parsed.success) {
    throw new ConfigurationError("invalid tags", { field: "tags" });
  }
  return parsed.data === null || parsed.data === undefined ? parsed.data : { ...parsed.data };
}

/** Named, funding-aware input for the sans-I/O confirm builder. */
export interface BuildConfirmRequestOptions {
  reservationId?: string | null;
  leaseId?: string | null;
  leaseClaimToken?: number | null;
  floorAtReservation?: boolean;
  model: string;
  tokenDetails: TokenDetails;
  provider: ProviderName;
  isProviderFallback?: boolean;
  /** Reconciliation id — REQUIRED. A falsy value throws before any enqueue. */
  callId: string;
  /** Billing modality; omitted here to preserve the legacy builder shape for text calls. */
  modality?: Modality;
  /** Settled non-token usage basis; outer null is omitted. */
  mediaUsage?: MediaUsage | null;
  providerRegion?: string | null;
  /** An unrecognized tier is downgraded to absent (logged at DEBUG). */
  serviceTier?: string | null;
}

/** Construction options for {@link BudgetEnforcer}. */
export interface BudgetEnforcerOptions {
  apiUrl: string;
  apiKey: string;
  budgetMode?: BudgetMode;
  failOpen?: boolean;
  /** Cache TTL in SECONDS for allow decisions (default 5). */
  cacheTtl?: number;
  /** Injectable `fetch` (tests). */
  fetch?: FetchLike;
  /** Injectable logger (default no-op). */
  logger?: Logger;
  /** Injectable epoch-ms clock (tests) — drives cache TTL AND the UTC local-cost day. */
  now?: () => number;
  /** Distinct injectable monotonic-ms clock for request/sticky ordering. */
  monotonicNow?: () => number;
  /** Shared check/confirm control-plane breaker; null/absent disables admission. */
  controlPlaneBreaker?: CircuitBreaker | null;
  /** Stable SDK-holder identity for lease ownership; minted when absent. */
  holderId?: string;
  /** Low-level lease activation seam; defaults on. */
  leaseEnabled?: boolean;
  /** Default output reservation bound when a call has no positive structural cap. */
  leaseOutputBoundDefault?: number;
  /** Future stopped-run gate. A non-null value bypasses lease authority. */
  terminationFor?: (runId: string) => unknown | null;
}

interface CapturedCheck {
  readonly agentRunId: string | undefined;
  /** A non-null tag statement remains tagged even when it is an empty record. */
  readonly tagged: boolean;
  readonly requestedCallId: string | undefined;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputBound: number;
  readonly model: string;
  readonly provider: ProviderName;
  readonly fallbackProviders: readonly ProviderName[];
  readonly fallbackModels: readonly string[];
  readonly modality: Modality;
  readonly hasEstimatedMedia: boolean;
  readonly timeoutMs: number;
}

type InitialGrantResult =
  | { readonly kind: "admission"; readonly admission: LeaseAdmission }
  | { readonly kind: "denied"; readonly result: MaterializedBudgetCheckResult }
  | { readonly kind: "legacy" }
  | { readonly kind: "outage" };

interface RenewalOperation {
  readonly runId: string;
  readonly originLeaseId: string;
  readonly originGeneration: number;
  readonly closeEpoch: number;
  readonly declaredModels: readonly string[];
  /** Models a widening renewal adds to the lease; empty for an ordinary renewal. */
  readonly wideningModels: readonly string[];
  readonly wire: Readonly<Record<string, unknown>>;
}

/** Bounded aggregate of uncounted fail-open tallies discarded with finished runs. */
interface UncountedAggregate {
  runs: number;
  calls: number;
  tokens: number;
}

function saturatingAdd(total: number, value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, total + Math.max(0, value));
}

interface AuthorityDispatch {
  readonly sequence: bigint;
  readonly runDispatchedAt: number;
}

interface LeaseAuthorityObservation {
  readonly dispatch: AuthorityDispatch;
  readonly observedSequence: bigint;
  readonly runObservedAt: number;
}

interface LeaseGlobalAuthorityStamp {
  readonly kind: "lease";
  readonly observation: LeaseAuthorityObservation;
  readonly dispatchSequenceWatermark: bigint;
}

type GlobalAuthorityStamp =
  | { readonly kind: "ordered"; readonly dispatch: AuthorityDispatch }
  | LeaseGlobalAuthorityStamp
  | { readonly kind: "fallback"; readonly dispatch: AuthorityDispatch };

type GlobalAuthorityOrder =
  | GlobalAuthorityStamp
  | { readonly kind: "suppressed"; readonly dispatch: AuthorityDispatch };

interface TerminationResolution {
  readonly reason: string;
  readonly source: RunStoppedSource;
}

interface TerminationRead {
  readonly isPresent: boolean;
  readonly resolution: TerminationResolution | null;
}

/**
 * Read only own data properties from the existing run-termination seam. This intentionally never
 * invokes getters or reads error/body/message values: malformed or hostile state simply leaves the
 * caller with the server-provided stopped-run fallback.
 */
function normalizeTerminationResolution(value: unknown): TerminationResolution | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  try {
    const reason = Reflect.getOwnPropertyDescriptor(value, "reason");
    const source = Reflect.getOwnPropertyDescriptor(value, "source");
    if (
      reason === undefined ||
      source === undefined ||
      !("value" in reason) ||
      !("value" in source) ||
      typeof reason.value !== "string" ||
      reason.value.length === 0 ||
      reason.value.length > 64 ||
      (source.value !== "server" && source.value !== "local_velocity")
    ) {
      return null;
    }
    return { reason: reason.value, source: source.value };
  } catch {
    return null;
  }
}

/** Fixed 2-decimal dollar formatting, keeping warning text byte-comparable (Python `%.2f`). */
function money(value: number): string {
  return value.toFixed(2);
}

// ---------------------------------------------------------------------------
// BudgetEnforcer.
// ---------------------------------------------------------------------------

export class BudgetEnforcer {
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly controlPlaneBreaker: CircuitBreaker | null;
  private readonly leaseLedger: LeaseLedger;
  private readonly terminationFor: (runId: string) => unknown | null;
  private readonly observedRunOwners = new WeakSet<object>();
  private readonly runOwnerCounts = new Map<string, number>();
  private readonly orphanedRuns = new Set<string>();
  private readonly unmanagedStates = new WeakSet<LeaseState>();
  private readonly pendingUnmanagedRuns = new Map<string, number>();
  /** Runs whose retirement surrender is queued or active; they take per-call checks. */
  private readonly retiringRuns = new Map<string, object>();
  /**
   * Retirable runs waiting for a free release worker, FIFO. Retirement never overflows the
   * dispatcher queue; each entry is re-evaluated when a worker takes it.
   */
  private readonly retirementBacklog = new Set<string>();
  private readonly runOwnerFinalizer = new FinalizationRegistry<string>((runId) => {
    this.onRunOwnerCollected(runId);
  });

  readonly budgetMode: BudgetMode;
  readonly failOpen: boolean;
  readonly cacheTtl: number;

  /**
   * Observe identity ownership without retaining its frame/handle. Only an unreachable
   * token proves a run cannot reactivate; callback completion alone does not.
   * Identity-only custom readers have no such proof and retain existing semantics.
   */
  observeRun(run: CurrentRun | undefined): void {
    if (run === undefined || this.closed) return;
    const owner = run.lifetime;
    if (owner === undefined) {
      this.preserveUnmanagedRun(run.agentRunId);
      return;
    }
    if (this.observedRunOwners.has(owner)) return;
    this.observedRunOwners.add(owner);
    this.runOwnerCounts.set(run.agentRunId, (this.runOwnerCounts.get(run.agentRunId) ?? 0) + 1);
    this.runOwnerFinalizer.register(owner, run.agentRunId);
  }

  private preserveUnmanagedRun(runId: string): void {
    const state = this.leaseLedger.stateFor(runId);
    if (state !== null) this.unmanagedStates.add(state);
    this.orphanedRuns.delete(runId);
  }

  // --- Mutable state (see the concurrency note at the top of this file). ---

  /** Chain-keyed, insertion-ordered LRU of unscoped allow responses. */
  private readonly allowCache = new Map<
    string,
    { response: BudgetCheckResponse; expiresAt: number }
  >();
  /** Last-known cloud budget limit — `null` until the FIRST successful cloud contact. */
  private lastKnownBudgetLimit: number | null = null;
  /** Last-known cloud current usage — `null` until the FIRST successful cloud contact. */
  private lastKnownCurrentUsage: number | null = null;
  /** Optional denial payload, separate from the authority watermark retained by clears. */
  private lastHardDenyResponse: BudgetCheckResponse | null = null;
  /** Ordering authority; a weak fallback stamp may govern a retained stronger denial payload. */
  private globalAuthorityOrder: GlobalAuthorityStamp | null = null;
  /** Latest completed ordered check authority, retained for lease dispatch fencing. */
  private completedOrderedGlobalAuthoritySequence: bigint | null = null;
  /** Latest accepted weak fallback dispatch, retained to fence older lease global clears. */
  private acceptedFallbackGlobalClearSequence: bigint | null = null;
  /** Collision-free dispatch identities for real check POSTs whose responses have not settled. */
  private readonly pendingOrderedRequests = new Set<bigint>();
  /** Total order for global-authority dispatches and eligible lease-response observations. */
  private authoritySequence = 0n;
  /** Run-cap sticky denials, insertion-ordered for bounded LRU replay. */
  private readonly runHardDenyResponses = new Map<
    string,
    { response: BudgetCheckResponse; observedAt: number }
  >();
  /** Per-UTC-day local spend buckets (fail-open / local-enforcement bookkeeping). */
  private readonly localCosts = new Map<string, number>();
  /** One blocking initial grant owner per run; followers immediately use legacy check. */
  private readonly initialGrantInFlight = new Set<string>();
  /** LRU of active uncounted warning episodes and their most recent emitted warning. */
  private readonly uncountedEpisodes = new Map<string, { lastWarnAt: number }>();
  /** Strong ownership keeps detached renewal promises observed until they settle. */
  private readonly renewalOperations = new Set<Promise<void>>();
  /** Generation-fenced post-snapshot spend captured synchronously at close. */
  private readonly lateRenewalSpend = new Map<string, number>();
  /** Every surrender (retirement, late successor, close) goes through this bounded queue. */
  private readonly releases: ReleaseDispatcher;
  /** Set only while a surrender attempt synchronously starts its request. */
  private rawFetchCapture: { raw: Promise<unknown> | null } | null = null;
  /** Drops not yet reported in an aggregate WARN line. */
  private readonly unreportedDrops = new Map<ReleaseDropReason, number>();
  private lastDropWarnAt: number | null = null;
  private dropWarnScheduled = false;
  /** Uncounted tallies of discarded runs: since the last WARN, and for the client's life. */
  private readonly unreportedUncounted: UncountedAggregate = { runs: 0, calls: 0, tokens: 0 };
  private readonly totalUncounted: UncountedAggregate = { runs: 0, calls: 0, tokens: 0 };
  private lastUncountedWarnAt: number | null = null;
  private uncountedWarnScheduled = false;
  private closeEpoch = 0;
  private closePromise: Promise<void> | null = null;
  /** Between close() and its single summary WARN, drops are reported only by that WARN. */
  private closeDraining = false;
  private closed = false;

  constructor(options: BudgetEnforcerOptions) {
    requireFetchLike(options.fetch);
    // A surrender attempt observes its underlying request so a request that ignores abort
    // keeps its dispatcher slot until it settles. Every other request is passed through; the
    // default fetch honours abort, so it needs no observation.
    const injected = options.fetch;
    const fetch: FetchLike | undefined =
      injected === undefined
        ? undefined
        : (input, init) => {
            const capture = this.rawFetchCapture;
            if (capture === null) return injected(input, init);
            this.rawFetchCapture = null;
            let raw: Promise<Response>;
            try {
              raw = Promise.resolve(injected(input, init));
            } catch (error) {
              raw = Promise.reject(error);
            }
            capture.raw = raw.then(
              () => {},
              () => {},
            );
            return raw;
          };
    // Transport normalizes the URL (strips ALL trailing slashes) and owns auth headers.
    this.transport = new Transport(options.apiUrl, options.apiKey, { fetch });
    this.logger = bestEffortLogger(options.logger ?? noopLogger);
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.releases = new ReleaseDispatcher({
      send: (request, timeoutMs) => this.attemptSurrender(request, timeoutMs),
      now: () => this.monotonicNow(),
      attemptTimeoutMs: DEFAULT_SURRENDER_TIMEOUT_MS,
      maxAttempts: SURRENDER_ATTEMPTS,
      itemBudgetMs: RELEASE_BUDGET_MS,
      onDrop: (reason) => this.noteReleaseDrop(reason),
      onWorkerReady: () => this.feedRetirements(),
    });
    this.controlPlaneBreaker = options.controlPlaneBreaker ?? null;
    this.leaseLedger = new LeaseLedger({
      holderId: options.holderId ?? crypto.randomUUID(),
      enabled: options.leaseEnabled ?? true,
      outputBoundDefault: options.leaseOutputBoundDefault,
    });
    this.terminationFor = options.terminationFor ?? outageTermination;
    this.budgetMode = options.budgetMode ?? "alert_only";
    this.failOpen = options.failOpen ?? true;
    this.cacheTtl = options.cacheTtl ?? 5;

    try {
      const register = Reflect.get(globalThis, NODE_LEASE_REGISTRATION);
      if (typeof register === "function") Reflect.apply(register, undefined, [this]);
    } catch {
      // Exit surrender is best effort; explicit close()/asyncDispose remains the guarantee.
    }
  }

  // -------------------------------------------------------------------------
  // Observability (tests assert on this; harmless read-only surface).
  // -------------------------------------------------------------------------

  /** Local fallback spend accrued for the current UTC day. */
  getLocalCurrentSpend(): number {
    return this.localCosts.get(this.todayKey()) ?? 0;
  }

  /** Last-known cloud budget limit, or `null` before any successful cloud contact. */
  get lastKnownBudget(): number | null {
    return this.lastKnownBudgetLimit;
  }

  /** Last-known cloud current usage, or `null` before any successful cloud contact. */
  get lastKnownUsage(): number | null {
    return this.lastKnownCurrentUsage;
  }

  /** Whether a sticky hard deny is currently remembered. */
  get hasStickyHardDeny(): boolean {
    return this.lastHardDenyResponse !== null || this.runHardDenyResponses.size > 0;
  }

  // -------------------------------------------------------------------------
  // Pure request builders (no I/O).
  // -------------------------------------------------------------------------

  /**
   * Build the outbound check request. Text calls include `fallback_providers` and
   * `fallback_models` as copied arrays (default `[]`; budget.md behavior 14). Non-text/media
   * calls omit both fallback keys because their lifecycle is primary-only. `modality` is
   * included when supplied, and a non-null `estimatedMedia` is emitted as `estimated_media`.
   * No confirm/event-only fields leak into this shape.
   */
  buildCheckRequest(options: CheckBudgetOptions): BudgetCheckRequest {
    const tags = copyCheckTags(options.tags);
    const request: BudgetCheckRequest = {
      estimated_input_tokens: options.estimatedInputTokens,
      model: options.model,
      provider: options.provider,
      failover_directive_version: "1",
      price_hints_version: "1",
      run_directive_version: "1",
    };
    // Non-text calls are primary-only and omit the fallback keys entirely on the wire.
    // Text calls retain the legacy always-present arrays (including explicit `modality:text`).
    if (options.modality === undefined || options.modality === "text") {
      request.fallback_providers = [...(options.fallbackProviders ?? [])];
      request.fallback_models = [...(options.fallbackModels ?? [])];
    }
    if (options.modality !== undefined) {
      request.modality = options.modality;
    }
    if (options.estimatedMedia !== null && options.estimatedMedia !== undefined) {
      request.estimated_media = options.estimatedMedia;
    }
    if (options.agentRunId !== undefined) {
      request.agent_run_id = options.agentRunId;
    }
    if (tags !== null && tags !== undefined) {
      request.tags = tags;
    }
    return request;
  }

  /**
   * Build the confirm request (no I/O). Throws BEFORE any enqueue/network when `callId`
   * is falsy — a missing reconciliation id is a caller programming error, not a
   * transient condition (budget.md behavior 19). An unrecognized `serviceTier` is
   * silently downgraded to absent and logged at DEBUG so the strict confirm schema never
   * 422s on a novel echoed tier (budget.md behavior 20). The completed request is parsed
   * before it leaves this pure builder so every settlement path shares the wire contract.
   */
  buildConfirmRequest(options: BuildConfirmRequestOptions): BudgetConfirmRequest {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new ConfigurationError("buildConfirmRequest requires a named options object", {
        field: null,
      });
    }
    if (!options.callId) {
      throw new ConfigurationError("call_id is required for budget confirm reconciliation", {
        field: "call_id",
      });
    }
    if (!BudgetConfirmRequestObjectSchema.shape.call_id.safeParse(options.callId).success) {
      throw new ConfigurationError("invalid call_id", { field: "call_id" });
    }

    let serviceTier: ServiceTier | null = null;
    const rawTier = options.serviceTier;
    if (rawTier !== null && rawTier !== undefined) {
      if (SERVICE_TIER_VALUES.has(rawTier)) {
        serviceTier = rawTier as ServiceTier;
      } else {
        // Log the substring only — never the raw echoed value (defense-in-depth).
        this.logger.debug("budget.confirm_service_tier_unrecognized");
      }
    }

    const leaseId = options.leaseId ?? null;
    const reservationId = leaseId === null ? (options.reservationId ?? null) : null;
    const request: BudgetConfirmRequest = {
      ...(leaseId !== null ? { lease_id: leaseId } : {}),
      ...(reservationId !== null ? { reservation_id: reservationId } : {}),
      model: options.model,
      provider: options.provider,
      is_provider_fallback: options.isProviderFallback ?? false,
      call_id: options.callId,
      token_details: options.tokenDetails,
      provider_region: options.providerRegion ?? null,
      service_tier: serviceTier,
    };
    if (options.modality !== undefined) {
      request.modality = options.modality;
    }
    if (options.mediaUsage !== null && options.mediaUsage !== undefined) {
      request.media_usage = options.mediaUsage;
    }
    const validated = BudgetConfirmRequestSchema.safeParse(request);
    if (!validated.success) {
      const issue = validated.error.issues[0];
      const field =
        issue !== undefined && issue.path.length > 0
          ? String(issue.path[issue.path.length - 1])
          : null;
      throw new ConfigurationError("invalid budget confirm request", { field });
    }
    if (leaseId !== null) {
      const claimToken = options.leaseClaimToken ?? null;
      if (claimToken === null) {
        throw new ConfigurationError("lease_claim_token is required for lease settlement", {
          field: "lease_claim_token",
        });
      }
      const runId = this.leaseLedger.runIdForCall(validated.data.call_id);
      this.leaseLedger.trueUp(validated.data.call_id, totalTokens(validated.data.token_details), {
        claimToken,
        floorAtReservation: options.floorAtReservation ?? false,
      });
      if (runId !== null) this.retireOrphanedRun(runId);
    }
    return validated.data;
  }

  /** Consume unknown paid work at its reservation floor without performing wire I/O. */
  consumeUnknownUsage(callId: string, claimToken: number | null): void {
    const runId = this.leaseLedger.runIdForCall(callId);
    this.leaseLedger.trueUp(callId, 0, { claimToken, floorAtReservation: true });
    if (runId !== null) this.retireOrphanedRun(runId);
  }

  /** Return one still-current local lease reservation without performing wire I/O. */
  releaseReservation(callId: string, claimToken: number | null): void {
    if (claimToken === null) return;
    if (!BudgetConfirmRequestObjectSchema.shape.call_id.safeParse(callId).success) {
      throw new ConfigurationError("invalid call_id", { field: "call_id" });
    }
    const runId = this.leaseLedger.runIdForCall(callId);
    this.leaseLedger.release(callId, { claimToken });
    if (runId !== null) this.retireOrphanedRun(runId);
  }

  /**
   * Build the typed exception for one already-denied preflight result. The stopped-run branch
   * deliberately precedes the compatible budget-error builder so it performs no legacy monetary
   * estimate work.
   */
  buildDenialError(
    result: BudgetCheckResult,
    estimatedInputTokens: number,
    agentRunId: string | null | undefined,
  ): BudgetExceededError | RunStoppedError {
    if (
      result.deniedByPeriod === "run_stopped" &&
      agentRunId !== null &&
      agentRunId !== undefined
    ) {
      const resolution = this.readTermination(agentRunId).resolution;
      return new RunStoppedError({
        agentRunId,
        reason: resolution?.reason ?? result.denyReason ?? "run_stopped",
        source: resolution?.source ?? "server",
      });
    }
    return buildBudgetExceededErrorFromResult(result, estimatedInputTokens);
  }

  /** Guard the mutable callback seam so an unreadable result still blocks lease authority safely. */
  private readTermination(runId: string): TerminationRead {
    try {
      const value = this.terminationFor(runId);
      return {
        isPresent: value !== null && value !== undefined,
        resolution: normalizeTerminationResolution(value),
      };
    } catch {
      return { isPresent: true, resolution: null };
    }
  }

  // -------------------------------------------------------------------------
  // checkBudget — the pre-flight decision.
  // -------------------------------------------------------------------------

  /**
   * Ask the cloud whether a call is within budget. Returns a {@link BudgetCheckResult};
   * it does NOT throw itself (the client raises the applicable typed error off a deny result).
   * On an outage it degrades per
   * the sticky-deny → fail-open → local-enforcement precedence.
   */
  async checkBudget(options: CheckBudgetOptions): Promise<BudgetCheckResult> {
    const unmanagedRunId = options.runLifetime === undefined ? options.agentRunId : undefined;
    if (unmanagedRunId !== undefined) {
      this.preserveUnmanagedRun(unmanagedRunId);
      this.pendingUnmanagedRuns.set(
        unmanagedRunId,
        (this.pendingUnmanagedRuns.get(unmanagedRunId) ?? 0) + 1,
      );
    }
    try {
      return await this.checkBudgetWithOwnership(options);
    } finally {
      // First direct admission creates the state during the call. Remember unmanaged
      // use on that state regardless of whether a managed owner was seen earlier.
      if (unmanagedRunId !== undefined) {
        this.preserveUnmanagedRun(unmanagedRunId);
        const remaining = (this.pendingUnmanagedRuns.get(unmanagedRunId) ?? 1) - 1;
        if (remaining <= 0) this.pendingUnmanagedRuns.delete(unmanagedRunId);
        else this.pendingUnmanagedRuns.set(unmanagedRunId, remaining);
      }
    }
  }

  private async checkBudgetWithOwnership(options: CheckBudgetOptions): Promise<BudgetCheckResult> {
    // Invariant 7 / D5: `provider` is required AT RUNTIME, even from untyped JS callers.
    if (!options.provider) {
      throw new ConfigurationError("provider is required for budget check", { field: "provider" });
    }

    // Validate the outbound request BEFORE either cache authority or the outage try/catch:
    // a hot chain must never authorize invalid estimates or malformed fallback input, and a caller bug
    // — misaligned fallback arrays, an invalid provider, >8 fallback models, an over-long
    // model — must raise LOUDLY to the caller here (Python constructs the validating model
    // OUTSIDE its try, budget.py:435-437) rather than 422ing on the wire, being misread as
    // an outage, and silently degrading every check to a fail-open allow.
    // Capture caller-owned tag attribution before validation and before any await. The
    // post-I/O state transaction below must use this exact snapshot, never a record a
    // caller subsequently mutates while the check is in flight.
    const tags = copyCheckTags(options.tags);
    const checkOptions: CheckBudgetOptions = Object.freeze({ ...options, tags });
    const validated = BudgetCheckRequestSchema.safeParse(this.buildCheckRequest(checkOptions));
    if (!validated.success) {
      const issue = validated.error.issues[0];
      const field =
        issue !== undefined && issue.path.length > 0
          ? String(issue.path[issue.path.length - 1])
          : null;
      throw new ConfigurationError(issue?.message ?? "invalid budget check request", { field });
    }
    let request: unknown = validated.data;
    if (options.modality !== undefined && options.modality !== "text") {
      const {
        fallback_providers: _fallbackProviders,
        fallback_models: _fallbackModels,
        ...mediaRequest
      } = validated.data;
      request = mediaRequest;
    }

    // Caller-owned values used after an async boundary are copied once. The arrays and
    // aggregate snapshot are frozen so a pending grant/check cannot observe later mutation.
    const fallbackProviders = Object.freeze([...(checkOptions.fallbackProviders ?? [])]);
    const fallbackModels = Object.freeze([...(checkOptions.fallbackModels ?? [])]);
    const stableOptions: CheckBudgetOptions = Object.freeze({
      ...checkOptions,
      fallbackProviders: [...fallbackProviders],
      fallbackModels: [...fallbackModels],
      estimatedMedia:
        checkOptions.estimatedMedia === null || checkOptions.estimatedMedia === undefined
          ? checkOptions.estimatedMedia
          : { ...checkOptions.estimatedMedia },
    });
    const captured: CapturedCheck = Object.freeze({
      agentRunId: checkOptions.agentRunId,
      tagged: tags !== null && tags !== undefined,
      requestedCallId: checkOptions.callId,
      estimatedInputTokens: checkOptions.estimatedInputTokens,
      estimatedOutputBound:
        positiveOutputBound(checkOptions.estimatedOutputBound) ??
        this.leaseLedger.outputBoundDefault,
      model: checkOptions.model,
      provider: checkOptions.provider,
      fallbackProviders,
      fallbackModels,
      modality: checkOptions.modality ?? "text",
      hasEstimatedMedia:
        checkOptions.estimatedMedia !== null && checkOptions.estimatedMedia !== undefined,
      timeoutMs:
        checkOptions.timeout !== undefined ? checkOptions.timeout * 1000 : DEFAULT_CHECK_TIMEOUT_MS,
    });
    const cacheKey = this.allowCacheKey(stableOptions);
    let leaseCallId: string | null = null;
    let leaseClaimToken: number | null = null;

    let widenAfterAllow = false;

    if (this.leaseEntryEligible(captured)) {
      leaseCallId = this.canonicalLeaseCallId(captured.requestedCallId);
      let leaseAdmission = this.admitLease(captured, leaseCallId, null);
      leaseClaimToken = leaseAdmission.claimToken;
      widenAfterAllow = leaseAdmission.reason === "model_outside_declared_set";

      const immediate = this.localLeaseResult(captured, leaseAdmission);
      if (immediate !== null) {
        this.noteAdmissionUncounted(captured, leaseAdmission);
        return immediate;
      }

      if (leaseAdmission.decision === LeaseDecision.NeedGrant) {
        const runId = captured.agentRunId;
        if (runId !== undefined && !this.initialGrantInFlight.has(runId)) {
          // Critical section: claim the run's grant slot before the first await.
          this.initialGrantInFlight.add(runId);
          const grant = await this.attemptInitialGrant(captured, leaseCallId, leaseClaimToken);
          if (grant.kind === "admission") {
            leaseAdmission = grant.admission;
            leaseClaimToken = leaseAdmission.claimToken;
            const granted = this.localLeaseResult(captured, leaseAdmission);
            if (granted !== null) {
              this.noteAdmissionUncounted(captured, leaseAdmission);
              return granted;
            }
          } else if (grant.kind === "denied") {
            return this.withLeaseClaim(grant.result, leaseClaimToken);
          } else if (grant.kind === "outage") {
            return this.handleColdLeaseOutage(captured, leaseCallId, leaseClaimToken);
          }
          // A grant loser, refused/malformed grant, or one-shot re-entry that still
          // needs authority continues to the legacy per-call endpoint exactly once.
        }
      }
    }

    // --- Critical section: cache read + LRU touch (no `await` inside). ---
    const cached = this.cachedAllow(cacheKey, stableOptions);
    if (cached !== null) {
      return this.withLeaseClaim(
        budgetCheckResult({
          allowed: true,
          remainingBudget: cached.remaining_budget,
          projectId: cached.project_id ?? null,
          reservationId: null,
          mode: cached.mode,
          budgetLimit: cached.budget_limit,
          currentUsage: cached.current_usage,
          priceHints: cached.price_hints ?? null,
          failoverTuningAllowed: null,
        }),
        leaseClaimToken,
      );
    }

    const admission: CircuitBreakerAdmission | null = this.controlPlaneBreaker?.admit() ?? null;
    if (admission !== null && !admission.allowed) {
      this.logger.debug("budget.check_skipped_breaker_open");
      if (leaseCallId !== null && leaseClaimToken !== null) {
        const reentry = this.admitLease(captured, leaseCallId, leaseClaimToken, true);
        const local = this.localLeaseResult(captured, reentry);
        if (local !== null) {
          this.noteAdmissionUncounted(captured, reentry);
          return local;
        }
        if (reentry.decision === LeaseDecision.NeedGrant) {
          return this.handleColdLeaseOutage(captured, leaseCallId, leaseClaimToken);
        }
      }
      return this.withLeaseClaim(
        this.handleOutage(captured.estimatedInputTokens, captured.agentRunId),
        leaseClaimToken,
      );
    }
    try {
      // Ordered response authority exists only for a real check POST. Capture and register
      // its dispatch after lease/cache/breaker decisions and immediately before the POST.
      const requestDispatch = this.captureAuthorityDispatch();
      this.registerPendingOrderedRequest(requestDispatch);
      try {
        let raw: Awaited<ReturnType<Transport["postJsonAndReadJson"]>>;
        try {
          raw = await this.transport.postJsonAndReadJson(BUDGET_CHECK_PATH, request, {
            timeoutMs: captured.timeoutMs,
          });
        } catch (error) {
          if (isReadOnlyKeyError(error)) {
            this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
            handleReadOnlyKeyError(error, this.logger);
          } else {
            this.controlPlaneBreaker?.recordFailure(admission ?? undefined);
            this.logger.warn("Cloud API budget check failed: %s", exceptionName(error));
          }
          return this.withLeaseClaim(
            this.handleOutage(captured.estimatedInputTokens, captured.agentRunId),
            leaseClaimToken,
          );
        }

        let response: BudgetCheckResponse;
        try {
          if (!raw.parsed) {
            throw raw.error;
          }
          response = BudgetCheckResponseSchema.parse(raw.value);
        } catch (error) {
          this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
          this.logger.error(
            "budget.check_response_unreadable: %s — possible server contract drift; enforcement degraded (fail_open=%s)",
            exceptionName(error),
            this.failOpen,
          );
          return this.withLeaseClaim(
            this.handleOutage(captured.estimatedInputTokens, captured.agentRunId),
            leaseClaimToken,
          );
        }

        this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
        const result = this.applyCheckResponse(response, stableOptions, cacheKey, requestDispatch);
        // Only a live allow for this run widens; denied, unreadable and outage paths never do.
        if (widenAfterAllow && response.allowed && result.allowed && !response.run_control) {
          this.scheduleWidening(captured);
        }
        return this.withLeaseClaim(result, leaseClaimToken);
      } finally {
        this.unregisterPendingOrderedRequest(requestDispatch);
      }
    } finally {
      this.controlPlaneBreaker?.releaseProbe(admission);
    }
  }

  /** Central lease-entry seam; D1 adds tagged-call bypass at this one boundary. */
  private leaseEntryEligible(captured: CapturedCheck): boolean {
    const runId = captured.agentRunId;
    if (
      this.closed ||
      this.retiringRuns.has(runId ?? "") ||
      !this.leaseLedger.enabled ||
      runId === undefined ||
      captured.modality !== "text" ||
      captured.hasEstimatedMedia ||
      this.lastHardDenyResponse !== null ||
      this.runHardDenyResponses.has(runId) ||
      captured.tagged
    ) {
      return false;
    }
    return !this.readTermination(runId).isPresent;
  }

  /** Validate or mint the canonical call capability before the ledger can mutate. */
  private canonicalLeaseCallId(requested: string | undefined): string {
    const callId = requested ?? crypto.randomUUID();
    if (!BudgetConfirmRequestObjectSchema.shape.call_id.safeParse(callId).success) {
      throw new ConfigurationError("invalid call_id", { field: "call_id" });
    }
    return callId;
  }

  /** Pure breaker inspection for the first synchronous lease admission. */
  private leaseBreakerOpen(): boolean {
    const snapshot = this.controlPlaneBreaker?.getState();
    return snapshot?.state === "open" && !snapshot.recoveryEligible;
  }

  /** One synchronous ledger read-modify-write section. Never make this method async. */
  private admitLease(
    captured: CapturedCheck,
    callId: string,
    claimToken: number | null,
    breakerOpen = this.leaseBreakerOpen(),
  ): LeaseAdmission {
    const runId = captured.agentRunId;
    if (runId === undefined) {
      throw new ConfigurationError("agent_run_id is required for lease admission", {
        field: "agent_run_id",
      });
    }
    const admission = this.leaseLedger.admit({
      runId,
      callId,
      estimatedInputTokens: captured.estimatedInputTokens,
      outputBound: captured.estimatedOutputBound,
      model: captured.model,
      fallbackModels: captured.fallbackModels,
      modality: captured.modality,
      hasEstimatedMedia: captured.hasEstimatedMedia,
      now: this.monotonicNow() / 1000,
      breakerOpen,
      claimToken,
    });
    // Aged reservations released by the admission sweep may make their runs retirable.
    for (const swept of this.leaseLedger.takeSweptRuns()) this.retireOrphanedRun(swept);
    return admission;
  }

  /** Map ledger authority and its immutable display snapshot into the local result shape. */
  private localLeaseResult(
    captured: CapturedCheck,
    admission: LeaseAdmission,
  ): MaterializedBudgetCheckResult | null {
    const runId = captured.agentRunId;
    if (runId === undefined) return null;
    const snapshot = this.leaseLedger.snapshotFor(runId);
    if (admission.decision === LeaseDecision.Deny) {
      return this.leaseResultFromSnapshot(snapshot, {
        allowed: false,
        leaseId: null,
        leaseClaimToken: admission.claimToken,
        mode: admission.mode ?? snapshot?.mode ?? "hard_deny",
        warning: admission.warning,
        deniedByPeriod: "agent_run",
        denySource: "lease_exhausted",
        denyReason: admission.reason,
      });
    }
    this.scheduleRenewal(captured, admission);
    if (!admission.admitted) return null;
    return this.leaseResultFromSnapshot(snapshot, {
      allowed: true,
      leaseId: admission.leaseId,
      leaseClaimToken: admission.claimToken,
      mode: admission.mode ?? snapshot?.mode ?? this.budgetMode,
      warning: admission.warning,
      deniedByPeriod: null,
      denySource: null,
      denyReason: null,
    });
  }

  /** Claim and launch one due renewal without awaiting it on the admission path. */
  private scheduleRenewal(captured: CapturedCheck, admission: LeaseAdmission): void {
    if (!admission.renewalDue || this.closed) return;
    if (this.renewalOperations.size >= MAX_RENEWAL_OPERATIONS) {
      this.logger.debug("lease.renew_worker_limit");
      return;
    }
    const runId = captured.agentRunId;
    if (runId === undefined) return;
    // A retry at the same lease and generation re-sends the first claim's declaration.
    const claimed = this.leaseLedger.claimRenewal(runId, {
      model: captured.model,
      provider: captured.provider,
      fallbackProviders: captured.fallbackProviders,
      fallbackModels: captured.fallbackModels,
    });
    if (claimed === null) return;
    this.launchRenewal(runId, claimed.request, claimed.addedModels);
  }

  /**
   * After an allowed per-call check for a chain the lease does not declare, claim one background
   * renewal that re-declares the call's full chain. The call keeps its per-call result; the lease
   * covers the chain only once the renewal is applied. A skipped claim (worker cap, backoff, a
   * renewal in flight) is retried by the next such call.
   */
  private scheduleWidening(captured: CapturedCheck): void {
    const runId = captured.agentRunId;
    if (runId === undefined || !this.leaseEntryEligible(captured)) return;
    if (this.renewalOperations.size >= MAX_RENEWAL_OPERATIONS) {
      this.logger.debug("lease.renew_worker_limit");
      return;
    }
    const claimed = this.leaseLedger.claimWideningRequest(runId, {
      now: this.monotonicNow() / 1000,
      model: captured.model,
      provider: captured.provider,
      fallbackProviders: captured.fallbackProviders,
      fallbackModels: captured.fallbackModels,
    });
    if (claimed === null) return;
    // While a retry is owed, the call sends that retry unchanged; its own chain widens later.
    if (claimed.retry)
      this.logger.debug("lease.renew_retry: added_models=%d", claimed.addedModels.length);
    else this.logger.debug("lease.widen: added_models=%d", claimed.addedModels.length);
    this.launchRenewal(runId, claimed.request, claimed.addedModels);
  }

  /** Validate and launch one claimed renewal without awaiting it on the admission path. */
  private launchRenewal(
    runId: string,
    claimed: LeaseRenewRequest,
    wideningModels: readonly string[],
  ): void {
    const originLeaseId = claimed.lease_id;
    const originGeneration = claimed.generation;
    const parsed = LeaseRenewRequestSchema.safeParse(claimed);
    if (!parsed.success) {
      this.failRenewal(runId, originLeaseId, originGeneration, false);
      this.logger.warn("lease.renew_request_invalid");
      return;
    }
    const fallbackProviders = [...(parsed.data.fallback_providers ?? [])];
    const fallbackModels = [...(parsed.data.fallback_models ?? [])];
    Object.freeze(fallbackProviders);
    Object.freeze(fallbackModels);
    const request: LeaseRenewRequest = Object.freeze({
      ...parsed.data,
      fallback_providers: fallbackProviders,
      fallback_models: fallbackModels,
    });
    const operation: RenewalOperation = Object.freeze({
      runId,
      originLeaseId,
      originGeneration,
      closeEpoch: this.closeEpoch,
      // An applied renewal covers exactly what the request declared, never the caller's chain.
      declaredModels: Object.freeze([
        ...(request.model === null || request.model === undefined ? [] : [request.model]),
        ...fallbackModels,
      ]),
      wideningModels,
      wire: Object.freeze(serializeLeaseRenewRequest(request)),
    });

    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(() => this.performRenewal(operation))
      .catch(() => {
        if (operation.closeEpoch === this.closeEpoch) {
          this.failRenewal(runId, originLeaseId, originGeneration);
        }
        this.logger.warn("lease.renew_failed: internal_error");
      })
      .finally(() => {
        this.renewalOperations.delete(tracked);
      });
    this.renewalOperations.add(tracked);
  }

  /** Execute one already-claimed renewal; every exit clears or supersedes its ledger claim. */
  private async performRenewal(operation: RenewalOperation): Promise<void> {
    const admission: CircuitBreakerAdmission | null = this.controlPlaneBreaker?.admit() ?? null;
    try {
      if (admission !== null && !admission.allowed) {
        if (operation.closeEpoch === this.closeEpoch) {
          this.failRenewal(
            operation.runId,
            operation.originLeaseId,
            operation.originGeneration,
            false,
          );
        }
        this.logger.debug("lease.renew_skipped_breaker_open");
        return;
      }

      const authorityDispatch = this.captureAuthorityDispatch();
      // From here the declaration may reach the control plane: only a superseding generation
      // may drop it, whatever a later attempt reports.
      if (operation.closeEpoch === this.closeEpoch) {
        this.leaseLedger.renewalDispatched(operation.runId, {
          expectedLeaseId: operation.originLeaseId,
          expectedGeneration: operation.originGeneration,
        });
      }
      let raw: Awaited<ReturnType<Transport["postJsonAndReadJson"]>>;
      try {
        raw = await this.transport.postJsonAndReadJson(LEASE_RENEW_PATH, operation.wire, {
          timeoutMs: RENEWAL_TIMEOUT_MS,
        });
      } catch (error) {
        const status = error instanceof TransportHttpError ? error.status : null;
        const responded =
          isReadOnlyKeyError(error) ||
          status === 503 ||
          (status !== null && status >= 400 && status < 500);
        if (responded) this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
        else this.controlPlaneBreaker?.recordFailure(admission ?? undefined);
        if (isReadOnlyKeyError(error)) handleReadOnlyKeyError(error, this.logger);

        if (operation.closeEpoch === this.closeEpoch) {
          if (status === 404 || status === 409) {
            this.leaseLedger.dropIfCurrent(operation.runId, {
              leaseId: operation.originLeaseId,
              generation: operation.originGeneration,
            });
          } else {
            this.failRenewal(operation.runId, operation.originLeaseId, operation.originGeneration);
          }
        }
        if (responded) this.logger.debug("lease.renew_refused: status=%s", status);
        else this.logger.warn("lease.renew_failed: control_plane_unreachable");
        return;
      }

      this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
      if (!raw.parsed) {
        if (operation.closeEpoch === this.closeEpoch) {
          this.failRenewal(operation.runId, operation.originLeaseId, operation.originGeneration);
        }
        this.logger.warn("lease.renew_response_unreadable");
        return;
      }
      const parsed = LeaseGrantResponseSchema.safeParse(raw.value);
      if (!parsed.success) {
        if (operation.closeEpoch === this.closeEpoch) {
          this.failRenewal(operation.runId, operation.originLeaseId, operation.originGeneration);
        }
        this.logger.warn("lease.renew_response_unreadable");
        return;
      }

      if (operation.closeEpoch !== this.closeEpoch) {
        this.surrenderLateSuccessor(parsed.data, this.lateSpendFor(operation));
        return;
      }

      if (
        !this.leaseLedger.isCurrentOrigin(operation.runId, {
          leaseId: operation.originLeaseId,
          generation: operation.originGeneration,
        })
      ) {
        this.surrenderLateSuccessor(parsed.data, 0);
        return;
      }

      const runControl = this.applyRenewalRunControl(parsed.data, operation);
      if (runControl.kind === "handled") return;
      const effective = runControl.response;

      if (this.readTermination(operation.runId).isPresent) {
        this.leaseLedger.dropIfCurrent(operation.runId, {
          leaseId: operation.originLeaseId,
          generation: operation.originGeneration,
        });
        this.surrenderLateSuccessor(parsed.data, 0);
        return;
      }

      const responseObservation = this.captureLeaseAuthorityObservation(authorityDispatch);
      this.refreshBudgetSnapshot(effective);
      const projected = this.projectGrantResponse(effective);
      const globalFence = this.leaseGlobalAuthorityFence(responseObservation, projected);
      if (effective.allowed && isInstallableLeaseGrantResponse(effective)) {
        const runWinner = this.runHardDenyAtOrAfter(
          operation.runId,
          authorityDispatch.runDispatchedAt,
        );
        if (globalFence.superseded || runWinner !== null) {
          this.foldRunStateForAllow(projected, operation.runId, authorityDispatch.runDispatchedAt);
          this.failRenewal(operation.runId, operation.originLeaseId, operation.originGeneration);
          this.surrenderLateSuccessor(parsed.data, 0);
          return;
        }
      }

      const outcome = this.leaseLedger.applyGrantResponse(operation.runId, effective, {
        now: responseObservation.runObservedAt / 1000,
        declaredModels: operation.declaredModels,
        expectedLeaseId: operation.originLeaseId,
        expectedGeneration: operation.originGeneration,
        wideningModels: operation.wideningModels,
      });
      if (outcome === GrantOutcome.Applied) {
        this.foldRunStateForAllow(projected, operation.runId, authorityDispatch.runDispatchedAt);
        this.clearGlobalHardDeny({
          kind: "lease",
          observation: responseObservation,
          dispatchSequenceWatermark: responseObservation.dispatch.sequence,
        });
        this.uncountedEpisodes.delete(operation.runId);
      } else if (outcome === GrantOutcome.Denied) {
        // A matching server refusal still invalidates its origin lease. The dispatch
        // fence suppresses only stale global authority; scoped run state still folds.
        const authorityOrder: GlobalAuthorityOrder = globalFence.superseded
          ? { kind: "suppressed", dispatch: authorityDispatch }
          : {
              kind: "lease",
              observation: responseObservation,
              dispatchSequenceWatermark: responseObservation.dispatch.sequence,
            };
        this.classifyHardDeny(
          projected,
          operation.runId,
          responseObservation.runObservedAt,
          authorityOrder,
        );
      } else if (outcome === GrantOutcome.Ineligible) {
        this.logger.debug("lease.renew_ineligible: reason=%s", ineligibleReason(effective));
        if (operation.wideningModels.length > 0) {
          this.logger.debug("lease.widen_refused: models=%d", operation.wideningModels.length);
        }
        this.releaseRefusedLease(operation.runId);
      } else if (outcome === GrantOutcome.Stale) {
        this.failRenewal(operation.runId, operation.originLeaseId, operation.originGeneration);
      }
    } finally {
      this.controlPlaneBreaker?.releaseProbe(admission);
      if (operation.closeEpoch !== this.closeEpoch) {
        this.lateRenewalSpend.delete(this.renewalKey(operation));
      }
      this.retireOrphanedRun(operation.runId);
    }
  }

  /**
   * `sent: false` only when this attempt provably never reached the control plane; the ledger
   * still keeps the declaration if an earlier attempt at the same origin may have.
   */
  private failRenewal(runId: string, leaseId: string, generation: number, sent = true): void {
    this.leaseLedger.renewalFailed(runId, {
      now: this.monotonicNow() / 1000,
      expectedLeaseId: leaseId,
      expectedGeneration: generation,
      sent,
    });
  }

  private leaseResultFromSnapshot(
    snapshot: LeaseSnapshot | null,
    fields: Pick<
      MaterializedBudgetCheckResult,
      | "allowed"
      | "leaseId"
      | "leaseClaimToken"
      | "mode"
      | "warning"
      | "deniedByPeriod"
      | "denySource"
      | "denyReason"
    >,
  ): MaterializedBudgetCheckResult {
    return budgetCheckResult({
      ...fields,
      remainingBudget: snapshot?.remainingBudget ?? 0,
      projectId: snapshot?.projectId ?? null,
      reservationId: null,
      budgetLimit: snapshot?.budgetLimit ?? 0,
      currentUsage: snapshot?.currentUsage ?? 0,
      priceHints: null,
      failoverTuningAllowed: null,
    });
  }

  /** Perform exactly one blocking initial grant attempt for the run-owned work slot. */
  private async attemptInitialGrant(
    captured: CapturedCheck,
    callId: string,
    claimToken: number | null,
  ): Promise<InitialGrantResult> {
    const runId = captured.agentRunId;
    if (runId === undefined) return { kind: "legacy" };
    const closeDispatchEpoch = this.closeEpoch;
    const admission: CircuitBreakerAdmission | null = this.controlPlaneBreaker?.admit() ?? null;
    try {
      if (admission !== null && !admission.allowed) {
        this.logger.debug("lease.grant_skipped_breaker_open");
        return { kind: "outage" };
      }

      const request = this.buildLeaseGrantRequest(captured);
      const authorityDispatch = this.captureAuthorityDispatch();
      let raw: Awaited<ReturnType<Transport["postJsonAndReadJson"]>>;
      try {
        raw = await this.transport.postJsonAndReadJson(
          LEASE_GRANT_PATH,
          serializeLeaseGrantRequest(request),
          { timeoutMs: captured.timeoutMs },
        );
      } catch (error) {
        const status = error instanceof TransportHttpError ? error.status : null;
        const responded =
          isReadOnlyKeyError(error) ||
          status === 503 ||
          (status !== null && status >= 400 && status < 500);
        if (responded) {
          this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
          if (isReadOnlyKeyError(error)) handleReadOnlyKeyError(error, this.logger);
          if (closeDispatchEpoch === this.closeEpoch) {
            this.leaseLedger.markIneligible(runId, {
              now: this.monotonicNow() / 1000,
              retryAfter: status === 409 ? LEASE_REFUSAL_LATCH_S : INELIGIBLE_RETRY_AFTER_S,
            });
          }
          this.logger.debug("lease.grant_refused: status=%s", status);
          return { kind: "legacy" };
        }
        this.controlPlaneBreaker?.recordFailure(admission ?? undefined);
        this.logger.warn("lease.grant_failed: control_plane_unreachable");
        return closeDispatchEpoch === this.closeEpoch ? { kind: "outage" } : { kind: "legacy" };
      }

      if (!raw.parsed) {
        this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
        if (closeDispatchEpoch === this.closeEpoch) {
          this.leaseLedger.markIneligible(runId, {
            now: this.monotonicNow() / 1000,
            retryAfter: INELIGIBLE_RETRY_AFTER_S,
          });
        }
        const grantParseFailureName = exceptionName(raw.error);
        this.logger.warn("lease.grant_response_unreadable: %s", grantParseFailureName);
        return { kind: "legacy" };
      }
      const parsed = LeaseGrantResponseSchema.safeParse(raw.value);
      if (!parsed.success) {
        this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
        if (closeDispatchEpoch === this.closeEpoch) {
          this.leaseLedger.markIneligible(runId, {
            now: this.monotonicNow() / 1000,
            retryAfter: INELIGIBLE_RETRY_AFTER_S,
          });
        }
        this.logger.warn("lease.grant_response_unreadable: %s", parsed.error.name);
        return { kind: "legacy" };
      }

      this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
      if (closeDispatchEpoch !== this.closeEpoch) {
        this.surrenderLateGrantResponse(parsed.data);
        return { kind: "legacy" };
      }

      const runControl = this.applyGrantRunControl(parsed.data, runId);
      if (runControl.kind === "denied") return runControl;
      if (runControl.kind === "misrouted") return { kind: "outage" };
      const effective = runControl.response;

      if (this.readTermination(runId).isPresent) {
        this.leaseLedger.drop(runId);
        this.surrenderLateGrantResponse(parsed.data);
        return { kind: "legacy" };
      }

      const responseObservation = this.captureLeaseAuthorityObservation(authorityDispatch);
      this.refreshBudgetSnapshot(effective);
      const projected = this.projectGrantResponse(effective);
      const globalFence = this.leaseGlobalAuthorityFence(responseObservation, projected);
      if (effective.allowed && isInstallableLeaseGrantResponse(effective)) {
        const runWinner = this.runHardDenyAtOrAfter(runId, authorityDispatch.runDispatchedAt);
        if (globalFence.superseded || runWinner !== null) {
          const foldedRunWinner = this.foldRunStateForAllow(
            projected,
            runId,
            authorityDispatch.runDispatchedAt,
          );
          this.surrenderLateGrantResponse(parsed.data);
          const winningResponse = globalFence.response ?? foldedRunWinner;
          return winningResponse === null
            ? { kind: "legacy" }
            : {
                kind: "denied",
                result: this.liveHardDenyResult(winningResponse, runId),
              };
        }
      }

      const outcome = this.leaseLedger.applyGrantResponse(runId, effective, {
        now: responseObservation.runObservedAt / 1000,
        declaredModels: [captured.model, ...captured.fallbackModels],
      });
      if (outcome === GrantOutcome.Denied) {
        const authorityOrder: GlobalAuthorityOrder = globalFence.superseded
          ? { kind: "suppressed", dispatch: authorityDispatch }
          : {
              kind: "lease",
              observation: responseObservation,
              dispatchSequenceWatermark: responseObservation.dispatch.sequence,
            };
        this.classifyHardDeny(projected, runId, responseObservation.runObservedAt, authorityOrder);
        const nonClearingRunStop =
          projected.mode === "hard_deny" && projected.denied_by_period === "run_stopped";
        const winningResponse = nonClearingRunStop ? null : globalFence.response;
        return {
          kind: "denied",
          result: this.projectCloudResponse(winningResponse ?? projected, runId),
        };
      }
      if (outcome === GrantOutcome.Ineligible) {
        this.logger.debug("lease.grant_ineligible: reason=%s", ineligibleReason(effective));
      }
      if (outcome !== GrantOutcome.Applied) return { kind: "legacy" };

      this.foldRunStateForAllow(projected, runId, authorityDispatch.runDispatchedAt);
      this.clearGlobalHardDeny({
        kind: "lease",
        observation: responseObservation,
        dispatchSequenceWatermark: responseObservation.dispatch.sequence,
      });
      this.uncountedEpisodes.delete(runId);
      return {
        kind: "admission",
        admission: this.admitLease(captured, callId, claimToken),
      };
    } finally {
      this.controlPlaneBreaker?.releaseProbe(admission);
      this.initialGrantInFlight.delete(runId);
      this.retireOrphanedRun(runId);
    }
  }

  private buildLeaseGrantRequest(captured: CapturedCheck): LeaseGrantRequest {
    const parsed = LeaseGrantRequestSchema.safeParse({
      agent_run_id: captured.agentRunId,
      holder_id: this.leaseLedger.holderId,
      model: captured.model,
      provider: captured.provider,
      fallback_providers: [...captured.fallbackProviders],
      fallback_models: [...captured.fallbackModels],
      fail_open: this.failOpen,
      estimated_input_tokens: Math.max(0, captured.estimatedInputTokens),
      run_directive_version: "1",
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.at(-1);
      throw new ConfigurationError("invalid lease grant request", {
        field: field === undefined ? null : String(field),
      });
    }
    return parsed.data;
  }

  /** Project a lease verdict into the ordinary check shape without losing its real period. */
  private projectGrantResponse(response: LeaseGrantResponse): BudgetCheckResponse {
    return {
      allowed: response.allowed,
      remaining_budget: response.remaining_budget,
      reservation_id: null,
      mode: response.mode,
      budget_limit: response.budget_limit,
      current_usage: response.current_usage,
      denied_by_period: Object.hasOwn(response, "denied_by_period")
        ? (response.denied_by_period ?? null)
        : response.allowed
          ? null
          : "agent_run",
      project_id: response.project_id,
      price_hints: null,
      run_control: response.run_control ?? null,
    };
  }

  /** Cold fail-open calls carry no lease ID, but their exact claimed reserve is owed. */
  private handleColdLeaseOutage(
    captured: CapturedCheck,
    callId: string,
    claimToken: number | null,
  ): MaterializedBudgetCheckResult {
    const result = this.handleOutage(captured.estimatedInputTokens, captured.agentRunId);
    const runId = captured.agentRunId;
    if (this.failOpen && result.allowed && runId !== undefined) {
      this.leaseLedger.recordUncounted(
        runId,
        Math.max(0, captured.estimatedInputTokens) + captured.estimatedOutputBound,
        { callId, claimToken },
      );
      this.noteUncounted(runId, "grant_unreachable");
    }
    return this.withLeaseClaim(result, claimToken);
  }

  private noteAdmissionUncounted(captured: CapturedCheck, admission: LeaseAdmission): void {
    if (admission.decision === LeaseDecision.AdmitUncounted && captured.agentRunId !== undefined) {
      this.noteUncounted(captured.agentRunId, admission.reason ?? "lease_unavailable");
    }
  }

  /** Rate-limit diagnostics only; the ledger tallies every call independently. */
  private noteUncounted(runId: string, reason: string): void {
    const now = this.monotonicNow();
    const episode = this.uncountedEpisodes.get(runId);
    if (episode === undefined) {
      this.logger.warn(
        "lease.uncounted_entry: Solwyn is unreachable and this run holds no live lease; calls proceed UNCOUNTED under fail_open and are tallied; a successful renewal reports the tallies, otherwise they are aggregated into a local warning when the run ends (reason=%s)",
        reason,
      );
      this.uncountedEpisodes.set(runId, { lastWarnAt: now });
    } else {
      this.uncountedEpisodes.delete(runId);
      if (now - episode.lastWarnAt >= UNCOUNTED_WARN_INTERVAL_MS) {
        this.logger.warn(
          "lease.uncounted_continuing: still admitting UNCOUNTED under fail_open (reason=%s)",
          reason,
        );
        episode.lastWarnAt = now;
      }
      this.uncountedEpisodes.set(runId, episode);
    }
    while (this.uncountedEpisodes.size > MAX_UNCOUNTED_EPISODES) {
      const oldest = this.uncountedEpisodes.keys().next().value;
      if (oldest === undefined) break;
      this.uncountedEpisodes.delete(oldest);
    }
  }

  private withLeaseClaim(
    result: BudgetCheckResult,
    leaseClaimToken: number | null,
  ): MaterializedBudgetCheckResult {
    return budgetCheckResult({ ...result, leaseClaimToken });
  }

  private warnDirectiveMismatch(
    requestAgentRunId: string | undefined,
    directiveAgentRunId: string,
  ): void {
    this.logger.warn(
      "run_control.directive_run_mismatch: request_agent_run_id=%s directive_agent_run_id=%s",
      requestAgentRunId === undefined ? undefined : escapeControlChars(requestAgentRunId),
      escapeControlChars(directiveAgentRunId),
    );
  }

  private logMisroutedDirective(
    channel: "budget.check" | "lease.grant" | "lease.renew",
    requestAgentRunId: string | undefined,
    directiveAgentRunId: string,
  ): void {
    this.logger.error(
      `${channel}_directive_misrouted: request_agent_run_id=%s directive_agent_run_id=%s — possible server contract drift; enforcement degraded (fail_open=%s)`,
      requestAgentRunId === undefined ? undefined : escapeControlChars(requestAgentRunId),
      escapeControlChars(directiveAgentRunId),
      this.failOpen,
    );
  }

  private matchingDirectiveResult(
    response: BudgetCheckResponse,
    agentRunId: string,
    directive: RunControlDirective,
  ): MaterializedBudgetCheckResult {
    const observed = markTerminatedWithObservation(agentRunId, {
      reason: directive.reason,
      source: "server",
    });
    const effectiveDirective: RunControlDirective = Object.freeze({
      ...directive,
      reason:
        observed.termination.source === "server" ? observed.termination.reason : directive.reason,
    });
    const effective: BudgetCheckResponse = {
      ...response,
      allowed: false,
      reservation_id: null,
      mode: "hard_deny",
      denied_by_period: "run_stopped",
      run_control: effectiveDirective,
    };

    // One response transaction: the registry mark above supplies the sticky stamp, and
    // every remaining state transition is synchronous with no intervening await.
    this.refreshBudgetSnapshot(effective);
    this.fileRunHardDeny(agentRunId, effective, observed.observedAt);
    this.leaseLedger.drop(agentRunId);
    return this.liveHardDenyResult(effective, agentRunId);
  }

  private applyCheckResponse(
    response: BudgetCheckResponse,
    options: CheckBudgetOptions,
    cacheKey: string,
    requestDispatch: AuthorityDispatch,
  ): MaterializedBudgetCheckResult {
    const directive = response.run_control;
    if (directive === null || directive === undefined) {
      return this.applyCloudResponse(response, options, cacheKey, requestDispatch);
    }
    if (directive.agent_run_id !== options.agentRunId) {
      this.warnDirectiveMismatch(options.agentRunId, directive.agent_run_id);
      if (response.denied_by_period === "run_stopped") {
        this.logMisroutedDirective("budget.check", options.agentRunId, directive.agent_run_id);
        return this.handleOutage(options.estimatedInputTokens, options.agentRunId);
      }
      return this.projectCloudResponse({ ...response, run_control: null }, options.agentRunId);
    }
    return this.matchingDirectiveResult(response, directive.agent_run_id, directive);
  }

  private applyGrantRunControl(
    response: LeaseGrantResponse,
    agentRunId: string,
  ):
    | { readonly kind: "ordinary"; readonly response: LeaseGrantResponse }
    | { readonly kind: "denied"; readonly result: MaterializedBudgetCheckResult }
    | { readonly kind: "misrouted" } {
    const directive = response.run_control;
    if (directive === null || directive === undefined) {
      return { kind: "ordinary", response };
    }
    if (directive.agent_run_id !== agentRunId) {
      this.warnDirectiveMismatch(agentRunId, directive.agent_run_id);
      if (response.denied_by_period === "run_stopped") {
        this.logMisroutedDirective("lease.grant", agentRunId, directive.agent_run_id);
        return { kind: "misrouted" };
      }
      return { kind: "ordinary", response: { ...response, run_control: null } };
    }
    return {
      kind: "denied",
      result: this.matchingDirectiveResult(
        this.projectGrantResponse(response),
        agentRunId,
        directive,
      ),
    };
  }

  private applyRenewalRunControl(
    response: LeaseGrantResponse,
    operation: RenewalOperation,
  ):
    | { readonly kind: "ordinary"; readonly response: LeaseGrantResponse }
    | { readonly kind: "handled" } {
    const directive = response.run_control;
    if (directive === null || directive === undefined) {
      return { kind: "ordinary", response };
    }
    if (directive.agent_run_id !== operation.runId) {
      this.warnDirectiveMismatch(operation.runId, directive.agent_run_id);
      if (response.denied_by_period === "run_stopped") {
        this.logMisroutedDirective("lease.renew", operation.runId, directive.agent_run_id);
        this.failRenewal(operation.runId, operation.originLeaseId, operation.originGeneration);
        return { kind: "handled" };
      }
      return { kind: "ordinary", response: { ...response, run_control: null } };
    }
    this.matchingDirectiveResult(this.projectGrantResponse(response), operation.runId, directive);
    return { kind: "handled" };
  }

  private refreshBudgetSnapshot(
    response: Pick<BudgetCheckResponse, "budget_limit" | "current_usage">,
  ): void {
    this.lastKnownBudgetLimit = response.budget_limit;
    this.lastKnownCurrentUsage = response.current_usage;
  }

  private projectCloudResponse(
    response: BudgetCheckResponse,
    activeAgentRunId: string | undefined,
  ): MaterializedBudgetCheckResult {
    if (response.allowed) {
      return budgetCheckResult({
        allowed: true,
        remainingBudget: response.remaining_budget,
        projectId: response.project_id ?? null,
        reservationId: response.reservation_id ?? null,
        mode: response.mode,
        warning: null,
        budgetLimit: response.budget_limit,
        currentUsage: response.current_usage,
        priceHints: response.price_hints ?? null,
        failoverTuningAllowed: response.failover_directive?.failover_tuning_allowed ?? null,
      });
    }
    if (response.mode === "hard_deny") {
      return this.liveHardDenyResult(response, activeAgentRunId);
    }

    const limitUsd = money(response.budget_limit);
    const usageUsd = money(response.current_usage);
    this.logger.warn(
      `Budget limit reached (alert_only mode): limit=$${limitUsd}, usage=$${usageUsd}`,
    );
    return budgetCheckResult({
      allowed: true,
      remainingBudget: response.remaining_budget,
      projectId: response.project_id ?? null,
      reservationId: response.reservation_id ?? null,
      mode: response.mode,
      warning: `Budget limit reached: $${usageUsd}/$${limitUsd} used`,
      budgetLimit: response.budget_limit,
      currentUsage: response.current_usage,
      priceHints: response.price_hints ?? null,
      failoverTuningAllowed: response.failover_directive?.failover_tuning_allowed ?? null,
    });
  }

  private captureAuthorityDispatch(): AuthorityDispatch {
    const runDispatchedAt = this.monotonicNow();
    this.authoritySequence += 1n;
    return { sequence: this.authoritySequence, runDispatchedAt };
  }

  private captureLeaseAuthorityObservation(dispatch: AuthorityDispatch): LeaseAuthorityObservation {
    const runObservedAt = this.monotonicNow();
    this.authoritySequence += 1n;
    return {
      dispatch,
      observedSequence: this.authoritySequence,
      runObservedAt,
    };
  }

  private registerPendingOrderedRequest(dispatch: AuthorityDispatch): void {
    this.pendingOrderedRequests.add(dispatch.sequence);
  }

  private unregisterPendingOrderedRequest(dispatch: AuthorityDispatch): void {
    this.pendingOrderedRequests.delete(dispatch.sequence);
  }

  private hasPendingOrderedRequestAfter(dispatch: AuthorityDispatch): boolean {
    for (const sequence of this.pendingOrderedRequests) {
      if (sequence > dispatch.sequence) return true;
    }
    return false;
  }

  /** Return a retained denial that independently outranks one lease response. */
  private globalDenyThatOutranksLeaseResponse(
    dispatch: AuthorityDispatch,
    observation: LeaseAuthorityObservation,
  ): BudgetCheckResponse | null {
    const response = this.lastHardDenyResponse;
    const order = this.globalAuthorityOrder;
    if (response === null || order === null) return null;
    const outranks =
      order.kind === "lease"
        ? order.observation.observedSequence > observation.observedSequence
        : order.dispatch.sequence > dispatch.sequence;
    return outranks ? response : null;
  }

  /** Snapshot whether newer ordered/global-deny authority supersedes one lease dispatch. */
  private leaseGlobalAuthorityFence(
    observation: LeaseAuthorityObservation,
    candidate: BudgetCheckResponse,
  ): { readonly superseded: boolean; readonly response: BudgetCheckResponse | null } {
    const { dispatch } = observation;
    const response = this.globalDenyThatOutranksLeaseResponse(dispatch, observation);
    const mayClearGlobalAuthority =
      candidate.allowed ||
      candidate.mode !== "hard_deny" ||
      candidate.denied_by_period === "agent_run" ||
      candidate.denied_by_period === "tag";
    const fallbackSupersedesClear =
      mayClearGlobalAuthority &&
      this.acceptedFallbackGlobalClearSequence !== null &&
      this.acceptedFallbackGlobalClearSequence > dispatch.sequence;
    const superseded =
      (this.completedOrderedGlobalAuthoritySequence !== null &&
        this.completedOrderedGlobalAuthoritySequence > dispatch.sequence) ||
      (candidate.allowed && (this.hasPendingOrderedRequestAfter(dispatch) || response !== null)) ||
      fallbackSupersedesClear;
    return {
      superseded,
      response:
        superseded && fallbackSupersedesClear && response === null
          ? this.lastHardDenyResponse
          : superseded
            ? response
            : null,
    };
  }

  /** Read and LRU-touch a run denial that is at least as new as one request. */
  private runHardDenyAtOrAfter(
    agentRunId: string,
    runDispatchedAt: number,
  ): BudgetCheckResponse | null {
    const sticky = this.runHardDenyResponses.get(agentRunId);
    if (sticky === undefined || sticky.observedAt < runDispatchedAt) return null;
    this.runHardDenyResponses.delete(agentRunId);
    this.runHardDenyResponses.set(agentRunId, sticky);
    return sticky.response;
  }

  /** Fold the run-local half of an ordered allow and return any newer/equal winner. */
  private foldRunStateForAllow(
    response: BudgetCheckResponse,
    agentRunId: string | undefined,
    runDispatchedAt: number,
  ): BudgetCheckResponse | null {
    if (agentRunId === undefined) return null;
    const newerServerStop = clearServerTerminationBeforeRequest(agentRunId, runDispatchedAt);
    const sticky = this.runHardDenyResponses.get(agentRunId);
    let winningRunResponse: BudgetCheckResponse | null = null;
    if (sticky !== undefined) {
      if (sticky.observedAt >= runDispatchedAt) {
        // A denial observed after (or exactly at) this request wins. Touch only; its
        // observation stamp is ordering authority and must never change on a hit.
        this.runHardDenyResponses.delete(agentRunId);
        this.runHardDenyResponses.set(agentRunId, sticky);
        winningRunResponse = sticky.response;
      } else {
        this.runHardDenyResponses.delete(agentRunId);
      }
    }
    if (winningRunResponse !== null || newerServerStop === undefined) {
      return winningRunResponse;
    }
    const stopped: BudgetCheckResponse = {
      ...response,
      allowed: false,
      reservation_id: null,
      mode: "hard_deny",
      denied_by_period: "run_stopped",
      run_control: {
        version: "1",
        action: "terminate",
        agent_run_id: agentRunId,
        reason: newerServerStop.reason,
      },
    };
    this.fileRunHardDeny(agentRunId, stopped, newerServerStop.atMonotonic);
    return stopped;
  }

  /**
   * Fold a successful cloud response into enforcer state and produce the result.
   * Critical section: no `await` — the last-known/cache/hard-deny updates all run to
   * completion atomically (behaviors 6, 9, 10, 11 + the deny-never-cached rule).
   */
  private applyCloudResponse(
    response: BudgetCheckResponse,
    options: CheckBudgetOptions,
    cacheKey: string,
    requestDispatch: AuthorityDispatch,
  ): MaterializedBudgetCheckResult {
    // Behavior 6: EVERY response (allow or deny) refreshes the last-known limit/usage.
    this.refreshBudgetSnapshot(response);

    // Request order, not completion order, chooses the global result. Independent run state
    // still folds below before that result is projected to the caller.
    const globalSticky = this.lastHardDenyResponse;
    const isNonClearingScopedHardDeny =
      !response.allowed &&
      response.mode === "hard_deny" &&
      (response.denied_by_period === "run_stopped" ||
        (response.denied_by_period === "agent_run" && options.agentRunId === undefined));
    const winningGlobalResponse =
      !isNonClearingScopedHardDeny &&
      globalSticky !== null &&
      this.globalAuthorityOrder !== null &&
      (this.globalAuthorityOrder.kind === "lease"
        ? this.globalAuthorityOrder.dispatchSequenceWatermark > requestDispatch.sequence
        : this.globalAuthorityOrder.dispatch.sequence > requestDispatch.sequence)
        ? globalSticky
        : null;

    if (response.allowed) {
      const winningRunResponse = this.foldRunStateForAllow(
        response,
        options.agentRunId,
        requestDispatch.runDispatchedAt,
      );
      this.clearGlobalHardDeny({ kind: "ordered", dispatch: requestDispatch });
      if (winningGlobalResponse !== null) {
        return this.liveHardDenyResult(winningGlobalResponse, options.agentRunId);
      }
      if (winningRunResponse !== null) {
        return this.liveHardDenyResult(winningRunResponse, options.agentRunId);
      }
      this.storeAllow(cacheKey, response, options);
      return this.projectCloudResponse(response, options.agentRunId);
    }

    this.classifyHardDeny(response, options.agentRunId, undefined, {
      kind: "ordered",
      dispatch: requestDispatch,
    });
    if (winningGlobalResponse !== null) {
      return this.liveHardDenyResult(winningGlobalResponse, options.agentRunId);
    }
    return this.projectCloudResponse(response, options.agentRunId);
  }

  /**
   * Fold each live/grant/renew hard denial into its scoped or global outage authority. A stopped
   * run may have short-circuited before project periods were re-evaluated, so unlike an agent-run
   * cap it deliberately leaves an older global hard denial intact.
   */
  private classifyHardDeny(
    response: BudgetCheckResponse,
    agentRunId: string | undefined,
    observedAt: number | undefined,
    authorityOrder: GlobalAuthorityOrder,
  ): void {
    const deniedByPeriod = response.denied_by_period;
    const runDispatchedAt =
      authorityOrder.kind === "lease"
        ? authorityOrder.observation.dispatch.runDispatchedAt
        : authorityOrder.dispatch.runDispatchedAt;
    if (response.mode !== "hard_deny") {
      this.allowCache.clear();
      this.clearGlobalHardDeny(authorityOrder);
      if (agentRunId !== undefined) {
        const sticky = this.runHardDenyResponses.get(agentRunId);
        if (sticky !== undefined && runDispatchedAt > sticky.observedAt) {
          this.runHardDenyResponses.delete(agentRunId);
        }
      }
      return;
    }

    if (deniedByPeriod === "agent_run" || deniedByPeriod === "run_stopped") {
      if (agentRunId !== undefined) {
        if (deniedByPeriod === "agent_run") this.clearGlobalHardDeny(authorityOrder);
        this.fileRunHardDeny(
          agentRunId,
          response,
          observedAt ?? (deniedByPeriod === "run_stopped" ? runObservedAt(agentRunId) : undefined),
        );
        return;
      }
      this.allowCache.clear();
      const fallbackOrder: GlobalAuthorityOrder =
        authorityOrder.kind === "ordered"
          ? { kind: "fallback", dispatch: authorityOrder.dispatch }
          : authorityOrder;
      if (fallbackOrder.kind === "fallback" || this.lastHardDenyResponse === null) {
        this.fileGlobalHardDeny(response, fallbackOrder);
      }
      return;
    }

    if (deniedByPeriod === "tag") {
      this.clearGlobalHardDeny(authorityOrder);
      return;
    }
    this.allowCache.clear();
    this.fileGlobalHardDeny(response, authorityOrder);
  }

  /** Clear the payload while retaining its authority order as a tombstone. */
  private clearGlobalHardDeny(order: GlobalAuthorityOrder): void {
    if (order.kind === "suppressed" || order.kind === "fallback") return;
    if (order.kind === "ordered") {
      const current = this.globalAuthorityOrder;
      if (current !== null) {
        const currentDispatchSequence =
          current.kind === "lease" ? current.dispatchSequenceWatermark : current.dispatch.sequence;
        if (order.dispatch.sequence <= currentDispatchSequence) return;
      }
      if (
        this.completedOrderedGlobalAuthoritySequence === null ||
        order.dispatch.sequence > this.completedOrderedGlobalAuthoritySequence
      ) {
        this.completedOrderedGlobalAuthoritySequence = order.dispatch.sequence;
      }
      this.globalAuthorityOrder = order;
      this.lastHardDenyResponse = null;
      return;
    }
    const current = this.globalAuthorityOrder;
    let dispatchSequenceWatermark = order.dispatchSequenceWatermark;
    if (current !== null) {
      if (current.kind === "lease") {
        if (current.dispatchSequenceWatermark > dispatchSequenceWatermark) {
          dispatchSequenceWatermark = current.dispatchSequenceWatermark;
        }
        if (order.observation.observedSequence < current.observation.observedSequence) {
          if (dispatchSequenceWatermark !== current.dispatchSequenceWatermark) {
            this.globalAuthorityOrder = { ...current, dispatchSequenceWatermark };
          }
          return;
        }
      } else if (order.observation.dispatch.sequence <= current.dispatch.sequence) {
        return;
      }
    }
    this.globalAuthorityOrder = { ...order, dispatchSequenceWatermark };
    this.lastHardDenyResponse = null;
  }

  /** Ordered denials use request order; admitted lease denials use response observation order. */
  private fileGlobalHardDeny(response: BudgetCheckResponse, order: GlobalAuthorityOrder): void {
    if (order.kind === "suppressed") return;
    if (order.kind === "ordered") {
      const current = this.globalAuthorityOrder;
      if (current !== null) {
        const currentDispatchSequence =
          current.kind === "lease" ? current.dispatchSequenceWatermark : current.dispatch.sequence;
        if (
          order.dispatch.sequence < currentDispatchSequence ||
          (order.dispatch.sequence === currentDispatchSequence &&
            this.lastHardDenyResponse !== null)
        ) {
          return;
        }
      }
      if (
        this.completedOrderedGlobalAuthoritySequence === null ||
        order.dispatch.sequence > this.completedOrderedGlobalAuthoritySequence
      ) {
        this.completedOrderedGlobalAuthoritySequence = order.dispatch.sequence;
      }
      this.globalAuthorityOrder = order;
      this.lastHardDenyResponse = response;
      return;
    }

    const current = this.globalAuthorityOrder;
    if (order.kind === "fallback") {
      if (current !== null) {
        // A no-run scoped fallback is weaker than lease authority observed after the
        // fallback was dispatched, even when that lease request itself began earlier.
        const currentSequence =
          current.kind === "lease"
            ? current.observation.observedSequence
            : current.dispatch.sequence;
        if (
          order.dispatch.sequence < currentSequence ||
          (order.dispatch.sequence === currentSequence && this.lastHardDenyResponse !== null)
        ) {
          return;
        }
      }
      this.acceptedFallbackGlobalClearSequence = order.dispatch.sequence;
      this.globalAuthorityOrder = order;
      // The fallback barrier advances independently; a stronger retained payload wins.
      if (this.lastHardDenyResponse === null) this.lastHardDenyResponse = response;
      return;
    }

    let dispatchSequenceWatermark = order.dispatchSequenceWatermark;
    if (current !== null) {
      if (current.kind === "lease") {
        if (current.dispatchSequenceWatermark > dispatchSequenceWatermark) {
          dispatchSequenceWatermark = current.dispatchSequenceWatermark;
        }
        if (order.observation.observedSequence < current.observation.observedSequence) {
          if (dispatchSequenceWatermark !== current.dispatchSequenceWatermark) {
            this.globalAuthorityOrder = { ...current, dispatchSequenceWatermark };
          }
          return;
        }
      }
      if (
        current.kind === "ordered" &&
        order.observation.dispatch.sequence < current.dispatch.sequence
      ) {
        return;
      }
      if (current.kind === "fallback" && current.dispatch.sequence > dispatchSequenceWatermark) {
        // The fallback payload is deliberately weaker, but its later dispatch still
        // fences ordered work that was already pending when the lease denial arrived.
        dispatchSequenceWatermark = current.dispatch.sequence;
      }
    }
    this.globalAuthorityOrder = { ...order, dispatchSequenceWatermark };
    this.lastHardDenyResponse = response;
  }

  /** Server-priced chain identity. Estimates, timeout, and run id are deliberately excluded. */
  private allowCacheKey(options: CheckBudgetOptions): string {
    return JSON.stringify([
      options.provider,
      options.model,
      options.fallbackProviders ?? [],
      options.fallbackModels ?? [],
      options.modality ?? "text",
    ]);
  }

  /** Global allows are authoritative only for unscoped, untagged checks. */
  private allowCacheEligible(options: CheckBudgetOptions): boolean {
    return (
      options.agentRunId === undefined && (options.tags === null || options.tags === undefined)
    );
  }

  /** Read, validate, and touch one cache entry without crossing an async boundary. */
  private cachedAllow(cacheKey: string, options: CheckBudgetOptions): BudgetCheckResponse | null {
    if (!this.allowCacheEligible(options)) {
      return null;
    }
    const entry = this.allowCache.get(cacheKey);
    if (entry === undefined) {
      return null;
    }
    if (!entry.response.allowed || this.now() >= entry.expiresAt) {
      this.allowCache.delete(cacheKey);
      return null;
    }
    this.allowCache.delete(cacheKey);
    this.allowCache.set(cacheKey, entry);
    return entry.response;
  }

  /** Store one unscoped allow as MRU and evict oldest chains past the bounded cap. */
  private storeAllow(
    cacheKey: string,
    response: BudgetCheckResponse,
    options: CheckBudgetOptions,
  ): void {
    if (!this.allowCacheEligible(options)) {
      return;
    }
    this.allowCache.delete(cacheKey);
    this.allowCache.set(cacheKey, {
      response,
      expiresAt: this.now() + this.cacheTtl * 1000,
    });
    while (this.allowCache.size > ALLOW_CACHE_MAX_ENTRIES) {
      const oldest = this.allowCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.allowCache.delete(oldest);
    }
  }

  /** File a fresh run denial as MRU, stamping its response-observation epoch exactly once. */
  private fileRunHardDeny(
    agentRunId: string,
    response: BudgetCheckResponse,
    observedAt = this.monotonicNow(),
  ): void {
    this.runHardDenyResponses.delete(agentRunId);
    this.runHardDenyResponses.set(agentRunId, {
      response,
      observedAt,
    });
    while (this.runHardDenyResponses.size > MAX_STICKY_RUN_DENIALS) {
      const oldest = this.runHardDenyResponses.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.runHardDenyResponses.delete(oldest);
    }
  }

  /** Build a hard-deny result for a fresh server verdict. */
  private liveHardDenyResult(
    response: BudgetCheckResponse,
    activeAgentRunId: string | undefined,
  ): MaterializedBudgetCheckResult {
    return budgetCheckResult({
      allowed: false,
      remainingBudget: response.remaining_budget,
      projectId: response.project_id ?? null,
      mode: response.mode,
      warning: `Budget exceeded: $${money(response.current_usage)}/$${money(response.budget_limit)} used`,
      budgetLimit: response.budget_limit,
      currentUsage: response.current_usage,
      failoverTuningAllowed: response.failover_directive?.failover_tuning_allowed ?? null,
      deniedByPeriod: response.denied_by_period ?? null,
      denySource: "server",
      denyReason: stickyDenyReason(response, activeAgentRunId),
    });
  }

  /**
   * The cloud-unreachable decision tree. Precedence (behaviors 8–12):
   *   1. A remembered hard deny wins FIRST — never re-opened, regardless of `failOpen`
   *      or the configured `budgetMode` (invariant 9, the milestone's soul).
   *   2. `failOpen` → allow, accruing the fallback estimate into local spend.
   *   3. `failOpen:false` → local enforcement against the last-known limit (fail-closed
   *      when no cloud contact ever succeeded).
   */
  private handleOutage(
    estimatedInputTokens: number,
    agentRunId: string | undefined,
  ): MaterializedBudgetCheckResult {
    // 1. Sticky hard deny — checked BEFORE fail-open / local enforcement.
    const globalSticky = this.lastHardDenyResponse;
    if (globalSticky !== null) {
      return this.priorHardDenyUnavailableResult(globalSticky, agentRunId);
    }
    if (agentRunId !== undefined) {
      const runSticky = this.runHardDenyResponses.get(agentRunId);
      if (runSticky !== undefined) {
        this.runHardDenyResponses.delete(agentRunId);
        this.runHardDenyResponses.set(agentRunId, runSticky);
        return this.priorHardDenyUnavailableResult(runSticky.response, agentRunId);
      }
      const retained = this.readTermination(agentRunId);
      if (retained.isPresent) {
        const warning = "Cloud API unreachable; preserving retained run stop";
        this.logger.warn(warning);
        const budgetLimit = this.lastKnownBudgetLimit ?? 0;
        const currentUsage = this.lastKnownCurrentUsage ?? 0;
        return budgetCheckResult({
          allowed: false,
          remainingBudget: Math.max(0, budgetLimit - currentUsage),
          mode: "hard_deny",
          warning,
          budgetLimit,
          currentUsage,
          deniedByPeriod: "run_stopped",
          denySource: "sticky_replay",
          denyReason: retained.resolution?.reason ?? "run_stopped",
        });
      }
    }

    const estimatedCost = DEFAULT_COST_PER_TOKEN * estimatedInputTokens;

    // 2. Fail-open — proceed, but still accrue local spend.
    if (this.failOpen) {
      // Critical section: single synchronous accumulate (no `await`).
      this.trackLocalCost(estimatedCost);
      return budgetCheckResult({
        allowed: true,
        remainingBudget: 0,
        mode: this.budgetMode,
        warning: "Cloud API unreachable; proceeding in fail-open mode",
      });
    }

    // 3. Fail-closed local enforcement.
    const limit = this.lastKnownBudgetLimit;
    if (limit === null) {
      // Behavior 12a: no cloud contact ever succeeded → deny.
      return budgetCheckResult({
        allowed: false,
        remainingBudget: 0,
        mode: this.budgetMode,
        warning: "Cloud unreachable and no prior budget limit known; denying request (fail-closed)",
        denySource: "local_enforcement",
        denyReason: "no_prior_budget_limit",
      });
    }

    // Critical section: read current spend, decide, and (on allow) accumulate — all
    // synchronous, no `await` between the read and the write.
    const current = this.getLocalCurrentSpend();
    if (current + estimatedCost > limit) {
      // Behavior 12b (deny branch): budgetLimit/currentUsage are the known limit/spend.
      return budgetCheckResult({
        allowed: false,
        remainingBudget: Math.max(0, limit - current),
        mode: this.budgetMode,
        warning: `Cloud unreachable; local enforcement denies: $${money(current)} + $${money(estimatedCost)} > $${money(limit)}`,
        budgetLimit: limit,
        currentUsage: current,
        denySource: "local_enforcement",
        denyReason: "local_budget_exceeded",
      });
    }

    // Behavior 12b (allow branch): track the estimated cost (side effect on allow only).
    this.trackLocalCost(estimatedCost);
    return budgetCheckResult({
      allowed: true,
      remainingBudget: Math.max(0, limit - current - estimatedCost),
      mode: this.budgetMode,
      warning: "Cloud API unreachable; enforcing locally",
      budgetLimit: limit,
      currentUsage: current + estimatedCost,
    });
  }

  /** Replay one sticky deny during an outage and emit the required warning every time. */
  private priorHardDenyUnavailableResult(
    response: BudgetCheckResponse,
    activeAgentRunId: string | undefined,
  ): MaterializedBudgetCheckResult {
    const warning = `Cloud API unreachable; preserving prior hard deny: $${money(response.current_usage)}/$${money(response.budget_limit)} used`;
    this.logger.warn(warning);
    return budgetCheckResult({
      allowed: false,
      remainingBudget: response.remaining_budget,
      projectId: response.project_id ?? null,
      reservationId: null,
      mode: response.mode,
      warning,
      budgetLimit: response.budget_limit,
      currentUsage: response.current_usage,
      priceHints: null,
      failoverTuningAllowed: null,
      deniedByPeriod: response.denied_by_period ?? null,
      denySource: "sticky_replay",
      denyReason: stickyDenyReason(response, activeAgentRunId),
    });
  }

  // -------------------------------------------------------------------------
  // Local cost tracking (per UTC calendar day).
  // -------------------------------------------------------------------------

  /**
   * Accumulate `cost` into the current UTC-day bucket. Multiple calls ADD (never
   * overwrite) within the same day (behavior 13). Synchronous read-modify-write — the
   * single-threaded event loop guarantees no lost update (replaces Python's mutex).
   */
  private trackLocalCost(cost: number): void {
    const key = this.todayKey();
    this.localCosts.set(key, (this.localCosts.get(key) ?? 0) + cost);
  }

  /** The current UTC calendar day as `YYYY-MM-DD` (behavior 13). */
  private todayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // Lifecycle.
  // -------------------------------------------------------------------------

  /** A run owner became unreachable: the run can retire once nothing else owns its state. */
  private onRunOwnerCollected(runId: string): void {
    if (this.closed) return;
    const remaining = (this.runOwnerCounts.get(runId) ?? 1) - 1;
    if (remaining > 0) {
      this.runOwnerCounts.set(runId, remaining);
      return;
    }
    this.runOwnerCounts.delete(runId);
    const state = this.leaseLedger.stateFor(runId);
    if (state !== null && this.unmanagedStates.has(state)) return;
    this.orphanedRuns.add(runId);
    this.retireOrphanedRun(runId);
  }

  /**
   * Evaluate ONE run. Called only when that run's state mutates (owner loss, reservation
   * settlement or release, renewal or grant completion, a finished surrender); admission and
   * settlement never walk the orphan set.
   */
  private retireOrphanedRun(runId: string, fromBacklog = false): void {
    if (
      this.closed ||
      !this.orphanedRuns.has(runId) ||
      this.retiringRuns.has(runId) ||
      this.runOwnerCounts.has(runId) ||
      this.pendingUnmanagedRuns.has(runId) ||
      this.initialGrantInFlight.has(runId)
    )
      return;
    const state = this.leaseLedger.stateFor(runId);
    if (state === null) {
      this.orphanedRuns.delete(runId);
      this.uncountedEpisodes.delete(runId);
      return;
    }
    if (this.unmanagedStates.has(state)) return;
    // Reservation/renewal owners are independent of frame reachability. In particular,
    // a detached renewal may outlive the final provider call's captured run snapshot.
    // Their completion re-evaluates this run.
    if (state.reservations.size > 0 || state.renewalInFlight || state.pendingReport !== null)
      return;
    if (state.leaseId === null) {
      // Without a lease nothing can be surrendered; spent_tokens is advisory (confirms settle).
      this.discardRetiredRun(runId, state);
      return;
    }
    if (!fromBacklog && (this.retirementBacklog.size > 0 || !this.releases.hasFreeWorker)) {
      this.retirementBacklog.add(runId);
      return;
    }
    const request = this.leaseLedger.buildSurrenderRequest(runId);
    if (request === null) return;
    this.retirementBacklog.delete(runId);
    const marker = {};
    this.retiringRuns.set(runId, marker);
    this.releases.submit(request, {
      onOutcome: (outcome) => this.finishRetirement(runId, state, request, marker, outcome),
    });
  }

  /** A worker is free: hand it the oldest retirable run (or several, if more are free). */
  private feedRetirements(): void {
    for (const runId of this.retirementBacklog) {
      if (this.closed || this.releases.pending > 0) return;
      this.retirementBacklog.delete(runId);
      this.retireOrphanedRun(runId, true);
    }
  }

  /** Every outcome ends the retirement: a dropped surrender is never relaunched. */
  private finishRetirement(
    runId: string,
    state: LeaseState,
    request: LeaseSurrenderRequest,
    marker: object,
    outcome: ReleaseOutcome,
  ): void {
    if (this.retiringRuns.get(runId) === marker) this.retiringRuns.delete(runId);
    if (this.closed) return;
    const sent = outcome.kind === "sent";
    if (
      this.unmanagedStates.has(state) ||
      this.leaseLedger.stateFor(runId) !== state ||
      state.reservations.size > 0 ||
      state.renewalInFlight ||
      state.spentTokensSinceReport !== request.spent_tokens
    ) {
      // A revived identity keeps its state; a released lease is never reused locally.
      if (sent) this.leaseLedger.acknowledgeSurrender(runId, request);
      this.retireOrphanedRun(runId);
      return;
    }
    this.discardRetiredRun(runId, state);
  }

  /**
   * Send the release owed by an ineligible renewal. Until its outcome arrives the run takes
   * per-call checks; a sent release lets the next eligible call grant again, and any other
   * outcome leaves the 150 s latch counted from the refusal. The pending release never blocks
   * retirement.
   */
  private releaseRefusedLease(runId: string): void {
    const pending = this.leaseLedger.stateFor(runId)?.releasePending ?? null;
    if (pending === null) return;
    const { request, token } = pending;
    this.releases.submit(request, {
      onOutcome: (outcome) => {
        // Never creates state: a retired run, a newer refusal or a closing client ignores it.
        if (this.closed) return;
        this.leaseLedger.resolveRefusalRelease(runId, token, outcome.kind === "sent");
      },
    });
  }

  /** Discard a finished run as an ordinary orphan, folding any uncounted tallies first. */
  private discardRetiredRun(runId: string, state: LeaseState): void {
    if (state.uncountedCalls > 0 || state.uncountedTokens > 0) {
      this.noteDiscardedUncounted(1, state.uncountedCalls, state.uncountedTokens);
    }
    this.leaseLedger.discard(runId);
    this.orphanedRuns.delete(runId);
    this.retirementBacklog.delete(runId);
    this.uncountedEpisodes.delete(runId);
  }

  /** Uncounted tallies travel only on renewals; a finished run's are aggregated and logged. */
  private noteDiscardedUncounted(runs: number, calls: number, tokens: number): void {
    for (const aggregate of [this.unreportedUncounted, this.totalUncounted]) {
      aggregate.runs = saturatingAdd(aggregate.runs, runs);
      aggregate.calls = saturatingAdd(aggregate.calls, calls);
      aggregate.tokens = saturatingAdd(aggregate.tokens, tokens);
    }
    if (this.uncountedWarnScheduled || this.closed) return;
    const last = this.lastUncountedWarnAt;
    if (last !== null && this.monotonicNow() - last < UNCOUNTED_WARN_INTERVAL_MS) return;
    // One microtask aggregates a synchronous burst; no timer is ever started.
    this.uncountedWarnScheduled = true;
    queueMicrotask(() => {
      this.uncountedWarnScheduled = false;
      const pending = this.unreportedUncounted;
      if (pending.runs === 0 || this.closed) return;
      this.lastUncountedWarnAt = this.monotonicNow();
      this.logger.warn(
        "lease.uncounted_discarded: %d finished runs held %d UNCOUNTED fail-open calls (%d estimated tokens) that no renewal can report",
        pending.runs,
        pending.calls,
        pending.tokens,
      );
      pending.runs = 0;
      pending.calls = 0;
      pending.tokens = 0;
    });
  }

  /** Count a dropped surrender and emit at most one aggregate WARN per interval. */
  private noteReleaseDrop(reason: ReleaseDropReason): void {
    this.unreportedDrops.set(reason, saturatingAdd(this.unreportedDrops.get(reason) ?? 0, 1));
    if (this.dropWarnScheduled || this.closeDraining) return;
    const last = this.lastDropWarnAt;
    if (last !== null && this.monotonicNow() - last < UNCOUNTED_WARN_INTERVAL_MS) return;
    this.dropWarnScheduled = true;
    queueMicrotask(() => {
      this.dropWarnScheduled = false;
      if (this.unreportedDrops.size === 0 || this.closeDraining) return;
      this.lastDropWarnAt = this.monotonicNow();
      this.logger.warn(
        "lease.surrenders_dropped: %s; unspent reserved tokens return when the leases expire",
        this.formatDrops(this.unreportedDrops),
      );
      this.unreportedDrops.clear();
    });
  }

  private formatDrops(drops: ReadonlyMap<ReleaseDropReason, number>): string {
    const parts: string[] = [];
    for (const reason of RELEASE_DROP_REASONS) {
      const count = drops.get(reason) ?? 0;
      if (count > 0) parts.push(`${reason}=${count}`);
    }
    return parts.length === 0 ? "none" : parts.join(" ");
  }

  private renewalKey(operation: RenewalOperation): string {
    return JSON.stringify([operation.runId, operation.originLeaseId, operation.originGeneration]);
  }

  private lateSpendFor(operation: RenewalOperation): number {
    const key = this.renewalKey(operation);
    const spent = this.lateRenewalSpend.get(key) ?? 0;
    this.lateRenewalSpend.delete(key);
    return spent;
  }

  private surrenderLateGrantResponse(response: LeaseGrantResponse): void {
    this.surrenderLateSuccessor(response, 0);
  }

  private surrenderLateSuccessor(response: LeaseGrantResponse, spentTokens: number): void {
    if (!response.eligible || !response.allowed || !isInstallableLeaseGrantResponse(response))
      return;
    const leaseId = response.lease_id;
    const generation = response.generation;
    const parsed = LeaseSurrenderRequestSchema.safeParse({
      lease_id: leaseId,
      holder_id: this.leaseLedger.holderId,
      generation,
      spent_tokens: Math.max(0, spentTokens),
    });
    if (!parsed.success) return;
    this.queueSurrender(parsed.data);
  }

  /** Late successors use the same bounded dispatcher, before, during and after close. */
  private queueSurrender(request: LeaseSurrenderRequest): void {
    this.releases.submit(request);
  }

  /**
   * One surrender attempt for the dispatcher. Payload setup failures skip the breaker; HTTP
   * answers (4xx, 503, read-only key) record breaker success, while transport failures and
   * other 5xx record failure. Only a timeout is retried, by the dispatcher.
   */
  private async attemptSurrender(
    request: LeaseSurrenderRequest,
    timeoutMs: number,
  ): Promise<ReleaseAttempt> {
    let body: Record<string, unknown>;
    try {
      const parsed = LeaseSurrenderRequestSchema.safeParse(request);
      if (!parsed.success || timeoutMs <= 0) return { result: "setup_failed", settled: null };
      body = serializeLeaseSurrenderRequest(parsed.data);
    } catch {
      return { result: "setup_failed", settled: null };
    }
    const admission: CircuitBreakerAdmission | null = this.controlPlaneBreaker?.admit() ?? null;
    let settled: Promise<unknown> | null = null;
    try {
      if (admission !== null && !admission.allowed) {
        this.logger.debug("lease.surrender_skipped_breaker_open");
        return { result: "breaker_open", settled: null };
      }
      const capture: { raw: Promise<unknown> | null } = { raw: null };
      let posting: Promise<Response>;
      this.rawFetchCapture = capture;
      try {
        posting = this.transport.postJson(LEASE_SURRENDER_PATH, body, { timeoutMs });
      } finally {
        this.rawFetchCapture = null;
      }
      settled = capture.raw;
      try {
        await posting;
        this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
        return { result: "sent", settled };
      } catch (error) {
        if (transportErrorLabel(error) === null) {
          this.logger.debug("lease.surrender_failed: local_error");
          return { result: "local_error", settled };
        }
        const status = error instanceof TransportHttpError ? error.status : null;
        const responded =
          isReadOnlyKeyError(error) ||
          status === 503 ||
          (status !== null && status >= 400 && status < 500);
        if (responded) this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
        else this.controlPlaneBreaker?.recordFailure(admission ?? undefined);
        if (isReadOnlyKeyError(error)) handleReadOnlyKeyError(error, this.logger);
        this.logger.debug("lease.surrender_failed: status=%s", status);
        if (status !== null) return { result: "refused", settled };
        if (error instanceof TransportTimeoutError) return { result: "timeout", settled };
        return { result: "unreachable", settled };
      }
    } finally {
      this.controlPlaneBreaker?.releaseProbe(admission);
    }
  }

  private remainingBefore(deadline: number): number {
    return Math.max(0, deadline - this.monotonicNow());
  }

  private async awaitBefore(promise: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = this.remainingBefore(deadline);
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
    });
    try {
      return await Promise.race([
        promise.then(
          () => true,
          () => true,
        ),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async finishClose(deadline: number, drainedUncounted: UncountedAggregate): Promise<void> {
    await this.awaitBefore(Promise.allSettled([...this.renewalOperations]), deadline);
    await this.awaitBefore(this.releases.whenIdle(), deadline);
    const left = this.releases.dropCloseTimeQueued();
    this.closeDraining = false;
    const inFlight = this.releases.active;
    const uncounted = this.totalUncounted;
    const drops = new Map<ReleaseDropReason, number>();
    const dropped = this.releases.counts().dropped;
    for (const reason of RELEASE_DROP_REASONS) drops.set(reason, dropped[reason]);
    this.unreportedDrops.clear();
    this.unreportedUncounted.runs = 0;
    this.unreportedUncounted.calls = 0;
    this.unreportedUncounted.tokens = 0;
    const anyDrop = [...drops.values()].some((count) => count > 0);
    if (left === 0 && inFlight === 0 && !anyDrop && uncounted.runs === 0) return;
    this.logger.warn(
      "lease.close_release_summary: shutdown_deadline=%d in_flight=%d dropped=[%s] uncounted_runs=%d uncounted_calls=%d uncounted_tokens=%d (closed with %d runs holding uncounted tallies)",
      left,
      inFlight,
      this.formatDrops(drops),
      uncounted.runs,
      uncounted.calls,
      uncounted.tokens,
      drainedUncounted.runs,
    );
  }

  /** Drain all lease authority and surrender it under one absolute monotonic deadline. */
  close(timeoutMs = DEFAULT_SURRENDER_TIMEOUT_MS): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;

    // One synchronous lifecycle section: close fencing precedes every async boundary.
    this.closed = true;
    this.closeDraining = true;
    this.closeEpoch += 1;
    for (const delta of this.leaseLedger.pendingRenewalSpendDeltas()) {
      this.lateRenewalSpend.set(
        JSON.stringify([delta.runId, delta.leaseId, delta.generation]),
        delta.spentTokens,
      );
    }
    const drainedUncounted = this.leaseLedger.uncountedTallies();
    this.noteDiscardedUncounted(
      drainedUncounted.runs,
      drainedUncounted.calls,
      drainedUncounted.tokens,
    );
    // Runs already retiring have their surrender queued or active; merging dedupes the rest.
    const requests = this.leaseLedger.drainSurrenderRequests(new Set(this.retiringRuns.keys()));
    this.uncountedEpisodes.clear();
    this.runOwnerCounts.clear();
    this.orphanedRuns.clear();
    this.retirementBacklog.clear();
    this.pendingUnmanagedRuns.clear();

    const deadline = this.monotonicNow() + Math.max(0, timeoutMs);
    // FIFO and uncapped in count; one attempt each within the close deadline.
    this.releases.clampForClose(deadline);
    for (const request of requests) this.releases.submit(request, { deadline, closeTime: true });
    this.closePromise = this.finishClose(deadline, drainedUncounted);
    return this.closePromise;
  }

  /** Whether {@link close} has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** `await using enforcer = new BudgetEnforcer(...)` runs the same {@link close}. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
