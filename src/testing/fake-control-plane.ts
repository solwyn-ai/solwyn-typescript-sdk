import { z } from "zod";
import {
  type InterceptOptions,
  type InterceptSurface,
  SolwynCore,
  type SolwynOptions,
} from "../client";
import { ENV_FIELD_MAP, type EnvSnapshot, getEnvSnapshot, SolwynConfigSchema } from "../config";
import { ConfigurationError } from "../errors";
import type { MediaSurfaceSpec } from "../providers/protocol";
import { createClientProxy, type InterceptedClient, type Solwyn } from "../proxies";
import { getCurrentRun } from "../run-context";
import type { FetchLike } from "../transport";
import type {
  BreakerStateReport,
  BudgetCheckRequest,
  BudgetCheckResponse,
  BudgetConfirmRequest,
  BudgetMode,
  IngestRejectionCode,
  LeaseGrantRequest,
  LeaseGrantResponse,
  LeaseRenewRequest,
  LeaseSurrenderRequest,
  MetadataEvent,
  ProviderName,
  RunControlDirective,
  UntrackedSurfaceReport,
} from "../types";
import {
  BreakerReportAcceptedSchema,
  BreakerStateReportSchema,
  BudgetCheckRequestSchema,
  BudgetCheckResponseSchema,
  BudgetConfirmRequestSchema,
  IngestResponseSchema,
  LeaseGrantRequestSchema,
  LeaseGrantResponseSchema,
  LeaseRenewRequestSchema,
  LeaseSurrenderRequestSchema,
  LeaseSurrenderResponseSchema,
  MetadataEventSchema,
  UntrackedSurfaceAcceptedSchema,
  UntrackedSurfaceReportSchema,
} from "../validation";
import { MAGIC_MODELS, validateTestingModels } from "./model-guard";
import {
  jsonValidationResponse,
  type PlaneResponse,
  parseBody,
  parseBodyList,
  responseToFetch,
  validatedResponse,
} from "./wire";

type MagicModel = (typeof MAGIC_MODELS)[number];
type DenialPeriod = "monthly" | "agent_run" | "run_stopped" | "tag";
type DenialScope = "check" | "lease";
type LeaseRefusalCode = "lease_unavailable" | "lease_holder_cap_exceeded";
type ScenarioKind =
  | "outage"
  | "slow"
  | "read_only"
  | "refuse_checks"
  | "refuse_leases"
  | "misroute_stops"
  | "reject_ingest";
type Route =
  | "health"
  | "check"
  | "confirm"
  | "ingest"
  | "untracked"
  | "breaker"
  | "lease_grant"
  | "lease_renew"
  | "lease_surrender";

interface LeaseRecord {
  readonly agentRunId: string;
  readonly holderId: string;
  readonly leaseId: string;
  generation: number;
  readonly grantedTokens: number;
  declaredPairs: Array<readonly [ProviderName, string]>;
  readonly failOpen: boolean;
  frozenResponse: string;
  lastRenewedFromGeneration: number | null;
}

export interface ScenarioWindow extends Disposable {
  end(): void;
}

interface RejectIngestEffect {
  readonly indices?: readonly number[];
  readonly count?: number;
  readonly malformed?: true;
  readonly code: IngestRejectionCode;
}

interface ScenarioSpec {
  readonly kind: ScenarioKind;
  readonly path: string | null;
  remaining: number | null;
  readonly seconds?: number;
  readonly status?: 409 | 422 | 429 | 503;
  readonly code?: LeaseRefusalCode;
  readonly retryAfter?: number;
  readonly rejectIngest?: RejectIngestEffect;
}

class ScenarioWindowState implements ScenarioWindow {
  private active = true;

  constructor(
    readonly spec: ScenarioSpec,
    private readonly remove: (window: ScenarioWindowState) => void,
  ) {}

  matches(path: string): boolean {
    return (
      this.active &&
      this.spec.remaining !== 0 &&
      (this.spec.path === null || this.spec.path === path)
    );
  }

  consume(): void {
    if (this.spec.remaining !== null) this.spec.remaining--;
  }

  end(): void {
    if (!this.active) return;
    this.active = false;
    this.remove(this);
  }

  [Symbol.dispose](): void {
    this.end();
  }
}

interface PreparedRequest {
  readonly outage: boolean;
  readonly delaySeconds: number;
  readonly delayMatched: boolean;
  readonly response: PlaneResponse | null;
}

export interface FakeControlPlaneOptions {
  mode?: BudgetMode;
  budgetLimit?: number;
  currentUsage?: number;
  remainingBudget?: number;
  projectId?: string;
  failoverTuningAllowed?: boolean;
  priceHints?: Record<string, number> | null;
  leaseEligible?: boolean;
  grantedTokens?: number;
  headroomShareTokens?: number | null;
  finalGrant?: boolean;
  refreshIntervalS?: number;
  leaseLengthS?: number;
}

const FakeControlPlaneOptionsSchema = z.strictObject({
  mode: z.enum(["alert_only", "hard_deny"]).optional(),
  budgetLimit: z.number().optional(),
  currentUsage: z.number().optional(),
  remainingBudget: z.number().optional(),
  projectId: z.string().min(1).optional(),
  failoverTuningAllowed: z.boolean().optional(),
  priceHints: z.record(z.string(), z.number()).nullable().optional(),
  leaseEligible: z.boolean().optional(),
  grantedTokens: z.number().int().min(0).optional(),
  headroomShareTokens: z.number().int().min(0).nullable().optional(),
  finalGrant: z.boolean().optional(),
  refreshIntervalS: z.number().positive().optional(),
  leaseLengthS: z.number().positive().optional(),
});

const CHECK_PATH = "/api/v1/budgets/check";
const CONFIRM_PATH = "/api/v1/budgets/confirm";
const LEASE_GRANT_PATH = "/api/v1/budgets/lease";
const LEASE_RENEW_PATH = "/api/v1/budgets/lease/renew";
const LEASE_SURRENDER_PATH = "/api/v1/budgets/lease/surrender";
const INGEST_PATH = "/api/v1/metadata/ingest";
const UNTRACKED_PATH = "/api/v1/untracked-surfaces";
const BREAKER_PATH = /^\/api\/v1\/projects\/[^/]+\/providers\/breaker-reports$/;
const DENIAL_PERIODS = new Set<DenialPeriod>(["monthly", "agent_run", "run_stopped", "tag"]);
const MAGIC_MODEL_SET = new Set<string>(MAGIC_MODELS);
const INGEST_REJECTION_CODE_SET = new Set<IngestRejectionCode>([
  "unknown_model",
  "unknown_service_tier",
  "invalid_tags",
  "tag_cardinality_exceeded",
  "unsupported_modality",
]);

