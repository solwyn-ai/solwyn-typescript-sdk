import { ConfigurationError } from "./errors";
import { bestEffortLogger, type Logger, noopLogger } from "./logging";
import { handleReadOnlyKeyError } from "./read-only-key";
import { SURFACE_CLIENT_SHAPES, type SurfaceClientShape, validateSurfacePath } from "./surfaces";
import {
  type FetchLike,
  isRetryableTransportError,
  MAX_RATE_LIMIT_ATTEMPTS,
  retryBackoffDelay,
  Transport,
  TransportHttpError,
  transportErrorLabel,
} from "./transport";
import {
  PROVIDER_NAMES,
  type ProviderName,
  UNTRACKED_CAPABILITY_SCOPES,
  UNTRACKED_CLIENT_SHAPES,
  UNTRACKED_POSTURES,
  UNTRACKED_RULE_KINDS,
  type UntrackedCapabilityScope,
  type UntrackedPosture,
  type UntrackedRuleKind,
  type UntrackedSurfaceReport,
} from "./types";
import { UntrackedSurfaceReportSchema } from "./validation";

export const UNTRACKED_SURFACE_REPORT_PATH = "/api/v1/untracked-surfaces";
export const UNTRACKED_SURFACE_REPORT_TIMEOUT_MS = 10_000;
export const UNTRACKED_SURFACE_REPORT_INTERVAL_MS = 900_000;
export const UNTRACKED_SURFACE_REPORT_BATCH_SIZE = 100;
export const UNTRACKED_SURFACE_REPORT_KEY_LIMIT = 512;
export const UNTRACKED_SURFACE_OCCURRENCES_MAX = 1_000_000_000;

export interface UntrackedSurfaceObservation {
  readonly provider: ProviderName;
  /** Local runtime shape. Unsupported values remain poison/local-only. */
  readonly clientShape: SurfaceClientShape;
  readonly surface: string;
  readonly ruleKind: UntrackedRuleKind;
  readonly capabilityScope: UntrackedCapabilityScope | null;
  readonly posture: UntrackedPosture;
  /** Optional aggregate count for callers that already coalesced observations. */
  readonly occurrences?: number;
}

export interface UntrackedSurfaceReporterOptions {
  readonly sdkInstanceId: string;
  readonly fetch?: FetchLike;
  readonly wallClock?: () => number;
  readonly monotonicClock?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: Logger;
  /** Close budget in milliseconds, shared by an active send and the final flush. */
  readonly shutdownDeadline?: number;
  readonly maxSendAttempts?: number;
  readonly retryBackoffBase?: number;
  readonly retryBackoffCap?: number;
  readonly random?: () => number;
}

export type UntrackedSurfaceObservationDisposition =
  | Readonly<{ status: "admitted" }>
  | Readonly<{
      status: "local_only";
      reason: "client_shape_not_in_wire";
      clientShape: SurfaceClientShape;
    }>;

const IDLE_FLUSH = Promise.resolve();

const ADMITTED_OBSERVATION = Object.freeze({ status: "admitted" as const });
const LOCAL_CLIENT_SHAPE_WARNING =
  "Untracked-surface observation retained locally because its client shape is not in the wire contract";

interface MutableObservation {
  provider: ProviderName;
  clientShape: SurfaceClientShape;
  surface: string;
  ruleKind: UntrackedRuleKind;
  capabilityScope: UntrackedCapabilityScope | null;
  posture: UntrackedPosture;
  totalOccurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  sentCursor: number;
  lastAttemptedAt: number | null;
  pending: BuiltUntrackedReport | null;
  disabled: boolean;
  poisonUntil: number;
}

interface BuiltUntrackedReport {
  readonly key: string;
  readonly cursor: number;
  readonly report: UntrackedSurfaceReport;
  attempts: number;
  rateLimitAttempts: number;
  nextAttemptAt: number;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function observationKey(observation: UntrackedSurfaceObservation, surface: string): string {
  return JSON.stringify([observation.provider, observation.clientShape, "async", surface]);
}

function toUtcRfc3339(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(".000Z", "Z");
}

/** Reporter-owned state with no transport, timer, or reporter reference. */
class UntrackedReportState {
  readonly #observations = new Map<string, MutableObservation>();
  #nextDueAt = Number.POSITIVE_INFINITY;

