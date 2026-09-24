/**
 * The metadata / confirm reporter.
 *
 * Batches and flushes two kinds of content-free telemetry to the Solwyn Cloud API
 * WITHOUT ever blocking or throwing into the LLM call path:
 * - `MetadataEvent`s → `POST /api/v1/metadata/ingest` (a JSON *array* per POST).
 * - `BudgetConfirmRequest`s → `POST /api/v1/budgets/confirm` (one object per POST).
 *
 * It is a bounded, drop-oldest, best-effort background sender: `report*` is
 * synchronous and non-blocking, all HTTP I/O happens on the periodic flush loop,
 * and every failure mode (network error, 4xx/5xx, malformed 202 body, a raising
 * log stack) is caught, logged by exception CLASS NAME ONLY, and swallowed.
 * Retryable failures are parked in strict FIFO order with bounded attempts and
 * deterministic backoff; terminal/exhausted loss is synchronously accounted.
 *
 * Per CLAUDE.md ("one async client — JS is async-native") this is the single
 * reporter class, modeled on Python's `AsyncMetadataReporter`.
 *
 * Privacy: this module never touches prompt/response content — `MetadataEvent` /
 * `BudgetConfirmRequest` are pure metadata by construction. It is deliberately NOT
 * a content-privileged module and must never be extended to accept a content field.
 */

import { ZodError } from "zod";
import type {
  CircuitBreaker,
  CircuitBreakerAdmission,
  CircuitBreakerState,
} from "./circuit-breaker";
import { ConfigurationError, SolwynError } from "./errors";
import { createEventTimestampAllocator } from "./event-timestamp";
import type { Logger } from "./logging";
import { bestEffortLogger, escapeControlChars, noopLogger } from "./logging";
import { handleReadOnlyKeyError, isReadOnlyKeyError } from "./read-only-key";
import {
  buildReceiptReplayEvents,
  ORDINARY_TOKEN_COUNT_MAX,
  ReceiptFoldState,
} from "./receipt-fold";
import { runOutsideRun } from "./run-context";
import {
  BUDGET_CONFIRM_PATH,
  type FetchLike,
  isRetryableTransportError,
  METADATA_INGEST_PATH,
  requireFetchLike,
  Transport,
  TransportError,
  TransportHttpError,
  TransportNetworkError,
  TransportTimeoutError,
} from "./transport";
import type { BudgetConfirmRequest, MetadataEvent } from "./types";
import {
  BreakerStateReportSchema,
  BudgetConfirmRequestSchema,
  MetadataEventSchema,
  serializeBudgetConfirmRequest,
  serializeMetadataEvent,
} from "./validation";

// ---------------------------------------------------------------------------
// Constants (reporter.md — exact values).
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_IN_FLIGHT = 3;
/** Confirm and settlement queues are each bounded at this (not user-configurable). */
const CONFIRM_SETTLEMENT_QUEUE_MAX = 1000;
/** Consecutive confirm-POST failures before ERROR-level escalation. */
const CONFIRM_FAILURE_THRESHOLD = 10;
/** Consecutive malformed-202-body responses before ERROR-level escalation. */
const UNPARSEABLE_RESPONSE_THRESHOLD = 10;
/** Ingest client-level timeout (Python `httpx` `timeout=10.0`). */
const INGEST_TIMEOUT_MS = 10_000;
/** Confirm per-request timeout (Python explicit `timeout=5.0`). */
const CONFIRM_TIMEOUT_MS = 5000;
/** Provider breaker-state report per-request timeout. */
const BREAKER_REPORT_TIMEOUT_MS = 5000;
/** Private edge-safe handshake installed only by the dedicated `./node` entry. */
const NODE_REPORTER_REGISTRATION = Symbol.for("@solwyn/sdk/node-reporter-registration");

type BreakerSnapshot = readonly [provider: string, state: CircuitBreakerState];

/**
 * Reporters that currently own queued, in-flight or retry work, unlogged drops or an
 * active breaker cycle. This set is the only strong root the flush cadence needs: an
 * idle reporter's pending tick holds it through a WeakRef, so a client dropped
 * without close() is collected (and its cadence stops) once its work is delivered.
 */
const reportersWithWork = new Set<MetadataReporter>();

/** The flush tick's reference to its reporter: weak where WeakRef exists, else strong. */
type TickTarget =
  | { readonly weak: WeakRef<MetadataReporter> }
  | { readonly strong: MetadataReporter };

/**
 * Arm one unref'd flush tick. Built at module level so the timer callback closes over
 * nothing but `target`; a closure created inside the reporter would root it.
 */
function armFlushTick(target: TickTarget, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const reporter = "weak" in target ? target.weak.deref() : target.strong;
    reporter?._tick();
  }, ms);
  // The flush cadence must never keep the Node event loop alive on its own: a process
  // that never calls close() must still be able to exit. `unref` is Node-only; web/edge
  // timers lack it, so the optional call is a no-op there.
  (timer as { unref?: () => void })?.unref?.();
  return timer;
}

export type SendOutcome = "sent" | "held" | "retry" | "dropped";
export type IngestRejectionKind = "clean" | "exact" | "legacy" | "malformed";

export interface IngestRejections {
  readonly kind: IngestRejectionKind;
  readonly indexes: readonly number[];
  readonly count: number;
}

export interface BatchSendResult {
  readonly outcome: SendOutcome;
  readonly rejections: IngestRejections;
}

const MALFORMED_REJECTIONS: IngestRejections = Object.freeze({
  kind: "malformed",
  indexes: Object.freeze([]),
  count: 0,
});

// ---------------------------------------------------------------------------
// Errors used to drive the "actively throw on a malformed 202 body" path.
// JS never throws on a missing object key (it yields `undefined`), so the port
// must throw explicitly to keep the catch-and-count path firing. Exact class-name
// parity with Python (`KeyError`/`ValueError`) is NOT a contract — only the
// class-name-only, count-at-10 semantics are.
// ---------------------------------------------------------------------------

/** A 202 body parsed as valid JSON but violating the ingest-response contract. */
export class RejectionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RejectionContractError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// A bounded, FIFO, drop-oldest queue.
// ---------------------------------------------------------------------------

/**
 * FIFO queue with a hard cap. Ordinary push overflow drops the OLDEST item;
 * restoration of previously owned work has the documented newest-suffix
 * exception below. Prefix drains preserve insertion order.
 */
class BoundedQueue<T> {
  private items: T[] = [];

  constructor(private readonly maxSize: number) {}

  get length(): number {
    return this.items.length;
  }