const RESERVED_WRAP_KEYS = ["apiKey", "apiUrl", "fetch"] as const;
const ENV_CONFIG_TO_OPTION: Readonly<Record<string, keyof SolwynOptions>> = Object.freeze({
  tags: "tags",
  fail_open: "failOpen",
  budget_mode: "budgetMode",
  budget_check_timeout: "budgetCheckTimeout",
  control_plane_failure_threshold: "controlPlaneFailureThreshold",
  control_plane_recovery_timeout: "controlPlaneRecoveryTimeout",
  breaker_reporting_enabled: "breakerReportingEnabled",
  circuit_breaker_failure_threshold: "circuitBreakerFailureThreshold",
  circuit_breaker_recovery_timeout: "circuitBreakerRecoveryTimeout",
  circuit_breaker_success_threshold: "circuitBreakerSuccessThreshold",
  budget_check_cache_ttl: "budgetCheckCacheTtl",
  reporter_batch_size: "reporterBatchSize",
  reporter_flush_interval: "reporterFlushInterval",
  reporter_max_queue_size: "reporterMaxQueueSize",
  reporter_max_in_flight: "reporterMaxInFlight",
  reporter_max_send_attempts: "reporterMaxSendAttempts",
  reporter_retry_backoff_base: "reporterRetryBackoffBase",
  reporter_retry_backoff_cap: "reporterRetryBackoffCap",
  reporter_shutdown_deadline: "reporterShutdownDeadline",
  breaker_report_heartbeat: "breakerReportHeartbeat",
  velocity_mode: "velocityMode",
  velocity_repeat_count: "velocityRepeatCount",
  velocity_repeat_window_s: "velocityRepeatWindowS",
  velocity_growth_streak: "velocityGrowthStreak",
  velocity_growth_factor: "velocityGrowthFactor",
  velocity_accel_floor_per_min: "velocityAccelFloorPerMin",
  velocity_accel_factor: "velocityAccelFactor",
});

type WrapOptions = Omit<SolwynOptions, "apiKey" | "apiUrl" | "fetch">;

interface ControlPlaneWiring {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly fetch: FetchLike;
}

/** Pure construction seam used to prove environment-neutral test wrappers. */
export function buildHermeticWrapOptions(
  wiring: ControlPlaneWiring,
  env: EnvSnapshot,
  options: WrapOptions = {},
): SolwynOptions {
  for (const key of RESERVED_WRAP_KEYS) {
    if (Object.hasOwn(options, key)) {
      throw new TypeError(`reserved control-plane wiring cannot be overridden: ${key}`);
    }
  }

  const defaults = SolwynConfigSchema.parse({ api_key: wiring.apiKey });
  const hermetic: Record<string, unknown> = {};
  for (const [field, envName] of Object.entries(ENV_FIELD_MAP)) {
    if (env[envName] === undefined) continue;
    if (field === "tags") {
      hermetic["tags"] = {};
      continue;
    }
    const option = ENV_CONFIG_TO_OPTION[field];
    const value = defaults[field as keyof typeof defaults];
    if (option !== undefined && value !== undefined && value !== null) {
      hermetic[option] = value;
    }
  }

  const base: Record<string, unknown> = {
    ...hermetic,
    apiKey: wiring.apiKey,
    apiUrl: wiring.apiUrl,
    fetch: wiring.fetch,
    budgetCheckCacheTtl: 0,
  };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined || !Object.hasOwn(base, key)) {
      base[key] = value;
    }
  }
  return base as SolwynOptions;
}

class TestingSolwynCore extends SolwynCore {
  readonly #primaryModel: unknown;
  readonly #defaultModel: unknown;
  readonly #fallbackModels: unknown[];

  constructor(client: unknown, options: SolwynOptions) {
    super(client, options);
    this.#primaryModel = options.model;
    this.#defaultModel = options.defaultParams?.["model"];
    this.#fallbackModels = Array.isArray(options.fallback)
      ? options.fallback.map((entry) => (Array.isArray(entry) ? entry[1] : undefined))
      : [];
  }

  #validateModels(kwargs: Record<string, unknown>): void {
    const configuredModel = Object.hasOwn(kwargs, "model") ? kwargs["model"] : this.#defaultModel;
    validateTestingModels(
      [
        typeof configuredModel === "string" ? configuredModel : this.#primaryModel,
        ...this.#fallbackModels,
      ],
      getCurrentRun(),
    );
  }

  override async interceptedCall(
    surface: InterceptSurface,
    kwargs: Record<string, unknown>,
    options: InterceptOptions = {},
    passthroughArgs: readonly unknown[] = [],
  ): Promise<unknown> {
    this.#validateModels(kwargs);
    return super.interceptedCall(surface, kwargs, options, passthroughArgs);
  }

  override async mediaCall(
    spec: MediaSurfaceSpec,
    kwargs: Record<string, unknown>,
    passthroughArgs: readonly unknown[] = [],
    resolvedRequest?: Parameters<SolwynCore["mediaCall"]>[3],
    markers: Parameters<SolwynCore["mediaCall"]>[4] = {},
  ): Promise<unknown> {
    this.#validateModels(kwargs);
    return super.mediaCall(spec, kwargs, passthroughArgs, resolvedRequest, markers);
  }

  override async resolveMediaRequest(
    kwargs: Record<string, unknown>,
    markers: Parameters<SolwynCore["resolveMediaRequest"]>[1] = {},
  ): Promise<Awaited<ReturnType<SolwynCore["resolveMediaRequest"]>>> {
    this.#validateModels(kwargs);
    return super.resolveMediaRequest(kwargs, markers);
  }
}

export function denialOnlyOpenAIClient(): {
  chat: { completions: { create(): never } };
} {
  return {
    chat: {
      completions: {
        create(): never {
          throw testingError("denial-only client reached provider dispatch");
        },
      },
    },
  };
}

function configurationError(error: z.ZodError): ConfigurationError {
  const issue = error.issues[0];
  const segment = issue?.path[0];
  return new ConfigurationError(issue?.message ?? "invalid fake control plane options", {
    field: segment === undefined ? null : String(segment),
  });
}

function testingError(message: string): Error {
  return new Error(`solwyn.testing: ${message}`);
}

function testingConfigurationError(message: string, field: string): ConfigurationError {
  return new ConfigurationError(`solwyn.testing: ${message}`, { field });
}

function errorResponse(status: number, detail: string): PlaneResponse {
  return { status, body: { detail }, headers: {} };
}

function normalizedTimestamp(timestamp: string): string {
  const rfc3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i.exec(
    timestamp,
  );
  if (rfc3339 !== null) {
    const wholeSecond = Date.parse(`${rfc3339[1]}${rfc3339[3]}`);
    if (Number.isFinite(wholeSecond)) {
      const fraction = (rfc3339[2] ?? "").replace(/0+$/, "");
      return `${Math.floor(wholeSecond / 1000)}:${fraction}`;
    }
  }
  const millis = Date.parse(timestamp);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : timestamp;
}