  isDue(now: number, final = false): boolean {
    if (!final) return now >= this.#nextDueAt;
    for (const observation of this.#observations.values()) {
      if (observation.disabled || now < observation.poisonUntil) continue;
      if (observation.pending !== null || observation.totalOccurrences > observation.sentCursor)
        return true;
    }
    return false;
  }

  #noteDue(observation: MutableObservation): void {
    if (observation.disabled) return;
    const due =
      observation.pending !== null
        ? observation.pending.nextAttemptAt
        : observation.totalOccurrences > observation.sentCursor
          ? Math.max(
              observation.poisonUntil,
              observation.lastAttemptedAt === null
                ? 0
                : observation.lastAttemptedAt + UNTRACKED_SURFACE_REPORT_INTERVAL_MS,
            )
          : Number.POSITIVE_INFINITY;
    this.#nextDueAt = Math.min(this.#nextDueAt, due);
  }

  observe(observation: UntrackedSurfaceObservation, seenAt: number): boolean {
    const occurrences = observation.occurrences ?? 1;
    if (!Number.isSafeInteger(occurrences) || occurrences < 1 || !Number.isFinite(seenAt)) {
      return false;
    }

    let surface: string;
    try {
      surface = validateSurfacePath(observation.surface);
    } catch {
      return false;
    }
    if (
      !isOneOf(PROVIDER_NAMES, observation.provider) ||
      !isOneOf(SURFACE_CLIENT_SHAPES, observation.clientShape) ||
      !isOneOf(UNTRACKED_RULE_KINDS, observation.ruleKind) ||
      (observation.capabilityScope !== null &&
        !isOneOf(UNTRACKED_CAPABILITY_SCOPES, observation.capabilityScope)) ||
      !isOneOf(UNTRACKED_POSTURES, observation.posture)
    ) {
      return false;
    }

    const key = observationKey(observation, surface);
    const current = this.#observations.get(key);
    if (current !== undefined) {
      if (current.disabled) return false;
      current.ruleKind = observation.ruleKind;
      current.capabilityScope = observation.capabilityScope;
      current.posture = observation.posture;
      current.totalOccurrences = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.totalOccurrences + occurrences,
      );
      current.firstSeenAt = Math.min(current.firstSeenAt, seenAt);
      current.lastSeenAt = Math.max(current.lastSeenAt, seenAt);
      this.#noteDue(current);
      return true;
    }
    if (this.#observations.size >= UNTRACKED_SURFACE_REPORT_KEY_LIMIT) {
      return false;
    }
    this.#observations.set(key, {
      provider: observation.provider,
      clientShape: observation.clientShape,
      surface,
      ruleKind: observation.ruleKind,
      capabilityScope: observation.capabilityScope,
      posture: observation.posture,
      totalOccurrences: occurrences,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      sentCursor: 0,
      lastAttemptedAt: null,
      pending: null,
      disabled: false,
      poisonUntil: 0,
    });
    this.#nextDueAt = 0;
    return true;
  }

  buildDue(
    monotonicNow: number,
    sdkInstanceId: string,
    randomUUID: () => string,
    final = false,
  ): BuiltUntrackedReport[] {
    const built: BuiltUntrackedReport[] = [];
    if (!this.isDue(monotonicNow, final)) return built;
    this.#nextDueAt = Number.POSITIVE_INFINITY;
    for (const [key, observation] of this.#observations) {
      if (observation.disabled) continue;
      if (observation.pending !== null) {
        if (final || monotonicNow >= observation.pending.nextAttemptAt) {
          observation.pending.nextAttemptAt = Number.POSITIVE_INFINITY;
          built.push(observation.pending);
        } else this.#noteDue(observation);
        continue;
      }
      if (observation.totalOccurrences <= observation.sentCursor) continue;
      if (
        monotonicNow < observation.poisonUntil ||
        (!final &&
          observation.lastAttemptedAt !== null &&
          monotonicNow - observation.lastAttemptedAt < UNTRACKED_SURFACE_REPORT_INTERVAL_MS)
      ) {
        this.#noteDue(observation);
        continue;
      }

      // Cadence advances for every build attempt, including schema poison.
      observation.lastAttemptedAt = monotonicNow;
      try {
        const occurrences = Math.min(
          observation.totalOccurrences - observation.sentCursor,
          UNTRACKED_SURFACE_OCCURRENCES_MAX,
        );
        const parsed = UntrackedSurfaceReportSchema.safeParse({
          provider: observation.provider,
          client_shape: observation.clientShape,
          mode: "async",
          surface: observation.surface,
          rule_kind: observation.ruleKind,
          capability_scope: observation.capabilityScope ?? null,
          posture: observation.posture,
          occurrences,
          first_seen_at: toUtcRfc3339(observation.firstSeenAt),
          last_seen_at: toUtcRfc3339(observation.lastSeenAt),
          sdk_instance_id: sdkInstanceId,
          report_id: randomUUID().toLowerCase(),
        });
        if (!parsed.success) {
          observation.poisonUntil = monotonicNow + UNTRACKED_SURFACE_REPORT_INTERVAL_MS;
          this.#noteDue(observation);
          continue;
        }
        observation.pending = {
          key,
          cursor: observation.sentCursor + occurrences,
          report: parsed.data,
          attempts: 0,
          rateLimitAttempts: 0,
          nextAttemptAt: Number.POSITIVE_INFINITY,
        };
        built.push(observation.pending);
      } catch {
        observation.poisonUntil = monotonicNow + UNTRACKED_SURFACE_REPORT_INTERVAL_MS;
        this.#noteDue(observation);
        // A poison entry is local-only and must not block valid siblings.
      }
    }
    return built;
  }

  markSent(reports: readonly BuiltUntrackedReport[]): void {
    for (const built of reports) {
      const observation = this.#observations.get(built.key);
      if (observation !== undefined) {
        observation.sentCursor = Math.max(observation.sentCursor, built.cursor);
        observation.pending = null;
        this.#noteDue(observation);
      }
    }
  }

  defer(reports: readonly BuiltUntrackedReport[], nextAttemptAt: number): void {
    for (const built of reports) {
      built.nextAttemptAt = nextAttemptAt;
      const observation = this.#observations.get(built.key);
      if (observation !== undefined) this.#noteDue(observation);
    }
  }

  reject(reports: readonly BuiltUntrackedReport[]): void {
    for (const built of reports) {
      const observation = this.#observations.get(built.key);
      if (observation !== undefined) {
        observation.disabled = true;
        observation.pending = null;
      }
    }
  }
}