  /** Append and return the evicted oldest entry, when capacity was already full. */
  push(item: T, bypassCapacity = false): T | undefined {
    const evicted =
      !bypassCapacity && this.items.length >= this.maxSize ? this.items.shift() : undefined;
    this.items.push(item);
    return evicted;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  /**
   * Restore a previously owned FIFO prefix while retaining the hard cap.
   *
   * Ordinary push overflow remains drop-oldest. Restoration is the deliberate
   * exception: the claimed prefix already owns the oldest positions, so a
   * concurrent refill's NEWEST suffix is evicted after the prefix is restored.
   * Returned evictions preserve their oldest-to-newest order.
   */
  restorePrefix(prefix: readonly T[]): T[] {
    this.items.unshift(...prefix);
    if (this.items.length <= this.maxSize) return [];
    return this.items.splice(this.maxSize);
  }

  /** Remove and return up to `n` oldest items (fewer if the queue is smaller). */
  drainUpTo(n: number): T[] {
    return this.items.splice(0, n);
  }

  /** Remove one matching FIFO prefix with a single array reindex. */
  drainWhileUpTo(n: number, predicate: (item: T) => boolean): T[] {
    let count = 0;
    for (const item of this.items) {
      if (count >= n || !predicate(item)) break;
      count += 1;
    }
    return this.items.splice(0, count);
  }

  /** Remove and return every item, oldest-first, emptying the queue. */
  drainAll(): T[] {
    return this.items.splice(0);
  }
}

/** A settlement is a confirm + its paired success event, flushed as one unit. */
interface Settlement {
  confirm: PendingConfirm;
  event: MetadataEvent;
}

interface Pending<T> {
  item: T;
  attempts: number;
  nextAttemptAt: number;
}

interface ProjectedEvent {
  canonical: MetadataEvent;
  wire: Record<string, unknown>;
}

interface PendingEvent extends Pending<MetadataEvent> {
  projection: ProjectedEvent | null;
}

interface ProjectedConfirm {
  canonical: BudgetConfirmRequest;
  wire: Record<string, unknown>;
}

type ProjectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

interface PendingConfirm extends Pending<BudgetConfirmRequest> {
  projection: ProjectedConfirm | null;
}

interface ConfirmAttemptResult {
  outcome: SendOutcome;
  error?: unknown;
  diagnosticRecorded?: boolean;
  /** Read-only-key skips are terminal but do not alter the confirm-failure diagnostic. */
  counterNeutral?: boolean;
}

interface ConfirmCycle {
  lastVerdict:
    | { readonly outcome: "sent" }
    | { readonly outcome: "failed"; error: unknown; diagnosticRecorded: boolean }
    | null;
}

/** Out-parameter for one ordinary delivery round. */
export interface FlushRound {
  /** True only when a stage exhausted its turn with due work still queued. */
  more: boolean;
}

interface EventStageResult {
  readonly clean: boolean;
  readonly more: boolean;
}

interface EventDispositionOptions {
  readonly emit?: boolean;
  readonly forceTerminal?: boolean;
}

/** One aggregated rejection group `(code, model)` → count + first message. */
interface RejectionGroup {
  code: string;
  model: string;
  count: number;
  message: string;
}

/** Construction options for {@link MetadataReporter}. */
export interface MetadataReporterOptions {
  /** Max events per ingest POST (default 50). */
  batchSize?: number;
  /** Background flush period in ms (default 5000). */
  flushInterval?: number;
  /** Metadata queue cap; drop-oldest on overflow (default 10_000). */
  maxQueueSize?: number;
  /**
   * Accepted and retained, but currently has no effect: confirms and ingest
   * batches are sent serially, one request at a time (default 3).
   */
  maxInFlight?: number;
  /** Total send attempts before a retryable item is disposed (default 5). */
  maxSendAttempts?: number;
  /** Retry backoff base in milliseconds (default 1000). */
  retryBackoffBase?: number;
  /** Retry backoff cap in milliseconds (default 60000). */
  retryBackoffCap?: number;
  /** Shared close deadline budget in milliseconds (default 5000). */
  shutdownDeadline?: number;
  /** Full breaker-report refresh heartbeat in milliseconds (default 60000). */
  breakerReportHeartbeat?: number;
  /** Injectable `fetch` (tests). */
  fetch?: FetchLike;
  /** Injectable logger (default no-op). */
  logger?: Logger;
  /** Shared check/confirm control-plane breaker; null/absent disables admission. */
  controlPlaneBreaker?: CircuitBreaker | null;
  /** Lazily collect provider breaker snapshots for the current cycle. */
  breakerSnapshots?: (() => readonly BreakerSnapshot[]) | null;
  /** Stable SDK instance identity included in every breaker report. */
  sdkInstanceId?: string | null;
  /** Whether provider breaker reporting is enabled (default true). */
  breakerReportingEnabled?: boolean;
  /** Injectable wall clock used once per breaker cycle. */
  wallClock?: () => Date;
  /** Injectable monotonic millisecond clock for retry/lifecycle tests. */
  monotonicClock?: () => number;
  /** Internal test seam for the confirm and settlement queue bound (default 1000). */
  controlQueueMaxSize?: number;
}

/**
 * Class-name-only diagnostic for a caught value. NEVER returns the message/body
 * (privacy guarantee — the sole log-safe projection of any thrown value).
 */
function exceptionName(error: unknown): string {
  try {
    if (error instanceof ZodError) return "ZodError";
    if (error instanceof ConfigurationError) return "ConfigurationError";
    if (error instanceof RejectionContractError) return "RejectionContractError";
    if (error instanceof TransportHttpError) return "TransportHttpError";
    if (error instanceof TransportNetworkError) return "TransportNetworkError";
    if (error instanceof TransportTimeoutError) return "TransportTimeoutError";
    if (error instanceof TransportError) return "TransportError";
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof SolwynError) return "SolwynError";
    if (error instanceof Error) return "Error";
  } catch {
    // Hostile/revoked values may throw from prototype inspection. Fall through
    // to a fixed primitive/object label without reading any caller-owned field.
  }
  return error === null ? "object" : typeof error;
}

/** Extract only top-level field names from schema issues; never retain messages or values. */
function issueFieldNames(issues: readonly { readonly path: readonly PropertyKey[] }[]): string[] {
  return [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : "<root>"))),
  ];
}

/** Serializer errors may expose an explicitly safe structural field label. */
function projectionErrorFields(error: unknown): string[] {
  if (error instanceof ConfigurationError && error.field) return [error.field];
  return ["<unknown>"];
}

export class MetadataReporter {
  /** Shared by every new ordinary event and receipt replay for this SDK instance. */
  readonly nextEventTimestamp = createEventTimestampAllocator();
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly controlPlaneBreaker: CircuitBreaker | null;
  private readonly breakerSnapshots: (() => readonly BreakerSnapshot[]) | null;
  private readonly sdkInstanceId: string | null;
  private readonly breakerReportingEnabled: boolean;
  private readonly wallClock: () => Date;
  readonly batchSize: number;
  readonly flushInterval: number;
  readonly maxQueueSize: number;
  readonly maxInFlight: number;
  readonly maxSendAttempts: number;
  readonly retryBackoffBase: number;
  readonly retryBackoffCap: number;
  readonly shutdownDeadline: number;
  readonly breakerReportHeartbeat: number;

  private readonly metadataQueue: BoundedQueue<PendingEvent>;
  private readonly confirmQueue: BoundedQueue<PendingConfirm>;
  private readonly settlementQueue: BoundedQueue<Settlement>;
  private readonly receiptFoldState = new ReceiptFoldState();
  private readonly monotonicClock: () => number;
  private readonly dropCounts = new Map<string, number>();
  private lastDropLogAt: number | null = null;
  private lastLoggedDropTotal = 0;
  private finalDeliveryStarted = false;

  private consecutiveConfirmFailures = 0;
  private consecutiveUnparseableResponses = 0;
  private inFlight = 0;

  private shuttingDown = false;
  private deliveryClosed = false;
  private readonly deliveryAbortController = new AbortController();
  private closeDeadline: number | null = null;
  private loopStarted = false;
  private tickTarget: TickTarget | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRound: Promise<void> | null = null;
  private breakerProjectId: string | null = null;
  private activeBreakerCycle: Promise<void> | null = null;
  private activeBreakerAbortController: AbortController | null = null;
  private readonly breakerLastSent = new Map<string, string>();
  private breakerHeartbeatAt = 0;
  /** Consecutive breaker cycles with a failed report; drives the retry backoff. */
  private breakerFailedCycles = 0;
  /** Monotonic time before which cadence rounds launch no breaker cycle. */
  private breakerRetryAt: number | null = null;
  private pendingBreakerSnapshots: readonly BreakerSnapshot[] | null = null;
  private closePromise: Promise<void> | null = null;
  private flushScheduleFailureLogged = false;
  private ownershipToken = 0;
  private readonly inHandConfirms = new Map<number, PendingConfirm>();
  private readonly inHandSettlements = new Map<number, Settlement>();
  private readonly inHandEventBatches = new Map<number, PendingEvent[]>();

  constructor(apiUrl: string, apiKey: string, options: MetadataReporterOptions = {}) {
    requireFetchLike(options.fetch);
    // Transport normalizes the URL (strips ALL trailing slashes) and owns auth.
    this.transport = new Transport(apiUrl, apiKey, { fetch: options.fetch });
    this.logger = bestEffortLogger(options.logger ?? noopLogger);
    this.controlPlaneBreaker = options.controlPlaneBreaker ?? null;
    this.breakerSnapshots = options.breakerSnapshots ?? null;
    this.sdkInstanceId = options.sdkInstanceId ?? null;
    this.breakerReportingEnabled = options.breakerReportingEnabled ?? true;
    this.wallClock = options.wallClock ?? (() => new Date());
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    // Retained for configuration compatibility; delivery is serial and never reads it.
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.maxSendAttempts = options.maxSendAttempts ?? 5;
    this.retryBackoffBase = options.retryBackoffBase ?? 1000;
    this.retryBackoffCap = options.retryBackoffCap ?? 60_000;
    this.shutdownDeadline = options.shutdownDeadline ?? 5000;
    this.breakerReportHeartbeat = options.breakerReportHeartbeat ?? 60_000;
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());

    const invalidPositiveInteger = (value: number): boolean =>
      !Number.isInteger(value) || !Number.isFinite(value) || value < 1;
    const controlQueueMaxSize = options.controlQueueMaxSize ?? CONFIRM_SETTLEMENT_QUEUE_MAX;
    if (invalidPositiveInteger(controlQueueMaxSize)) {
      throw new ConfigurationError("controlQueueMaxSize must be an integer >= 1", {
        field: "controlQueueMaxSize",
      });
    }
    if (invalidPositiveInteger(this.maxQueueSize)) {
      throw new ConfigurationError("maxQueueSize must be an integer >= 1", {
        field: "maxQueueSize",
      });
    }
    if (invalidPositiveInteger(this.maxSendAttempts)) {
      throw new ConfigurationError("maxSendAttempts must be an integer >= 1", {
        field: "maxSendAttempts",
      });
    }
    for (const [field, value] of [
      ["retryBackoffBase", this.retryBackoffBase],
      ["retryBackoffCap", this.retryBackoffCap],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new ConfigurationError(`${field} must be finite and > 0`, { field });
      }
    }
    if (!Number.isFinite(this.shutdownDeadline) || this.shutdownDeadline < 0) {
      throw new ConfigurationError("shutdownDeadline must be finite and >= 0", {
        field: "shutdownDeadline",
      });
    }
    if (!Number.isFinite(this.breakerReportHeartbeat) || this.breakerReportHeartbeat <= 0) {
      throw new ConfigurationError("breakerReportHeartbeat must be finite and > 0", {
        field: "breakerReportHeartbeat",
      });
    }

