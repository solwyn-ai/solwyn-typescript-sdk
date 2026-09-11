import { type Logger, noopLogger } from "./logging";
import { SURFACE_CLIENT_SHAPES, type SurfaceClientShape, validateSurfacePath } from "./surfaces";
import { type FetchLike, Transport } from "./transport";
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
}

export type UntrackedSurfaceObservationDisposition =
  | Readonly<{ status: "admitted" }>
  | Readonly<{
      status: "local_only";
      reason: "client_shape_not_in_wire";
      clientShape: SurfaceClientShape;
    }>;

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
}

interface BuiltUntrackedReport {
  readonly key: string;
  readonly cursor: number;
  readonly report: UntrackedSurfaceReport;
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
      current.ruleKind = observation.ruleKind;
      current.capabilityScope = observation.capabilityScope;
      current.posture = observation.posture;
      current.totalOccurrences = Math.min(
        Number.MAX_SAFE_INTEGER,
        current.totalOccurrences + occurrences,
      );
      current.firstSeenAt = Math.min(current.firstSeenAt, seenAt);
      current.lastSeenAt = Math.max(current.lastSeenAt, seenAt);
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
    });
    return true;
  }

  buildDue(
    monotonicNow: number,
    sdkInstanceId: string,
    randomUUID: () => string,
  ): BuiltUntrackedReport[] {
    const built: BuiltUntrackedReport[] = [];
    for (const [key, observation] of this.#observations) {
      if (observation.totalOccurrences <= observation.sentCursor) continue;
      if (
        observation.lastAttemptedAt !== null &&
        monotonicNow - observation.lastAttemptedAt < UNTRACKED_SURFACE_REPORT_INTERVAL_MS
      ) {
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
        if (!parsed.success) continue;
        built.push({
          key,
          cursor: observation.sentCursor + occurrences,
          report: parsed.data,
        });
      } catch {
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
    this.#logger = options.logger ?? noopLogger;
  }

  observe(
    observation: UntrackedSurfaceObservation,
  ): UntrackedSurfaceObservationDisposition | undefined {
    if (this.#closePromise !== undefined) return undefined;
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
    return this.#requestFlush();
  }

  /** One bounded final cycle, including any already-active advisory send. */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#shutdownDeadline = performance.now() + UNTRACKED_SURFACE_REPORT_TIMEOUT_MS;
    this.#closePromise = Promise.resolve().then(async () => {
      const timer = setTimeout(() => this.#shutdownController.abort(), this.#sendTimeout());
      try {
        await this.#requestFlush();
      } finally {
        clearTimeout(timer);
        this.#shutdownController.abort();
      }
    });
    return this.#closePromise;
  }

  #sendTimeout(): number {
    return this.#shutdownDeadline === undefined
      ? UNTRACKED_SURFACE_REPORT_TIMEOUT_MS
      : Math.max(0, this.#shutdownDeadline - performance.now());
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
        await this.#flushOnce();
      } catch {
        // Advisory failures must not reject a provider call or close().
      }
    } while (this.#flushRequested && !this.#shutdownController.signal.aborted);

    // Clear the active worker before resolving, without a completion-hook gap
    // in which a newly requested flush could attach to an already-finished drain.
    this.#activeFlush = undefined;
    finishFlush();
  }

  async #flushOnce(): Promise<void> {
    let reports: BuiltUntrackedReport[];
    try {
      reports = this.#state.buildDue(this.#monotonicClock(), this.#sdkInstanceId, this.#randomUUID);
    } catch {
      return;
    }

    for (let offset = 0; offset < reports.length; offset += UNTRACKED_SURFACE_REPORT_BATCH_SIZE) {
      const timeoutMs = this.#sendTimeout();
      if (timeoutMs <= 0 || this.#shutdownController.signal.aborted) return;
      const batch = reports.slice(offset, offset + UNTRACKED_SURFACE_REPORT_BATCH_SIZE);
      try {
        await this.#transport.postJson(
          UNTRACKED_SURFACE_REPORT_PATH,
          batch.map((built) => built.report),
          { timeoutMs, signal: this.#shutdownController.signal },
        );
      } catch {
        continue;
      }
      this.#state.markSent(batch);
    }
  }
}