export class UntrackedSurfaceReporter {
  readonly #transport: Transport;
  readonly #sdkInstanceId: string;
  readonly #wallClock: () => number;
  readonly #monotonicClock: () => number;
  readonly #randomUUID: () => string;
  readonly #logger: Logger;
  readonly #state = new UntrackedReportState();
  readonly #shutdownBudget: number;
  readonly #maxSendAttempts: number;
  readonly #retryBackoffBase: number;
  readonly #retryBackoffCap: number;
  readonly #random: () => number;
  #disabled = false;
  #rateLimitedUntil = 0;
  readonly #lastFailureLogAt = new Map<string, number>();
  #retryExhaustedSinceLog = 0;
  readonly #warnedLocalClientShapes = new Set<SurfaceClientShape>();
  #activeFlush: Promise<void> | undefined;
  #flushRequested = false;
  #closePromise: Promise<void> | undefined;
  #shutdownDeadline: number | undefined;
  readonly #shutdownController = new AbortController();

  constructor(apiUrl: string, apiKey: string, options: UntrackedSurfaceReporterOptions) {
    this.#transport = new Transport(apiUrl, apiKey, {
      fetch: options.fetch,
      maxRetries: 0,
    });
    this.#sdkInstanceId = options.sdkInstanceId;
    this.#wallClock = options.wallClock ?? Date.now;
    this.#monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#logger = bestEffortLogger(options.logger ?? noopLogger);
    this.#shutdownBudget = options.shutdownDeadline ?? 5000;
    this.#maxSendAttempts = options.maxSendAttempts ?? 5;
    this.#retryBackoffBase = options.retryBackoffBase ?? 1000;
    this.#retryBackoffCap = options.retryBackoffCap ?? 60_000;
    this.#random = options.random ?? Math.random;
    if (!Number.isFinite(this.#shutdownBudget) || this.#shutdownBudget < 0) {
      throw new ConfigurationError("shutdownDeadline must be finite and >= 0", {
        field: "shutdownDeadline",
      });
    }
    if (!Number.isInteger(this.#maxSendAttempts) || this.#maxSendAttempts < 1) {
      throw new ConfigurationError("maxSendAttempts must be an integer >= 1", {
        field: "maxSendAttempts",
      });
    }
    for (const [field, value] of [
      ["retryBackoffBase", this.#retryBackoffBase],
      ["retryBackoffCap", this.#retryBackoffCap],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0)
        throw new ConfigurationError(`${field} must be finite and > 0`, { field });
    }
  }

  observe(
    observation: UntrackedSurfaceObservation,
  ): UntrackedSurfaceObservationDisposition | undefined {
    if (this.#closePromise !== undefined || this.#disabled) return undefined;
    try {
      if (!isOneOf(SURFACE_CLIENT_SHAPES, observation.clientShape)) {
        return undefined;
      }
      if (!isOneOf(UNTRACKED_CLIENT_SHAPES, observation.clientShape)) {
        if (!this.#warnedLocalClientShapes.has(observation.clientShape)) {
          this.#warnedLocalClientShapes.add(observation.clientShape);
          try {
            this.#logger.warn(LOCAL_CLIENT_SHAPE_WARNING, observation.clientShape);
          } catch {
            // Advisory diagnostics must never affect a provider call.
          }
        }
        return Object.freeze({
          status: "local_only" as const,
          reason: "client_shape_not_in_wire" as const,
          clientShape: observation.clientShape,
        });
      }
      return this.#state.observe(observation, this.#wallClock()) ? ADMITTED_OBSERVATION : undefined;
    } catch {
      // Advisory bookkeeping must never affect a provider call.
      return undefined;
    }
  }

  flushDue(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const now = this.#monotonicClock();
    if (this.#disabled || now < this.#rateLimitedUntil || !this.#state.isDue(now)) {
      return this.#activeFlush ?? IDLE_FLUSH;
    }
    return this.#requestFlush();
  }

  /** One bounded final cycle, including any already-active advisory send. */
  close(timeout = this.#shutdownBudget): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const budget = Number.isFinite(timeout)
      ? Math.max(0, Math.min(timeout, this.#shutdownBudget))
      : 0;
    this.#shutdownDeadline = performance.now() + budget;
    this.#closePromise = Promise.resolve().then(async () => {
      if (budget === 0) this.#shutdownController.abort();
      const timer = setTimeout(
        () => this.#shutdownController.abort(),
        Math.min(2 ** 31 - 1, budget),
      );
      try {
        await this.#requestFlush();
      } finally {
        clearTimeout(timer);
        this.#shutdownController.abort();
        this.#warnRetryExhausted(true);
      }
    });
    return this.#closePromise;
  }

  #sendTimeout(): number {
    return this.#shutdownDeadline === undefined
      ? UNTRACKED_SURFACE_REPORT_TIMEOUT_MS
      : Math.max(
          0,
          Math.min(UNTRACKED_SURFACE_REPORT_TIMEOUT_MS, this.#shutdownDeadline - performance.now()),
        );
  }

  #requestFlush(): Promise<void> {
    this.#flushRequested = true;
    if (this.#activeFlush !== undefined) return this.#activeFlush;

    let finishFlush!: () => void;
    const active = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    this.#activeFlush = active;
    void this.#drainRequestedFlushes(finishFlush);
    return active;
  }

  async #drainRequestedFlushes(finishFlush: () => void): Promise<void> {
    do {
      this.#flushRequested = false;
      try {
        const final = this.#closePromise !== undefined;
        const progressed = await this.#flushOnce(final);
        if (final && progressed && this.#state.isDue(this.#monotonicClock(), true))
          this.#flushRequested = true;
      } catch {
        // Advisory failures must not reject a provider call or close().
      }
    } while (this.#flushRequested && !this.#shutdownController.signal.aborted);

    // Clear the active worker before resolving, without a completion-hook gap
    // in which a newly requested flush could attach to an already-finished drain.
    this.#activeFlush = undefined;
    finishFlush();
  }

  #warnSendFailure(error: unknown): void {
    const now = this.#monotonicClock();
    const status = error instanceof TransportHttpError ? error.status : null;
    const failureType = transportErrorLabel(error) ?? "unknown";
    const key = status === null ? failureType : String(status);
    const last = this.#lastFailureLogAt.get(key);
    if (last !== undefined && now - last < 60_000) return;
    this.#lastFailureLogAt.set(key, now);
    this.#logger.warn("untracked.send_failed: status=%s exc_type=%s", status, failureType);
  }

  #retryBatch(batch: readonly BuiltUntrackedReport[], error: unknown): void {
    const now = this.#monotonicClock();
    const rateLimited = error instanceof TransportHttpError && error.status === 429;
    const retryAfterMs = error instanceof TransportHttpError ? (error.retryAfterMs ?? 0) : 0;
    if (rateLimited) {
      this.#rateLimitedUntil = Math.max(this.#rateLimitedUntil, now + retryAfterMs);
    }
    let exhausted = 0;
    for (const built of batch) {
      if (rateLimited) built.rateLimitAttempts += 1;
      else built.attempts += 1;
      if (
        built.attempts >= this.#maxSendAttempts ||
        built.rateLimitAttempts >= MAX_RATE_LIMIT_ATTEMPTS
      ) {
        this.#state.markSent([built]);
        exhausted += 1;
        continue;
      }
      const delay = Math.max(
        retryAfterMs,
        retryBackoffDelay(
          Math.max(built.attempts, built.rateLimitAttempts),
          this.#retryBackoffBase,
          this.#retryBackoffCap,
          this.#random,
        ),
      );
      this.#state.defer([built], now + delay);
      if (rateLimited) this.#rateLimitedUntil = Math.max(this.#rateLimitedUntil, now + delay);
    }
    this.#retryExhaustedSinceLog += exhausted;
    this.#warnRetryExhausted();
  }

  #warnRetryExhausted(final = false): void {
    const now = this.#monotonicClock();
    const last = this.#lastFailureLogAt.get("retry_exhausted");
    if (this.#retryExhaustedSinceLog > 0 && (final || last === undefined || now - last >= 60_000)) {
      this.#lastFailureLogAt.set("retry_exhausted", now);
      this.#logger.warn("untracked.retry_exhausted: reports=%d", this.#retryExhaustedSinceLog);
      this.#retryExhaustedSinceLog = 0;
    }
  }

  async #flushOnce(final: boolean): Promise<boolean> {
    if (this.#disabled || this.#monotonicClock() < this.#rateLimitedUntil) return false;
    let reports: BuiltUntrackedReport[];
    try {
      reports = this.#state.buildDue(
        this.#monotonicClock(),
        this.#sdkInstanceId,
        this.#randomUUID,
        final,
      );
    } catch {
      return false;
    }
    let progressed = false;
    for (let offset = 0; offset < reports.length; offset += UNTRACKED_SURFACE_REPORT_BATCH_SIZE) {
      const timeoutMs = this.#sendTimeout();
      if (timeoutMs <= 0 || this.#shutdownController.signal.aborted) return progressed;
      if (this.#monotonicClock() < this.#rateLimitedUntil) {
        this.#state.defer(reports.slice(offset), this.#rateLimitedUntil);
        return progressed;
      }
      const batch = reports.slice(offset, offset + UNTRACKED_SURFACE_REPORT_BATCH_SIZE);
      try {
        await this.#transport.postJson(
          UNTRACKED_SURFACE_REPORT_PATH,
          batch.map((built) => built.report),
          { timeoutMs, signal: this.#shutdownController.signal },
        );
      } catch (error) {
        if (handleReadOnlyKeyError(error, this.#logger)) {
          this.#disabled = true;
          this.#state.reject(batch);
          return progressed;
        }
        this.#warnSendFailure(error);
        if (!isRetryableTransportError(error)) this.#state.reject(batch);
        else this.#retryBatch(batch, error);
        continue;
      }
      this.#state.markSent(batch);
      progressed = true;
    }
    return progressed;
  }
}