    this.metadataQueue = new BoundedQueue(this.maxQueueSize);
    this.confirmQueue = new BoundedQueue(controlQueueMaxSize);
    this.settlementQueue = new BoundedQueue(controlQueueMaxSize);

    // The core never imports Node. When `@solwyn/sdk/node` is the selected entry,
    // that module installs a weak registration callback behind this global symbol.
    try {
      const register = Reflect.get(globalThis, NODE_REPORTER_REGISTRATION);
      if (typeof register === "function") Reflect.apply(register, undefined, [this]);
    } catch {
      // Exit rescue is best effort; explicit close()/asyncDispose remains the guarantee.
    }
  }

  // -------------------------------------------------------------------------
  // Observability accessors (tests assert on these).
  // -------------------------------------------------------------------------

  get metadataQueueSize(): number {
    return this.metadataQueue.length;
  }

  get confirmQueueSize(): number {
    return this.confirmQueue.length;
  }

  get settlementQueueSize(): number {
    return this.settlementQueue.length;
  }

  /** Observable shutdown signal (Python `_shutdown_event.is_set()`). */
  get isShutdown(): boolean {
    return this.shuttingDown;
  }

  /** Outstanding in-flight send count (never leaks: decremented in a `finally`). */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Defensive sparse snapshot; retry/disposition drains populate it in A3. */
  get droppedCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.dropCounts);
  }

  /** Learn the project id returned by a budget check; falsy values never erase authority. */
  observeProjectId(projectId: string | null | undefined): void {
    if (projectId) {
      this.breakerProjectId = projectId;
    }
  }

  // -------------------------------------------------------------------------
  // Public enqueue surface — off the call path: never blocks, never throws.
  // -------------------------------------------------------------------------

  /** Enqueue a metadata event; drop-oldest on overflow. */
  report(event: MetadataEvent): void {
    if (this.shuttingDown) {
      this.#disposeEvent(event, "closed_enqueue", true);
      return;
    }
    try {
      this.start();
      this._enqueue(event);
      reportersWithWork.add(this);
    } catch {
      // Enqueue is deliberately nonthrowing. A start/scheduling failure is
      // contained by start() and does not prevent the item from being retained.
    }
  }

  /** Fire-and-forget a confirm; count it when shutdown already owns delivery. */
  reportConfirm(request: BudgetConfirmRequest): void {
    if (this.shuttingDown) {
      this._countDrop("confirm", "closed_enqueue");
      return;
    }
    try {
      this.start();
      const evicted = this.confirmQueue.push(this._pendingConfirm(request));
      reportersWithWork.add(this);
      if (evicted !== undefined) this._countDrop("confirm", "overflow");
    } catch (error) {
      this.logger.warn(`reporter.confirm_enqueue_failed: exc_type=${exceptionName(error)}`);
    }
  }

  /** Fire-and-forget a confirm+event pair; count both halves after close. */
  reportSettlement(request: BudgetConfirmRequest, event: MetadataEvent): void {
    if (this.shuttingDown) {
      this._recordDrop("settlement_confirm", "closed_enqueue");
      this._foldOrRecordEventDrop(event, "closed_enqueue", true);
      this._maybeLogDrops(false);
      return;
    }
    try {
      this.start();
      const evicted = this.settlementQueue.push({ confirm: this._pendingConfirm(request), event });
      reportersWithWork.add(this);
      if (evicted !== undefined) {
        this._recordDrop("settlement_confirm", "overflow");
        this._moveEventToQueue(evicted.event, false);
        this._maybeLogDrops(false);
      }
    } catch (error) {
      this.logger.warn(`reporter.settlement_enqueue_failed: exc_type=${exceptionName(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Sans-I/O internals (independently testable, mirroring `_ReporterBase`).
  // -------------------------------------------------------------------------

  /** Push an event onto the bounded metadata queue. */
  _enqueue(event: MetadataEvent): void {
    this._moveEventToQueue(event);
  }

  /** Pop up to `batchSize` events FIFO (oldest first); remainder stays queued. */
  _drainBatch(): MetadataEvent[] {
    return this.metadataQueue.drainUpTo(this.batchSize).map((pending) => pending.item);
  }

  private _pendingEvent(item: MetadataEvent): PendingEvent {
    return { item, attempts: 0, nextAttemptAt: 0, projection: null };
  }

  private _pendingConfirm(item: BudgetConfirmRequest): PendingConfirm {
    return { item, attempts: 0, nextAttemptAt: 0, projection: null };
  }

  private _moveEventToQueue(event: MetadataEvent, emit = true): void {
    const evicted = this.metadataQueue.push(this._pendingEvent(event), this.finalDeliveryStarted);
    if (evicted === undefined) return;
    this._foldOrRecordEventDrop(evicted.item, "overflow");
    if (emit) this._maybeLogDrops(false);
  }

  private _restoreConfirmPrefix(prefix: readonly PendingConfirm[]): void {
    const evicted = this.confirmQueue.restorePrefix(prefix);
    this._countDrop("confirm", "overflow", evicted.length);
  }

  private _restoreEventPrefix(prefix: readonly PendingEvent[], emit = true): void {
    const evicted = this.metadataQueue.restorePrefix(prefix);
    for (const pending of evicted) {
      this._foldOrRecordEventDrop(pending.item, "overflow");
    }
    if (emit && evicted.length > 0) this._maybeLogDrops(false);
  }

  private _restoreSettlementPrefix(prefix: readonly Settlement[]): void {
    const evicted = this.settlementQueue.restorePrefix(prefix);
    this._recordDrop("settlement_confirm", "overflow", evicted.length);
    for (const settlement of evicted) this._moveEventToQueue(settlement.event, false);
    if (evicted.length > 0) this._maybeLogDrops(false);
  }

  private _recordDrop(kind: string, reason: string, n = 1): void {
    if (n <= 0) return;
    const key = `${kind}.${reason}`;
    this.dropCounts.set(key, (this.dropCounts.get(key) ?? 0) + n);
  }

  private _countDrop(kind: string, reason: string, n = 1): void {
    if (n <= 0) return;
    this._recordDrop(kind, reason, n);
    this._maybeLogDrops(false);
  }

  /** Runtime-safe cardinality for terminal receipt accounting and legacy ranking. */
  private _eventDropWeight(event: MetadataEvent): number {
    try {
      if (event.status !== "budget_denied") return 1;
      const weight = event.receipt_aggregate_count;
      return typeof weight === "number" &&
        Number.isInteger(weight) &&
        weight >= 1 &&
        weight <= ORDINARY_TOKEN_COUNT_MAX
        ? weight
        : 1;
    } catch {
      return 1;
    }
  }

  /** Fold or record one event disposition without invoking the drop logger. */
  private _foldOrRecordEventDrop(
    event: MetadataEvent,
    reason: string,
    forceTerminal = false,
  ): void {
    const weight = this._eventDropWeight(event);
    if (forceTerminal) {
      this._recordDrop("event", reason, weight);
      return;
    }
    try {
      switch (this.receiptFoldState.fold(event)) {
        case "folded":
          return;
        case "overflow":
          this._recordDrop("event", "receipt_fold_overflow", weight);
          return;
        case "terminal":
          this._recordDrop("event", reason, weight);
          return;
        case "not_denied":
          this._recordDrop("event", reason);
          return;
      }
    } catch {
      // Runtime callers can bypass TypeScript with proxies, revoked objects, or
      // invalid field values. Losing such an event is still accounted once (or at
      // a safely readable receipt weight) without escaping into the call path.
      this._recordDrop("event", reason, weight);
    }
  }

  private _disposeEvents(
    events: readonly MetadataEvent[],
    reason: string,
    options: EventDispositionOptions = {},
  ): void {
    const { emit = true, forceTerminal = false } = options;
    for (const event of events) this._foldOrRecordEventDrop(event, reason, forceTerminal);
    if (emit && events.length > 0) this._maybeLogDrops(false);
  }

  #disposeEvent(event: MetadataEvent, reason: string, forceTerminal = false): void {
    this._foldOrRecordEventDrop(event, reason, forceTerminal);
    this._maybeLogDrops(false);
  }

  private _dropTotal(): number {
    let total = 0;
    for (const value of this.dropCounts.values()) total += value;
    return total;
  }

  private _maybeLogDrops(force: boolean): void {
    const total = this._dropTotal();
    if (total === this.lastLoggedDropTotal) return;
    const now = this.monotonicClock();
    if (!force && this.lastDropLogAt !== null && now - this.lastDropLogAt < 60_000) {
      return;
    }
    const since = total - this.lastLoggedDropTotal;
    this.lastLoggedDropTotal = total;
    this.lastDropLogAt = now;
    this.logger.warn(
      "reporter.spend_events_dropped: new=%d totals=%s",
      since,
      JSON.stringify(this.droppedCounts),
    );
  }

  /** Overflow-safe, no-jitter backoff in monotonic milliseconds. */
  _backoffDelay(attempts: number): number {
    // Python clamps exponentiation at 1023 before multiplying. JS would produce
    // Infinity at larger exponents, but keeping the clamp preserves exact parity.
    return Math.min(
      this.retryBackoffCap,
      this.retryBackoffBase * 2 ** Math.min(attempts - 1, 1023),
    );
  }

  /** The two auth headers (delegated to the transport). */
  _authHeaders(): Record<string, string> {
    return this.transport.authHeaders();
  }

  /** Reset the consecutive-confirm-failure counter (a confirm succeeded). */
  _recordConfirmSuccess(): void {
    this.consecutiveConfirmFailures = 0;
  }

  /** Count a confirm failure; escalate to ERROR at/after the threshold. */
  _recordConfirmFailure(error: unknown, diagnosticRecorded = false): void {
    this.consecutiveConfirmFailures += 1;
    const name = exceptionName(error);
    if (this.consecutiveConfirmFailures >= CONFIRM_FAILURE_THRESHOLD) {
      this.logger.error(
        `reporter.confirm_send_persistent_failure: exc_type=${name} ` +
          `consecutive_failures=${this.consecutiveConfirmFailures}`,
      );
    } else if (!diagnosticRecorded) {
      this.logger.warn(`reporter.confirm_send_failed: exc_type=${name}`);
    }
  }

  /** Reset the consecutive-unparseable-response counter (a body parsed cleanly). */
  _recordParseableResponse(): void {
    this.consecutiveUnparseableResponses = 0;
  }

  /** Count a malformed 202 body; escalate to ERROR at/after the threshold. */
  _recordUnparseableResponse(error: unknown): void {
    this.consecutiveUnparseableResponses += 1;
    const name = exceptionName(error);
    if (this.consecutiveUnparseableResponses >= UNPARSEABLE_RESPONSE_THRESHOLD) {
      this.logger.error(
        `reporter.ingest_response_unparseable_persistent: exc_type=${name} ` +
          `consecutive_failures=${this.consecutiveUnparseableResponses}`,
      );
    } else {
      this.logger.warn(`reporter.ingest_response_unparseable: exc_type=${name}`);
    }
  }

  /**
   * An outgoing event failed {@link MetadataEventSchema} validation before send.
   * Drop only that event (never block the batch), count it on the SAME consecutive
   * counter as malformed 202 bodies (escalating to ERROR at the threshold), and log
   * a PRIVACY-SAFE per-event line: the offending FIELD NAMES and the error CLASS
   * only — never any field value or zod message body (which can echo the value).
   */
  _recordUnserializableEvent(error: unknown, fieldNames: string[]): void {
    this.consecutiveUnparseableResponses += 1;
    const name = exceptionName(error);
    const fields = fieldNames.length > 0 ? fieldNames.join(",") : "<unknown>";
    if (this.consecutiveUnparseableResponses >= UNPARSEABLE_RESPONSE_THRESHOLD) {
      this.logger.error(
        `reporter.ingest_event_unserializable_persistent: fields=${fields} ` +
          `exc_type=${name} consecutive_failures=${this.consecutiveUnparseableResponses}`,
      );
    } else {
      this.logger.warn(`reporter.ingest_event_unserializable: fields=${fields} exc_type=${name}`);
    }
  }

  /**
   * Parse the durable ingest disposition without retaining the response or raw body.
   * Missing indexes are the supported legacy form. Invalid index shapes preserve the
   * trusted count but advance the contract-drift diagnostic.
   */
  _parseIngestRejections(body: unknown, batchSize: number): IngestRejections {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      this._recordUnparseableResponse(new TypeError("ingest response body is not an object"));
      return MALFORMED_REJECTIONS;
    }
    const rejected = (body as Record<string, unknown>)["rejected"];
    if (!Array.isArray(rejected)) {
      this._recordUnparseableResponse(
        new RejectionContractError("ingest response 'rejected' is not an array"),
      );
      return MALFORMED_REJECTIONS;
    }
    if (rejected.length > batchSize) {
      this._recordUnparseableResponse(
        new RejectionContractError("'rejected' longer than the submitted batch"),
      );
      return MALFORMED_REJECTIONS;
    }
    if (rejected.length === 0) {
      this._recordParseableResponse();
      return { kind: "clean", indexes: [], count: 0 };
    }

    const groups: RejectionGroup[] = [];
    const byKey = new Map<string, RejectionGroup>();
    const indexes: number[] = [];
    let indexesComplete = true;
    let shapeError = false;
    for (const entry of rejected) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        this._recordUnparseableResponse(new TypeError("ingest rejection entry is not an object"));
        return MALFORMED_REJECTIONS;
      }
      const record = entry as Record<string, unknown>;
      const code = record["code"];
      const model = record["model"];
      const message = record["message"];
      // Log identity is optional for disposition. A future server shape can still
      // identify the rejected event even when it cannot furnish a diagnostic group.
      if (typeof code === "string" && typeof model === "string" && typeof message === "string") {
        const key = `${code}\u0000${model}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          const group: RejectionGroup = { code, model, count: 1, message };
          byKey.set(key, group);
          groups.push(group);
        }
      }

      if (!("index" in record)) {
        indexesComplete = false;
        continue;
      }
      const index = record["index"];
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= batchSize
      ) {
        shapeError = true;
        continue;
      }
      indexes.push(index);
    }
    if (new Set(indexes).size !== indexes.length) shapeError = true;

    try {
      for (const group of groups) {
        this.logger.warn(
          `reporter.ingest_events_rejected: code=${escapeControlChars(group.code)} ` +
            `model=${escapeControlChars(group.model)} count=${group.count} ` +
            `message=${escapeControlChars(group.message)}`,
        );
      }
    } catch {
      // Best-effort diagnostic containment.
    }

    if (shapeError) {
      this._recordUnparseableResponse(new RejectionContractError("invalid rejection indexes"));
      return { kind: "legacy", indexes: [], count: rejected.length };
    }
    this._recordParseableResponse();
    if (!indexesComplete) {
      return { kind: "legacy", indexes: [], count: rejected.length };
    }
    return { kind: "exact", indexes: [...indexes].sort((a, b) => a - b), count: rejected.length };
  }

  // -------------------------------------------------------------------------
  // I/O — send paths. Each guards its in-flight counter in a `finally`.
  // -------------------------------------------------------------------------

  /**
   * POST one metadata batch. Each event is first validated against
   * {@link MetadataEventSchema} (wire-contract.md: the outgoing ingest array is
   * parsed before send). Validation is FAIL-OPEN PER EVENT: an invalid event is
   * dropped + logged (field names + class only) + counted, and the rest of the
   * batch is still sent — one bad event never 422s the whole request. On 2xx the
   * batch is DURABLE (it landed): parse the 202 body for rejections (fail-open — a
   * parse failure never re-queues). On non-2xx / network failure, return a
   * retry/terminal outcome for the owning drain and log type-only. Never throws.
   */
  async _sendBatch(events: MetadataEvent[], deadline?: number): Promise<BatchSendResult> {
    const projected: ProjectedEvent[] = [];
    for (const event of events) {
      const result = this._projectEvent(event);
      if (result.ok) {
        projected.push(result.value);
      } else {
        this.#disposeEvent(event, "terminal_status");
      }
    }
    if (projected.length === 0) {
      return { outcome: "dropped", rejections: MALFORMED_REJECTIONS };
    }
    return this.#sendProjectedBatch(projected, deadline);
  }

  /** Validate, normalize, and serialize once without retaining caller-owned state. */
  private _projectEvent(event: MetadataEvent): ProjectionResult<ProjectedEvent> {
    let parsed: ReturnType<typeof MetadataEventSchema.safeParse>;
    try {
      parsed = MetadataEventSchema.safeParse(event);
    } catch (error) {
      this._recordUnserializableEvent(error, ["<unknown>"]);
      return { ok: false, error };
    }
    if (!parsed.success) {
      this._recordUnserializableEvent(parsed.error, issueFieldNames(parsed.error.issues));
      return { ok: false, error: parsed.error };
    }

    try {
      return {
        ok: true,
        value: {
          canonical: parsed.data,
          wire: serializeMetadataEvent(parsed.data),
        },
      };
    } catch (error) {
      this._recordUnserializableEvent(error, projectionErrorFields(error));
      return { ok: false, error };
    }
  }

  /** Send prebuilt projections so response indexes remain aligned one-to-one. */
  async #sendProjectedBatch(
    projected: readonly ProjectedEvent[],
    deadline?: number,
    isCurrent: () => boolean = () => true,
  ): Promise<BatchSendResult> {
    this.inFlight += 1;
    try {
      const body = await this.transport.postJsonAndReadJson(
        METADATA_INGEST_PATH,
        projected.map((event) => event.wire),
        {
          timeoutMs: this._sendTimeout(deadline, INGEST_TIMEOUT_MS),
          signal: this.deliveryAbortController.signal,
        },
      );
      if (!isCurrent()) {
        return { outcome: "sent", rejections: MALFORMED_REJECTIONS };
      }
      if (!body.parsed) {
        this._recordUnparseableResponse(body.error);
        return { outcome: "sent", rejections: MALFORMED_REJECTIONS };
      }
      return {
        outcome: "sent",
        rejections: this._parseIngestRejections(body.value, projected.length),
      };
    } catch (sendError) {
      if (!isCurrent()) {
        return {
          outcome: isRetryableTransportError(sendError) ? "retry" : "dropped",
          rejections: MALFORMED_REJECTIONS,
        };
      }
      if (handleReadOnlyKeyError(sendError, this.logger)) {
        return { outcome: "sent", rejections: MALFORMED_REJECTIONS };
      }
      // Whole-batch failure (non-2xx or network). Body/status text never logged.
      this.logger.warn(
        `Failed to send metadata batch (${projected.length} events): ${exceptionName(sendError)}`,
      );
      return {
        outcome: isRetryableTransportError(sendError) ? "retry" : "dropped",
        rejections: MALFORMED_REJECTIONS,
      };
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * POST one confirm. Any 2xx resets the failure counter; any failure (non-2xx or
   * network) increments it and logs type-only. The send itself is single-attempt;
   * its owning FIFO drain applies bounded retry. Never throws.
   *
   * The request is first validated against {@link BudgetConfirmRequestSchema} — symmetric
   * with how {@link _sendBatch} validates every {@link MetadataEvent} before send (finding
   * 4). An invalid confirm (e.g. a `call_id` past D1's maxLength 36, or a TokenDetails
   * field outside 0..100_000_000) is dropped + logged privacy-safe + counted instead of
   * 422ing server-side and stranding the reservation.
   */
  async _sendConfirm(request: BudgetConfirmRequest): Promise<SendOutcome> {
    const result = await this.#sendConfirmAttempt(this._pendingConfirm(request));
    if (result.outcome === "sent" && !result.counterNeutral) {
      this._recordConfirmSuccess();
    } else if (result.outcome === "retry" || result.outcome === "dropped") {
      this._recordConfirmFailure(result.error, result.diagnosticRecorded);
    }
    return result.outcome;
  }

  async #sendConfirmAttempt(
    pending: PendingConfirm,
    deadline?: number,
    isCurrent: () => boolean = () => true,
  ): Promise<ConfirmAttemptResult> {
    if (pending.projection === null) {
      const projection = this._projectConfirm(pending.item);
      if (!projection.ok) {
        return { outcome: "dropped", error: projection.error, diagnosticRecorded: true };
      }
      pending.item = projection.value.canonical;
      pending.projection = projection.value;
    }

    const admission: CircuitBreakerAdmission | null = this.controlPlaneBreaker?.admit() ?? null;
    if (admission !== null && !admission.allowed) {
      this.logger.debug("reporter.confirm_held_breaker_open");
      return { outcome: "held" };
    }

    this.inFlight += 1;
    try {
      await this.transport.postJson(BUDGET_CONFIRM_PATH, pending.projection.wire, {
        timeoutMs: this._sendTimeout(deadline, CONFIRM_TIMEOUT_MS),
        signal: this.deliveryAbortController.signal,
      });
      if (isCurrent()) this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
      return { outcome: "sent" };
    } catch (error) {
      if (isReadOnlyKeyError(error)) {
        if (isCurrent()) {
          this.controlPlaneBreaker?.recordSuccess(admission ?? undefined);
          handleReadOnlyKeyError(error, this.logger);
        }
        return { outcome: "sent", counterNeutral: true };
      } else {
        if (!isCurrent()) {
          return {
            outcome:
              error instanceof TransportHttpError && !isRetryableTransportError(error)
                ? "dropped"
                : "retry",
            error,
          };
        }
        this.controlPlaneBreaker?.recordFailure(admission ?? undefined);
        if (error instanceof TransportHttpError && !isRetryableTransportError(error)) {
          const status = error.status;
          this.logger.warn("reporter.confirm_terminal_status: status=%d", status);
          return { outcome: "dropped", error };
        }
        return { outcome: "retry", error };
      }
    } finally {
      this.controlPlaneBreaker?.releaseProbe(admission);
      this.inFlight -= 1;
    }
  }

  /** Validate and prebuild a confirm before breaker admission or transport I/O. */
  private _projectConfirm(request: BudgetConfirmRequest): ProjectionResult<ProjectedConfirm> {
    let parsed: ReturnType<typeof BudgetConfirmRequestSchema.safeParse>;
    try {
      parsed = BudgetConfirmRequestSchema.safeParse(request);
    } catch (error) {
      this._recordUnserializableConfirm(error, ["<unknown>"]);
      return { ok: false, error };
    }
    if (!parsed.success) {
      this._recordUnserializableConfirm(parsed.error, issueFieldNames(parsed.error.issues));
      return { ok: false, error: parsed.error };
    }

    try {
      return {
        ok: true,
        value: {
          canonical: parsed.data,
          wire: serializeBudgetConfirmRequest(parsed.data),
        },
      };
    } catch (error) {
      this._recordUnserializableConfirm(error, projectionErrorFields(error));
      return { ok: false, error };
    }
  }

  /** Confirm projection diagnostics contain field names and class only. */
  private _recordUnserializableConfirm(error: unknown, fieldNames: readonly string[]): void {
    const fields = fieldNames.length > 0 ? fieldNames.join(",") : "<unknown>";
    this.logger.warn(
      `reporter.confirm_unserializable: fields=${fields} exc_type=${exceptionName(error)}`,
    );
  }

  private _recordCycleFailure(
    cycle: ConfirmCycle,
    error: unknown,
    diagnosticRecorded = false,
  ): void {
    cycle.lastVerdict = { outcome: "failed", error, diagnosticRecorded };
  }

  private _recordCycleSuccess(cycle: ConfirmCycle): void {
    cycle.lastVerdict = { outcome: "sent" };
  }

  private _nextOwnershipToken(): number {
    this.ownershipToken += 1;
    return this.ownershipToken;
  }

  private _claimConfirm(): readonly [token: number, pending: PendingConfirm] | null {
    if (this.deliveryClosed) return null;
    const pending = this.confirmQueue.shift();
    if (pending === undefined) return null;
    const token = this._nextOwnershipToken();
    this.inHandConfirms.set(token, pending);
    return [token, pending];
  }

  private _claimSettlement(): readonly [token: number, settlement: Settlement] | null {
    if (this.deliveryClosed) return null;
    const settlement = this.settlementQueue.shift();
    if (settlement === undefined) return null;
    const token = this._nextOwnershipToken();
    this.inHandSettlements.set(token, settlement);
    return [token, settlement];
  }

  private _claimEventBatch(
    final: boolean,
  ): readonly [token: number, pending: PendingEvent[]] | null {
    if (this.deliveryClosed) return null;
    const now = this.monotonicClock();
    const pending = this.metadataQueue.drainWhileUpTo(
      this.batchSize,
      (item) => final || item.nextAttemptAt <= now,
    );
    if (pending.length === 0) return null;
    const token = this._nextOwnershipToken();
    this.inHandEventBatches.set(token, pending);
    return [token, pending];
  }

  private _claimIsCurrent(
    claims: ReadonlyMap<number, unknown>,
    token: number,
    deadline?: number,
  ): boolean {
    return !this.deliveryClosed && claims.has(token) && !this._deadlineExpired(deadline);
  }

  /** Whether a queued head could be sent now (ordinary rounds honour backoff). */
  private _headDue(head: Pending<unknown> | undefined): boolean {
    return head !== undefined && head.nextAttemptAt <= this.monotonicClock();
  }

  /**
   * Send due confirms FIFO. An ordinary round resolves at most `limit` items and
   * returns true only when that quota ran out with a due head still queued.
   */
  private async _drainConfirms(
    cycle: ConfirmCycle,
    deadline?: number,
    final = false,
    limit?: number,
  ): Promise<boolean> {
    let resolved = 0;
    while (!this.deliveryClosed && !this._deadlineExpired(deadline)) {
      if (limit !== undefined && resolved >= limit) {
        return this._headDue(this.confirmQueue.peek());
      }
      const head = this.confirmQueue.peek();
      if (head === undefined) return false;
      if (!final && head.nextAttemptAt > this.monotonicClock()) return false;
      const claimed = this._claimConfirm();
      if (claimed === null) return false;
      resolved += 1;
      const [token, pending] = claimed;
      const result = await this.#sendConfirmAttempt(pending, deadline, () =>
        this._claimIsCurrent(this.inHandConfirms, token, deadline),
      );
      if (this._deadlineExpired(deadline) || !this.inHandConfirms.delete(token)) return false;

      if (result.outcome === "sent") {
        if (!result.counterNeutral) this._recordCycleSuccess(cycle);
        continue;
      }
      if (result.outcome === "held") {
        if (!final) {
          this._restoreConfirmPrefix([pending]);
          return false;
        }
        this._countDrop("confirm", "exit_breaker_open");
        this._countDrop("confirm", "exit_breaker_open", this.confirmQueue.drainAll().length);
        return false;
      }

      this._recordCycleFailure(cycle, result.error, result.diagnosticRecorded);
      if (result.outcome === "dropped") {
        this._countDrop("confirm", "terminal_status");
        continue;
      }
      pending.attempts += 1;
      if (final || pending.attempts >= this.maxSendAttempts) {
        this._countDrop("confirm", "retry_exhausted");
        continue;
      }
      pending.nextAttemptAt = this.monotonicClock() + this._backoffDelay(pending.attempts);
      this._restoreConfirmPrefix([pending]);
      // FIFO: nothing behind a backing-off head may jump it.
      return false;
    }
    return false;
  }

  /** Settlement twin of {@link _drainConfirms}; each event follows its own confirm. */
  private async _drainSettlements(
    cycle: ConfirmCycle,
    deadline?: number,
    final = false,
    limit?: number,
  ): Promise<boolean> {
    let resolved = 0;
    while (!this.deliveryClosed && !this._deadlineExpired(deadline)) {
      if (limit !== undefined && resolved >= limit) {
        return this._headDue(this.settlementQueue.peek()?.confirm);
      }
      const head = this.settlementQueue.peek();
      if (head === undefined) return false;
      if (!final && head.confirm.nextAttemptAt > this.monotonicClock()) return false;
      const claimed = this._claimSettlement();
      if (claimed === null) return false;
      resolved += 1;
      const [token, settlement] = claimed;
      const result = await this.#sendConfirmAttempt(settlement.confirm, deadline, () =>
        this._claimIsCurrent(this.inHandSettlements, token, deadline),
      );
      if (this._deadlineExpired(deadline) || !this.inHandSettlements.delete(token)) return false;

      if (result.outcome === "sent") {
        if (!result.counterNeutral) this._recordCycleSuccess(cycle);
        this._moveEventToQueue(settlement.event);
        continue;
      }
      if (result.outcome === "held") {
        if (!final) {
          this._restoreSettlementPrefix([settlement]);
          return false;
        }
        const stranded = [settlement, ...this.settlementQueue.drainAll()];
        this._recordDrop("settlement_confirm", "exit_breaker_open", stranded.length);
        for (const remainder of stranded) {
          this._moveEventToQueue(remainder.event, false);
        }
        this._maybeLogDrops(false);
        return false;
      }

      this._recordCycleFailure(cycle, result.error, result.diagnosticRecorded);
      if (result.outcome === "dropped") {
        this._recordDrop("settlement_confirm", "terminal_status");
        this._moveEventToQueue(settlement.event, false);
        this._maybeLogDrops(false);
        continue;
      }
      settlement.confirm.attempts += 1;
      if (final || settlement.confirm.attempts >= this.maxSendAttempts) {
        this._recordDrop("settlement_confirm", "retry_exhausted");
        this._moveEventToQueue(settlement.event, false);
        this._maybeLogDrops(false);
        continue;
      }
      settlement.confirm.nextAttemptAt =
        this.monotonicClock() + this._backoffDelay(settlement.confirm.attempts);
      this._restoreSettlementPrefix([settlement]);
      return false;
    }
    return false;
  }

  /** Select exact/full/partial-legacy dispositions; partial legacy is stable-heaviest. */
  _dispositionIndexes(events: readonly MetadataEvent[], rejections: IngestRejections): number[] {
    if (rejections.kind === "exact") return [...rejections.indexes];
    if (rejections.kind !== "legacy" || rejections.count <= 0) return [];
    if (rejections.count >= events.length) return events.map((_event, index) => index);
    return events
      .map((event, index) => ({ index, weight: this._eventDropWeight(event) }))
      .sort((left, right) => right.weight - left.weight || left.index - right.index)
      .slice(0, rejections.count)
      .map(({ index }) => index)
      .sort((left, right) => left - right);
  }

  private _publishIngestDispositions(
    events: readonly MetadataEvent[],
    rejections: IngestRejections,
    forceTerminal = false,
  ): void {
    if (rejections.kind === "legacy" && rejections.count > 0 && rejections.count < events.length) {
      const weight = this._dispositionIndexes(events, rejections).reduce(
        (total, index) => total + this._eventDropWeight(events[index] as MetadataEvent),
        0,
      );
      this._recordDrop("event", "ingest_rejected", weight);
      this._maybeLogDrops(false);
      return;
    }

    const disposed = this._dispositionIndexes(events, rejections)
      .map((index) => events[index])
      .filter((event): event is MetadataEvent => event !== undefined);
    this._disposeEvents(disposed, "ingest_rejected", { forceTerminal });
  }

  /**
   * Send due metadata in batches. An ordinary round sends at most the batches
   * queued when the stage starts, so arrivals during its sends wait for the next
   * round and can never extend this one.
   */
  async _drainEventBatches(deadline?: number, final = false): Promise<EventStageResult> {
    let sentCleanBatch = false;
    let cycleClean = true;
    const cleanNow = (): boolean =>
      sentCleanBatch && cycleClean && !this.deliveryClosed && !this._deadlineExpired(deadline);
    let batchesLeft =
      this.batchSize >= 1 ? Math.ceil(this.metadataQueue.length / this.batchSize) : 0;
    while (!this.deliveryClosed && !this._deadlineExpired(deadline)) {
      if (!final && batchesLeft <= 0) {
        return { clean: cleanNow(), more: this._headDue(this.metadataQueue.peek()) };
      }
      const claimed = this._claimEventBatch(final);
      if (claimed === null) break;
      batchesLeft -= 1;
      const [token, pendingBatch] = claimed;
      const valid: PendingEvent[] = [];
      const projected: ProjectedEvent[] = [];
      const invalid: MetadataEvent[] = [];
      for (const pending of pendingBatch) {
        let projection = pending.projection;
        if (projection === null) {
          const result = this._projectEvent(pending.item);
          if (!result.ok) {
            invalid.push(pending.item);
            cycleClean = false;
            continue;
          }
          projection = result.value;
          pending.item = projection.canonical;
          pending.projection = projection;
        }
        valid.push(pending);
        projected.push(projection);
      }
      this.inHandEventBatches.set(token, valid);
      this._disposeEvents(invalid, "terminal_status", { forceTerminal: final });
      if (valid.length === 0) {
        this.inHandEventBatches.delete(token);
        continue;
      }

      // Spend observations are needed for reconciliation and must remain
      // independently deliverable when budget/confirm admission is unavailable.
      // Ingest is therefore deliberately not guarded by the shared breaker.
      const events = projected.map((event) => event.canonical);
      const result = await this.#sendProjectedBatch(projected, deadline, () =>
        this._claimIsCurrent(this.inHandEventBatches, token, deadline),
      );
      if (this._deadlineExpired(deadline) || !this.inHandEventBatches.delete(token)) {
        return { clean: false, more: false };
      }
      if (result.outcome === "sent") {
        this._publishIngestDispositions(events, result.rejections, final);
        const clean = result.rejections.kind === "clean";
        sentCleanBatch ||= clean;
        cycleClean &&= clean;
        continue;
      }
      cycleClean = false;
      if (result.outcome === "dropped") {
        this._disposeEvents(
          valid.map((pending) => pending.item),
          "terminal_status",
          { forceTerminal: final },
        );
        continue;
      }
      const retryAt = this.monotonicClock();
      const survivors: PendingEvent[] = [];
      const exhausted: MetadataEvent[] = [];
      for (const pending of valid) {
        pending.attempts += 1;
        if (final || pending.attempts >= this.maxSendAttempts) {
          exhausted.push(pending.item);
        } else {
          pending.nextAttemptAt = retryAt + this._backoffDelay(pending.attempts);
          survivors.push(pending);
        }
      }
      if (survivors.length > 0) this._restoreEventPrefix(survivors, false);
      this._disposeEvents(exhausted, "retry_exhausted", {
        emit: false,
        forceTerminal: final,
      });
      this._maybeLogDrops(false);
      return { clean: cleanNow(), more: false };
    }
    return { clean: cleanNow(), more: false };
  }

  /** Transfer recovery-eligible aggregates synchronously to the event-queue tail. */
  private _drainReceiptFoldsToQueue(): void {
    if (this.deliveryClosed) return;
    const replayEvents = this.receiptFoldState
      .takeForCycle({ final: false })
      .flatMap(({ key, fold }) =>
        buildReceiptReplayEvents(key, fold, this.sdkInstanceId, this.nextEventTimestamp),
      );
    if (replayEvents.length === 0) return;
    for (const event of replayEvents) this._moveEventToQueue(event, false);
    this._maybeLogDrops(false);
  }

  /**
   * One delivery round: confirms → settlements → events, with one confirm
   * failure increment per round. An ordinary round gives each control stage a
   * turn of at most `max(1, min(batchSize, maxQueueSize))` items and the event
   * stage the batches queued at its start; `round.more` reports whether any
   * stage stopped at its quota with due work left. The final flush is unbounded.
   * Returns whether the round's metadata delivery was clean.
   */
  async _flushRemaining(deadline?: number, final = false, round?: FlushRound): Promise<boolean> {
    this._drainReceiptFoldsToQueue();
    const cycle: ConfirmCycle = { lastVerdict: null };
    const limit = final ? undefined : Math.max(1, Math.min(this.batchSize, this.maxQueueSize));
    const moreConfirms = await this._drainConfirms(cycle, deadline, final, limit);
    const moreSettlements = await this._drainSettlements(cycle, deadline, final, limit);
    const { clean, more: moreEvents } = await this._drainEventBatches(deadline, final);
    if (round !== undefined) round.more = moreConfirms || moreSettlements || moreEvents;
    if (cycle.lastVerdict?.outcome === "sent") {
      this._recordConfirmSuccess();
    } else if (cycle.lastVerdict?.outcome === "failed") {
      this._recordConfirmFailure(cycle.lastVerdict.error, cycle.lastVerdict.diagnosticRecorded);
    }
    if (clean) this.receiptFoldState.noteCycleSuccess();
    this._maybeLogDrops(final);
    return clean;
  }

  private _breakerSnapshotKey(snapshot: CircuitBreakerState): string {
    return `${snapshot.state}:${snapshot.failureCount}:${snapshot.successCount}`;
  }

  /** Cheap cadence precheck: no worker is spawned when every report is deduplicated. */
  _breakerReportsDue(): boolean {
    if (
      this.activeBreakerCycle !== null ||
      !this.breakerReportingEnabled ||
      this.breakerSnapshots === null ||
      this.sdkInstanceId === null ||
      this.breakerProjectId === null
    ) {
      return false;
    }
    const now = this.monotonicClock();
    if (now - this.breakerHeartbeatAt >= this.breakerReportHeartbeat) return true;
    try {
      const snapshots = this.breakerSnapshots();
      const due = snapshots.some(
        ([provider, snapshot]) =>
          this.breakerLastSent.get(provider) !== this._breakerSnapshotKey(snapshot),
      );
      this.pendingBreakerSnapshots = due ? snapshots : null;
      return due;
    } catch {
      // Let the launched cycle own the one privacy-safe supplier diagnostic.
      this.pendingBreakerSnapshots = null;
      return true;
    }
  }

  /** Launch or adopt the one active provider-breaker reporting cycle. */
  _startBreakerCycle(force = false, deadline?: number): Promise<void> {
    if (this.activeBreakerCycle !== null) {
      return this.activeBreakerCycle;
    }
    if (
      !this.breakerReportingEnabled ||
      this.breakerSnapshots === null ||
      this.sdkInstanceId === null ||
      this.breakerProjectId === null
    ) {
      return Promise.resolve();
    }

    const abortController = new AbortController();
    const cycle = this._runBreakerCycle(
      this.breakerProjectId,
      this.breakerSnapshots,
      this.sdkInstanceId,
      force,
      deadline,
      abortController.signal,
    );
    this.activeBreakerCycle = cycle;
    this.activeBreakerAbortController = abortController;
    const clearActiveCycle = () => {
      if (this.activeBreakerCycle === cycle) {
        this.activeBreakerCycle = null;
        this.activeBreakerAbortController = null;
      }
    };
    void cycle.then(clearActiveCycle, clearActiveCycle);
    return cycle;
  }

  private async _runBreakerCycle(
    projectId: string,
    snapshotsSupplier: () => readonly BreakerSnapshot[],
    sdkInstanceId: string,
    force: boolean,
    deadline?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    let snapshots: readonly BreakerSnapshot[];
    try {
      snapshots =
        !force && this.pendingBreakerSnapshots !== null
          ? this.pendingBreakerSnapshots
          : snapshotsSupplier();
      this.pendingBreakerSnapshots = null;
    } catch (error) {
      this.pendingBreakerSnapshots = null;
      this.logger.warn("reporter.breaker_snapshot_failed: exc_type=%s", exceptionName(error));
      return;
    }

    const now = this.monotonicClock();
    const heartbeatDue = now - this.breakerHeartbeatAt >= this.breakerReportHeartbeat;
    if (force || heartbeatDue) {
      // Stamp at build time, not success: failed providers remain due through their
      // absent last-sent keys even though this heartbeat window has been consumed.
      this.breakerHeartbeatAt = now;
    }
    const due = snapshots.filter(
      ([provider, snapshot]) =>
        force ||
        heartbeatDue ||
        this.breakerLastSent.get(provider) !== this._breakerSnapshotKey(snapshot),
    );
    if (due.length === 0) return;

    const reportedAt = this.wallClock().toISOString();
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/providers/breaker-reports`;
    const outcome = { delivered: false, failed: false };
    try {
      await this._postBreakerReports(
        path,
        due,
        reportedAt,
        sdkInstanceId,
        outcome,
        deadline,
        signal,
      );
    } finally {
      this._noteBreakerCycleOutcome(outcome.delivered, outcome.failed);
    }
  }

  private async _postBreakerReports(
    path: string,
    due: readonly BreakerSnapshot[],
    reportedAt: string,
    sdkInstanceId: string,
    outcome: { delivered: boolean; failed: boolean },
    deadline?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const [provider, snapshot] of due) {
      if (this._deadlineExpired(deadline)) return;
      const parsed = BreakerStateReportSchema.safeParse({
        provider,
        state: snapshot.state,
        failure_count: snapshot.failureCount,
        success_count: snapshot.successCount,
        reported_at: reportedAt,
        sdk_instance_id: sdkInstanceId,
      });
      if (!parsed.success) {
        const parseFailureName = exceptionName(parsed.error);
        this.logger.warn(
          "reporter.breaker_snapshot_invalid: provider=%s exc_type=%s",
          provider,
          parseFailureName,
        );
        continue;
      }
      try {
        await this.transport.postJson(path, parsed.data, {
          timeoutMs: this._sendTimeout(deadline, BREAKER_REPORT_TIMEOUT_MS),
          signal,
        });
        if (this._deadlineExpired(deadline)) return;
        this.breakerLastSent.set(provider, this._breakerSnapshotKey(snapshot));
        outcome.delivered = true;
      } catch (error) {
        if (this._deadlineExpired(deadline)) return;
        outcome.failed = true;
        if (isReadOnlyKeyError(error)) {
          handleReadOnlyKeyError(error, this.logger);
          return;
        }
        this.logger.warn(
          "reporter.breaker_send_failed: provider=%s exc_type=%s",
          provider,
          exceptionName(error),
        );
      }
    }
  }

  /**
   * A cycle with any failed report arms an independent retry deadline: never sooner
   * than one flush interval, then the reporter's no-jitter retry backoff. A cycle
   * whose reports all succeed clears it. Cadence rounds, including zero-delay
   * continuation rounds, respect the deadline; the forced close-time cycle does not.
   */
  private _noteBreakerCycleOutcome(delivered: boolean, failed: boolean): void {
    if (failed) {
      this.breakerFailedCycles += 1;
      this.breakerRetryAt =
        this.monotonicClock() +
        Math.max(this.flushInterval, this._backoffDelay(this.breakerFailedCycles));
    } else if (delivered) {
      this.breakerFailedCycles = 0;
      this.breakerRetryAt = null;
    }
  }

  /** Whether a failed breaker report's retry deadline still gates cadence cycles. */
  private _breakerRetryPending(): boolean {
    return this.breakerRetryAt !== null && this.monotonicClock() < this.breakerRetryAt;
  }

  // -------------------------------------------------------------------------
  // Lifecycle.
  // -------------------------------------------------------------------------

  /**
   * Begin the periodic flush cadence. Idempotent while live; typed failure after close.
   * The first tick is armed outside any active run, so the cadence never inherits and
   * pins the run that happened to construct or first use this reporter.
   */
  start(): void {
    if (this.shuttingDown) {
      throw new SolwynError("cannot start a closed MetadataReporter");
    }
    if (this.loopStarted) return;
    this.loopStarted = true;
    this.tickTarget =
      typeof WeakRef === "function" ? { weak: new WeakRef(this) } : { strong: this };
    runOutsideRun(() => this._armTick(false));
  }

  private _warnFlushScheduleFailure(error: unknown): void {
    if (this.flushScheduleFailureLogged) return;
    this.flushScheduleFailureLogged = true;
    this.logger.warn("reporter.flush_schedule_failed: exc_type=%s", exceptionName(error));
  }

  /**
   * Whether anything still needs this reporter to run: queued, in-hand or retrying
   * items (retries stay queued with a future due time), counted drops not yet logged,
   * retained receipt aggregates, or an active breaker cycle.
   */
  private _hasWork(): boolean {
    return (
      this.confirmQueue.length > 0 ||
      this.settlementQueue.length > 0 ||
      this.metadataQueue.length > 0 ||
      this.inHandConfirms.size > 0 ||
      this.inHandSettlements.size > 0 ||
      this.inHandEventBatches.size > 0 ||
      this.activeBreakerCycle !== null ||
      !this.receiptFoldState.isEmpty ||
      this._dropTotal() !== this.lastLoggedDropTotal
    );
  }

  /**
   * Arm the next tick. A quota-exhausted round continues on a zero-delay timer turn
   * (never a microtask), so producers, close() and other timers still run between
   * rounds. The reporter stays strongly held only while it has work; otherwise the
   * tick holds it weakly and a reachable reporter keeps its cadence and heartbeat.
   */
  private _armTick(more: boolean): void {
    const target = this.tickTarget;
    if (this.shuttingDown || target === null) return;
    if (more || this._hasWork()) reportersWithWork.add(this);
    else reportersWithWork.delete(this);
    try {
      this.tickTimer = armFlushTick(target, more ? 0 : this.flushInterval);
    } catch (error) {
      // Queued items stay owned (and rooted) until close() delivers or counts them.
      this._warnFlushScheduleFailure(error);
    }
  }

  /** Timer entry point for one ordinary round. Internal: called only by the flush tick. */
  _tick(): void {
    this.tickTimer = null;
    if (this.shuttingDown || this.activeRound !== null) return;
    reportersWithWork.add(this);
    const round = this._runRound().then((more) => {
      this.activeRound = null;
      // Once close() has begun it owns delivery and releases the root when it resolves.
      if (!this.shuttingDown) this._armTick(more);
    });
    this.activeRound = round;
  }

  private async _runRound(): Promise<boolean> {
    try {
      const round: FlushRound = { more: false };
      await this._flushRemaining(undefined, false, round);
      if (this.shuttingDown) return false;
      if (!this._breakerRetryPending() && this._breakerReportsDue()) {
        void this._startBreakerCycle();
      }
      return round.more;
    } catch (error) {
      // A single flush failure is not a scheduler failure and must not kill
      // cadence. The next tick gets an independent chance to make progress.
      this.logger.warn("reporter.flush_cycle_failed: exc_type=%s", exceptionName(error));
      return false;
    }
  }

  private _effectiveDeadline(deadline?: number): number | null {
    if (deadline !== undefined) return deadline;
    return this.closeDeadline;
  }

  private _deadlineExpired(deadline?: number): boolean {
    const effective = this._effectiveDeadline(deadline);
    return effective !== null && this.monotonicClock() >= effective;
  }

  private _sendTimeout(deadline: number | undefined, ordinaryTimeout: number): number {
    const effective = this._effectiveDeadline(deadline);
    if (effective === null) return ordinaryTimeout;
    const remaining = effective - this.monotonicClock();
    return Math.max(50, Math.min(5000, remaining));
  }

  /** Race an advisory worker against the one absolute close deadline. */
  private async _awaitWithin<T>(operation: Promise<T>, deadline: number): Promise<boolean> {
    const remaining = Math.max(0, deadline - this.monotonicClock());
    if (remaining === 0) {
      void operation.catch(() => {});
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timed-out");
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), remaining);
    });
    try {
      const result = await Promise.race([
        operation.then(
          () => true,
          () => true,
        ),
        timeout,
      ]);
      if (result === timedOut) {
        void operation.catch(() => {});
        return false;
      }
      return true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Take terminal receipt ownership and append replay behind already-queued live events. */
  #takeFoldsFinal(): void {
    this.finalDeliveryStarted = true;
    const replayEvents = this.receiptFoldState
      .takeForCycle({ final: true })
      .flatMap(({ key, fold }) =>
        buildReceiptReplayEvents(key, fold, this.sdkInstanceId, this.nextEventTimestamp),
      );
    for (const event of replayEvents) this._moveEventToQueue(event, false);
  }

  /** Atomically claim and count every queue/in-hand item that has no later owner. */
  private _sealDelivery(): void {
    if (this.deliveryClosed) return;
    this.#takeFoldsFinal();
    this.deliveryClosed = true;
    this.deliveryAbortController.abort();

    const confirms = [...this.confirmQueue.drainAll(), ...this.inHandConfirms.values()];
    this.inHandConfirms.clear();
    this._recordDrop("confirm", "shutdown_deadline", confirms.length);

    const settlements = [...this.settlementQueue.drainAll(), ...this.inHandSettlements.values()];
    this.inHandSettlements.clear();
    this._recordDrop("settlement_confirm", "shutdown_deadline", settlements.length);
    for (const settlement of settlements) {
      this._foldOrRecordEventDrop(settlement.event, "shutdown_deadline", true);
    }

    const events = [
      ...this.metadataQueue.drainAll(),
      ...[...this.inHandEventBatches.values()].flat(),
    ];
    this.inHandEventBatches.clear();
    this._disposeEvents(
      events.map((pending) => pending.item),
      "shutdown_deadline",
      { emit: false, forceTerminal: true },
    );
    try {
      this._maybeLogDrops(true);
    } catch {
      // Delivery disposition is complete before best-effort diagnostics. An
      // injected clock/logger failure must not reopen or strand ownership.
    }
  }

  /**
   * Install the close fence/promise synchronously, then finish all delivery under
   * the first caller's one absolute deadline. Later callers receive this exact
   * promise and cannot tighten, extend, or replace the chosen budget.
   */
  close(timeout = this.shutdownDeadline): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;

    let resolveClose!: () => void;
    const shared = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    // Publish identity and the enqueue fence before consulting any injected clock.
    // An ordinary round may still own a confirm while close joins it; from here on
    // its event transfer must not evict ready metadata to make room.
    this.closePromise = shared;
    this.finalDeliveryStarted = true;
    this.shuttingDown = true;
    // Close owns delivery from here: root the reporter until it resolves, then release.
    reportersWithWork.add(this);
    const release = (): void => {
      reportersWithWork.delete(this);
      resolveClose();
    };

    let deadline: number;
    try {
      const budget = Number.isFinite(timeout) && timeout >= 0 ? timeout : 0;
      deadline = this.monotonicClock() + budget;
      this.closeDeadline = deadline;
      if (this.tickTimer !== null) {
        clearTimeout(this.tickTimer);
        this.tickTimer = null;
      }
      void this._finishClose(deadline).then(release, () => {
        this._sealDelivery();
        release();
      });
    } catch {
      this.closeDeadline = Number.NEGATIVE_INFINITY;
      this._sealDelivery();
      release();
    }
    return shared;
  }

  private async _finishClose(deadline: number): Promise<void> {
    // Stop cadence before final spend delivery. A stuck active send is advisory
    // here: the outer deadline wins and the in-hand token is sealed below.
    const round = this.activeRound;
    if (round !== null) await this._awaitWithin(round, deadline);
    this.#takeFoldsFinal();
    if (!this._deadlineExpired(deadline)) {
      const finalFlush = this._flushRemaining(deadline, true);
      await this._awaitWithin(finalFlush, deadline);
    }
    this._sealDelivery();

    // Breaker snapshots are advisory: only after spend is sealed do we await an
    // active report and, if time remains, build one distinct forced full cycle.
    const active = this.activeBreakerCycle;
    if (active !== null) {
      const settled = await this._awaitWithin(active, deadline);
      if (!settled) this.activeBreakerAbortController?.abort();
      if (settled && this.activeBreakerCycle === active) {
        this.activeBreakerCycle = null;
        this.activeBreakerAbortController = null;
      }
    }
    if (!this._deadlineExpired(deadline)) {
      const forced = this._startBreakerCycle(true, deadline);
      const settled = await this._awaitWithin(forced, deadline);
      if (!settled) this.activeBreakerAbortController?.abort();
    }
    this._maybeLogDrops(true);
  }

  /** `await using reporter = new MetadataReporter(...)` runs the same `close()`. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