function scenarioCount(
  value: number | null | undefined,
  defaultValue: number | null,
): number | null {
  if (value === undefined) return defaultValue;
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw testingError("scenario request count must be a nonnegative integer or null");
  }
  return value;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function abortableDelay(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(abortError(signal as AbortSignal)));
    const timer = setTimeout(() => finish(resolve), seconds * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeControlPlane {
  readonly apiKey = `sk_proj_${"0".repeat(64)}`;
  readonly apiUrl = "http://control-plane.invalid";
  readonly fetch: FetchLike;

  readonly checks: BudgetCheckRequest[] = [];
  readonly confirms: BudgetConfirmRequest[] = [];
  readonly ingested: MetadataEvent[] = [];
  readonly leaseGrants: LeaseGrantRequest[] = [];
  readonly leaseRenewals: LeaseRenewRequest[] = [];
  readonly leaseSurrenders: LeaseSurrenderRequest[] = [];
  readonly untrackedReports: UntrackedSurfaceReport[] = [];
  readonly breakerReports: BreakerStateReport[] = [];
  readonly unmatchedRequests: Array<{ method: string; path: string }> = [];

  get denialReceipts(): MetadataEvent[] {
    return this.ingested.filter((event) => event.deny_source != null);
  }

  get aggregateReplays(): MetadataEvent[] {
    return this.ingested.filter((event) => event.deny_source === "aggregate_replay");
  }

  private readonly mode: BudgetMode;
  private readonly budgetLimit: number;
  private readonly currentUsage: number;
  private readonly remainingBudget: number;
  private readonly projectId: string;
  private readonly failoverTuningAllowed: boolean;
  private readonly priceHints: Record<string, number> | null;

  private readonly leaseEligible: boolean;
  private readonly grantedTokens: number;
  private readonly headroomShareTokens: number;
  private readonly finalGrant: boolean;
  private readonly refreshIntervalS: number;
  private readonly leaseLengthS: number;

  private readonly pendingDenials: DenialPeriod[] = [];
  private readonly pendingLeaseDenials: DenialPeriod[] = [];
  private readonly deniedRuns = new Set<string>();
  private readonly stoppedRunReasons = new Map<string, string>();
  private readonly runawaySeen = new Set<string>();
  private readonly killSeenRuns = new Set<string>();
  private readonly activeReservations = new Set<string>();
  private readonly settledReservations = new Set<string>();
  private readonly confirmedCallIds = new Set<string>();
  private readonly ingestCallIds = new Set<string>();
  private readonly ingestLegacyIds = new Set<string>();
  private readonly lastUntrackedReportIds = new Map<string, string>();
  private readonly scenarioWindows = new Set<ScenarioWindowState>();
  private readonly leasesByHolder = new Map<string, Map<string, LeaseRecord>>();
  private readonly leasesById = new Map<string, LeaseRecord>();
  private readonly expiredLeaseIds = new Set<string>();
  private readonly releasedLeaseIds = new Set<string>();
  private reservationCounter = 0;
  private leaseCounter = 0;

  constructor(options: FakeControlPlaneOptions = {}) {
    const parsed = FakeControlPlaneOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw configurationError(parsed.error);
    }
    const value = parsed.data;
    const leaseLengthS = value.leaseLengthS ?? 90;
    const refreshIntervalS = value.refreshIntervalS ?? 30;
    if (refreshIntervalS >= leaseLengthS) {
      throw new ConfigurationError("refreshIntervalS must be less than leaseLengthS", {
        field: "refreshIntervalS",
      });
    }

    this.mode = value.mode ?? "hard_deny";
    this.budgetLimit = value.budgetLimit ?? 100;
    this.currentUsage = value.currentUsage ?? 0;
    this.remainingBudget = value.remainingBudget ?? this.budgetLimit - this.currentUsage;
    this.projectId = value.projectId ?? "proj_fake";
    this.failoverTuningAllowed = value.failoverTuningAllowed ?? true;
    this.priceHints = value.priceHints === undefined ? null : value.priceHints;
    this.leaseEligible = value.leaseEligible ?? true;
    this.grantedTokens = value.grantedTokens ?? 200_000;
    this.headroomShareTokens = value.headroomShareTokens ?? this.grantedTokens;
    this.finalGrant = value.finalGrant ?? false;
    this.refreshIntervalS = refreshIntervalS;
    this.leaseLengthS = leaseLengthS;

    this.fetch = async (input, init) => {
      let body: unknown;
      let jsonInvalid = false;
      if (init?.body !== undefined && init.body !== null) {
        if (typeof init.body !== "string") {
          jsonInvalid = true;
        } else {
          try {
            body = JSON.parse(init.body) as unknown;
          } catch {
            jsonInvalid = true;
          }
        }
      }
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(input).pathname;
      const prepared = this.prepareFetch(method, path, body, jsonInvalid);
      if (prepared.outage) {
        throw new TypeError("fetch failed");
      }
      if (prepared.delayMatched) {
        await abortableDelay(prepared.delaySeconds, init?.signal ?? undefined);
      }
      return responseToFetch(prepared.response as PlaneResponse);
    };
  }

  wrap<C extends object>(client: C, options: WrapOptions = {}): Solwyn & InterceptedClient<C> {
    const resolvedOptions = buildHermeticWrapOptions(this, getEnvSnapshot(), options);
    const core = new TestingSolwynCore(client, resolvedOptions);
    return createClientProxy(core, client) as Solwyn & InterceptedClient<C>;
  }

  outage(options: { requests?: number; path?: string } = {}): ScenarioWindow {
    return this.addScenario({
      kind: "outage",
      path: options.path ?? null,
      remaining: scenarioCount(options.requests, null),
    });
  }

  slow(seconds: number, options: { path?: string; requests?: number } = {}): ScenarioWindow {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw testingError("slow seconds must be a nonnegative finite number");
    }
    return this.addScenario({
      kind: "slow",
      path: options.path ?? CONFIRM_PATH,
      remaining: scenarioCount(options.requests, null),
      seconds,
    });
  }

  readOnly(options: { requests?: number; path?: string } = {}): ScenarioWindow {
    return this.addScenario({
      kind: "read_only",
      path: options.path ?? null,
      remaining: scenarioCount(options.requests, null),
    });
  }

  refuseChecks(
    options: { status?: 422 | 429 | 503; requests?: number; retryAfter?: number } = {},
  ): ScenarioWindow {
    const status = options.status ?? 503;
    if (status !== 422 && status !== 429 && status !== 503) {
      throw testingError(`unsupported check refusal status '${String(status)}'`);
    }
    const retryAfter = options.retryAfter ?? 60;
    if (!Number.isInteger(retryAfter) || retryAfter < 0) {
      throw testingError("retryAfter must be a nonnegative integer");
    }
    return this.addScenario({
      kind: "refuse_checks",
      path: CHECK_PATH,
      remaining: scenarioCount(options.requests, null),
      status,
      retryAfter,
    });
  }

  refuseLeases(
    options: { status?: 503 | 409; code?: LeaseRefusalCode; requests?: number | null } = {},
  ): ScenarioWindow {
    const status = options.status ?? 503;
    const code = options.code ?? "lease_unavailable";
    if (status !== 503 && status !== 409) {
      throw testingConfigurationError("unsupported lease refusal status", "status");
    }
    if (code !== "lease_unavailable" && code !== "lease_holder_cap_exceeded") {
      throw testingConfigurationError("unsupported lease refusal code", "code");
    }
    if (
      (status === 503 && code !== "lease_unavailable") ||
      (status === 409 && code !== "lease_holder_cap_exceeded")
    ) {
      throw testingConfigurationError(
        "lease refusal status/code must be 503/lease_unavailable or 409/lease_holder_cap_exceeded",
        "code",
      );
    }
    if (
      options.requests !== undefined &&
      options.requests !== null &&
      (!Number.isInteger(options.requests) || options.requests < 0)
    ) {
      throw testingConfigurationError(
        "lease refusal requests must be a nonnegative integer",
        "requests",
      );
    }
    return this.addScenario({
      kind: "refuse_leases",
      path: null,
      remaining: options.requests ?? null,
      status,
      code,
    });
  }

  rejectIngest(options: {
    indices?: number[];
    count?: number;
    malformed?: boolean;
    code?: IngestRejectionCode;
    requests?: number | null;
  }): ScenarioWindow {
    const selected =
      Number(options.indices !== undefined) +
      Number(options.count !== undefined) +
      Number(options.malformed === true);
    if (selected !== 1) {
      throw testingError("rejectIngest requires exactly one of indices, count, or malformed");
    }
    if (options.indices !== undefined) {
      if (
        options.indices.length === 0 ||
        options.indices.some((index) => !Number.isInteger(index) || index < 0) ||
        new Set(options.indices).size !== options.indices.length
      ) {
        throw testingError("rejectIngest indices must be unique nonnegative integers");
      }
    }
    if (options.count !== undefined && (!Number.isInteger(options.count) || options.count < 1)) {
      throw testingError("rejectIngest count must be a positive integer");
    }
    const code = options.code ?? "invalid_tags";
    if (!INGEST_REJECTION_CODE_SET.has(code)) {
      throw testingError(`unknown ingest rejection code '${String(code)}'`);
    }
    const effect: RejectIngestEffect = {
      code,
      ...(options.indices === undefined ? {} : { indices: [...options.indices] }),
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.malformed === true ? { malformed: true as const } : {}),
    };
    return this.addScenario({
      kind: "reject_ingest",
      path: INGEST_PATH,
      remaining: scenarioCount(options.requests, 1),
      rejectIngest: effect,
    });
  }

  denyNext(n = 1, options: { period?: DenialPeriod; scope?: DenialScope } = {}): void {
    if (!Number.isInteger(n) || n < 0) {
      throw testingConfigurationError("denyNext count must be a nonnegative integer", "n");
    }
    const period = options.period ?? "monthly";
    if (!DENIAL_PERIODS.has(period)) {
      throw testingConfigurationError(`unknown denial period '${String(period)}'`, "period");
    }
    const scope = options.scope ?? "check";
    if (scope !== "check" && scope !== "lease") {
      throw testingConfigurationError(`unknown denial scope '${String(scope)}'`, "scope");
    }
    if (scope === "lease" && period === "tag") {
      throw testingConfigurationError("lease denials cannot use the tag period", "period");
    }
    const queue = scope === "lease" ? this.pendingLeaseDenials : this.pendingDenials;
    for (let index = 0; index < n; index++) {
      queue.push(period);
    }
  }

  denyRun(agentRunId: string): void {
    this.deniedRuns.add(agentRunId);
  }

  stopRun(agentRunId: string, options: { reason?: string } = {}): void {
    const reason = options.reason ?? "manual_kill";
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 64) {
      throw testingConfigurationError(
        "stop reason must be a nonempty string of at most 64 characters",
        "reason",
      );
    }
    const existing = this.stoppedRunReasons.get(agentRunId);
    if (existing === undefined) {
      this.stoppedRunReasons.set(agentRunId, reason);
      return;
    }
    if (existing !== reason) {
      throw testingConfigurationError(
        `run ${JSON.stringify(agentRunId)} is already stopped with reason ${JSON.stringify(existing)}; clearStop() before scripting reason ${JSON.stringify(reason)}`,
        "reason",
      );
    }
  }

  clearStop(agentRunId: string): void {
    this.stoppedRunReasons.delete(agentRunId);
  }

  get stoppedRuns(): Record<string, string> {
    return Object.fromEntries(this.stoppedRunReasons);
  }

  misrouteStops(options: { requests?: number | null } = {}): ScenarioWindow {
    if (
      options.requests !== undefined &&
      options.requests !== null &&
      (!Number.isInteger(options.requests) || options.requests < 0)
    ) {
      throw testingConfigurationError(
        "misrouteStops requests must be a nonnegative integer or null",
        "requests",
      );
    }
    return this.addScenario({
      kind: "misroute_stops",
      path: null,
      remaining: options.requests ?? null,
    });
  }

  clearDenials(): void {
    this.pendingDenials.length = 0;
    this.pendingLeaseDenials.length = 0;
    this.deniedRuns.clear();
  }

  expireReservations(): void {
    this.activeReservations.clear();
  }

  expireLeases(): void {
    for (const leaseId of this.leasesById.keys()) this.expiredLeaseIds.add(leaseId);
  }

  resetRecording(): void {
    this.checks.length = 0;
    this.confirms.length = 0;
    this.ingested.length = 0;
    this.leaseGrants.length = 0;
    this.leaseRenewals.length = 0;
    this.leaseSurrenders.length = 0;
    this.untrackedReports.length = 0;
    this.breakerReports.length = 0;
    this.unmatchedRequests.length = 0;
  }

  handle(method: string, path: string, body: unknown): PlaneResponse {
    return this.dispatch(method.toUpperCase(), path, body);
  }

  private dispatch(method: string, path: string, body: unknown): PlaneResponse {
    const route = this.resolveRoute(method, path);
    if (route === null) {
      this.unmatchedRequests.push({ method, path });
      return errorResponse(404, "not found");
    }
    const refusal = this.endpointRefusal(method, path, body);
    if (refusal !== null) return refusal;
    if (method === "POST") {
      const readOnly = this.matchingScenarios("read_only", path)[0];
      if (readOnly !== undefined) {
        readOnly.consume();
        return this.readOnlyResponse();
      }
    }
    if (route === "ingest") {
      const invalid = this.validateIngestBody(body);
      if (invalid !== null) return invalid;
      const rejection = this.matchingScenarios("reject_ingest", path)[0];
      if (rejection !== undefined) rejection.consume();
      return this.handleIngest(body, rejection?.spec.rejectIngest);
    }
    return this.routeHandler(route, body);
  }

  private addScenario(spec: ScenarioSpec): ScenarioWindowState {
    const window = new ScenarioWindowState(spec, (current) => {
      this.scenarioWindows.delete(current);
    });
    this.scenarioWindows.add(window);
    return window;
  }

  private matchingScenarios(kind: ScenarioKind, path: string): ScenarioWindowState[] {
    return [...this.scenarioWindows].filter(
      (window) => window.spec.kind === kind && window.matches(path),
    );
  }

  private prepareFetch(
    method: string,
    path: string,
    body: unknown,
    jsonInvalid: boolean,
  ): PreparedRequest {
    const outages = this.matchingScenarios("outage", path);
    if (outages.length > 0) {
      for (const window of outages) window.consume();
      return { outage: true, delaySeconds: 0, delayMatched: false, response: null };
    }

    const slows = this.matchingScenarios("slow", path);
    const delaySeconds = slows.reduce((sum, window) => sum + (window.spec.seconds ?? 0), 0);
    for (const window of slows) window.consume();

    if (jsonInvalid) {
      return {
        outage: false,
        delaySeconds,
        delayMatched: slows.length > 0,
        response: jsonValidationResponse(),
      };
    }

    return {
      outage: false,
      delaySeconds,
      delayMatched: slows.length > 0,
      response: this.dispatch(method, path, body),
    };
  }

  private routeHandler(route: Exclude<Route, "ingest">, body: unknown): PlaneResponse {
    if (route === "health") return { status: 200, body: { status: "ok" }, headers: {} };
    if (route === "check") return this.handleCheck(body);
    if (route === "confirm") return this.handleConfirm(body);
    if (route === "untracked") return this.handleUntracked(body);
    if (route === "lease_grant") return this.handleLeaseGrant(body);
    if (route === "lease_renew") return this.handleLeaseRenew(body);
    if (route === "lease_surrender") return this.handleLeaseSurrender(body);
    return this.handleBreaker(body);
  }

  private resolveRoute(method: string, path: string): Route | null {
    if (method === "GET" && path === "/health") return "health";
    if (method !== "POST") return null;
    if (path === CHECK_PATH) return "check";
    if (path === CONFIRM_PATH) return "confirm";
    if (path === INGEST_PATH) return "ingest";
    if (path === UNTRACKED_PATH) return "untracked";
    if (path === LEASE_GRANT_PATH) return "lease_grant";
    if (path === LEASE_RENEW_PATH) return "lease_renew";
    if (path === LEASE_SURRENDER_PATH) return "lease_surrender";
    if (BREAKER_PATH.test(path)) return "breaker";
    return null;
  }

  private validateIngestBody(body: unknown): PlaneResponse | null {
    const parsed = parseBodyList(MetadataEventSchema, body);
    return parsed.success ? null : parsed.response;
  }

  private endpointRefusal(method: string, path: string, body: unknown): PlaneResponse | null {
    if (method !== "POST") return null;
    if (path === CHECK_PATH) {
      const checkRefusal = this.matchingScenarios("refuse_checks", path)[0];
      if (checkRefusal !== undefined) {
        checkRefusal.consume();
        return this.checkRefusal(checkRefusal.spec, body);
      }
    }
    if (path !== LEASE_GRANT_PATH && path !== LEASE_RENEW_PATH && path !== LEASE_SURRENDER_PATH)
      return null;
    const leaseRefusal = this.matchingScenarios("refuse_leases", path).find((window) => {
      const code = window.spec.code;
      return (
        code === "lease_unavailable" ||
        (code === "lease_holder_cap_exceeded" && path === LEASE_GRANT_PATH)
      );
    });
    if (leaseRefusal === undefined) return null;
    leaseRefusal.consume();
    const code = leaseRefusal.spec.code as LeaseRefusalCode;
    return this.leaseError(
      leaseRefusal.spec.status as 409 | 503,
      code,
      code === "lease_unavailable"
        ? "Budget lease service temporarily unavailable; retry"
        : "Active lease holder limit exceeded",
    );
  }

  private readOnlyResponse(): PlaneResponse {
    return {
      status: 403,
      body: {
        detail: {
          code: "read_only_key",
          message: "read-only project key cannot write",
        },
      },
      headers: {},
    };
  }

  private checkRefusal(spec: ScenarioSpec, body: unknown): PlaneResponse {
    if (spec.status === 422) {
      const diagnostic =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const model =
        typeof diagnostic["model"] === "string" ? diagnostic["model"].slice(0, 50) : "unknown";
      const provider =
        typeof diagnostic["provider"] === "string" ? diagnostic["provider"] : "unknown";
      return {
        status: 422,
        body: {
          detail: {
            code: "unknown_model",
            model,
            provider,
            message: `Solwyn does not have pricing for model '${model}'. File an issue at https://github.com/solwyn-ai/solwyn-python-sdk/issues or contact support — we typically add new models within 24h.`,
          },
        },
        headers: {},
      };
    }
    if (spec.status === 429) {
      const retryAfter = spec.retryAfter ?? 60;
      return {
        status: 429,
        body: { detail: "Rate limit exceeded", retry_after: retryAfter },
        headers: { "Retry-After": String(retryAfter) },
      };
    }
    return errorResponse(503, "Budget backend temporarily unavailable; retry");
  }

  private handleCheck(body: unknown): PlaneResponse {
    const parsed = parseBody(BudgetCheckRequestSchema, body);
    if (!parsed.success) return parsed.response;
    const request = parsed.data as unknown as BudgetCheckRequest;
    const models = [request.model, ...(request.fallback_models ?? [])];
    for (const model of models) {
      if (model.startsWith("solwyn-test/") && !MAGIC_MODEL_SET.has(model)) {
        throw testingError(`unknown magic model '${model}'`);
      }
    }

    this.checks.push(request);
    const evaluation = this.evaluateChain(request.agent_run_id ?? null, models, "check");
    const verdict = {
      period: evaluation.period,
      mode:
        evaluation.period === "run_stopped"
          ? "hard_deny"
          : evaluation.trigger === "solwyn-test/deny-alert"
            ? "alert_only"
            : this.mode,
    };
    const excludeNullOptionals =
      request.failover_directive_version === "1" || request.run_directive_version === "1";
    const reservationId =
      verdict.period === null
        ? `res_fake_${String(++this.reservationCounter).padStart(8, "0")}`
        : null;
    const runControl = this.runStopDirective(
      request.agent_run_id ?? null,
      verdict.period,
      request.run_directive_version === "1",
      CHECK_PATH,
    );
    const response: BudgetCheckResponse = {
      allowed: verdict.period === null,
      remaining_budget:
        verdict.period === null
          ? this.remainingBudget
          : verdict.period === "run_stopped"
            ? 0
            : Math.max(0, this.remainingBudget),
      mode: verdict.mode,
      budget_limit: this.budgetLimit,
      current_usage: this.currentUsage,
      project_id: this.projectId,
      ...(reservationId === null && excludeNullOptionals ? {} : { reservation_id: reservationId }),
      ...(verdict.period === null && excludeNullOptionals
        ? {}
        : { denied_by_period: verdict.period }),
      ...(request.price_hints_version === "1" && this.priceHints !== null
        ? { price_hints: { ...this.priceHints } }
        : excludeNullOptionals
          ? {}
          : { price_hints: null }),
      ...(request.failover_directive_version === "1"
        ? {
            failover_directive: {
              version: "1" as const,
              failover_tuning_allowed: this.failoverTuningAllowed,
            },
          }
        : excludeNullOptionals
          ? {}
          : { failover_directive: null }),
      ...(excludeNullOptionals
        ? runControl === null
          ? {}
          : { run_control: runControl }
        : { run_control: runControl }),
    };
    if (reservationId !== null) {
      this.activeReservations.add(reservationId);
    }
    return validatedResponse(200, BudgetCheckResponseSchema, response);
  }

  private requireRunForPeriod(period: DenialPeriod, runId: string | null): void {
    if ((period === "agent_run" || period === "run_stopped") && runId === null) {
      throw testingConfigurationError(
        `run-scoped denial '${period}' requires an agent_run_id`,
        "agent_run_id",
      );
    }
  }

  private runStopDirective(
    agentRunId: string | null,
    period: DenialPeriod | null,
    optedIn: boolean,
    path: string,
  ): RunControlDirective | null {
    if (!optedIn || agentRunId === null || period !== "run_stopped") return null;
    const reason = this.stoppedRunReasons.get(agentRunId);
    if (reason === undefined) return null;
    const misroute = this.matchingScenarios("misroute_stops", path)[0];
    if (misroute !== undefined) misroute.consume();
    return {
      version: "1",
      action: "terminate",
      agent_run_id: misroute === undefined ? agentRunId : "solwyn-test-misrouted-run",
      reason,
    };
  }

  private handleLeaseGrant(body: unknown): PlaneResponse {
    const parsed = parseBody(LeaseGrantRequestSchema, body);
    if (!parsed.success) return parsed.response;
    const request = parsed.data;
    this.validateLeaseMagicModels([request.model, ...(request.fallback_models ?? [])]);
    this.leaseGrants.push(request);

    const declaredPairs = this.grantDeclaredPairs(request);
    const current = this.findLeaseForHolder(request.agent_run_id, request.holder_id);
    if (
      current !== undefined &&
      !this.expiredLeaseIds.has(current.leaseId) &&
      !this.releasedLeaseIds.has(current.leaseId)
    ) {
      if (
        this.samePairs(current.declaredPairs, declaredPairs) &&
        current.failOpen === (request.fail_open ?? true)
      ) {
        return this.replayGrant(current);
      }
      return this.leaseError(
        409,
        "lease_holder_cap_exceeded",
        "Active lease holder limit exceeded",
      );
    }

    const verdict = this.leaseVerdict(
      request.agent_run_id,
      [request.model, ...(request.fallback_models ?? [])],
      request.run_directive_version === "1",
      LEASE_GRANT_PATH,
    );
    if (verdict !== null) return validatedResponse(200, LeaseGrantResponseSchema, verdict);

    const record: LeaseRecord = {
      agentRunId: request.agent_run_id,
      holderId: request.holder_id,
      leaseId: `lse_fake${++this.leaseCounter}`,
      generation: 1,
      grantedTokens: this.grantedTokens,
      declaredPairs,
      failOpen: request.fail_open ?? true,
      frozenResponse: "",
      lastRenewedFromGeneration: null,
    };
    let holders = this.leasesByHolder.get(request.agent_run_id);
    if (holders === undefined) {
      holders = new Map();
      this.leasesByHolder.set(request.agent_run_id, holders);
    }
    holders.set(request.holder_id, record);
    this.leasesById.set(record.leaseId, record);
    return this.storeLeaseResponse(record, this.leaseResponse(record));
  }

  private handleLeaseRenew(body: unknown): PlaneResponse {
    const parsed = parseBody(LeaseRenewRequestSchema, body);
    if (!parsed.success) return parsed.response;
    const request = parsed.data;
    const additions = this.renewalDeclaredPairs(request);
    this.validateLeaseMagicModels(additions.map(([, model]) => model));
    this.leaseRenewals.push(request);

    const record = this.leasesById.get(request.lease_id);
    if (
      record === undefined ||
      record.holderId !== request.holder_id ||
      this.expiredLeaseIds.has(request.lease_id) ||
      this.releasedLeaseIds.has(request.lease_id)
    ) {
      return this.leaseError(404, "lease_not_found", "Budget lease not found");
    }
    if (
      record.lastRenewedFromGeneration === request.generation &&
      record.generation === request.generation + 1
    ) {
      return this.replayLeaseResponse(record);
    }
    if (
      request.generation !== record.generation ||
      (record.lastRenewedFromGeneration !== null &&
        record.lastRenewedFromGeneration >= record.generation)
    ) {
      return this.leaseError(409, "lease_generation_conflict", "Budget lease generation conflict");
    }

    const declaredPairs = this.unionPairs(record.declaredPairs, additions);
    const verdict = this.leaseVerdict(
      record.agentRunId,
      declaredPairs.map(([, model]) => model),
      request.run_directive_version === "1",
      LEASE_RENEW_PATH,
    );
    record.lastRenewedFromGeneration = request.generation;
    record.generation++;
    if (verdict !== null) return this.storeLeaseResponse(record, verdict);

    record.declaredPairs = declaredPairs;
    return this.storeLeaseResponse(record, this.leaseResponse(record));
  }

  private handleLeaseSurrender(body: unknown): PlaneResponse {
    const parsed = parseBody(LeaseSurrenderRequestSchema, body);
    if (!parsed.success) return parsed.response;
    const request = parsed.data;
    this.leaseSurrenders.push(request);

    const record = this.leasesById.get(request.lease_id);
    if (record === undefined || record.holderId !== request.holder_id) {
      return this.leaseError(404, "lease_not_found", "Budget lease not found");
    }
    // Approved Python/core simulator parity; OpenAPI omits surrender's 409 response.
    if (!this.surrenderGenerationAccepted(record, request.generation)) {
      return this.leaseError(409, "lease_generation_conflict", "Budget lease generation conflict");
    }
    if (this.expiredLeaseIds.has(record.leaseId) || this.releasedLeaseIds.has(record.leaseId)) {
      return validatedResponse(200, LeaseSurrenderResponseSchema, { released_tokens: 0 });
    }
    this.releasedLeaseIds.add(record.leaseId);
    return validatedResponse(200, LeaseSurrenderResponseSchema, {
      released_tokens: record.grantedTokens,
    });
  }

  /**
   * The current generation, or the predecessor of a stored successor that carries no lease
   * block (an ineligible or denied renewal). A predecessor whose successor is live stays 409.
   */
  private surrenderGenerationAccepted(record: LeaseRecord, generation: number): boolean {
    if (generation === record.generation) return true;
    if (record.lastRenewedFromGeneration !== generation || record.frozenResponse === "") {
      return false;
    }
    const successor = JSON.parse(record.frozenResponse) as LeaseGrantResponse;
    return successor.lease_id === null || successor.lease_id === undefined;
  }

  private leaseVerdict(
    agentRunId: string,
    models: readonly string[],
    runOptedIn: boolean,
    path: string,
  ): LeaseGrantResponse | null {
    const evaluation = this.evaluateChain(agentRunId, models, "lease");
    if (evaluation.period === "tag") {
      return this.leaseVerdictResponse({
        eligible: false,
        allowed: true,
        ineligibleReason: "scoped_rules_present",
      });
    }
    if (evaluation.period !== null) {
      const runControl = this.runStopDirective(agentRunId, evaluation.period, runOptedIn, path);
      return this.leaseVerdictResponse({
        eligible: true,
        allowed: false,
        deniedByPeriod: evaluation.period,
        mode: "hard_deny",
        remainingBudget:
          evaluation.period === "run_stopped" ? 0 : Math.max(0, this.remainingBudget),
        ...(runControl === null ? {} : { runControl }),
      });
    }
    if (evaluation.ineligible) {
      return this.leaseVerdictResponse({
        eligible: false,
        allowed: true,
        ineligibleReason: "zero_rate_model",
      });
    }
    return null;
  }

  private evaluateChain(
    agentRunId: string | null,
    models: readonly string[],
    scope: DenialScope,
  ): { period: DenialPeriod | null; ineligible: boolean; trigger: MagicModel | null } {
    if (agentRunId !== null && this.stoppedRunReasons.has(agentRunId)) {
      return { period: "run_stopped", ineligible: false, trigger: null };
    }
    const pending = scope === "lease" ? this.pendingLeaseDenials : this.pendingDenials;
    const queued = pending.shift();
    if (queued !== undefined) {
      this.requireRunForPeriod(queued, agentRunId);
      return { period: queued, ineligible: false, trigger: null };
    }
    if (agentRunId !== null && this.deniedRuns.has(agentRunId)) {
      return { period: "agent_run", ineligible: false, trigger: null };
    }
    for (const model of models) {
      switch (model) {
        case "solwyn-test/deny":
        case "solwyn-test/deny-alert":
          return { period: "monthly", ineligible: false, trigger: model };
        case "solwyn-test/deny-tag":
          return { period: "tag", ineligible: false, trigger: model };
        case "solwyn-test/deny-stopped":
          this.requireRunForPeriod("run_stopped", agentRunId);
          return { period: "run_stopped", ineligible: false, trigger: model };
        case "solwyn-test/runaway":
          this.requireRunForPeriod("agent_run", agentRunId);
          if (this.runawaySeen.has(agentRunId as string)) {
            return { period: "agent_run", ineligible: false, trigger: model };
          }
          this.runawaySeen.add(agentRunId as string);
          return { period: null, ineligible: false, trigger: model };
        case "solwyn-test/kill":
          this.requireRunForPeriod("run_stopped", agentRunId);
          if (this.killSeenRuns.has(agentRunId as string)) {
            this.stopRun(agentRunId as string);
            return { period: "run_stopped", ineligible: false, trigger: model };
          }
          this.killSeenRuns.add(agentRunId as string);
          return { period: null, ineligible: false, trigger: model };
        case "solwyn-test/lease-ineligible":
        case "no-such-model-for-leases":
          if (scope === "lease") return { period: null, ineligible: true, trigger: null };
          break;
        default:
          break;
      }
    }
    return { period: null, ineligible: scope === "lease" && !this.leaseEligible, trigger: null };
  }

  private leaseVerdictResponse(options: {
    eligible: boolean;
    allowed: boolean;
    ineligibleReason?: string;
    deniedByPeriod?: DenialPeriod;
    mode?: BudgetMode;
    remainingBudget?: number;
    runControl?: RunControlDirective | null;
  }): LeaseGrantResponse {
    return {
      eligible: options.eligible,
      allowed: options.allowed,
      ...(options.ineligibleReason === undefined
        ? {}
        : { ineligible_reason: options.ineligibleReason }),
      ...(options.deniedByPeriod === undefined ? {} : { denied_by_period: options.deniedByPeriod }),
      ...(options.runControl === undefined ? {} : { run_control: options.runControl }),
      project_id: this.projectId,
      mode: options.mode ?? this.mode,
      budget_limit: this.budgetLimit,
      current_usage: this.currentUsage,
      remaining_budget: options.remainingBudget ?? this.remainingBudget,
    };
  }

  private validateLeaseMagicModels(models: readonly string[]): void {
    for (const model of models) {
      if (model.startsWith("solwyn-test/") && !MAGIC_MODEL_SET.has(model)) {
        throw testingConfigurationError(`unknown magic model '${model}'`, "model");
      }
    }
  }

  private findLeaseForHolder(agentRunId: string, holderId: string): LeaseRecord | undefined {
    return this.leasesByHolder.get(agentRunId)?.get(holderId);
  }

  private grantDeclaredPairs(request: LeaseGrantRequest): Array<readonly [ProviderName, string]> {
    return this.declaredPairs(
      request.provider,
      request.model,
      request.fallback_providers ?? [],
      request.fallback_models ?? [],
    );
  }

  private renewalDeclaredPairs(request: LeaseRenewRequest): Array<readonly [ProviderName, string]> {
    if (
      request.provider === undefined ||
      request.provider === null ||
      request.model === undefined ||
      request.model === null
    ) {
      return [];
    }
    return this.declaredPairs(
      request.provider,
      request.model,
      request.fallback_providers ?? [],
      request.fallback_models ?? [],
    );
  }

  private declaredPairs(
    provider: ProviderName,
    model: string,
    fallbackProviders: readonly ProviderName[],
    fallbackModels: readonly string[],
  ): Array<readonly [ProviderName, string]> {
    const pairs: Array<readonly [ProviderName, string]> = [[provider, model]];
    for (const [index, fallbackProvider] of fallbackProviders.entries()) {
      const fallbackModel = fallbackModels[index];
      if (fallbackModel !== undefined) pairs.push([fallbackProvider, fallbackModel]);
    }
    return this.uniquePairs(pairs);
  }

  private uniquePairs(
    pairs: readonly (readonly [ProviderName, string])[],
  ): Array<readonly [ProviderName, string]> {
    const result: Array<readonly [ProviderName, string]> = [];
    for (const pair of pairs) {
      if (!result.some(([provider, model]) => provider === pair[0] && model === pair[1])) {
        result.push(pair);
      }
    }
    return result;
  }

  private unionPairs(
    current: readonly (readonly [ProviderName, string])[],
    additions: readonly (readonly [ProviderName, string])[],
  ): Array<readonly [ProviderName, string]> {
    return this.uniquePairs([...current, ...additions]);
  }

  private samePairs(
    first: readonly (readonly [ProviderName, string])[],
    second: readonly (readonly [ProviderName, string])[],
  ): boolean {
    return (
      first.length === second.length &&
      first.every(
        ([provider, model], index) =>
          provider === second[index]?.[0] && model === second[index]?.[1],
      )
    );
  }

  private leaseResponse(record: LeaseRecord): LeaseGrantResponse {
    return {
      eligible: true,
      allowed: true,
      lease_id: record.leaseId,
      generation: record.generation,
      granted_tokens: record.grantedTokens,
      refresh_interval_s: this.refreshIntervalS,
      lease_length_s: this.leaseLengthS,
      headroom_share_tokens: this.headroomShareTokens,
      posture: {
        mode: this.mode,
        on_unreachable: record.failOpen ? "fail_open" : "local_enforce",
      },
      final_grant: this.finalGrant,
      project_id: this.projectId,
      mode: this.mode,
      budget_limit: this.budgetLimit,
      current_usage: this.currentUsage,
      remaining_budget: this.remainingBudget,
    };
  }

  private storeLeaseResponse(record: LeaseRecord, body: LeaseGrantResponse): PlaneResponse {
    const response = validatedResponse(200, LeaseGrantResponseSchema, body);
    record.frozenResponse = JSON.stringify(response.body);
    return response;
  }

  private replayLeaseResponse(record: LeaseRecord): PlaneResponse {
    return validatedResponse(200, LeaseGrantResponseSchema, JSON.parse(record.frozenResponse));
  }

  private replayGrant(record: LeaseRecord): PlaneResponse {
    const response = JSON.parse(record.frozenResponse) as LeaseGrantResponse;
    if (response.lease_length_s === undefined || response.refresh_interval_s === undefined) {
      return this.leaseError(409, "lease_generation_conflict", "Budget lease generation conflict");
    }
    return validatedResponse(200, LeaseGrantResponseSchema, response);
  }

  private leaseError(status: 404 | 409 | 503, code: string, message: string): PlaneResponse {
    return { status, body: { detail: { code, message } }, headers: {} };
  }

  private handleConfirm(body: unknown): PlaneResponse {
    const parsed = parseBody(BudgetConfirmRequestSchema, body);
    if (!parsed.success) return parsed.response;
    const request = parsed.data;
    if (this.confirmedCallIds.has(request.call_id)) {
      return { status: 204, body: null, headers: {} };
    }

    if (request.lease_id !== null && request.lease_id !== undefined) {
      this.confirmedCallIds.add(request.call_id);
      this.confirms.push(request);
      return { status: 204, body: null, headers: {} };
    }

    const reservationId = request.reservation_id as string;
    if (this.settledReservations.has(reservationId)) {
      this.confirmedCallIds.add(request.call_id);
      return { status: 204, body: null, headers: {} };
    }
    if (!this.activeReservations.has(reservationId)) {
      return errorResponse(404, "Reservation not found or expired");
    }

    this.activeReservations.delete(reservationId);
    this.settledReservations.add(reservationId);
    this.confirmedCallIds.add(request.call_id);
    this.confirms.push(request);
    return { status: 204, body: null, headers: {} };
  }

  private handleIngest(body: unknown, rejection?: RejectIngestEffect): PlaneResponse {
    const parsed = parseBodyList(MetadataEventSchema, body);
    if (!parsed.success) return parsed.response;

    let ingested = 0;
    for (const event of parsed.data) {
      const callIdentity = `${event.call_id}\u0000${event.attempt_index}`;
      const legacyIdentity = `${normalizedTimestamp(event.timestamp)}\u0000${event.sdk_instance_id}`;
      if (this.ingestCallIds.has(callIdentity) || this.ingestLegacyIds.has(legacyIdentity)) {
        continue;
      }
      this.ingestCallIds.add(callIdentity);
      this.ingestLegacyIds.add(legacyIdentity);
      this.ingested.push(event);
      ingested++;
    }

    if (rejection === undefined) {
      return validatedResponse(202, IngestResponseSchema, { ingested, rejected: [] });
    }
    if (rejection.malformed === true) {
      return { status: 202, body: { rejected: "corrupt" }, headers: {} };
    }
    if (rejection.count !== undefined) {
      if (rejection.count > parsed.data.length) {
        throw testingError("rejectIngest count exceeds the batch length");
      }
      const rejected = Array.from({ length: rejection.count }, (_, index) => ({
        code: rejection.code,
        model: (parsed.data[index]?.model ?? "").slice(0, 50),
        message: `scripted ${rejection.code} rejection`,
      }));
      return {
        status: 202,
        body: { ingested: Math.max(parsed.data.length - rejected.length, 0), rejected },
        headers: {},
      };
    }

    const indices = rejection.indices ?? [];
    if (indices.some((index) => index >= parsed.data.length)) {
      throw testingError("rejectIngest index exceeds the batch length");
    }
    const rejected = indices.map((index) => ({
      index,
      code: rejection.code,
      model: (parsed.data[index]?.model ?? "").slice(0, 50),
      message: `scripted ${rejection.code} rejection`,
    }));
    return validatedResponse(202, IngestResponseSchema, {
      ingested: Math.max(parsed.data.length - rejected.length, 0),
      rejected,
    });
  }

  private handleUntracked(body: unknown): PlaneResponse {
    if (Array.isArray(body) && body.length > 100) {
      return errorResponse(400, "untracked surface batches may contain at most 100 reports");
    }
    const parsed = parseBodyList(UntrackedSurfaceReportSchema, body);
    if (!parsed.success) return parsed.response;

    for (const report of parsed.data) {
      const key = [report.provider, report.client_shape, report.mode, report.surface].join(
        "\u0000",
      );
      if (this.lastUntrackedReportIds.get(key) === report.report_id) {
        continue;
      }
      this.lastUntrackedReportIds.set(key, report.report_id);
      this.untrackedReports.push(report);
    }
    return validatedResponse(202, UntrackedSurfaceAcceptedSchema, {
      accepted: parsed.data.length,
    });
  }

  private handleBreaker(body: unknown): PlaneResponse {
    const parsed = parseBody(BreakerStateReportSchema, body);
    if (!parsed.success) return parsed.response;
    this.breakerReports.push(parsed.data);
    return validatedResponse(202, BreakerReportAcceptedSchema, { accepted: true });
  }
}
