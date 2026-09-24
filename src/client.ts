/**
 * `SolwynCore` — the Solwyn client pipeline (M4 scope).
 *
 * Wraps a caller-supplied provider SDK client and runs every intercepted call
 * through a fixed pipeline:
 *
 *   pre-flight token estimate (length-based, via `privacy.ts`)
 *     -> budget check (deny -> typed budget/stop error, never dispatched)
 *     -> health-ordered candidate walk across the `[primary, ...fallbacks]` chain:
 *          per-call `Deadline` -> `SelectionPolicy.order` over breaker snapshots ->
 *          per-candidate breaker admission -> same-dialect native passthrough or
 *          cross-dialect translation (fails LOUD on untranslatable) -> dispatch ->
 *          disposition-driven failover (`classifyException`: FAIL_FAST propagates
 *          without a breaker signal; FAILOVER/POST_SEND_AMBIGUOUS walk on and count
 *          the breaker once per provider per walk; same-provider 429 retries honor
 *          `Retry-After`)
 *     -> usage extraction (served adapter) + cross-dialect response reshape
 *     -> settlement: confirm reservation + metadata event build (one `call_id`)
 *     -> reporter enqueue
 *
 * Streaming calls return the provider stream wrapped by `stream.ts`; usage, breaker
 * credit, and confirm all settle once, at stream end (never at hop return). A
 * pre-first-chunk (establishment) failure walks to the next candidate; a mid-stream
 * error (wrapper already returned) never fails over (first-byte rule).
 *
 * Ported from `solwyn/_base.py` + `solwyn/client.py`. Python's sync/async split
 * collapses to one async class (CLAUDE.md). Metadata attribution is by provider NAME
 * (invariant 5): a served fallback stamps its own `name` on the budget confirm and the
 * metadata event, sets `is_provider_fallback`/`is_model_fallback`, and records the
 * `failover_reason`.
 *
 * PRIVACY: this module NEVER inspects a content-bearing field. The only content seams
 * are the opaque `kwargs`/`response`/`chunk` bags it forwards straight to the provider,
 * to `privacy.ts` (which returns an integer), and — for a cross-dialect hop — to the
 * content-privileged `providers/translation/` package (which returns a translated bag
 * or a value-free structural error). `client.ts` only ever receives an integer
 * char/token count and opaque payloads back — it never reads `messages`/`system`/
 * `contents`/response text. It performs no logging of any caught value.
 */

import {
  type BudgetCheckResult,
  BudgetEnforcer,
  type BuildConfirmRequestOptions,
  budgetCheckResult,
} from "./budget";
import {
  CircuitBreaker,
  type CircuitBreakerAdmission,
  CircuitBreakerManager,
} from "./circuit-breaker";
import {
  FAILOVER_TUNING_DEFAULTS,
  type FailoverIdempotency,
  type FailoverTuningConfig,
  pickFailoverTuning,
  pickVelocityConfig,
  resolveConfig,
  type SolwynConfig,
  type SolwynConfigOptions,
} from "./config";
import type { CoverageRuntime, CoverageSource } from "./coverage";
import { safeErrorClassName } from "./error-class";
import {
  ConfigurationError,
  ProviderUnavailableError,
  RunStoppedError,
  SolwynError,
  UnsupportedSurfaceError,
  UntranslatableModelError,
} from "./errors";
import {
  extractMediaUsageFailSoft,
  extractUsageFailSoft,
  hasSettlementFunding,
  safeExtractRegion,
  safeExtractServiceTier,
} from "./fail-soft";
import { consoleLogger, type Logger } from "./logging";
import { normalizeOpenaiOutputCap, resolveEffectiveOutputBound } from "./output-bound";
import {
  estimateContentLength,
  estimateResponsesContentLength,
  estimateTokensFromLength,
} from "./privacy";
import { validatePinnedClientFamily } from "./providers/detection";
import { resolveProviderIdentity } from "./providers/index";
import type { Dialect, DispatchSurface, MediaSurfaceSpec } from "./providers/protocol";
// Namespace import (NOT destructured) so the native-happy-path zero-translation guarantee stays
// spy-able: `translation.md` pins `TestZeroTranslationOnNativePath` (a `vi.spyOn` on the module's
// named exports asserting the native path never calls `toCanonical`/`normalizeResponse`), and the
// dispatch loop must call THROUGH the namespace object for that spy to be observed.
import * as translation from "./providers/translation/index";
import { ORDINARY_TOKEN_COUNT_MAX } from "./receipt-fold";
import {
  assertRawProviderClient,
  buildRuntimes,
  type FallbackSpec,
  type ProviderRuntime,
  parseFallbackSpec,
} from "./registry";
import { MetadataReporter } from "./reporter";
import {
  callerAbortSignal,
  captureMeteredRequestOptions,
  crossProviderRequestOptions,
  snapshotRequestOptions,
  snapshotRequestStructure,
  validateMeteredGoogleOptions,
  withoutGoogleRequestTransport,
} from "./request-options";
import {
  ambiguousFailoverAllowed,
  budgetCheckTimeout,
  buildCandidate,
  CostPolicy,
  classifyException,
  Deadline,
  Disposition,
  dropForeignCandidates,
  HealthBasedPolicy,
  type IdempotencyMode,
  LatencyTracker,
  type ProviderCandidate,
  providerNameOf,
  type RoutingRequest,
  resolveIdempotencyMode,
  retryAfterSeconds,
  retryFitsWithinDeadline,
  type SelectionPolicy,
  sameProviderCandidates,
} from "./routing";
import { getCurrentRun } from "./run-context";
import {
  acquireTerminationHandle,
  markTerminated,
  postcheckTermination,
  type RunTermination,
  runTermination,
  type TerminationHandle,
} from "./run-control";
import {
  abortStream,
  createDeferredResponseStream,
  type DeferredResponseStream,
  observeResponseStream,
  type ResponseStreamLike,
  type StreamWrapperOptions,
  wrapStream,
} from "./stream";
import {
  observeEvaluatedProperty,
  observePublicProperty,
  type SurfaceObservation,
} from "./surface-graph";
import {
  applySurfacePosture,
  type EffectiveSurfaceDecision,
  effectiveSurfaceDecision,
  SurfaceNamespaceGuardCache,
  SurfaceObservationRegistry,
  SurfaceWarnOnceLatch,
} from "./surface-guard";
import {
  contextIsDeclared,
  deriveSurfaceClientShape,
  type ObservedSurfaceSource,
  resolveSurfaceRule,
  type SurfaceCondition,
  type SurfaceContext,
  type SurfaceRule,
  validateSurfacePath,
} from "./surfaces";
import { captureTags } from "./tags";
import type { TokenDetails } from "./token-details";
import { buildTokenDetails, zeroTokenDetails } from "./token-details";
import { type FetchLike, requireFetchLike } from "./transport";
import type {
  BudgetMode,
  DenySource,
  FailoverReason,
  MediaUsage,
  MetadataEvent,
  Modality,
  ProviderName,
  VelocityFlag,
} from "./types";
import { UntrackedSurfaceReporter } from "./untracked-reporter";
import { DENY_ELIGIBLE_RULE_ORDER, VelocityMonitor } from "./velocity";

const CUSTOM_INSPECT = Symbol.for("nodejs.util.inspect.custom");
const EMPTY_VELOCITY_FLAGS: readonly VelocityFlag[] = Object.freeze([]);

/** Restore only target-owned Google transport fields, preserving canonical generation settings. */
function restoreGoogleTargetTransport(
  params: Record<string, unknown>,
  targetDefaults: Record<string, unknown>,
): Record<string, unknown> {
  const endpointSafe = withoutGoogleRequestTransport(params);
  const targetConfig = targetDefaults["config"];
  if (targetConfig !== null && typeof targetConfig === "object") {
    const config = endpointSafe["config"];
    const restored = { ...(config !== null && typeof config === "object" ? config : {}) };
    for (const key of ["httpOptions", "abortSignal"]) {
      if (Object.hasOwn(targetConfig, key)) {
        Reflect.set(restored, key, Reflect.get(targetConfig, key));
      }
    }
    endpointSafe["config"] = restored;
  }
  return endpointSafe;
}

interface RunSnapshot {
  readonly lifetime?: object;
  readonly agentRunId: string;
  readonly agentRunName: string;
  readonly tags: Readonly<Record<string, string>> | null;
  readonly parentAgentRunId: string | null;
}

/** Immutable intercepted-call attribution. Unlike a run snapshot, tags may be present unscoped. */
interface CallAttribution {
  readonly lifetime?: object;
  readonly agentRunId: string | undefined;
  readonly agentRunName: string | undefined;
  readonly tags: Readonly<Record<string, string>> | undefined;
  readonly parentAgentRunId: string | undefined;
}

type AttributionSnapshot = RunSnapshot | CallAttribution;

/** Freeze a defensive run-attribution snapshot at the public call boundary. */
function snapshotCurrentRun(budget?: BudgetEnforcer): RunSnapshot | undefined {
  const current = getCurrentRun();
  budget?.observeRun(current);
  if (current === undefined) return undefined;
  const tags = current.tags == null ? null : Object.freeze({ ...current.tags });
  return Object.freeze({
    lifetime: current.lifetime,
    agentRunId: current.agentRunId,
    agentRunName: current.agentRunName,
    tags,
    parentAgentRunId: current.parentAgentRunId ?? null,
  });
}

/**
 * The logger handed to tag capture: one warn-once latch per client. `captureTags` warns on
 * every clamped capture; through this latch the first clamp on a client reaches `warn` and
 * every later one is logged at debug level with its running count, so a hot path with an
 * oversized tag layer does not emit one warning per call. Other levels pass through.
 */
function tagCaptureLogger(logger: Logger): Logger {
  let clampWarnings = 0;
  return {
    debug: (message, ...args) => logger.debug(message, ...args),
    info: (message, ...args) => logger.info(message, ...args),
    error: (message, ...args) => logger.error(message, ...args),
    warn(message, ...args): void {
      clampWarnings += 1;
      if (clampWarnings === 1) {
        logger.warn(
          `${message} (further occurrences on this client are logged at debug level)`,
          ...args,
        );
        return;
      }
      logger.debug(`${message} (occurrence ${clampWarnings} on this client)`, ...args);
    },
  };
}

/** Capture complete intercepted-call attribution once, before asynchronous admission work. */
function captureCallAttribution(
  perCallTags: unknown,
  defaultTags: unknown,
  logger: Logger,
  budget: BudgetEnforcer,
): CallAttribution {
  const run = snapshotCurrentRun(budget);
  const tags = captureTags({
    perCallTags,
    runTags: run?.tags,
    defaultTags,
    logger,
  });
  return Object.freeze({
    lifetime: run?.lifetime,
    agentRunId: run?.agentRunId,
    agentRunName: run?.agentRunName,
    tags: tags === undefined ? undefined : Object.freeze({ ...tags }),
    parentAgentRunId: run?.parentAgentRunId ?? undefined,
  });
}

/** Copy caller-owned kwargs while reserving Solwyn's own tag statement for attribution. */
function copyKwargsAndExtractTags(kwargs: Record<string, unknown>): {
  readonly callerKwargs: Record<string, unknown>;
  readonly perCallTags: unknown;
} {
  const tagDescriptor = Object.getOwnPropertyDescriptor(kwargs, "solwyn_tags");
  const perCallTags = tagDescriptor === undefined ? undefined : kwargs["solwyn_tags"];
  const callerKwargs: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(kwargs)) {
    if (key === "solwyn_tags" || !Object.prototype.propertyIsEnumerable.call(kwargs, key)) {
      continue;
    }
    Object.defineProperty(callerKwargs, key, {
      value: kwargs[key as keyof typeof kwargs],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return { callerKwargs: snapshotRequestStructure(callerKwargs), perCallTags };
}

function hasRunIdentity(
  attribution: AttributionSnapshot | undefined,
): attribution is AttributionSnapshot & {
  readonly agentRunId: string;
  readonly agentRunName: string;
} {
  return attribution?.agentRunId !== undefined && attribution.agentRunName !== undefined;
}

/** Copy one provider/default layer while reserving Solwyn-owned attribution for the pipeline. */
function withoutSolwynTags(layer: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = { ...layer };
  delete filtered["solwyn_tags"];
  return filtered;
}

/** Clamp a reported token quantity without changing enforcement or settlement math. */
function wireTokenQuantity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), ORDINARY_TOKEN_COUNT_MAX);
}

/** Materialize the optional event flag list without retaining caller-owned mutable state. */
export function materializeVelocityFlags(
  flags: readonly VelocityFlag[] | null | undefined,
): VelocityFlag[] | undefined {
  return flags !== null && flags !== undefined && flags.length > 0 ? [...flags] : undefined;
}

interface EventReceiptFields {
  denySource?: DenySource | null;
  denyReason?: string | null;
  deniedByPeriod?: string | null;
  estimatedOutputBound?: number | null;
  velocityFlags?: readonly VelocityFlag[] | null;
}

/** Attach only populated receipt fields so legacy wire objects remain unchanged. */
function applyEventReceiptFields(event: MetadataEvent, fields: EventReceiptFields): void {
  if (fields.denySource !== null && fields.denySource !== undefined) {
    event.deny_source = fields.denySource;
  }
  if (fields.denyReason !== null && fields.denyReason !== undefined) {
    event.deny_reason = fields.denyReason;
  }
  if (fields.deniedByPeriod !== null && fields.deniedByPeriod !== undefined) {
    event.denied_by_period = fields.deniedByPeriod;
  }
  if (fields.estimatedOutputBound !== null && fields.estimatedOutputBound !== undefined) {
    event.estimated_output_bound = wireTokenQuantity(fields.estimatedOutputBound);
  }
  const velocityFlags = materializeVelocityFlags(fields.velocityFlags);
  if (velocityFlags !== undefined) {
    event.velocity_flags = velocityFlags;
  }
}

type InspectValue = (value: unknown, options?: unknown) => string;

// The two callbacks a core hands out are built here, outside the constructor. V8 gives
// every closure created in one function a shared context, so a constructor-created
// closure that used `this` would keep the core, its provider and its lease holder
// reachable from any other callback created there (such as one the reporter's timer
// can reach). Each factory closes over exactly the one value it needs.

/** Node `util.inspect` hook that renders only the wrapped client. */
function inspectHook(
  client: unknown,
): (depth: number, inspectOptions: unknown, inspectValue: InspectValue) => string {
  return (_depth, inspectOptions, inspectValue) =>
    `Solwyn(${inspectValue(client, inspectOptions)})`;
}

/** Breaker-snapshot supplier for the reporter; references the breaker registry only. */
function breakerSnapshotSupplier(
  breakers: CircuitBreakerManager,
): () => ReturnType<CircuitBreakerManager["snapshots"]> {
  return () => breakers.snapshots();
}

/**
 * A single fallback chain entry: `[client, model]`, `[client, model, defaultParams]`,
 * or `[client, model, defaultParams, providerOverride]`. Positional/arity-driven,
 * matching {@link FallbackSpec}.
 */
export type FallbackEntry = FallbackSpec;

/**
 * Public constructor options for {@link SolwynCore} / `Solwyn`. camelCase (the TS
 * public surface); mapped internally to the snake_case `SolwynConfig`. Every field is
 * optional except that a valid `apiKey` must resolve (from here or `SOLWYN_API_KEY`
 * on Node) or construction throws `ConfigurationError`.
 */
export interface SolwynOptions {
  /** Solwyn project API key (`sk_proj_` + 64 hex). Falls back to `SOLWYN_API_KEY` on Node. */
  apiKey?: string;
  /** Solwyn Cloud API base URL. Defaults to `https://api.solwyn.ai`. */
  apiUrl?: string;
  /** Model for the primary provider link (per-call `model` overrides this). */
  model?: string;
  /** Explicit provider identity pin for the primary client (bypasses structural detection). */
  provider?: string;
  /** Ordered fallback chain (built up front; walked on failover from M4 onward). */
  fallback?: FallbackEntry[];
  /** Global fill-absent request defaults (per-call kwargs win). */
  defaultParams?: Record<string, unknown>;
  /** Default spend-attribution tags. Validated and stored; call integration lands in D1b. */
  tags?: Record<string, string> | null;
  /** Budget fail-open policy (M2). Accepted and validated now. */
  failOpen?: boolean;
  /** Budget mode (M2). Accepted and validated now. */
  budgetMode?: BudgetMode;
  /** Posture for public provider surfaces that Solwyn cannot budget-track (default `"warn"`). */
  onUnmetered?: "warn" | "raise" | "allow";
  /** Exact reviewed terminal surface tokens allowed to bypass the unmetered posture. */
  acknowledgeUntracked?: string[];
  /** Send content-free untracked-surface advisories to Solwyn Cloud (default true). */
  reportUntrackedSurfaces?: boolean;
  /** Enable run-scoped local token leases (default true). */
  leaseEnabled?: boolean;
  /** Output-token reservation when a request has no usable structural cap (default 4096). */
  leaseOutputBoundDefault?: number;
  /**
   * Injectable candidate-ordering policy (routing subsystem). Defaults to
   * {@link HealthBasedPolicy} (health-tier ordering only). Swapping it changes attempt
   * order with ZERO changes to dispatch/translation/budget — the drop-in guarantee.
   */
  selectionPolicy?: SelectionPolicy;
  /** Cross-provider failover idempotency policy. `"safe"` (default) / `"never"` / `"always"`. */
  failoverIdempotency?: FailoverIdempotency;
  /** Same-provider retries on a 429/529 carrying a usable `Retry-After` (default 0). */
  sameProviderRetries?: number;
  /** Window in SECONDS for preflight, Retry-After sleeps, and between-hop gates (default 30). */
  failoverTotalTimeout?: number;
  /** Immutable per-call provider read bound in SECONDS (default 600). */
  failoverHopReadTimeout?: number;
  /** Circuit-breaker recovery-window jitter fraction (default 0.2). */
  circuitBreakerRecoveryTimeoutJitter?: number;
  /** Consecutive failures before a provider breaker opens (default 3). */
  circuitBreakerFailureThreshold?: number;
  /** Base recovery timeout in seconds (default 60). */
  circuitBreakerRecoveryTimeout?: number;
  /** HALF_OPEN successes required to close (default 2). */
  circuitBreakerSuccessThreshold?: number;
  /** Injectable logger (D6). Defaults to a console-backed logger (warn+error visible). */
  logger?: Logger;
  /** Injectable `fetch` for the reporter transport (tests). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Budget-check cache TTL in seconds (default 5). Set to 0 to disable caching. */
  budgetCheckCacheTtl?: number;
  /** Budget-check timeout in seconds, capped by the whole-chain deadline (default 1). */
  budgetCheckTimeout?: number;
  /** Consecutive check/confirm outages before the shared control-plane breaker opens. */
  controlPlaneFailureThreshold?: number;
  /** Control-plane breaker recovery timeout in seconds (default 30). */
  controlPlaneRecoveryTimeout?: number;
  /** Publish provider breaker snapshots from reporter cycles (default true). */
  breakerReportingEnabled?: boolean;
  /** Reporter batch size (events per ingest POST). */
  reporterBatchSize?: number;
  /** Reporter background flush interval in SECONDS (default 5). */
  reporterFlushInterval?: number;
  /** Reporter queue cap (drop-oldest on overflow). */
  reporterMaxQueueSize?: number;
  /**
   * Accepted for compatibility but currently has no effect: reporter sends are serial,
   * one request at a time.
   */
  reporterMaxInFlight?: number;
  /** Reporter attempts before disposing retryable telemetry (default 5). */
  reporterMaxSendAttempts?: number;
  /** Reporter retry backoff base in seconds (default 1). */
  reporterRetryBackoffBase?: number;
  /** Reporter retry backoff cap in seconds (default 60). */
  reporterRetryBackoffCap?: number;
  /** Reporter shutdown deadline in seconds (default 5; zero is legal). */
  reporterShutdownDeadline?: number;
  /** Breaker report full-refresh heartbeat in seconds (default 60). */
  breakerReportHeartbeat?: number;
  /** Local structural velocity posture (default "warn"). */
  velocityMode?: "off" | "warn" | "deny";
  /** Near-identical calls needed inside the repeat window (default 5). */
  velocityRepeatCount?: number;
  /** Repeat detection window in seconds (default 60). */
  velocityRepeatWindowS?: number;
  /** Strictly growing call count needed for growth detection (default 8). */
  velocityGrowthStreak?: number;
  /** Latest/first token-size factor needed for growth detection (default 3). */
  velocityGrowthFactor?: number;
  /** Minimum current-minute call count for rate acceleration (default 30). */
  velocityAccelFloorPerMin?: number;
  /** Current/prior-minute call-count factor for rate acceleration (default 3). */
  velocityAccelFactor?: number;
}

/** The set of public option keys — anything else (e.g. `projectId`) is rejected. */
const KNOWN_OPTION_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "apiUrl",
  "model",
  "provider",
  "fallback",
  "defaultParams",
  "tags",
  "failOpen",
  "budgetMode",
  "onUnmetered",
  "acknowledgeUntracked",
  "reportUntrackedSurfaces",
  "leaseEnabled",
  "leaseOutputBoundDefault",
  "selectionPolicy",
  "failoverIdempotency",
  "sameProviderRetries",
  "failoverTotalTimeout",
  "failoverHopReadTimeout",
  "circuitBreakerRecoveryTimeoutJitter",
  "circuitBreakerFailureThreshold",
  "circuitBreakerRecoveryTimeout",
  "circuitBreakerSuccessThreshold",
  "logger",
  "fetch",
  "budgetCheckCacheTtl",
  "budgetCheckTimeout",
  "controlPlaneFailureThreshold",
  "controlPlaneRecoveryTimeout",
  "breakerReportingEnabled",
  "reporterBatchSize",
  "reporterFlushInterval",
  "reporterMaxQueueSize",
  "reporterMaxInFlight",
  "reporterMaxSendAttempts",
  "reporterRetryBackoffBase",
  "reporterRetryBackoffCap",
  "reporterShutdownDeadline",
  "breakerReportHeartbeat",
  "velocityMode",
  "velocityRepeatCount",
  "velocityRepeatWindowS",
  "velocityGrowthStreak",
  "velocityGrowthFactor",
  "velocityAccelFloorPerMin",
  "velocityAccelFactor",
]);

/**
 * Which intercepted surface a call arrived on. Aliases the provider-protocol
 * {@link DispatchSurface} so the dispatcher and adapters name the same concept; it is
 * threaded to the adapter's `prepareCall`/`createStreamAccumulator` seams verbatim.
 */
export type InterceptSurface = DispatchSurface;

/** Per-call dispatch options threaded from the proxies. */
export interface InterceptOptions {
  /** Force the dedicated streaming method regardless of a `stream` kwarg (Google-shaped SDKs). */
  forceStream?: boolean;
  /** Concrete metered Responses resource leaf. */
  responsesLeaf?: "create" | "parse" | "stream";
}

/** Resolved primary runtime plus the built (but not-yet-served) fallback chain. */
interface InitState {
  runtimes: ProviderRuntime[];
  primary: ProviderRuntime;
  /** Every non-primary runtime's provider name, in configured-chain order (budget check). */
  fallbackProviders: ProviderName[];
  /** Every non-primary runtime's model, element-aligned with {@link fallbackProviders}. */
  fallbackModels: string[];
}

interface SurfaceRuntimeDescriptor extends CoverageRuntime {
  readonly sdkClient: unknown;
  readonly context: SurfaceContext;
}

function validateSurfaceRuntimeContext(context: SurfaceContext): void {
  if (context.clientShape === "undeclared_sdk" || !contextIsDeclared(context)) {
    throw new ConfigurationError(
      `unsupported provider client pairing: ${context.provider ?? "unknown"}/${context.clientShape}/${context.dialect}`,
      { field: "client" },
    );
  }
}

function buildSurfaceRuntimeDescriptor(
  sdkClient: unknown,
  model: string,
  providerOverride?: string,
): SurfaceRuntimeDescriptor {
  const identity = resolveProviderIdentity(sdkClient, providerOverride);
  if (providerOverride !== undefined) {
    validatePinnedClientFamily(sdkClient, identity.provider, identity.dialect);
  }
  const context = Object.freeze({
    provider: identity.provider,
    dialect: identity.dialect,
    clientShape: deriveSurfaceClientShape(sdkClient),
  });
  validateSurfaceRuntimeContext(context);
  return Object.freeze({
    sdkClient,
    provider: identity.provider,
    dialect: identity.dialect,
    clientShape: context.clientShape,
    model,
    context,
  });
}

/** Synchronous surface-only view of the provider chain used by guards and coverage. */
function buildSurfaceRuntimeDescriptors(
  primaryClient: unknown,
  primaryModel: string | null,
  providerOverride: string | undefined,
  fallbackSpecs: readonly FallbackSpec[],
): readonly SurfaceRuntimeDescriptor[] {
  const descriptors = [
    buildSurfaceRuntimeDescriptor(primaryClient, primaryModel ?? "", providerOverride),
  ];
  for (const spec of fallbackSpecs) {
    const parsed = parseFallbackSpec(spec);
    descriptors.push(
      buildSurfaceRuntimeDescriptor(parsed.client, parsed.model, parsed.providerOverride),
    );
  }
  return Object.freeze(descriptors);
}

/** Internal immutable-per-call resolution shared by media lifecycle and proxy bypasses. */
interface ResolvedMediaRequest {
  readonly kwargs: Record<string, unknown>;
  readonly model: string;
  readonly attribution: CallAttribution;
}

/** Private proxy markers layered after caller capture; never caller-facing attribution. */
interface MediaInternalMarkers {
  readonly _solwyn_image_op?: "generate" | "edit";
  readonly _solwyn_audio_op?: "speech" | "transcriptions";
}

/** Immutable server-governed values consumed after one budget preflight. */
interface FailoverTuning {
  readonly totalTimeout: number;
  readonly idempotency: "safe" | "never" | "always";
  readonly sameProviderRetries: number;
  readonly hopReadTimeout: number;
}

/** Wall-clock timer (web-standard; monotonic). */
function nowMs(): number {
  return performance.now();
}

/** The rejection for a caller abort: its reason when that is an Error, else an `AbortError`. */
function callerAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Resolve after `ms` (web-standard `setTimeout`; used only for same-provider 429 retries), or
 * reject with {@link callerAbortError} as soon as the caller's signal aborts. The timer and
 * the abort listener are both released on whichever outcome comes first.
 */
function abortableDelayMs(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(callerAbortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(callerAbortError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Per-call transport keys forwarded verbatim onto the HTTP request (gateway/observability
 * credentials). NEVER carried across a same-dialect cross-provider hop to a DIFFERENT
 * vendor's endpoint — stripped and re-authored from the target entry (client-base.md #15).
 */
const ENDPOINT_SCOPED_KEYS = ["extra_headers", "extra_query", "extra_body"] as const;

const RESPONSES_DEFAULT_KEYS_TO_DROP = new Set([
  "max_tokens",
  "max_completion_tokens",
  "stream_options",
  "solwyn_tags",
]);

const BACKGROUND_RESPONSES_MESSAGE =
  "Queued background responses expose no create-time usage and cannot be budget-metered by Solwyn. Use the raw OpenAI client for background responses.";

const STREAMING_PARSE_MESSAGE =
  "Solwyn does not meter streaming responses.parse. Use responses.create(stream=True) for metered streaming calls, or the raw provider client for streaming parse.";

/** Versioned shared slot keeps separately loaded ESM/CJS copies on one bounded ledger. */
const SURFACE_POSTURE_KEY = Symbol.for("@solwyn/sdk.surfacePosture.v1");

interface SurfacePostureState {
  readonly observations: SurfaceObservationRegistry;
  readonly warnings: SurfaceWarnOnceLatch;
}

interface GlobalWithSurfacePosture {
  [SURFACE_POSTURE_KEY]?: SurfacePostureState;
}

function createSurfacePostureState(): SurfacePostureState {
  return {
    observations: new SurfaceObservationRegistry(),
    warnings: new SurfaceWarnOnceLatch(),
  };
}

function surfacePostureState(): SurfacePostureState {
  const shared = globalThis as GlobalWithSurfacePosture;
  shared[SURFACE_POSTURE_KEY] ??= createSurfacePostureState();
  return shared[SURFACE_POSTURE_KEY];
}

/** Test-only deterministic reset for the process-wide untracked-surface state. */
export function __resetUnmeteredSurfaceWarnings(): void {
  (globalThis as GlobalWithSurfacePosture)[SURFACE_POSTURE_KEY] = createSurfacePostureState();
}

function isSurfaceObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function provisionalSurfaceDecision(
  path: string,
  rule: SurfaceRule | undefined,
): EffectiveSurfaceDecision {
  const expected = rule?.expectedShapes[0];
  if (rule === undefined || expected === undefined) {
    return effectiveSurfaceDecision({
      path,
      descriptorCategory: "field",
      returnShape: "opaque",
    });
  }
  return Object.freeze({
    surface: path,
    kind: rule.kind,
    acknowledgmentToken: rule.acknowledgmentToken ?? path,
    capabilityScope: rule.capabilityScope,
    observedReturnShape: expected.returnShape,
    driftedFromRuleId: null,
    rule,
  });
}

function staticSurfaceDecision(
  path: string,
  rule: SurfaceRule | undefined,
  observation: SurfaceObservation,
): EffectiveSurfaceDecision {
  if (
    rule !== undefined &&
    observation.returnShape === "unevaluated_accessor" &&
    rule.expectedShapes.some(
      (expected) => expected.descriptorCategory === observation.descriptorCategory,
    )
  ) {
    return Object.freeze({
      surface: path,
      kind: rule.kind,
      acknowledgmentToken: rule.acknowledgmentToken ?? path,
      capabilityScope: rule.capabilityScope,
      observedReturnShape: observation.returnShape,
      driftedFromRuleId: null,
      rule,
    });
  }
  return effectiveSurfaceDecision(observation, rule);
}

const BEDROCK_UNBOUNDED_READ_WARNING =
  "Bedrock client (model %s) has no readable finite socket timeout: Solwyn passes requestTimeout per call, but cannot guarantee a hard end-to-end Converse stream deadline and only checks the failover deadline BETWEEN hops, so one stuck read can hang the call indefinitely. Configure a finite socket timeout on the client's requestHandler.";

type BedrockSocketTimeoutState = "bounded" | "unbounded" | "unknown";

/** Defensive structural inspection only; unreadable state is unknown and never warns. */
function bedrockSocketTimeoutState(client: unknown): BedrockSocketTimeoutState {
  try {
    if ((typeof client !== "object" || client === null) && typeof client !== "function") {
      return "unknown";
    }
    const configured = Reflect.get(client, "config", client);
    let requestHandler: unknown;
    if (configured === undefined || configured === null) {
      requestHandler = Reflect.get(client, "requestHandler", client);
    } else {
      if (
        (typeof configured !== "object" || configured === null) &&
        typeof configured !== "function"
      ) {
        return "unbounded";
      }
      requestHandler = Reflect.get(configured, "requestHandler", configured);
    }
    if (requestHandler === undefined || requestHandler === null) {
      return "unbounded";
    }
    if (
      (typeof requestHandler !== "object" || requestHandler === null) &&
      typeof requestHandler !== "function"
    ) {
      return "unbounded";
    }

    const direct = Reflect.get(requestHandler, "socketTimeout", requestHandler);
    if (direct !== undefined) {
      return typeof direct === "number" && Number.isFinite(direct) && direct > 0
        ? "bounded"
        : "unbounded";
    }

    const handlerConfig = Reflect.get(requestHandler, "config", requestHandler);
    if (handlerConfig !== undefined) {
      if (
        (typeof handlerConfig !== "object" || handlerConfig === null) &&
        typeof handlerConfig !== "function"
      ) {
        return "unbounded";
      }
      const nested = Reflect.get(handlerConfig, "socketTimeout", handlerConfig);
      return typeof nested === "number" && Number.isFinite(nested) && nested > 0
        ? "bounded"
        : "unbounded";
    }

    // A lazily-resolved handler config cannot be inspected structurally without invoking it.
    if (Reflect.get(requestHandler, "configProvider", requestHandler) !== undefined) {
      return "unknown";
    }
    return "unbounded";
  } catch {
    return "unknown";
  }
}

let costPolicyNoHintsWarningEmitted = false;

/** Reset the process-wide CostPolicy warning latch between unit tests. */
export function __resetCostPolicyWarningForTesting(): void {
  costPolicyNoHintsWarningEmitted = false;
}
/**
 * Per-SOURCE-DIALECT allow-lists for an entry's `default_params` when building a
 * cross-dialect translation input (client-base.md `_SOURCE_COMPATIBLE_DEFAULT_KEYS`).
 * Keyed by DIALECT, not provider name — every OpenAI-compatible provider shares the
 * `openai` key set. A target entry's default_params may hold target-native keys (e.g.
 * Anthropic `top_k`) that are NOT legal on the source dialect; only the source-legal
 * subset seeds `toCanonical`. Ports `client.py::_SOURCE_COMPATIBLE_DEFAULT_KEYS`.
 */
const SOURCE_COMPATIBLE_DEFAULT_KEYS: Record<Dialect, ReadonlySet<string>> = {
  openai: new Set([
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "stop",
    "stream",
    "stream_options",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
  ]),
  anthropic: new Set([
    "system",
    "max_tokens",
    "temperature",
    "top_p",
    "stop",
    "stop_sequences",
    "stream",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
  ]),
  google: new Set(["config", "max_output_tokens", "stream"]),
  bedrock: new Set(["system", "inferenceConfig", "toolConfig", "stream"]),
};

/**
 * Return the subset of a target entry's `default_params` that is also legal on the
 * SOURCE dialect (keyed by dialect — every OpenAI-compatible provider shares the
 * `openai` set). Ports `client.py::_source_compatible_defaults`.
 */
function sourceCompatibleDefaults(
  dialect: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = SOURCE_COMPATIBLE_DEFAULT_KEYS[dialect as Dialect];
  if (allowed === undefined) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (allowed.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/** Whether a record has an own enumerable key, including spreadable symbol keys. */
function hasOwnEnumerableKey(record: object): boolean {
  for (const key of Reflect.ownKeys(record)) {
    if (Object.prototype.propertyIsEnumerable.call(record, key)) return true;
  }
  return false;
}

/**
 * The per-call idempotency override kwarg. Resolved to an effective idempotency mode
 * (`true` → `"always"`, `false` → `"safe"`) then STRIPPED before dispatch on every hop —
 * it must never reach the underlying provider SDK call (routing-failover.md #24).
 */
const PER_CALL_IDEMPOTENT_KEY = "solwynIdempotent";

/** Translate the camelCase public options to the snake_case `SolwynConfig` input. */
function toConfigOptions(options: SolwynOptions): SolwynConfigOptions {
  const configOptions: SolwynConfigOptions = {};
  if (options.apiKey !== undefined) configOptions.api_key = options.apiKey;
  if (options.apiUrl !== undefined) configOptions.api_url = options.apiUrl;
  if (options.failOpen !== undefined) configOptions.fail_open = options.failOpen;
  if (options.budgetMode !== undefined) configOptions.budget_mode = options.budgetMode;
  if (options.onUnmetered !== undefined) configOptions.on_unmetered = options.onUnmetered;
  if (options.acknowledgeUntracked !== undefined) {
    configOptions.acknowledge_untracked = options.acknowledgeUntracked;
  }
  if (options.reportUntrackedSurfaces !== undefined) {
    configOptions.report_untracked_surfaces = options.reportUntrackedSurfaces;
  }
  if (options.leaseEnabled !== undefined) configOptions.lease_enabled = options.leaseEnabled;
  if (options.leaseOutputBoundDefault !== undefined) {
    configOptions.lease_output_bound_default = options.leaseOutputBoundDefault;
  }
  if (options.defaultParams !== undefined) configOptions.default_params = options.defaultParams;
  if (options.tags !== undefined) configOptions.tags = options.tags;
  if (options.failoverIdempotency !== undefined) {
    configOptions.failover_idempotency = options.failoverIdempotency;
  }
  if (options.sameProviderRetries !== undefined) {
    configOptions.same_provider_retries = options.sameProviderRetries;
  }
  if (options.failoverTotalTimeout !== undefined) {
    configOptions.failover_total_timeout = options.failoverTotalTimeout;
  }
  if (options.failoverHopReadTimeout !== undefined) {
    configOptions.failover_hop_read_timeout = options.failoverHopReadTimeout;
  }
  if (options.circuitBreakerRecoveryTimeoutJitter !== undefined) {
    configOptions.circuit_breaker_recovery_timeout_jitter =
      options.circuitBreakerRecoveryTimeoutJitter;
  }
  if (options.circuitBreakerFailureThreshold !== undefined) {
    configOptions.circuit_breaker_failure_threshold = options.circuitBreakerFailureThreshold;
  }
  if (options.circuitBreakerRecoveryTimeout !== undefined) {
    configOptions.circuit_breaker_recovery_timeout = options.circuitBreakerRecoveryTimeout;
  }
  if (options.circuitBreakerSuccessThreshold !== undefined) {
    configOptions.circuit_breaker_success_threshold = options.circuitBreakerSuccessThreshold;
  }
  if (options.budgetCheckCacheTtl !== undefined) {
    configOptions.budget_check_cache_ttl = options.budgetCheckCacheTtl;
  }
  if (options.budgetCheckTimeout !== undefined) {
    configOptions.budget_check_timeout = options.budgetCheckTimeout;
  }
  if (options.controlPlaneFailureThreshold !== undefined) {
    configOptions.control_plane_failure_threshold = options.controlPlaneFailureThreshold;
  }
  if (options.controlPlaneRecoveryTimeout !== undefined) {
    configOptions.control_plane_recovery_timeout = options.controlPlaneRecoveryTimeout;
  }
  if (options.breakerReportingEnabled !== undefined) {
    configOptions.breaker_reporting_enabled = options.breakerReportingEnabled;
  }
  if (options.reporterBatchSize !== undefined) {
    configOptions.reporter_batch_size = options.reporterBatchSize;
  }
  if (options.reporterFlushInterval !== undefined) {
    configOptions.reporter_flush_interval = options.reporterFlushInterval;
  }
  if (options.reporterMaxQueueSize !== undefined) {
    configOptions.reporter_max_queue_size = options.reporterMaxQueueSize;
  }
  if (options.reporterMaxInFlight !== undefined) {
    configOptions.reporter_max_in_flight = options.reporterMaxInFlight;
  }
  if (options.reporterMaxSendAttempts !== undefined) {
    configOptions.reporter_max_send_attempts = options.reporterMaxSendAttempts;
  }
  if (options.reporterRetryBackoffBase !== undefined) {
    configOptions.reporter_retry_backoff_base = options.reporterRetryBackoffBase;
  }
  if (options.reporterRetryBackoffCap !== undefined) {
    configOptions.reporter_retry_backoff_cap = options.reporterRetryBackoffCap;
  }
  if (options.reporterShutdownDeadline !== undefined) {
    configOptions.reporter_shutdown_deadline = options.reporterShutdownDeadline;
  }
  if (options.breakerReportHeartbeat !== undefined) {
    configOptions.breaker_report_heartbeat = options.breakerReportHeartbeat;
  }
  if (options.velocityMode !== undefined) {
    configOptions.velocity_mode = options.velocityMode;
  }
  if (options.velocityRepeatCount !== undefined) {
    configOptions.velocity_repeat_count = options.velocityRepeatCount;
  }
  if (options.velocityRepeatWindowS !== undefined) {
    configOptions.velocity_repeat_window_s = options.velocityRepeatWindowS;
  }
  if (options.velocityGrowthStreak !== undefined) {
    configOptions.velocity_growth_streak = options.velocityGrowthStreak;
  }
  if (options.velocityGrowthFactor !== undefined) {
    configOptions.velocity_growth_factor = options.velocityGrowthFactor;
  }
  if (options.velocityAccelFloorPerMin !== undefined) {
    configOptions.velocity_accel_floor_per_min = options.velocityAccelFloorPerMin;
  }
  if (options.velocityAccelFactor !== undefined) {
    configOptions.velocity_accel_factor = options.velocityAccelFactor;
  }
  return configOptions;
}

/**
 * The Solwyn client pipeline. Construction is synchronous (config resolves eagerly, so
 * a bad `apiKey` throws from `new`); provider auto-detection / runtime-chain assembly
 * is async and happens lazily on the first intercepted call, memoized thereafter.
 *
 * Not constructed directly by consumers — `proxies.ts` wraps an instance in the
 * attribute-passthrough `Proxy` that becomes the public `Solwyn`.
 */
export class SolwynCore {
  readonly #client: unknown;
  readonly #config: SolwynConfig;
  /** Computed once from the resolved, private config; never sampled on a request hot path. */
  readonly #hasNoGlobalDefaultParams: boolean;
  readonly #primaryModel: string | null;
  readonly #providerOverride: string | undefined;
  readonly #fallbackSpecs: FallbackSpec[];
  readonly #reporter: MetadataReporter;
  readonly #budget: BudgetEnforcer;
  readonly #breakers: CircuitBreakerManager;
  readonly #controlPlaneBreaker: CircuitBreaker;
  readonly #sdkInstanceId: string;
  readonly #logger: Logger;
  /** {@link tagCaptureLogger}: the client's warn-once latch for merged-tag clamping. */
  readonly #tagLogger: Logger;
  /** Injectable candidate-ordering policy (default health-based). */
  readonly #selectionPolicy: SelectionPolicy;
  /** Per-provider rolling latency window feeding {@link LatencyPolicy}. */
  readonly #latency: LatencyTracker;
  /** Constructor-requested eight-field posture, immutable across directive mutations. */
  readonly #requestedFailoverTuning: FailoverTuningConfig;
  /** One immutable, content-blind velocity history for the lifetime of this client. */
  readonly #velocity: VelocityMonitor;
  readonly #velocityMode: "off" | "warn" | "deny";
  #surfaceRuntimes: readonly SurfaceRuntimeDescriptor[];
  #surfaceContext: SurfaceContext;
  readonly #surfaceGuards = new SurfaceNamespaceGuardCache();
  readonly #untrackedSurfaceReporter: UntrackedSurfaceReporter | null;

  #initPromise: Promise<InitState> | null = null;
  #closePromise: Promise<void> | null = null;
  #failoverTuningSuppressionLogged = false;

  constructor(client: unknown, options: SolwynOptions = {}) {
    // This synchronous identity gate precedes config/resource construction and every
    // provider override lookup/detection. Inspect only tuple-shaped fallback entries here;
    // malformed unrelated values remain on parseFallbackSpec's established validation path.
    assertRawProviderClient(client);
    if (Array.isArray(options.fallback)) {
      for (const spec of options.fallback) {
        if (Array.isArray(spec) && spec.length >= 2 && spec.length <= 4) {
          assertRawProviderClient(spec[0]);
        }
      }
    }

    // Reject unknown/renamed options (e.g. `projectId`) so an untyped JS caller cannot
    // silently pass a dropped field — mirrors Python's unexpected-keyword TypeError.
    for (const key of Object.keys(options)) {
      if (!KNOWN_OPTION_KEYS.has(key)) {
        throw new ConfigurationError(`unexpected option '${key}'`, { field: key });
      }
    }
    const config = resolveConfig(toConfigOptions(options));
    requireFetchLike(options.fetch);

    this.#client = client;
    // Node's util.inspect may bypass a Proxy get trap and invoke the target hook with the
    // proxy as `this`. An own hook bound to the wrapped client (not to `this`) stays
    // valid for any receiver while using only the edge-safe global symbol key.
    Object.defineProperty(this, CUSTOM_INSPECT, {
      configurable: true,
      enumerable: false,
      value: inspectHook(client),
      writable: false,
    });
    // Resolves defaults + env fallback and validates the api_key format. Throws
    // ConfigurationError synchronously on bad config.
    this.#config = config;
    this.#hasNoGlobalDefaultParams = !hasOwnEnumerableKey(config.default_params);
    this.#requestedFailoverTuning = pickFailoverTuning(this.#config);
    const velocityConfig = pickVelocityConfig(this.#config);
    this.#velocity = new VelocityMonitor(velocityConfig);
    this.#velocityMode = velocityConfig.velocity_mode;
    this.#primaryModel = options.model ?? null;
    this.#providerOverride = options.provider;
    this.#fallbackSpecs = options.fallback ?? [];
    this.#sdkInstanceId = crypto.randomUUID();
    // D6: resolve one logger for every core and advisory subsystem.
    this.#logger = options.logger ?? consoleLogger;
    this.#tagLogger = tagCaptureLogger(this.#logger);
    this.#surfaceRuntimes = buildSurfaceRuntimeDescriptors(
      this.#client,
      this.#primaryModel,
      this.#providerOverride,
      this.#fallbackSpecs,
    );
    const primarySurfaceRuntime = this.#surfaceRuntimes[0];
    if (primarySurfaceRuntime === undefined) {
      throw new ConfigurationError("no primary provider runtime was built", { field: null });
    }
    this.#surfaceContext = primarySurfaceRuntime.context;
    this.#validateSurfaceAcknowledgments();
    this.#untrackedSurfaceReporter = this.#config.report_untracked_surfaces
      ? new UntrackedSurfaceReporter(this.#config.api_url, this.#config.api_key, {
          sdkInstanceId: this.#sdkInstanceId,
          fetch: options.fetch,
          logger: this.#logger,
        })
      : null;
    // Routing signal state is pure and sans-I/O. The policy defaults to health-tier ordering;
    // swapping it changes attempt order with ZERO dispatch/translation/budget changes.
    this.#selectionPolicy = options.selectionPolicy ?? new HealthBasedPolicy();
    this.#latency = new LatencyTracker();
    this.#controlPlaneBreaker = new CircuitBreaker({
      failureThreshold: this.#config.control_plane_failure_threshold,
      recoveryTimeout: this.#config.control_plane_recovery_timeout,
      successThreshold: 1,
      name: "control-plane",
      logger: this.#logger,
    });

    // Per-provider-NAME breaker registry (invariant 5). Thresholds/jitter flow from the
    // resolved config; the config default jitter is 0.2 (breakers run jittered by
    // default — see circuit-breaker.ts flag). One breaker is eagerly created per runtime
    // in #buildInit; #getCircuitBreaker lazily returns the same instance thereafter.
    // Built before the reporter, whose snapshot supplier references only this registry.
    this.#breakers = new CircuitBreakerManager({
      failureThreshold: this.#config.circuit_breaker_failure_threshold,
      recoveryTimeout: this.#config.circuit_breaker_recovery_timeout,
      successThreshold: this.#config.circuit_breaker_success_threshold,
      recoveryTimeoutJitter: this.#config.circuit_breaker_recovery_timeout_jitter,
    });

    this.#reporter = new MetadataReporter(this.#config.api_url, this.#config.api_key, {
      batchSize: this.#config.reporter_batch_size,
      flushInterval: this.#config.reporter_flush_interval * 1000,
      maxQueueSize: this.#config.reporter_max_queue_size,
      maxInFlight: this.#config.reporter_max_in_flight,
      maxSendAttempts: this.#config.reporter_max_send_attempts,
      retryBackoffBase: this.#config.reporter_retry_backoff_base * 1000,
      retryBackoffCap: this.#config.reporter_retry_backoff_cap * 1000,
      shutdownDeadline: this.#config.reporter_shutdown_deadline * 1000,
      breakerReportHeartbeat: this.#config.breaker_report_heartbeat * 1000,
      fetch: options.fetch,
      logger: this.#logger,
      controlPlaneBreaker: this.#controlPlaneBreaker,
      breakerSnapshots: breakerSnapshotSupplier(this.#breakers),
      sdkInstanceId: this.#sdkInstanceId,
      breakerReportingEnabled: this.#config.breaker_reporting_enabled,
    });
    this.#reporter.start();

    // The pre-flight budget enforcer. Budget knobs (budget_mode, fail_open, cache TTL)
    // flow from SolwynOptions through the resolved config — validated once at
    // construction, not duplicated here. Every success path builds settlement sans-I/O and
    // queues it through the reporter (D18).
    this.#budget = new BudgetEnforcer({
      apiUrl: this.#config.api_url,
      apiKey: this.#config.api_key,
      budgetMode: this.#config.budget_mode,
      failOpen: this.#config.fail_open,
      cacheTtl: this.#config.budget_check_cache_ttl,
      fetch: options.fetch,
      logger: this.#logger,
      controlPlaneBreaker: this.#controlPlaneBreaker,
      holderId: this.#sdkInstanceId,
      leaseEnabled: this.#config.lease_enabled,
      leaseOutputBoundDefault: this.#config.lease_output_bound_default,
    });
  }

  /**
   * The resolved logger (D6). Exposed for the proxy layer's Bedrock command-classification
   * diagnostics (a shape-classified / untracked-passthrough command warning). NOT part of the
   * public `Solwyn` surface — the top-level proxy forwards a `logger` access to the wrapped
   * client, never to the core (see `createClientProxy`).
   */
  get logger(): Logger {
    return this.#logger;
  }

  /** Synchronous, descriptor-derived context used by every proxy read decision. */
  get surfaceContext(): SurfaceContext {
    this.#refreshSurfaceRuntimesBeforeInit();
    return this.#surfaceContext;
  }

  /** Detached structural inputs used to register the public wrapper with `coverage()`. */
  surfaceCoverageSource(): CoverageSource {
    this.#refreshSurfaceRuntimesBeforeInit();
    if (!isSurfaceObject(this.#client)) {
      throw new TypeError("invalid coverage source");
    }
    return {
      rawClient: this.#client,
      context: this.#surfaceContext,
      providerChain: this.#surfaceRuntimes.map(({ provider, dialect, clientShape, model }) =>
        Object.freeze({ provider, dialect, clientShape, model }),
      ),
      posture: this.#config.on_unmetered,
      acknowledgments: this.#config.acknowledge_untracked,
    };
  }

  /** Whether the primary owns the tracked native OpenAI/Azure Responses wrapper. */
  get usesNativeResponsesSurface(): boolean {
    this.#refreshSurfaceRuntimesBeforeInit();
    return (
      this.#surfaceContext.clientShape === "openai_sdk" &&
      (this.#surfaceContext.provider === "openai" ||
        this.#surfaceContext.provider === "azure_openai")
    );
  }

  #acknowledgmentApplies(path: string, rule: SurfaceRule | undefined): boolean {
    const exact = rule?.acknowledgmentToken ?? path;
    return this.#config.acknowledge_untracked.some(
      (token) => token === exact || token.startsWith(`${path}.`),
    );
  }

  #reportSurfaceObservation(decision: EffectiveSurfaceDecision): void {
    const reporter = this.#untrackedSurfaceReporter;
    const provider = this.#surfaceContext.provider;
    const posture = this.#config.on_unmetered;
    if (
      reporter === null ||
      provider === null ||
      posture === "raise" ||
      (decision.kind !== "unmetered_spend" && decision.kind !== "unknown")
    ) {
      return;
    }
    const admitted = reporter.observe({
      provider: provider as ProviderName,
      clientShape: this.#surfaceContext.clientShape,
      surface: decision.surface,
      ruleKind: decision.kind,
      capabilityScope: decision.capabilityScope,
      posture,
      occurrences: 1,
    });
    if (admitted?.status === "admitted") {
      void reporter.flushDue();
    }
  }

  #applySurfacePosture<T>(decision: EffectiveSurfaceDecision, execute: () => T): T {
    const provider = this.#surfaceContext.provider;
    if (provider === null) {
      throw new SolwynError("surface provider attribution is unavailable");
    }
    const shared = surfacePostureState();
    return applySurfacePosture({
      posture: this.#config.on_unmetered,
      decision,
      provider,
      clientShape: this.#surfaceContext.clientShape,
      acknowledgments: this.#config.acknowledge_untracked,
      registry: shared.observations,
      warningLatch: shared.warnings,
      report: () => this.#reportSurfaceObservation(decision),
      logger: this.#logger,
      guardAcknowledgedDescendant: (value) => this.#guardSurfaceValue(value, decision.surface),
      execute,
    });
  }

  #guardSurfaceValue<T>(value: T, path: string): T {
    if (!isSurfaceObject(value)) {
      throw new SolwynError("acknowledged descendant has unguardable prefix");
    }
    const target = value;
    return this.#surfaceGuards.getOrCreate(
      target,
      path,
      this.#surfaceContext,
      (surface, execute) => {
        const property = surface.slice(surface.lastIndexOf(".") + 1);
        return this.resolveSurfaceRead(target, property, surface, "raw", execute);
      },
    ) as T;
  }

  #throwSurfaceDecision(decision: EffectiveSurfaceDecision): void {
    if (decision.kind === "blocked") {
      throw new ConfigurationError(decision.rule?.reason ?? "blocked surface", {
        field: decision.surface,
      });
    }
    if (decision.kind === "unsupported") {
      throw new UnsupportedSurfaceError({
        surface: decision.surface,
        provider: this.#surfaceContext.provider ?? "unknown",
      });
    }
    if (decision.kind === "metered") {
      throw new SolwynError(`metered surface reached generic resolver: ${decision.surface}`);
    }
  }

  /** Resolve a public SDK property before its getter or value is touched. */
  resolveSurfaceRead(
    target: object,
    property: string,
    path: string,
    source: ObservedSurfaceSource,
    execute: () => unknown,
    namespaceTransform?: (value: object) => unknown,
    missingNamespace?: () => object,
    interceptedMethod?: () => unknown,
  ): unknown {
    this.#refreshSurfaceRuntimesBeforeInit();
    if (property.startsWith("_")) return execute();
    const surface = validateSurfacePath(path);
    const rule = resolveSurfaceRule({ context: this.#surfaceContext, path: surface, source });
    const provisional = provisionalSurfaceDecision(surface, rule);

    const staticObservation = observePublicProperty(target, property, surface);
    if (staticObservation === undefined) {
      // Only explicitly synthetic namespaces supply this factory. Their reviewed
      // wrapper exists without a raw descriptor; never probe a dynamic provider get.
      // Raw-backed namespaces and present-but-drifted shapes keep the usual guard.
      if (rule?.kind === "namespace" && missingNamespace !== undefined) {
        return missingNamespace();
      }
      // Promise assimilation must stay inert even for get-only provider Proxies.
      if (property === "then") return undefined;
      let present = false;
      try {
        present = Reflect.has(target, property);
      } catch {
        present = true;
      }
      if (
        rule !== undefined &&
        rule.kind !== "namespace" &&
        (rule.kind !== "metered" || interceptedMethod === undefined)
      ) {
        this.#throwSurfaceDecision(provisional);
      }

      const dynamicDecision = effectiveSurfaceDecision({
        path: surface,
        descriptorCategory: "field",
        returnShape: "opaque",
      });
      if (
        this.#config.on_unmetered === "raise" &&
        !this.#acknowledgmentApplies(surface, undefined)
      ) {
        // An absent descriptor cannot distinguish a missing field from a dynamic
        // Proxy capability. Even a reviewed namespace must refuse before lookup.
        return this.#applySurfacePosture(dynamicDecision, execute);
      }

      const value = execute();
      if (!present && value === undefined) return value;
      const actual = observeEvaluatedProperty(surface, "field", value);
      if (rule?.kind === "namespace" && rule.acceptsShape(actual) && isSurfaceObject(value)) {
        return namespaceTransform === undefined
          ? this.#guardSurfaceValue(value, surface)
          : namespaceTransform(value);
      }
      const resolved = this.#applySurfacePosture(effectiveSurfaceDecision(actual), () => value);
      return resolved;
    }
    const observation = staticObservation;
    const decision = staticSurfaceDecision(surface, rule, observation);
    if (decision.kind === "metered" && interceptedMethod !== undefined) {
      // Optional method reads are not dispatches: a reviewed callable may be replaced
      // by its interceptor, but any evaluated drift must cross the ordinary posture.
      const value = execute();
      const actual = observeEvaluatedProperty(surface, observation.descriptorCategory, value);
      if (rule?.acceptsShape(actual)) return interceptedMethod();
      return this.#applySurfacePosture(effectiveSurfaceDecision(actual, rule), () => value);
    }
    this.#throwSurfaceDecision(decision);
    if (
      (decision.kind === "unmetered_spend" || decision.kind === "unknown") &&
      this.#config.on_unmetered === "raise" &&
      !this.#acknowledgmentApplies(surface, decision.rule ?? undefined)
    ) {
      return this.#applySurfacePosture(decision, execute);
    }

    let evaluated = false;
    let rawValue: unknown;
    const readOnce = (): unknown => {
      if (!evaluated) {
        rawValue = execute();
        evaluated = true;
      }
      return rawValue;
    };
    const evaluatedObservation = (): SurfaceObservation =>
      observeEvaluatedProperty(surface, observation.descriptorCategory, readOnce());
    const guardEvaluatedValue = (value: unknown): unknown => {
      const actual = evaluatedObservation();
      return actual.returnShape === "resource" || actual.returnShape === "mapping"
        ? this.#guardSurfaceValue(value, surface)
        : value;
    };

    if (decision.kind === "namespace") {
      const value = readOnce();
      const actual = evaluatedObservation();
      if (rule?.acceptsShape(actual) && isSurfaceObject(value)) {
        return namespaceTransform === undefined
          ? this.#guardSurfaceValue(value, surface)
          : namespaceTransform(value);
      }
      return this.#applySurfacePosture(effectiveSurfaceDecision(actual, rule), () => value);
    }

    if (decision.kind === "metadata" || decision.kind === "infrastructure") {
      const value = readOnce();
      const actual = evaluatedObservation();
      if (rule?.acceptsShape(actual)) return value;
      // Inert accessors are reviewed statically as unevaluated; after evaluation
      // they must satisfy the same value-shape contract as an inert data field.
      if (
        actual.descriptorCategory === "getter" &&
        (actual.returnShape === "scalar" ||
          actual.returnShape === "mapping" ||
          actual.returnShape === "opaque") &&
        rule?.acceptsShape({ ...actual, descriptorCategory: "field" })
      ) {
        return value;
      }
      return this.#applySurfacePosture(effectiveSurfaceDecision(actual, rule), () => value);
    }

    const value = this.#applySurfacePosture(decision, readOnce);
    // Static drift already entered unknown posture before evaluation. Finish by
    // guarding the evaluated value, not by recording the same drift a second time.
    if (decision.kind === "unknown") return guardEvaluatedValue(rawValue);
    // Even data descriptors can differ from Proxy.get results. Every evaluated
    // value must satisfy the reviewed shape before an acknowledgment can allow it.
    const actual = evaluatedObservation();
    if (rule !== undefined && !rule.acceptsShape(actual)) {
      return this.#applySurfacePosture(effectiveSurfaceDecision(actual, rule), () => rawValue);
    }
    const exactRawResponse =
      decision.kind === "unmetered_spend" &&
      decision.capabilityScope === "raw_response" &&
      this.#config.acknowledge_untracked.includes(decision.acknowledgmentToken);
    return exactRawResponse ? value : guardEvaluatedValue(rawValue);
  }

  /** Resolve one wrapper-owned operation before the interception pipeline starts. */
  enforceExplicitSurface(
    path: string,
    source: ObservedSurfaceSource = "wrapper",
    condition?: SurfaceCondition,
  ): void {
    this.#refreshSurfaceRuntimesBeforeInit();
    const surface = validateSurfacePath(path);
    const rule = resolveSurfaceRule({
      context: this.#surfaceContext,
      path: surface,
      source,
      condition,
    });
    const decision = provisionalSurfaceDecision(surface, rule);
    if (decision.kind === "metered") return;
    this.#throwSurfaceDecision(decision);
    if (decision.kind === "unmetered_spend" || decision.kind === "unknown") {
      this.#applySurfacePosture(decision, () => undefined);
      return;
    }
    throw new SolwynError(`non-dispatch surface reached explicit resolver: ${surface}`);
  }

  #validateSurfaceAcknowledgments(context: SurfaceContext = this.#surfaceContext): void {
    for (const token of this.#config.acknowledge_untracked) {
      if (token.includes(":")) {
        const rule = resolveSurfaceRule({
          context,
          path: "audio.speech.create",
          source: "synthetic_policy",
          condition: "openai_untracked_tts_model",
        });
        if (rule?.kind === "unmetered_spend" && rule.acknowledgmentToken === token) continue;
        throw new ConfigurationError(
          "acknowledge_untracked token has no applicable conditional rule",
          { field: "acknowledge_untracked" },
        );
      }
      const rule = resolveSurfaceRule({
        context,
        path: token,
        source: "raw",
      });
      if (rule?.kind === "namespace") {
        throw new ConfigurationError("acknowledge_untracked token names a resource container", {
          field: "acknowledge_untracked",
        });
      }
      if (
        rule !== undefined &&
        (rule.kind !== "unmetered_spend" || rule.acknowledgmentToken !== token)
      ) {
        throw new ConfigurationError(
          "acknowledge_untracked token does not resolve to an exact unmetered surface",
          { field: "acknowledge_untracked" },
        );
      }
      let current: unknown = this.#client;
      const segments = token.split(".");
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment === undefined || !isSurfaceObject(current)) {
          throw new ConfigurationError("acknowledge_untracked path is not statically visible", {
            field: "acknowledge_untracked",
          });
        }
        const prefix = segments.slice(0, index + 1).join(".");
        const observation = observePublicProperty(current, segment, prefix);
        if (observation === undefined) {
          throw new ConfigurationError("acknowledge_untracked path is not statically visible", {
            field: "acknowledge_untracked",
          });
        }
        if (index === segments.length - 1) {
          if (rule === undefined && observation.returnShape === "unevaluated_accessor") {
            throw new ConfigurationError(
              "acknowledge_untracked terminal shape is not statically visible",
              { field: "acknowledge_untracked" },
            );
          }
          if (
            rule === undefined &&
            (observation.returnShape === "resource" || observation.returnShape === "mapping")
          ) {
            throw new ConfigurationError("acknowledge_untracked token names a resource container", {
              field: "acknowledge_untracked",
            });
          }
          if (
            rule !== undefined &&
            staticSurfaceDecision(prefix, rule, observation).driftedFromRuleId !== null
          ) {
            throw new ConfigurationError(
              "acknowledge_untracked path does not match its reviewed shape",
              { field: "acknowledge_untracked" },
            );
          }
          const descriptorShapes = rule?.expectedShapes.filter(
            (shape) => shape.descriptorCategory === observation.descriptorCategory,
          );
          if (
            observation.returnShape === "unevaluated_accessor" &&
            descriptorShapes !== undefined &&
            descriptorShapes.length > 0 &&
            descriptorShapes.every((shape) => shape.returnShape === "unevaluated_accessor")
          ) {
            continue;
          }
          const returned = Reflect.get(current, segment, current);
          const actual = observeEvaluatedProperty(prefix, observation.descriptorCategory, returned);
          if (rule !== undefined && !rule.acceptsShape(actual)) {
            throw new ConfigurationError(
              "acknowledge_untracked evaluated attribute does not match its reviewed shape",
              { field: "acknowledge_untracked" },
            );
          }
          if (
            rule === undefined &&
            (actual.returnShape === "resource" || actual.returnShape === "mapping")
          ) {
            throw new ConfigurationError("acknowledge_untracked token names a resource container", {
              field: "acknowledge_untracked",
            });
          }
          continue;
        }
        const prefixRule = resolveSurfaceRule({
          context,
          path: prefix,
          source: "raw",
        });
        if (prefixRule !== undefined) {
          if (prefixRule.kind !== "namespace" && prefixRule.kind !== "unmetered_spend") {
            throw new ConfigurationError(
              `acknowledge_untracked prefix '${prefix}' is not a namespace`,
              { field: "acknowledge_untracked" },
            );
          }
          if (staticSurfaceDecision(prefix, prefixRule, observation).driftedFromRuleId !== null) {
            const prefixKind = prefixRule.kind === "namespace" ? "namespace" : "unmetered prefix";
            throw new ConfigurationError(
              `acknowledge_untracked ${prefixKind} '${prefix}' shape drifted`,
              { field: "acknowledge_untracked" },
            );
          }
        } else if (observation.returnShape === "unevaluated_accessor") {
          throw new ConfigurationError(
            `acknowledge_untracked unknown prefix '${prefix}' is not guardable`,
            { field: "acknowledge_untracked" },
          );
        }
        const next = Reflect.get(current, segment, current);
        const actual = observeEvaluatedProperty(prefix, observation.descriptorCategory, next);
        const guardable =
          isSurfaceObject(next) &&
          (actual.returnShape === "resource" || actual.returnShape === "mapping");
        if (prefixRule?.kind === "namespace") {
          if (!prefixRule.acceptsShape(actual)) {
            throw new ConfigurationError(
              `acknowledge_untracked namespace '${prefix}' shape drifted`,
              { field: "acknowledge_untracked" },
            );
          }
          if (!guardable) {
            throw new ConfigurationError(
              `acknowledge_untracked prefix '${prefix}' is not a namespace`,
              { field: "acknowledge_untracked" },
            );
          }
        } else if (prefixRule?.kind === "unmetered_spend") {
          if (!prefixRule.acceptsShape(actual)) {
            throw new ConfigurationError(
              `acknowledge_untracked unmetered prefix '${prefix}' shape drifted`,
              { field: "acknowledge_untracked" },
            );
          }
          if (!guardable) {
            throw new ConfigurationError(
              `acknowledge_untracked unmetered prefix '${prefix}' is not a guardable provider resource`,
              { field: "acknowledge_untracked" },
            );
          }
        } else if (!guardable) {
          throw new ConfigurationError(
            `acknowledge_untracked unknown prefix '${prefix}' is not guardable`,
            { field: "acknowledge_untracked" },
          );
        }
        current = next;
      }
    }
  }

  /** Lazily build (and memoize) the `[primary, ...fallbacks]` runtime chain. */
  #ensureInit(issuanceProvider?: string): Promise<InitState> {
    if (this.#initPromise === null) {
      this.#refreshSurfaceRuntimesBeforeInit();
      this.#initPromise = this.#buildInit(issuanceProvider);
    }
    return this.#initPromise;
  }

  /**
   * Preserve the established lazy provider-attribution lifecycle until the first call.
   * A mutable OpenAI-compatible base URL may legitimately select a different attribution
   * provider before initialization; the SDK family/dialect must remain stable because the
   * public proxy topology was chosen at construction.
   */
  #refreshSurfaceRuntimesBeforeInit(): void {
    if (this.#initPromise !== null) return;
    let next: readonly SurfaceRuntimeDescriptor[];
    try {
      next = buildSurfaceRuntimeDescriptors(
        this.#client,
        this.#primaryModel,
        this.#providerOverride,
        this.#fallbackSpecs,
      );
    } catch {
      // Wrapper mutation traps intentionally expose the provider client's live write surface.
      // A framework may temporarily replace/delete a detection-bearing namespace; that must
      // not retroactively invalidate the already-selected proxy topology. Provider-attribution
      // refresh is therefore best-effort until initialization, while the real lazy adapter
      // build still performs its full validation before the first metered call.
      return;
    }
    const currentPrimary = this.#surfaceRuntimes[0];
    const nextPrimary = next[0];
    if (currentPrimary === undefined || nextPrimary === undefined) {
      throw new ConfigurationError("no primary provider runtime was built", { field: null });
    }
    if (
      currentPrimary.sdkClient !== nextPrimary.sdkClient ||
      currentPrimary.dialect !== nextPrimary.dialect ||
      currentPrimary.clientShape !== nextPrimary.clientShape
    ) {
      throw new ConfigurationError("provider client shape changed before initialization", {
        field: "client",
      });
    }
    const unchanged =
      next.length === this.#surfaceRuntimes.length &&
      next.every((runtime, index) => {
        const current = this.#surfaceRuntimes[index];
        return (
          current !== undefined &&
          runtime.sdkClient === current.sdkClient &&
          runtime.provider === current.provider &&
          runtime.dialect === current.dialect &&
          runtime.clientShape === current.clientShape &&
          runtime.model === current.model
        );
      });
    if (unchanged) return;
    this.#validateSurfaceAcknowledgments(nextPrimary.context);
    this.#surfaceRuntimes = next;
    this.#surfaceContext = nextPrimary.context;
  }

  async #buildInit(issuanceProvider?: string): Promise<InitState> {
    const primaryProvider = this.#providerOverride ?? issuanceProvider;
    const runtimes = await buildRuntimes(
      this.#client,
      this.#primaryModel,
      this.#fallbackSpecs,
      primaryProvider === undefined ? {} : { primaryProvider },
    );
    const primary = runtimes[0];
    if (primary === undefined) {
      // buildRuntimes always yields at least the primary; defensive only.
      throw new ConfigurationError("no primary provider runtime was built", { field: null });
    }
    if (runtimes.length !== this.#surfaceRuntimes.length) {
      throw new ConfigurationError("provider runtime chain changed during initialization", {
        field: "client",
      });
    }
    for (let index = 0; index < runtimes.length; index += 1) {
      const runtime = runtimes[index];
      const surfaceRuntime = this.#surfaceRuntimes[index];
      if (
        runtime === undefined ||
        surfaceRuntime === undefined ||
        runtime.adapter.name !== surfaceRuntime.provider ||
        runtime.adapter.dialect !== surfaceRuntime.dialect ||
        deriveSurfaceClientShape(runtime.sdkClient) !== surfaceRuntime.clientShape
      ) {
        throw new ConfigurationError("provider surface attribution changed during initialization", {
          field: "client",
        });
      }
    }
    // behavior 36 / invariant 5: eagerly construct one breaker per distinct provider
    // name across the whole chain up front, so a later failover is pure dispatch. The
    // manager memoizes by name, so this is idempotent with #getCircuitBreaker at dispatch.
    for (const runtime of runtimes) {
      this.#breakers.get(runtime.adapter.name);
      if (
        runtime.adapter.dialect === "bedrock" &&
        bedrockSocketTimeoutState(runtime.sdkClient) === "unbounded"
      ) {
        this.#logger.warn(BEDROCK_UNBOUNDED_READ_WARNING, runtime.entry.model);
      }
    }
    // Budget check's failover chain: every NON-primary runtime's provider + model,
    // element-aligned in configured-chain order (built up front even though M2 serves
    // only the primary).
    const fallbackProviders = runtimes.slice(1).map((r) => r.adapter.name as ProviderName);
    const fallbackModels = runtimes.slice(1).map((r) => r.entry.model);
    return { runtimes, primary, fallbackProviders, fallbackModels };
  }

  /** Apply the exact pre-budget local-run gate and record one content-blind observation. */
  #precheckRunControl(ctx: AdmissionContext): RunControlPrecheck {
    const activeRun = ctx.run;
    if (!hasRunIdentity(activeRun)) {
      return { flags: EMPTY_VELOCITY_FLAGS, pendingLocalReason: null };
    }

    const retained = runTermination(activeRun.agentRunId);
    if (retained?.source === "local_velocity") {
      this.#raiseRunStopped(ctx, retained, "run_terminated", EMPTY_VELOCITY_FLAGS);
    }
    if (this.#velocityMode === "off") {
      return { flags: EMPTY_VELOCITY_FLAGS, pendingLocalReason: null };
    }

    const observedAt = performance.now() / 1000;
    const flags = this.#velocity.observe({
      runId: activeRun.agentRunId,
      estimatedInputTokens: Math.max(0, Math.trunc(ctx.inputTokens)),
      model: ctx.model,
      now: observedAt,
    });
    for (const flag of flags) {
      if (this.#velocity.shouldWarn(activeRun.agentRunId, flag, observedAt)) {
        this.#safeWarn("velocity.flagged: rule=%s run=%s", flag, activeRun.agentRunId);
      }
    }
    if (this.#velocityMode !== "deny") {
      return { flags, pendingLocalReason: null };
    }

    const denyRule = DENY_ELIGIBLE_RULE_ORDER.find((rule) => flags.includes(rule));
    if (denyRule === undefined) {
      return { flags, pendingLocalReason: null };
    }
    const winner = markTerminated(activeRun.agentRunId, {
      reason: `velocity:${denyRule}`,
      source: "local_velocity",
    });
    if (winner.source === "server") {
      return { flags, pendingLocalReason: denyRule };
    }
    this.#raiseRunStopped(ctx, winner, "local_velocity", flags);
  }

  /** Reconcile live budget authority with concurrent/existing registry state before tuning. */
  #postcheckRunControl(
    ctx: AdmissionContext,
    budget: BudgetCheckResult,
    precheck: RunControlPrecheck,
  ): void {
    const activeRun = ctx.run;
    if (!hasRunIdentity(activeRun)) return;

    let termination: RunTermination | undefined;
    let retainedOnly = false;
    let pendingFreshLocal = false;
    if (precheck.pendingLocalReason !== null) {
      termination = markTerminated(activeRun.agentRunId, {
        reason: `velocity:${precheck.pendingLocalReason}`,
        source: "local_velocity",
      });
      pendingFreshLocal = termination.source === "local_velocity";
    } else {
      termination = runTermination(activeRun.agentRunId);
      if (termination === undefined) {
        termination = postcheckTermination(activeRun.agentRunId);
        retainedOnly = termination !== undefined;
      }
    }
    if (termination === undefined) return;

    const ordinaryServerStop =
      termination.source === "server" &&
      !budget.allowed &&
      budget.deniedByPeriod === "run_stopped" &&
      (retainedOnly ||
        ((budget.denySource === "server" || budget.denySource === "sticky_replay") &&
          budget.denyReason === termination.reason));
    if (ordinaryServerStop) return;

    try {
      this.#budget.releaseReservation(ctx.callId, budget.leaseClaimToken ?? null);
    } catch {
      // Capability cleanup is best effort; the run stop remains authoritative.
    }
    this.#raiseRunStopped(
      ctx,
      termination,
      pendingFreshLocal ? "local_velocity" : "run_terminated",
      precheck.flags,
    );
  }

  /** Report one registry-gate receipt, then throw a fresh typed public stop. */
  #raiseRunStopped(
    ctx: AdmissionContext,
    termination: RunTermination,
    denySource: DenySource,
    flags: readonly VelocityFlag[],
  ): never {
    this.#reportBudgetDenied(() =>
      this.#buildRegistryDeniedEvent(ctx, termination, denySource, flags),
    );
    throw new RunStoppedError({
      agentRunId: ctx.run?.agentRunId ?? "",
      reason: termination.reason,
      source: termination.source,
    });
  }

  /** Best-effort denial telemetry with a safe, class-name-only diagnostic on failure. */
  #reportBudgetDenied(build: () => MetadataEvent): void {
    try {
      this.#reporter.report(build());
    } catch (error) {
      this.#safeWarn(
        "Failed to report budget_denied metadata event: %s",
        safeErrorClassName(error) ?? "unknown",
      );
    }
  }

  #safeWarn(message: string, ...args: unknown[]): void {
    try {
      this.#logger.warn(message, ...args);
    } catch {
      // Diagnostics must never change admission or provider-call behavior.
    }
  }

  /** Primary-attributed, attempt-zero receipt shared by chat, Responses, and media gates. */
  #buildRegistryDeniedEvent(
    ctx: AdmissionContext,
    termination: RunTermination,
    denySource: DenySource,
    flags: readonly VelocityFlag[],
  ): MetadataEvent {
    const event: MetadataEvent = {
      model: ctx.model,
      provider: ctx.provider,
      input_tokens: wireTokenQuantity(ctx.inputTokens),
      output_tokens: 0,
      token_details: null,
      latency_ms: 0,
      status: "budget_denied",
      is_model_fallback: false,
      is_provider_fallback: false,
      failover_reason: null,
      failover_error_class: null,
      attempt_index: 0,
      call_id: ctx.callId,
      service_tier: null,
      sdk_instance_id: this.#sdkInstanceId,
      timestamp: this.#reporter.nextEventTimestamp(),
      provider_region: safeExtractRegion(
        () => ctx.primary.adapter.extractRegion(ctx.primary.sdkClient),
        this.#logger,
      ),
    };
    if (ctx.modality !== undefined) event.modality = ctx.modality;
    if (ctx.estimatedMedia !== null) event.media_usage = ctx.estimatedMedia;
    applyEventReceiptFields(event, {
      denySource,
      denyReason: termination.reason,
      deniedByPeriod: "run_stopped",
      estimatedOutputBound: ctx.estimatedOutputBound,
      velocityFlags: flags,
    });
    this.#applyRunReceipt(event, ctx.run);
    return event;
  }

  #applyRunReceipt(event: MetadataEvent, run: AttributionSnapshot | undefined): void {
    if (run === undefined) return;
    if (hasRunIdentity(run)) {
      event.agent_run_id = run.agentRunId;
      event.agent_run_name = run.agentRunName;
      if (run.parentAgentRunId !== null && run.parentAgentRunId !== undefined) {
        event.parent_agent_run_id = run.parentAgentRunId;
      }
    }
    if (run.tags !== null && run.tags !== undefined) {
      event.tags = { ...run.tags };
    }
  }

  /**
   * The single interception entry point. Snapshots the active run scope and mints one
   * `call_id` per invocation, stamps the per-call chain {@link Deadline}, sizes a
   * pre-flight input-token estimate against the PRIMARY, runs the budget check once, then
   * walks the health-ordered candidate chain (see {@link #walk}). Returns the served
   * provider's response (buffered) or a stream wrapper (streaming) — reshaped back to the
   * caller's dialect on a cross-dialect served hop, identical for a same-dialect one.
   */
  async interceptedCall(
    surface: InterceptSurface,
    kwargs: Record<string, unknown>,
    options: InterceptOptions = {},
    passthroughArgs: readonly unknown[] = [],
  ): Promise<unknown> {
    // Copy and remove our reserved kwarg before any await, estimation, or admission. This
    // leaves caller-owned params untouched while making every later hop share one input bag.
    const { callerKwargs, perCallTags } = copyKwargsAndExtractTags(kwargs);
    // Capture exactly once at issuance so deferred streams retain the scope that created them,
    // while unscoped configured/per-call tags remain real attribution.
    const run = captureCallAttribution(
      perCallTags,
      this.#config.tags,
      this.#tagLogger,
      this.#budget,
    );
    const callId = crypto.randomUUID();
    return this.#executeInterceptedCall(
      surface,
      callerKwargs,
      run,
      callId,
      options,
      snapshotRequestOptions(passthroughArgs),
    );
  }

  /** Capture issuance context now; all admission/provider work belongs to first use. */
  prepareResponsesStreamCall(
    kwargs: Record<string, unknown>,
    passthroughArgs: readonly unknown[] = [],
  ): DeferredResponseStream {
    const { callerKwargs, perCallTags } = copyKwargsAndExtractTags(kwargs);
    const run = captureCallAttribution(
      perCallTags,
      this.#config.tags,
      this.#tagLogger,
      this.#budget,
    );
    const callId = crypto.randomUUID();
    const effective = this.#mergeResponsesKwargs(
      { model: this.#primaryModel ?? "", default_params: {} },
      callerKwargs,
    );
    const capturedOptions = snapshotRequestOptions(passthroughArgs);
    // Resolve by the synchronous issuance identity, never redetect after an adapter import.
    // No admission, transport, health verdict, or latency sampling runs in initialization.
    // Catch independently because the helper may be pre-aborted or never activated.
    this.#ensureInit(this.#surfaceContext.provider ?? undefined).catch(() => {});
    return createDeferredResponseStream({
      start: async () =>
        (await this.#executeInterceptedCall(
          "responses",
          effective,
          run,
          callId,
          { responsesLeaf: "stream", forceStream: true },
          capturedOptions,
        )) as ResponseStreamLike,
      onAbortBeforeStart: () => {},
      logger: this.#logger,
    });
  }

  async #executeInterceptedCall(
    surface: InterceptSurface,
    callerKwargs: Record<string, unknown>,
    run: CallAttribution,
    callId: string,
    options: InterceptOptions,
    passthroughArgs: readonly unknown[],
  ): Promise<unknown> {
    // One monotonic chain deadline, stamped at entry, shared by the budget pre-flight AND
    // every hop (client-base.md behavior 1). remaining() never negative; expired() ⇔ ≤ 0.
    const deadline = new Deadline(this.#config.failover_total_timeout);

    const { primary, runtimes, fallbackProviders, fallbackModels } = await this.#ensureInit();
    const primaryProvider = primary.adapter.name as ProviderName;
    const primaryDialect = primary.adapter.dialect;

    // Resolve + STRIP the per-call idempotency override before any dispatch: it must never
    // reach the underlying SDK on ANY hop (routing-failover.md #24).
    let perCallIdempotent: boolean | undefined;
    if (PER_CALL_IDEMPOTENT_KEY in callerKwargs) {
      const raw = callerKwargs[PER_CALL_IDEMPOTENT_KEY];
      perCallIdempotent = raw === true ? true : raw === false ? false : undefined;
      delete callerKwargs[PER_CALL_IDEMPOTENT_KEY];
    }

    const responsesLeaf = surface === "responses" ? (options.responsesLeaf ?? "create") : undefined;
    const requestDefaults = {
      global: snapshotRequestStructure({ ...withoutSolwynTags(this.#config.default_params) }),
      entries: new Map(
        runtimes.map((runtime) => [
          runtime,
          snapshotRequestStructure({ ...withoutSolwynTags(runtime.entry.default_params) }),
        ]),
      ),
    };
    // Responses has one authority mapping that filters only default layers. Other surfaces keep
    // the existing ordinary fill-absent merge.
    const mergedPrimary =
      surface === "responses"
        ? this.#mergeResponsesKwargs(primary.entry, callerKwargs)
        : this.#mergeKwargs(primary, callerKwargs);
    const primaryModel =
      typeof mergedPrimary["model"] === "string" ? mergedPrimary["model"] : primary.entry.model;

    // Truthy coercion, matching Python's `bool(kwargs.get("stream", False)) or force`:
    // an untyped caller's `stream: 1` must take the streaming pipeline (F19). Computed
    // ONCE at entry — every hop's streaming-method selection derives from THIS boolean,
    // never a per-hop translated flag (client-base.md behavior 13).
    const isStreaming = options.forceStream === true || Boolean(mergedPrimary["stream"]);

    if (surface === "responses") {
      const responseSurface = `responses.${responsesLeaf}`;
      if (primary.adapter.supportsResponses !== true) {
        throw new UnsupportedSurfaceError({ surface: responseSurface, provider: primaryProvider });
      }
      if (responsesLeaf !== "parse" && mergedPrimary["background"] === true) {
        throw new ConfigurationError(BACKGROUND_RESPONSES_MESSAGE, { field: "background" });
      }
      if (responsesLeaf === "parse" && isStreaming) {
        throw new ConfigurationError(STREAMING_PARSE_MESSAGE, { field: "stream" });
      }
    }

    passthroughArgs = captureMeteredRequestOptions(passthroughArgs);
    if (primaryDialect === "google") validateMeteredGoogleOptions(mergedPrimary);
    for (const runtime of runtimes) {
      if (runtime.adapter.dialect === "google") {
        validateMeteredGoogleOptions(requestDefaults.entries.get(runtime) ?? {});
      }
    }

    // Pre-flight input-token estimate: content -> integer (privacy.ts), then the length
    // ratio keyed off the PRIMARY provider. Zero content estimates 0 (bypassing min-1, D8).
    const charCount =
      surface === "responses"
        ? estimateResponsesContentLength(mergedPrimary)
        : estimateContentLength(mergedPrimary);
    const estimatedInputTokens =
      charCount > 0 ? estimateTokensFromLength(charCount, primaryProvider) : 0;
    const estimatedOutputBound = resolveEffectiveOutputBound({
      sourceProvider: primaryProvider,
      sourceDialect: primaryDialect,
      sourceModel: primaryModel,
      globalDefaults: requestDefaults.global,
      callParams: surface === "responses" ? mergedPrimary : callerKwargs,
      hops: runtimes.map((runtime) => ({
        provider: runtime.adapter.name,
        dialect: runtime.adapter.dialect,
        model: runtime === primary ? primaryModel : runtime.entry.model,
        defaultParams: requestDefaults.entries.get(runtime),
      })),
      defaultBound: this.#config.lease_output_bound_default,
      responses: surface === "responses",
    });
    const admission: AdmissionContext = {
      callId,
      run,
      primary,
      provider: primaryProvider,
      model: primaryModel,
      inputTokens: estimatedInputTokens,
      estimatedOutputBound,
      modality: surface === "responses" ? "text" : undefined,
      estimatedMedia: null,
    };
    const velocity = this.#precheckRunControl(admission);

    // Budget pre-flight (behavior 4): checked ONCE against the PRIMARY provider/model,
    // before any hop, bounded by the SAME chain deadline. A deny throws a typed budget/stop
    // error and the wrapped client is never called. checkBudget never throws
    // (it degrades on an outage per its own sticky-deny -> fail-open -> local-enforcement
    // precedence — invariant 9 lives inside it); the client never swallows its result.
    const budget = budgetCheckResult(
      await this.#budget.checkBudget({
        runLifetime: run?.lifetime,
        agentRunId: run?.agentRunId,
        tags: run.tags,
        callId,
        estimatedInputTokens,
        estimatedOutputBound,
        model: primaryModel,
        provider: primaryProvider,
        fallbackProviders: surface === "responses" ? [] : fallbackProviders,
        fallbackModels: surface === "responses" ? [] : fallbackModels,
        ...(surface === "responses" ? { modality: "text" as const } : {}),
        timeout: budgetCheckTimeout(deadline, this.#config.budget_check_timeout),
      }),
    );
    this.#postcheckRunControl(admission, budget, velocity);
    const tuning = this.#applyFailoverTuningDirective(budget.failoverTuningAllowed);
    deadline.replaceTotal(tuning.totalTimeout);
    this.#reporter.observeProjectId(budget.projectId);
    const ctx: DispatchContext = {
      surface,
      responsesLeaf,
      callId,
      run,
      isStreaming,
      estimatedInputTokens,
      estimatedOutputBound,
      velocityFlags: velocity.flags,
      priceHints: budget.priceHints,
      funding: Object.freeze({
        reservationId: budget.allowed ? budget.reservationId : null,
        leaseId: budget.allowed ? budget.leaseId : null,
        leaseClaimToken: budget.allowed ? budget.leaseClaimToken : null,
      }),
      passthroughArgs,
      requestDefaults,
      callerKwargs: surface === "responses" ? mergedPrimary : callerKwargs,
      primary,
      primaryProvider,
      primaryModel,
      primaryDialect,
      deadline,
      tuning,
    };

    if (!budget.allowed) {
      // behavior 5: a hard-deny still reports a `budget_denied` event carrying the
      // pre-flight ESTIMATED input tokens (never 0 unless truly empty), output_tokens=0,
      // latency_ms=0, is_(model|provider)_fallback=false (a deny never fails over), and
      // the PRIMARY's region. The typed denial remains authoritative when best-effort reporting
      // cannot be constructed or enqueued.
      const primaryHop = this.#computeHop(primary, ctx, false, false, runtimes);
      const region = safeExtractRegion(
        () => primary.adapter.extractRegion(primary.sdkClient),
        this.#logger,
      );
      this.#reportBudgetDenied(() => this.#buildBudgetDeniedEvent(ctx, primaryHop, region, budget));
      throw this.#budget.buildDenialError(budget, estimatedInputTokens, run?.agentRunId);
    }

    // Idempotency resolves per call (explicit override wins over the client-level config).
    const mode = resolveIdempotencyMode(perCallIdempotent, tuning.idempotency);
    const streamTermination =
      isStreaming && hasRunIdentity(run)
        ? { handle: acquireTerminationHandle(run.agentRunId), transferred: false }
        : undefined;
    ctx.streamTermination = streamTermination;
    try {
      return await this.#walk(ctx, runtimes, mode);
    } catch (error) {
      if (!ctx.bufferedSettlementComplete) this.#releaseFunding(ctx.callId, ctx.funding);
      throw error;
    } finally {
      if (streamTermination !== undefined && !streamTermination.transferred) {
        streamTermination.handle.release();
      }
    }
  }

  /**
   * Resolve one media request against the constructor-time config snapshot and primary runtime.
   *
   * This is an INTERNAL proxy seam, not part of the public `Solwyn` intersection: the top-level
   * proxy exposes only lifecycle methods from this core. Keeping resolution here ensures a raw
   * untracked carve-out and the tracked lifecycle use the exact same fill-absent merge, including
   * the configured-model fallback for an explicit `model: undefined` or `model: null`.
   */
  async resolveMediaRequest(
    kwargs: Record<string, unknown>,
    markers: MediaInternalMarkers = {},
  ): Promise<ResolvedMediaRequest> {
    const { callerKwargs, perCallTags } = copyKwargsAndExtractTags(kwargs);
    const attribution = captureCallAttribution(
      perCallTags,
      this.#config.tags,
      this.#tagLogger,
      this.#budget,
    );
    const { primary } = await this.#ensureInit();
    return this.#resolveMediaRequest(primary, callerKwargs, attribution, markers);
  }

  /**
   * Primary-only lifecycle for tracked non-chat calls. Media calls deliberately bypass
   * candidate selection, translation, provider/model fallbacks, retries, and streaming.
   */
  async mediaCall(
    spec: MediaSurfaceSpec,
    kwargs: Record<string, unknown>,
    passthroughArgs: readonly unknown[] = [],
    resolvedRequest?: ResolvedMediaRequest,
    markers: MediaInternalMarkers = {},
  ): Promise<unknown> {
    passthroughArgs = captureMeteredRequestOptions(passthroughArgs);
    const directRequest =
      resolvedRequest === undefined ? copyKwargsAndExtractTags(kwargs) : undefined;
    const run =
      resolvedRequest?.attribution ??
      captureCallAttribution(
        directRequest?.perCallTags,
        this.#config.tags,
        this.#tagLogger,
        this.#budget,
      );
    const callId = crypto.randomUUID();
    const deadline = new Deadline(this.#config.failover_total_timeout);
    const { primary } = await this.#ensureInit();
    const provider = primary.adapter.name as ProviderName;
    const resolved =
      resolvedRequest ??
      this.#resolveMediaRequest(primary, directRequest?.callerKwargs ?? {}, run, markers);
    const merged = resolved.kwargs;
    const model = resolved.model;
    if (primary.adapter.dialect === "google") validateMeteredGoogleOptions(merged);
    const requestMeasurement = spec.measureRequest(merged);
    const estimatedInputTokens = requestMeasurement?.input_tokens ?? 0;
    const estimatedMedia = spec.estimateMedia(merged);
    const admission: AdmissionContext = {
      callId,
      run,
      primary,
      provider,
      model,
      inputTokens: estimatedInputTokens,
      estimatedOutputBound: null,
      modality: spec.modality,
      estimatedMedia,
    };
    const velocity = this.#precheckRunControl(admission);
    const budget = budgetCheckResult(
      await this.#budget.checkBudget({
        runLifetime: run?.lifetime,
        agentRunId: run?.agentRunId,
        tags: run.tags,
        callId,
        estimatedInputTokens,
        estimatedMedia,
        model,
        provider,
        modality: spec.modality,
        fallbackProviders: [],
        fallbackModels: [],
        timeout: budgetCheckTimeout(deadline, this.#config.budget_check_timeout),
      }),
    );
    this.#postcheckRunControl(admission, budget, velocity);
    const tuning = this.#applyFailoverTuningDirective(budget.failoverTuningAllowed);
    deadline.replaceTotal(tuning.totalTimeout);
    this.#reporter.observeProjectId(budget.projectId);
    const deniedRegion = budget.allowed
      ? null
      : safeExtractRegion(() => primary.adapter.extractRegion(primary.sdkClient), this.#logger);
    const deniedContext: MediaEventContext = {
      callId,
      model,
      provider,
      region: deniedRegion,
      run,
    };

    if (!budget.allowed) {
      this.#reportBudgetDenied(() =>
        this.#buildMediaEvent(deniedContext, {
          status: "budget_denied",
          modality: spec.modality,
          inputTokens: estimatedInputTokens,
          tokenDetails: null,
          mediaUsage: estimatedMedia,
          latencyMs: 0,
          failoverErrorClass: null,
          denySource: budget.denySource,
          denyReason: budget.denyReason,
          deniedByPeriod: budget.deniedByPeriod,
          velocityFlags: velocity.flags,
        }),
      );
      throw this.#budget.buildDenialError(budget, estimatedInputTokens, run?.agentRunId);
    }

    const funding: FundingContext = Object.freeze({
      reservationId: budget.reservationId,
      leaseId: budget.leaseId,
      leaseClaimToken: budget.leaseClaimToken,
    });
    if (deadline.expired()) {
      this.#releaseFunding(callId, funding);
      throw new ProviderUnavailableError("failover deadline expired", {
        attempted: [provider],
      });
    }
    const started = nowMs();
    let region: string | null = null;
    try {
      region = safeExtractRegion(
        () => primary.adapter.extractRegion(primary.sdkClient),
        this.#logger,
      );
      const prepare = primary.adapter.prepareMediaCall;
      if (prepare === undefined) {
        throw new UnsupportedSurfaceError({ surface: spec.surface, provider });
      }
      const prepared = prepare.call(primary.adapter, spec.surface, primary.sdkClient, merged, {
        timeout: tuning.hopReadTimeout,
        maxRetries: 0,
      });
      const response = await prepared.method(prepared.kwargs, ...passthroughArgs);
      const { tokenDetails, mediaUsage } = extractMediaUsageFailSoft({
        extractUsage: () => spec.extractUsage(response, { effectiveModel: model, provider }),
        measureRequest: () => spec.measureRequest(merged),
        measureMedia: () => spec.measureMedia(merged, response),
        logger: this.#logger,
      });
      const serviceTier = safeExtractServiceTier(
        () => primary.adapter.extractServiceTier(response),
        this.#logger,
      );
      const latencyMs = nowMs() - started;
      const context: MediaEventContext = {
        callId,
        model,
        provider,
        region,
        run,
      };
      const event = this.#buildMediaEvent(context, {
        status: "success",
        modality: spec.modality,
        inputTokens: tokenDetails?.input_tokens ?? 0,
        outputTokens: tokenDetails?.output_tokens ?? 0,
        tokenDetails,
        mediaUsage,
        latencyMs,
        failoverErrorClass: null,
        serviceTier,
        velocityFlags: velocity.flags,
      });
      if (hasSettlementFunding(funding) && (tokenDetails !== null || mediaUsage !== null)) {
        this.#settlePaidCall(event, {
          reservationId: funding.reservationId,
          leaseId: funding.leaseId,
          leaseClaimToken: funding.leaseClaimToken,
          model,
          tokenDetails: tokenDetails ?? zeroTokenDetails(),
          provider,
          isProviderFallback: false,
          callId,
          providerRegion: region,
          modality: spec.modality,
          mediaUsage,
          serviceTier,
        });
      } else {
        this.#reporter.report(event);
      }
      if (funding.leaseId === null) {
        this.#releaseFunding(callId, funding);
      }
      return response;
    } catch (error) {
      try {
        this.#reporter.report(
          this.#buildMediaEvent(
            { callId, model, provider, region, run },
            {
              status: "error",
              modality: spec.modality,
              inputTokens: 0,
              tokenDetails: null,
              mediaUsage: null,
              latencyMs: nowMs() - started,
              failoverErrorClass: safeErrorClassName(error),
            },
          ),
        );
      } catch {
        // Error telemetry is best effort and must never mask the original failure.
      }
      this.#releaseFunding(callId, funding);
      throw error;
    }
  }

  /** Apply the one authoritative media merge and return its effective model. */
  #resolveMediaRequest(
    primary: ProviderRuntime,
    kwargs: Record<string, unknown>,
    attribution: CallAttribution,
    markers: MediaInternalMarkers,
  ): ResolvedMediaRequest {
    const merged = this.#mergeKwargs(primary, { ...kwargs, ...markers });
    return {
      kwargs: merged,
      model: typeof merged["model"] === "string" ? merged["model"] : primary.entry.model,
      attribution,
    };
  }

  /** Fill-absent merge: global default_params < entry default_params < per-call kwargs. */
  #mergeKwargs(primary: ProviderRuntime, kwargs: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {
      ...withoutSolwynTags(this.#config.default_params),
      ...withoutSolwynTags(primary.entry.default_params),
      ...withoutSolwynTags(kwargs),
    };
    if (merged["model"] === undefined || merged["model"] === null) {
      merged["model"] = primary.entry.model;
    }
    return merged;
  }

  /** Responses effective view: filtered defaults layers, then caller values verbatim. */
  #mergeResponsesKwargs(
    primary: Pick<ProviderRuntime["entry"], "model" | "default_params">,
    kwargs: Record<string, unknown>,
  ): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    for (const layer of [this.#config.default_params, primary.default_params]) {
      for (const [key, value] of Object.entries(layer)) {
        if (!RESPONSES_DEFAULT_KEYS_TO_DROP.has(key)) {
          defaults[key] = value;
        }
      }
    }
    const merged: Record<string, unknown> = { ...defaults, ...withoutSolwynTags(kwargs) };
    if (merged["model"] === undefined || merged["model"] === null) {
      merged["model"] = primary.model;
    }
    return merged;
  }

  /**
   * The health-ordered candidate walk (routing-failover.md #17–#33). Builds one
   * {@link ProviderCandidate} per configured runtime over NON-mutating breaker reads, asks
   * the injected {@link SelectionPolicy} to order them (and filters the output back down to
   * the client's own runtimes — a misbehaving policy cannot inject a foreign runtime), then
   * walks in order:
   *
   *  - deadline re-checked between hops (spent → stop the walk);
   *  - one breaker `admit()` per candidate; a refused admission SKIPS it with no side
   *    effects (no dispatch, no breaker mutation, no metadata event);
   *  - the hop's request is prepared (same-dialect native passthrough, or cross-dialect
   *    translation that FAILS LOUD — an untranslatable abort stops the WHOLE chain,
   *    releasing the probe neutrally, never swallowed into a retry);
   *  - dispatch is classified on failure (`classifyException`): FAIL_FAST re-raises the
   *    original and NEVER counts the breaker; POST_SEND_AMBIGUOUS-not-allowed re-raises the
   *    original (possibly_succeeded) and counts the breaker; FAILOVER (and
   *    POST_SEND_AMBIGUOUS under "always") counts the breaker ONCE per provider per walk and
   *    advances — with a same-provider 429 retry inserted first when the `Retry-After` fits
   *    the deadline margin.
   *
   * Telemetry (routing-failover.md #20, Python per-hop parity): a served success reports its own
   * success event; EVERY non-retried failed hop reports exactly one error event in the catch
   * (an advancing FAILOVER/PSA-under-"always" hop, a FAIL_FAST abort, and a not-failed-over PSA
   * abort all report — carrying the FAILED hop's region); an intermediate same-provider 429 that
   * is retried reports nothing; chain exhaustion re-raises the LAST exception with NO extra report.
   */
  async #walk(
    ctx: DispatchContext,
    runtimes: ProviderRuntime[],
    mode: IdempotencyMode,
  ): Promise<unknown> {
    const { deadline } = ctx;
    const ambiguousAllowed = ambiguousFailoverAllowed(mode);

    const selection = this.#selectCandidates(ctx, runtimes);
    let candidates = selection.candidates;
    if (ctx.surface === "responses") {
      candidates = candidates.filter((candidate) => candidate.runtime === ctx.primary);
    }
    // "never" idempotency filters the walk to same-PROVIDER entries only — no cross-provider
    // hop at all, even for a FAILOVER-classified error (same-provider model swaps still run).
    if (mode === "never") {
      candidates = sameProviderCandidates(candidates, ctx.primaryProvider);
    }

    // behavior 10: no usable candidates → "all providers unavailable" (empty attempted);
    // an already-spent deadline before the walk → "failover deadline expired" with the full
    // ordered candidate-name list as attempted.
    if (candidates.length === 0) {
      throw new ProviderUnavailableError("all providers unavailable", { attempted: [] });
    }
    if (deadline.expired()) {
      throw new ProviderUnavailableError("failover deadline expired", {
        attempted: candidates.map(providerNameOf),
      });
    }

    // Deduped per-walk breaker-failure set (routing-failover.md #21): a provider counts at
    // most one breaker failure per logical call even across multiple same-provider entries.
    const failedBreakerProviders = new Set<string>();
    // Whether the PRIMARY runtime was attempted AND errored in this walk (drives a served
    // fallback's failover_reason: reactive "primary_error" vs proactive "circuit_open").
    let primaryErrored = false;
    // Once the walk encounters the primary, even a refused admission means later fallback
    // attribution is health-driven rather than the initial cost displacement.
    let primaryReached = false;
    // The LAST exception encountered across the walk; re-raised on chain exhaustion (#27). Each
    // hop reports its OWN error event in the catch, so there is no separate terminal report.
    let lastError: unknown;
    let anyAttemptFailed = false;

    for (let i = 0; i < candidates.length; i += 1) {
      // Re-check the deadline BETWEEN hops (#17), not only at entry.
      if (deadline.expired()) {
        break;
      }
      const runtime = candidates[i]?.runtime as ProviderRuntime;
      if (runtime === ctx.primary) {
        primaryReached = true;
      }
      const providerName = runtime.adapter.name;
      const breaker = this.#getCircuitBreaker(providerName);

      // One admission per attempted candidate (#11). A refused admission skips the
      // candidate with NO side effects (no dispatch, no breaker mutation, no event).
      const admission = breaker.admit();
      if (!admission.allowed) {
        continue;
      }
      const hop = this.#computeHop(
        runtime,
        ctx,
        primaryErrored,
        selection.costRouted && !primaryReached,
        runtimes,
      );

      // Prepare the hop's request. A cross-dialect Untranslatable* abort (raised BEFORE any
      // network call) stops the WHOLE chain (#16/#32): release the probe neutrally (no
      // health verdict) and PROPAGATE — never swallow it into a failover/retry.
      let hopKwargs: Record<string, unknown>;
      try {
        hopKwargs = this.#prepareHopKwargs(runtime, hop, ctx);
      } catch (prepError) {
        breaker.releaseProbe(admission);
        throw prepError;
      }

      // Same-provider 429 retries reset to the snapshotted budget for EACH chain entry.
      let retriesRemaining = ctx.responsesLeaf === "stream" ? 0 : ctx.tuning.sameProviderRetries;
      // A caller abort observed during (or at the end of) a Retry-After sleep ends the call.
      let retryAbort: Error | undefined;

      while (true) {
        // The provider read bound is immutable for the whole logical call. The total deadline
        // gates sleeps and BETWEEN-hop advancement but never shrinks an already-dispatched read.
        const hopReadTimeoutSeconds = ctx.tuning.hopReadTimeout;
        const hopStarted = nowMs();
        try {
          const attempt = ctx.isStreaming
            ? this.#attemptStreaming(
                ctx,
                hop,
                runtime,
                breaker,
                hopKwargs,
                hopStarted,
                hopReadTimeoutSeconds,
                admission,
                failedBreakerProviders,
              )
            : this.#attemptBuffered(
                ctx,
                hop,
                runtime,
                breaker,
                hopKwargs,
                hopStarted,
                hopReadTimeoutSeconds,
                admission,
              );
          return await attempt;
        } catch (error) {
          // A paid buffered response can fail caller-facing normalization after its usage
          // has settled. It is terminal work, not another provider failure or retry.
          if (ctx.bufferedSettlementComplete) throw error;
          lastError = error;
          anyAttemptFailed = true;
          const latencyMs = nowMs() - hopStarted;
          const disposition = classifyException(error);

          // The PRIMARY was attempted and raised in this walk → a later cross-provider success is
          // a REACTIVE failover (primary_error), not a proactive circuit-open reroute (#29).
          if (runtime === ctx.primary) {
            primaryErrored = true;
          }

          // #18: same-provider retry on a 429 whose Retry-After fits the deadline margin.
          // Re-attempt the SAME candidate holding the SAME admission across the sleep — NO breaker
          // verdict and NO error event for the unresolved 429 (#20). After the sleep, RE-CHECK the
          // deadline: a sleep that spent the whole chain budget falls through to normal failover
          // handling; a retry that still fits keeps the call's constant snapshotted read bound.
          // The sleep honours the caller's AbortSignal even when the provider SDK would ignore
          // it, and signal.aborted is re-checked before re-dispatch. An abort is the caller
          // ending the call: the 429 hop is accounted below as an un-retried failure, then the
          // abort is raised in place of advancing, so it can never become a failover.
          if (disposition === Disposition.FAILOVER && retriesRemaining > 0) {
            const delaySeconds = retryAfterSeconds(error);
            if (delaySeconds !== null && retryFitsWithinDeadline(delaySeconds, deadline)) {
              retriesRemaining -= 1;
              const signal = callerAbortSignal(
                ctx.passthroughArgs,
                ctx.callerKwargs,
                ctx.primaryDialect,
              );
              try {
                await abortableDelayMs(delaySeconds * 1000, signal);
                if (signal?.aborted) retryAbort = callerAbortError(signal);
              } catch (abortError) {
                retryAbort = abortError as Error;
              }
              if (retryAbort === undefined && !deadline.expired()) {
                continue;
              }
            }
          }

          // Breaker accounting (#21/#22): FAILOVER and POST_SEND_AMBIGUOUS are provider-health
          // signals (record ONCE per provider per walk); FAIL_FAST is request-shaped and NEVER a
          // signal. A no-verdict exit (FAIL_FAST, or a provider already counted this walk) frees
          // the consumed HALF_OPEN probe slot so the breaker is never stranded (#32).
          if (disposition === Disposition.FAIL_FAST) {
            breaker.releaseProbe(admission);
          } else {
            this.#recordBreakerFailureDedup(
              breaker,
              providerName,
              failedBreakerProviders,
              admission,
            );
          }

          // #20/#25: report ONE error event per NON-retried failed hop — a FAIL_FAST abort, a
          // not-failed-over post-send-ambiguous abort, AND an advancing FAILOVER / PSA-under-
          // "always" hop — BEFORE raising or advancing (Python per-hop telemetry parity; an
          // intermediate 429 that retried above `continue`d out and reports nothing). It carries
          // the FAILED hop's region so a possibly-succeeded abort reconciles at the correct
          // regional price; possibly_succeeded is true ONLY on the not-failed-over PSA abort (#25).
          const possiblySucceeded =
            disposition === Disposition.POST_SEND_AMBIGUOUS &&
            (!ambiguousAllowed || ctx.responsesLeaf === "stream");
          const failedRegion = safeExtractRegion(
            () => runtime.adapter.extractRegion(runtime.sdkClient),
            this.#logger,
          );
          this.#reporter.report(
            this.#buildErrorEvent(
              ctx,
              hop,
              error,
              latencyMs,
              possiblySucceeded ? true : null,
              failedRegion,
            ),
          );

          if (retryAbort !== undefined) {
            // The caller aborted during the Retry-After sleep: end the call, never advance.
            throw retryAbort;
          }
          if (disposition === Disposition.FAIL_FAST) {
            // #26: stop the whole chain, re-raise the IDENTICAL original exception.
            throw error;
          }
          if (possiblySucceeded) {
            // #21/#25: the request MAY have reached the model and idempotency is not asserted —
            // re-raise the ORIGINAL, do NOT advance.
            throw error;
          }
          // Advance: FAILOVER (retry exhausted/none), or POST_SEND_AMBIGUOUS under "always"
          // (#22/#23). Move to the next candidate.
          break;
        }
      }
    }

    // Chain outcome. A terminal failure after ≥1 attempt re-raises the LAST exception (#27); each
    // failed hop ALREADY reported its own error event inside the walk, so there is NO extra
    // terminal report here (Python re-raises `last_exc` without one). If nothing was ever attempted
    // (every admission refused, or the deadline expired before any hop), no candidate could serve.
    if (anyAttemptFailed) {
      throw lastError;
    }
    // Every eligible candidate refused admission (all breakers OPEN mid-walk): no hop was ever
    // dispatched. Report the FULL ordered candidate-name list as `attempted` (Python parity —
    // `[r.adapter.name for r in candidates]`), NOT just the admitted subset.
    throw new ProviderUnavailableError("all providers unavailable", {
      attempted: ctx.surface === "responses" ? [] : candidates.map(providerNameOf),
    });
  }

  /**
   * Build one {@link ProviderCandidate} per configured runtime using ONLY non-mutating
   * breaker reads (`getState()`, read once per runtime), a per-runtime observed p50, and a
   * request-scoped price-hint map (so every candidate in this selection sees a consistent
   * view). Asks the injected policy to order them,
   * then defensively drops any candidate whose `runtime` is not identity-one-of the client's
   * own runtimes (a misbehaving policy cannot inject a foreign runtime), preserving order.
   */
  #selectCandidates(ctx: DispatchContext, runtimes: ProviderRuntime[]): CandidateSelection {
    const consumesLatencySignals = this.#selectionPolicy.consumesLatencySignals ?? true;
    const consumesPriceSignals = this.#selectionPolicy.consumesPriceSignals ?? true;
    const priceHints = consumesPriceSignals ? ctx.priceHints : null;
    const candidates = runtimes.map((runtime) => {
      const snapshot = this.#getCircuitBreaker(runtime.adapter.name).getState();
      const latencyP50 = consumesLatencySignals
        ? this.#latency.observedP50(runtime.adapter.name)
        : null;
      const rawHint = priceHints?.[runtime.adapter.name];
      const priceHint = typeof rawHint === "number" ? rawHint : null;
      return buildCandidate(
        runtime,
        { state: snapshot.state, recoveryEligible: snapshot.recoveryEligible },
        latencyP50,
        priceHint,
      );
    });
    const req: RoutingRequest = {
      requestedProvider: ctx.primaryProvider,
      estimatedInputTokens: ctx.estimatedInputTokens,
    };
    const canonicalByRuntime = new Map(
      candidates.map((candidate) => [candidate.runtime, candidate]),
    );
    const policyOrdered = dropForeignCandidates(
      this.#selectionPolicy.order(candidates, req),
      runtimes,
    );
    const ordered = policyOrdered.flatMap((candidate) => {
      const canonical = canonicalByRuntime.get(candidate.runtime);
      return canonical === undefined ? [] : [canonical];
    });
    if (
      !costPolicyNoHintsWarningEmitted &&
      this.#selectionPolicy instanceof CostPolicy &&
      ctx.priceHints === null
    ) {
      costPolicyNoHintsWarningEmitted = true;
      this.#logger.warn(
        "CostPolicy selected but this budget check carried no price hints; using health-based order",
      );
    }
    const first = ordered[0];
    const primary = ordered.find((candidate) => candidate.runtime === ctx.primary);
    const firstHint = first?.priceHint;
    const primaryHint = primary?.priceHint;
    const costRouted =
      consumesPriceSignals &&
      first !== undefined &&
      first.runtime !== ctx.primary &&
      providerNameOf(first) !== ctx.primaryProvider &&
      primary !== undefined &&
      primary.breakerState === "closed" &&
      first.breakerState === "closed" &&
      typeof firstHint === "number" &&
      (typeof primaryHint !== "number" || firstHint < primaryHint);
    return { candidates: ordered, costRouted };
  }

  /**
   * Count exactly one breaker failure per provider per walk (#21): the FIRST advancing/aborting
   * failure for a provider records it; a subsequent one for the same provider in the same walk
   * is a no-verdict exit, so its consumed HALF_OPEN probe slot is released neutrally (#19).
   */
  #recordBreakerFailureDedup(
    breaker: CircuitBreaker,
    providerName: string,
    failed: Set<string>,
    admission: CircuitBreakerAdmission,
  ): void {
    if (failed.has(providerName)) {
      breaker.releaseProbe(admission);
      return;
    }
    failed.add(providerName);
    breaker.recordFailure(admission);
  }

  /** Successful paid work cannot become a failed provider call or refunded lease authority. */
  #settlePaidCall(event: MetadataEvent, options: BuildConfirmRequestOptions): void {
    try {
      const confirm = this.#budget.buildConfirmRequest(options);
      this.#reporter.reportSettlement(confirm, event);
    } catch {
      this.#budget.consumeUnknownUsage(options.callId, options.leaseClaimToken ?? null);
      this.#safeWarn("budget.confirm_construction_failed: paid usage retained conservatively");
      // Preserve the independent success receipt where its structural metadata is valid.
      try {
        this.#reporter.report(event);
      } catch {
        /* Reporting cannot replace provider success. */
      }
    }
  }

  /** Consume an escaping/non-lease funding boundary without masking its primary outcome. */
  #releaseFunding(callId: string, funding: FundingContext): void {
    if (funding.leaseClaimToken === null) {
      return;
    }
    try {
      this.#budget.releaseReservation(callId, funding.leaseClaimToken);
    } catch {
      // Local capability cleanup is best effort; the original provider/bookkeeping value wins.
    }
  }

  /**
   * Apply one server entitlement synchronously before routing continues. The resolved
   * config object is mutated in place (later readers retain identity), while breakers are
   * retuned only when at least one of the governed eight values actually changes.
   */
  #applyFailoverTuningDirective(allowed: boolean | null): FailoverTuning {
    if (allowed !== null) {
      const target = allowed ? this.#requestedFailoverTuning : FAILOVER_TUNING_DEFAULTS;
      const changed =
        this.#config.failover_total_timeout !== target.failover_total_timeout ||
        this.#config.failover_hop_read_timeout !== target.failover_hop_read_timeout ||
        this.#config.failover_idempotency !== target.failover_idempotency ||
        this.#config.same_provider_retries !== target.same_provider_retries ||
        this.#config.circuit_breaker_recovery_timeout_jitter !==
          target.circuit_breaker_recovery_timeout_jitter ||
        this.#config.circuit_breaker_failure_threshold !==
          target.circuit_breaker_failure_threshold ||
        this.#config.circuit_breaker_recovery_timeout !== target.circuit_breaker_recovery_timeout ||
        this.#config.circuit_breaker_success_threshold !== target.circuit_breaker_success_threshold;

      if (changed) {
        this.#config.failover_total_timeout = target.failover_total_timeout;
        this.#config.failover_hop_read_timeout = target.failover_hop_read_timeout;
        this.#config.failover_idempotency = target.failover_idempotency;
        this.#config.same_provider_retries = target.same_provider_retries;
        this.#config.circuit_breaker_recovery_timeout_jitter =
          target.circuit_breaker_recovery_timeout_jitter;
        this.#config.circuit_breaker_failure_threshold = target.circuit_breaker_failure_threshold;
        this.#config.circuit_breaker_recovery_timeout = target.circuit_breaker_recovery_timeout;
        this.#config.circuit_breaker_success_threshold = target.circuit_breaker_success_threshold;
        this.#breakers.replaceTuning({
          failureThreshold: target.circuit_breaker_failure_threshold,
          recoveryTimeout: target.circuit_breaker_recovery_timeout,
          successThreshold: target.circuit_breaker_success_threshold,
          recoveryTimeoutJitter: target.circuit_breaker_recovery_timeout_jitter,
        });

        if (!allowed && !this.#failoverTuningSuppressionLogged) {
          this.#failoverTuningSuppressionLogged = true;
          this.#safeWarn(
            "Custom failover tuning is unavailable for this plan; SDK defaults applied",
          );
        }
      }
    }

    return Object.freeze({
      totalTimeout: this.#config.failover_total_timeout,
      idempotency: this.#config.failover_idempotency,
      sameProviderRetries: this.#config.same_provider_retries,
      hopReadTimeout: this.#config.failover_hop_read_timeout,
    });
  }

  /** The breaker for a provider name (invariant 5). Lazily created; memoized by name. */
  #getCircuitBreaker(provider: string): CircuitBreaker {
    return this.#breakers.get(provider);
  }

  /**
   * Compute one served hop's attribution (invariant 5 — attribution by NAME): served
   * provider/model, the fallback booleans, the configured-chain `attempt_index` (0 =
   * primary, NOT the walk position), and the SUCCESS-event failover_reason. A primary hop
   * has both fallback flags false and a null failover_reason; a same-provider model swap is
   * `is_model_fallback` (not `is_provider_fallback`); any served provider differing from the
   * primary is `is_provider_fallback` and carries `requested_provider`/`requested_model`.
   */
  #computeHop(
    runtime: ProviderRuntime,
    ctx: DispatchContext,
    primaryErrored: boolean,
    costRouted: boolean,
    runtimes: ProviderRuntime[],
  ): HopAttribution {
    const isPrimary = runtime === ctx.primary;
    const provider = runtime.adapter.name as ProviderName;
    // The primary hop honors a per-call model override; a fallback hop uses its OWN
    // configured model (the caller's model was for the primary, not this entry).
    const model = isPrimary ? ctx.primaryModel : runtime.entry.model;
    const isProviderFallback = provider !== ctx.primaryProvider;
    const isModelFallback = !isPrimary && provider === ctx.primaryProvider;
    const failoverReason: FailoverReason | null = isProviderFallback
      ? primaryErrored
        ? "primary_error"
        : costRouted
          ? "cost_routed"
          : "circuit_open"
      : isModelFallback
        ? "model_fallback"
        : null;
    return {
      provider,
      model,
      crossDialect: runtime.adapter.dialect !== ctx.primaryDialect,
      isModelFallback,
      isProviderFallback,
      // Position in the CONFIGURED chain, not the health-ordered walk (#28).
      attemptIndex: runtimes.indexOf(runtime),
      requestedProvider: isProviderFallback ? ctx.primaryProvider : null,
      requestedModel: isProviderFallback ? ctx.primaryModel : null,
      failoverReason,
    };
  }

  /**
   * Prepare the hop's request bag. A SAME-dialect hop is a native passthrough (primary,
   * same-provider model swap, or same-dialect cross-vendor): global < entry < per-call
   * merge with the served model swapped in; a same-dialect CROSS-vendor hop additionally
   * strips the endpoint-scoped keys and re-authors them from the TARGET entry (behavior 15),
   * never inheriting them from the caller's original endpoint. A CROSS-dialect hop runs the
   * minimal translation subset (`toCanonical` → `fromCanonical`) and FAILS LOUD: an empty
   * target model raises {@link UntranslatableModelError} before translation (behavior 16),
   * a cross-dialect streaming request carrying tools raises before any foreign stream opens
   * (behavior 17), and any structural untranslatability raises `UntranslatableRequestError`
   * (including cross-dialect INTO bedrock, which has no reachable Converse command
   * constructor — D14). None of these are ever swallowed into a retry.
   */
  #prepareHopKwargs(
    runtime: ProviderRuntime,
    hop: HopAttribution,
    ctx: DispatchContext,
  ): Record<string, unknown> {
    if (ctx.surface === "responses") {
      // `callerKwargs` is the already-resolved Responses effective bag. The provider must still
      // receive its own shallow record: an SDK mutating its argument cannot mutate dispatch state.
      return { ...ctx.callerKwargs };
    }
    const servedDialect = runtime.adapter.dialect;
    const targetName = hop.provider;
    const globalDefaults = ctx.requestDefaults.global;
    const entryDefaults = ctx.requestDefaults.entries.get(runtime) ?? {};
    const endpointTransition =
      hop.isProviderFallback || runtime.sdkClient !== ctx.primary.sdkClient;

    if (!endpointTransition) {
      // PRIMARY hop or SAME-PROVIDER model swap — native passthrough (no translation).
      // Fill-absent precedence: per-call kwargs > per-entry default_params > global. The
      // served model determines the cap key. Normalize aliases within each layer before
      // merging, using the same helper as admission — client-base.md #14.
      const needsOutputCapNormalization =
        servedDialect === "openai" &&
        (Object.hasOwn(ctx.callerKwargs, "max_tokens") ||
          Object.hasOwn(ctx.callerKwargs, "max_completion_tokens"));
      if (
        runtime === ctx.primary &&
        !hop.crossDialect &&
        this.#hasNoGlobalDefaultParams &&
        !needsOutputCapNormalization
      ) {
        return { ...ctx.callerKwargs, model: hop.model };
      }
      const normalize = (layer: Record<string, unknown>) =>
        servedDialect === "openai" ? normalizeOpenaiOutputCap(targetName, hop.model, layer) : layer;
      return {
        ...normalize(globalDefaults),
        ...normalize(entryDefaults),
        ...normalize(ctx.callerKwargs),
        model: hop.model,
      };
    }

    // CROSS-PROVIDER hop. Defensive structural guard (#16): the target entry MUST carry a
    // concrete model. An empty/falsy model would otherwise 400 against a healthy provider,
    // burning a chain hop — raise UntranslatableModelError up front (before any network call).
    if (!hop.model) {
      throw new UntranslatableModelError({ model: hop.model, provider: hop.provider });
    }

    if (servedDialect === ctx.primaryDialect) {
      // SAME-DIALECT cross-vendor hop (e.g. Groq → OpenRouter): native passthrough with a
      // model swap. The legacy-key rewrite (`max_completion_tokens` → `max_tokens` for
      // non-OpenAI targets) is applied PER SOURCE LAYER BEFORE the precedence merge — never on
      // the merged dict, or an entry-default cap could silently beat a per-call one (#14).
      const normalized: Record<string, unknown> = {
        ...normalizeOpenaiOutputCap(targetName, hop.model, globalDefaults),
        ...normalizeOpenaiOutputCap(targetName, hop.model, entryDefaults),
        ...normalizeOpenaiOutputCap(targetName, hop.model, ctx.callerKwargs),
      };
      // Endpoint-scoped transport params authored for the ORIGINAL target must not reach a
      // different vendor: strip them, then re-author from the TARGET entry's own defaults (#15).
      const passthrough: Record<string, unknown> = { ...normalized };
      for (const key of ENDPOINT_SCOPED_KEYS) delete passthrough[key];
      for (const key of ENDPOINT_SCOPED_KEYS) {
        if (Object.hasOwn(entryDefaults, key)) {
          passthrough[key] = entryDefaults[key];
        }
      }
      passthrough["model"] = hop.model;
      if (servedDialect === "google") {
        return restoreGoogleTargetTransport(passthrough, entryDefaults);
      }
      return passthrough;
    }

    // CROSS-DIALECT hop → translate via the canonical subset (may FAIL LOUD). Translation
    // seeds from SOURCE-dialect values only: the target entry's default_params may hold
    // target-native keys (e.g. Anthropic `top_k`) illegal on the source dialect, so filter
    // them through the source-dialect allow-list (`_SOURCE_COMPATIBLE_DEFAULT_KEYS`, #45).
    const sourceDefaults = sourceCompatibleDefaults(ctx.primaryDialect, entryDefaults);
    const normalizeSource = (layer: Record<string, unknown>) =>
      ctx.primaryDialect === "openai"
        ? normalizeOpenaiOutputCap(ctx.primaryProvider, ctx.primaryModel, layer)
        : layer;
    const sourceKwargs: Record<string, unknown> = {
      ...normalizeSource(globalDefaults),
      ...normalizeSource(sourceDefaults),
      ...normalizeSource(ctx.callerKwargs),
    };
    const canonical = translation.toCanonical(
      ctx.primaryDialect,
      ctx.primaryDialect === "google" ? withoutGoogleRequestTransport(sourceKwargs) : sourceKwargs,
    );
    if (ctx.isStreaming && Array.isArray(canonical.tools) && canonical.tools.length > 0) {
      // Tool-call deltas are outside the v1 streaming-translation subset (#17).
      translation.failCrossProviderToolStream({
        source: ctx.primaryDialect,
        target: servedDialect,
      });
    }
    // No bedrockCommandConstructor is passed: cross-dialect INTO bedrock has no reachable
    // Converse command class, so `fromCanonical` fails loud (D14). OUT of bedrock (or between
    // the OpenAI/Anthropic/Google dialects) renders a plain kwargs bag. Re-apply the target
    // entry defaults as fill-absent (e.g. Anthropic `max_tokens`) so the target's own
    // required/default fields fill when the caller omitted them on the source dialect.
    const callKwargs = translation.fromCanonical(servedDialect, canonical, hop.model) as Record<
      string,
      unknown
    >;
    const targetKwargs =
      servedDialect === "openai"
        ? {
            ...normalizeOpenaiOutputCap(targetName, hop.model, entryDefaults),
            ...normalizeOpenaiOutputCap(targetName, hop.model, callKwargs),
          }
        : { ...entryDefaults, ...callKwargs };
    if (servedDialect !== "openai") delete targetKwargs["max_completion_tokens"];
    if (servedDialect !== "openai" && servedDialect !== "anthropic")
      delete targetKwargs["max_tokens"];
    return servedDialect === "google"
      ? restoreGoogleTargetTransport(targetKwargs, entryDefaults)
      : targetKwargs;
  }

  /**
   * One buffered hop attempt. On success: credit the breaker + latency window immediately
   * (behavior 25), extract usage (letting a non-null missing-usage estimate win — invariant
   * 6), queue the reservation settlement, and return the response reshaped to the caller's dialect on a
   * cross-dialect hop (behavior 32). On failure: THROW for the walk to classify.
   */
  async #attemptBuffered(
    ctx: DispatchContext,
    hop: HopAttribution,
    runtime: ProviderRuntime,
    breaker: CircuitBreaker,
    hopKwargs: Record<string, unknown>,
    hopStarted: number,
    hopReadTimeoutSeconds: number,
    admission: CircuitBreakerAdmission,
  ): Promise<unknown> {
    const adapter = runtime.adapter;
    const endpointTransition =
      hop.isProviderFallback || runtime.sdkClient !== ctx.primary.sdkClient;
    const response = await this.#invoke(
      ctx.surface,
      ctx.responsesLeaf,
      runtime,
      hopKwargs,
      false,
      endpointTransition
        ? crossProviderRequestOptions(
            ctx.passthroughArgs,
            ctx.callerKwargs,
            ctx.primaryDialect,
            adapter.dialect,
          )
        : ctx.passthroughArgs,
      hopReadTimeoutSeconds,
      endpointTransition,
      { ...ctx.requestDefaults.global, ...ctx.requestDefaults.entries.get(runtime) },
    );
    const latencyMs = nowMs() - hopStarted;
    breaker.recordSuccess(admission);
    this.#latency.recordLatency(hop.provider, latencyMs);

    const usage = extractUsageFailSoft({
      extract: () => adapter.extractUsage(response),
      estimate: () =>
        adapter.estimateMissingUsage(response, {
          estimatedInputTokens: ctx.estimatedInputTokens,
        }),
      estimatedInputTokens: ctx.estimatedInputTokens,
      logger: this.#logger,
      estimateEmptyUsage: ctx.surface === "responses",
    });
    const serviceTier = safeExtractServiceTier(
      () => adapter.extractServiceTier(response),
      this.#logger,
    );
    const region = safeExtractRegion(() => adapter.extractRegion(runtime.sdkClient), this.#logger);

    let normalizedResponse: unknown;
    let normalizationFailure: { error: unknown } | undefined;
    try {
      normalizedResponse = hop.crossDialect
        ? translation.normalizeResponse({
            served: adapter.dialect,
            requested: ctx.primaryDialect,
            response,
          })
        : response;
    } catch (error) {
      // Normalization still precedes confirm/report, but cannot refund provider-measured
      // spend. Report the failed caller outcome with the actual paid usage, then rethrow
      // the structural translation error after once-only settlement ownership is consumed.
      normalizationFailure = { error };
    }
    const event = this.#baseEvent(ctx, hop, {
      status: normalizationFailure === undefined ? "success" : "error",
      inputTokens: usage.tokenDetails.input_tokens,
      outputTokens: usage.tokenDetails.output_tokens,
      tokenDetails: usage.tokenDetails,
      latencyMs,
      serviceTier,
      region,
      failoverErrorClass:
        normalizationFailure === undefined ? null : safeErrorClassName(normalizationFailure.error),
      possiblySucceeded: null,
      velocityFlags: ctx.velocityFlags,
    });
    if (hasSettlementFunding(ctx.funding)) {
      this.#settlePaidCall(event, {
        reservationId: ctx.funding.reservationId,
        leaseId: ctx.funding.leaseId,
        leaseClaimToken: ctx.funding.leaseClaimToken,
        model: hop.model,
        tokenDetails: usage.tokenDetails,
        provider: hop.provider,
        isProviderFallback: hop.isProviderFallback,
        callId: ctx.callId,
        providerRegion: region,
        serviceTier,
        floorAtReservation: usage.usageUnmeasured,
      });
    } else {
      this.#reporter.report(event);
    }
    if (ctx.funding.leaseId === null) {
      this.#releaseFunding(ctx.callId, ctx.funding);
    }
    ctx.bufferedSettlementComplete = true;
    if (normalizationFailure !== undefined) throw normalizationFailure.error;
    return normalizedResponse;
  }

  /**
   * One streaming hop attempt. Establishment (`await` on the streaming dispatch) may throw a
   * PRE-first-chunk failure — that propagates to the walk to fail over (stream-accumulator.md
   * #20). Once established the wrapper is returned and the hop is committed: NEITHER breaker
   * credit nor metadata fires at hop-return; both settle EXACTLY ONCE at stream end
   * (behaviors 25/26). A mid-stream provider error (wrapper already returned) never fails over —
   * it credits one breaker failure and reports the sole possibly_succeeded event (F9). An
   * internal translation failure instead settles observed usage and releases the admission
   * neutrally while preserving the structural error. A
   * cross-dialect served stream is normalized per-chunk via the translation seam (behavior
   * 32); a same-dialect stream is strict passthrough (`chunkTranslator === null`).
   */
  async #attemptStreaming(
    ctx: DispatchContext,
    hop: HopAttribution,
    runtime: ProviderRuntime,
    breaker: CircuitBreaker,
    hopKwargs: Record<string, unknown>,
    hopStarted: number,
    hopReadTimeoutSeconds: number,
    admission: CircuitBreakerAdmission,
    failedBreakerProviders: Set<string>,
  ): Promise<unknown> {
    const adapter = runtime.adapter;
    const endpointTransition =
      hop.isProviderFallback || runtime.sdkClient !== ctx.primary.sdkClient;
    const rawResponse = await this.#invoke(
      ctx.surface,
      ctx.responsesLeaf,
      runtime,
      hopKwargs,
      true,
      endpointTransition
        ? crossProviderRequestOptions(
            ctx.passthroughArgs,
            ctx.callerKwargs,
            ctx.primaryDialect,
            adapter.dialect,
          )
        : ctx.passthroughArgs,
      hopReadTimeoutSeconds,
      endpointTransition,
      { ...ctx.requestDefaults.global, ...ctx.requestDefaults.entries.get(runtime) },
    );
    let cleanupTarget: unknown = rawResponse;
    let terminationHandoff: ProvisionalTerminationHandoff | undefined;
    try {
      const rawSource = adapter.unwrapStreamSource(rawResponse);
      cleanupTarget = rawSource;
      if (!isAsyncIterable(rawSource)) {
        throw new ConfigurationError("streaming call did not return an async iterable", {
          field: null,
        });
      }
      // Retain Google's first-byte boundary and replay its first chunk exactly once.
      // Native @google/genai establishes HTTP before returning its generator; a first-pull
      // failure therefore is NOT itself pre-send proof. The classifier still distinguishes
      // proven connection failures/429s from ambiguous body-read failures conservatively.
      const source: AsyncIterable<unknown> =
        adapter.dialect === "google" ? await materializeStream(rawSource) : rawSource;
      cleanupTarget = source;
      const accumulator = adapter.createStreamAccumulator({
        estimatedInputTokens: ctx.estimatedInputTokens,
        surface: ctx.surface,
      });
      const region = safeExtractRegion(
        () => adapter.extractRegion(runtime.sdkClient),
        this.#logger,
      );
      // The stream callbacks below outlive this frame for as long as the caller holds the
      // stream, so they close over only what settlement reads — never `ctx`, whose caller
      // kwargs, passthrough arguments and request defaults carry the request content.
      const settlement: StreamSettlementContext = {
        surface: ctx.surface,
        callId: ctx.callId,
        run: ctx.run,
        estimatedInputTokens: ctx.estimatedInputTokens,
        velocityFlags: ctx.velocityFlags,
        funding: ctx.funding,
        primaryDialect: ctx.primaryDialect,
      };
      // Cross-dialect: translate each raw served chunk to the caller's dialect (the
      // accumulator still observes the RAW served chunk, so usage settles against what was
      // served). Same-dialect: null → strict passthrough (translator never invoked).
      let translationFailure: { readonly error: unknown } | undefined;
      const chunkTranslator = hop.crossDialect
        ? (rawChunk: unknown): unknown[] => {
            try {
              return translation.translateStreamChunk({
                served: adapter.dialect,
                requested: settlement.primaryDialect,
                chunk: rawChunk,
              });
            } catch (error) {
              // Recognize only this trusted translation seam's exact failure. A provider
              // can throw a public translation-error instance without acquiring this status.
              translationFailure = { error };
              throw error;
            }
          }
        : null;

      terminationHandoff =
        ctx.streamTermination === undefined
          ? undefined
          : new ProvisionalTerminationHandoff(ctx.streamTermination.handle);
      const streamOptions: StreamWrapperOptions = {
        stream: source,
        accumulator,
        startTime: hopStarted,
        onComplete: (tokenDetails, elapsedMs) => {
          try {
            let settledTokenDetails = tokenDetails;
            let usageUnmeasured = tokenDetails.is_estimated;
            if (settlement.surface === "responses") {
              if (tokenDetails.input_tokens === 0 && tokenDetails.output_tokens === 0) {
                settledTokenDetails = buildTokenDetails({
                  input_tokens: settlement.estimatedInputTokens,
                  output_tokens: 0,
                  is_estimated: true,
                });
                usageUnmeasured = true;
              } else if (tokenDetails.is_estimated) {
                usageUnmeasured = true;
              }
            }
            breaker.recordSuccess(admission);
            this.#latency.recordLatency(hop.provider, elapsedMs);
            const serviceTier = safeExtractServiceTier(
              () => accumulator.getServiceTier(),
              this.#logger,
            );
            const event = this.#buildSuccessEvent(settlement, hop, {
              tokenDetails: settledTokenDetails,
              latencyMs: elapsedMs,
              serviceTier,
              region,
            });
            if (hasSettlementFunding(settlement.funding)) {
              // Build the confirm (no I/O) and send it TOGETHER with the event via a SINGLE
              // reportSettlement — the same queue path used by buffered settlement (behavior 26).
              this.#settlePaidCall(event, {
                reservationId: settlement.funding.reservationId,
                leaseId: settlement.funding.leaseId,
                leaseClaimToken: settlement.funding.leaseClaimToken,
                model: hop.model,
                tokenDetails: settledTokenDetails,
                provider: hop.provider,
                isProviderFallback: hop.isProviderFallback,
                callId: settlement.callId,
                providerRegion: region,
                serviceTier,
                ...(settlement.surface === "responses" || usageUnmeasured
                  ? { floorAtReservation: usageUnmeasured }
                  : {}),
              });
            } else {
              this.#reporter.report(event);
            }
            if (settlement.funding.leaseId === null) {
              this.#releaseFunding(settlement.callId, settlement.funding);
            }
          } catch (error) {
            this.#releaseFunding(settlement.callId, settlement.funding);
            throw error;
          }
        },
        onError: (error) => {
          if (translationFailure !== undefined && translationFailure.error === error) {
            translationFailure = undefined;
            // Translation stopped a paid stream after observe(); it is neither a provider
            // outage nor verified native EOF. Consume the admission without a health verdict.
            breaker.releaseProbe(admission);
            const usage = extractUsageFailSoft({
              extract: () => accumulator.finalize(),
              estimate: () => null,
              estimatedInputTokens: settlement.estimatedInputTokens,
              logger: this.#logger,
            });
            const serviceTier = safeExtractServiceTier(
              () => accumulator.getServiceTier(),
              this.#logger,
            );
            const event = this.#baseEvent(settlement, hop, {
              status: "error",
              inputTokens: usage.tokenDetails.input_tokens,
              outputTokens: usage.tokenDetails.output_tokens,
              tokenDetails: usage.tokenDetails,
              latencyMs: nowMs() - hopStarted,
              serviceTier,
              region,
              failoverErrorClass: safeErrorClassName(error),
              possiblySucceeded: null,
              velocityFlags: settlement.velocityFlags,
            });
            if (hasSettlementFunding(settlement.funding)) {
              this.#settlePaidCall(event, {
                reservationId: settlement.funding.reservationId,
                leaseId: settlement.funding.leaseId,
                leaseClaimToken: settlement.funding.leaseClaimToken,
                model: hop.model,
                tokenDetails: usage.tokenDetails,
                provider: hop.provider,
                isProviderFallback: hop.isProviderFallback,
                callId: settlement.callId,
                providerRegion: region,
                serviceTier,
                floorAtReservation: usage.usageUnmeasured,
              });
            } else {
              this.#reporter.report(event);
            }
            if (settlement.funding.leaseId === null)
              this.#releaseFunding(settlement.callId, settlement.funding);
            return;
          }
          try {
            this.#recordBreakerFailureDedup(
              breaker,
              hop.provider,
              failedBreakerProviders,
              admission,
            );
            this.#reporter.report(
              this.#buildStreamErrorEvent(settlement, hop, nowMs() - hopStarted, region),
            );
          } finally {
            this.#releaseFunding(settlement.callId, settlement.funding);
          }
        },
        chunkTranslator,
        logger: this.#logger,
        abortCheck: terminationHandoff?.abortCheck,
        abortRelease: terminationHandoff?.abortRelease,
      };
      const wrapper =
        ctx.responsesLeaf === "stream"
          ? observeResponseStream(rawResponse, streamOptions, (error) => {
              try {
                const disposition = classifyException(error);
                if (disposition === Disposition.FAIL_FAST) breaker.releaseProbe(admission);
                else
                  this.#recordBreakerFailureDedup(
                    breaker,
                    hop.provider,
                    failedBreakerProviders,
                    admission,
                  );
                this.#reporter.report(
                  this.#buildErrorEvent(
                    settlement,
                    hop,
                    error,
                    nowMs() - hopStarted,
                    disposition === Disposition.POST_SEND_AMBIGUOUS ? true : null,
                    region,
                  ),
                );
              } finally {
                this.#releaseFunding(settlement.callId, settlement.funding);
              }
            })
          : wrapStream(streamOptions);
      cleanupTarget = wrapper;
      // The PRIMARY adapter owns the caller-dialect RESULT shape (Python client.py:1139) — a
      // Bedrock-primary stream served cross-dialect by Anthropic must still return the boto3
      // `{ stream, ... }` contract the caller iterates, NOT the served adapter's shape (whose
      // wrapStreamResult may be identity, leaving `.stream` undefined). `unwrapStreamSource`
      // correctly used the SERVED adapter above; only the result wrap is on the primary side. A
      // same-dialect hop makes primary === served, so this is identical to the old behavior.
      const result = ctx.primary.adapter.wrapStreamResult(wrapper, rawResponse);
      terminationHandoff?.commit();
      if (ctx.streamTermination !== undefined) {
        ctx.streamTermination.transferred = true;
      }
      return result;
    } catch (error) {
      terminationHandoff?.discard();
      try {
        if (
          ctx.responsesLeaf === "stream" &&
          rawResponse !== null &&
          typeof rawResponse === "object"
        ) {
          const done = Reflect.get(rawResponse, "done");
          if (typeof done === "function") Promise.resolve(done.call(rawResponse)).catch(() => {});
          const abort = Reflect.get(rawResponse, "abort");
          if (typeof abort === "function") abort.call(rawResponse);
        } else {
          await abortStream(cleanupTarget);
        }
      } catch {
        // Setup cleanup is best effort; preserve the original construction failure.
      }
      throw error;
    }
  }

  /**
   * Native dispatch for a served hop — fully dialect-agnostic. The adapter's
   * {@link ProviderAdapter.prepareCall} seam owns the entire request→wire-call
   * transformation (surface→method selection, streaming kwargs shaping such as
   * `stream_options.include_usage`/`stream: true`, receiver binding, and the per-dialect
   * argument arrangement) and returns a fully-bound callable. The dispatcher only spreads
   * the caller's trailing RequestOptions (signal/headers/timeout/...) into it, forwarded
   * verbatim so a served hop preserves per-request cancellation/headers (F13). This method
   * therefore has ZERO knowledge of any dialect's method shapes — an Anthropic
   * (`messages.create`), Google (`models.generateContent`), or Bedrock (`send(command)`)
   * adapter drops into the same seam without any change here.
   */
  async #invoke(
    surface: InterceptSurface,
    responsesLeaf: "create" | "parse" | "stream" | undefined,
    runtime: ProviderRuntime,
    merged: Record<string, unknown>,
    isStreaming: boolean,
    passthroughArgs: readonly unknown[],
    hopReadTimeoutSeconds: number,
    crossProvider: boolean,
    entryDefaultParams: Record<string, unknown>,
  ): Promise<unknown> {
    if (crossProvider && runtime.adapter.dialect === "google") {
      const signalOptions = passthroughArgs[0];
      if (
        signalOptions !== null &&
        typeof signalOptions === "object" &&
        Object.hasOwn(signalOptions, "abortSignal")
      ) {
        const config = merged["config"];
        merged = {
          ...merged,
          config: {
            ...(config !== null && typeof config === "object" ? config : {}),
            abortSignal: Reflect.get(signalOptions, "abortSignal"),
          },
        };
      }
    }
    const dispatch = runtime.adapter.prepareCall(runtime.sdkClient, merged, {
      surface,
      isStreaming,
      // A hop serving a request authored for a DIFFERENT provider (adapters may sanitize
      // options meant for the original endpoint under this flag; the dispatcher never branches).
      crossProvider,
      // SECONDS — the `PrepareCallOptions.timeout` contract. Every owning adapter converts this
      // immutable per-call provider bound exactly once to its SDK's millisecond carrier.
      timeout: hopReadTimeoutSeconds,
      maxRetries: 0,
      // The fill-absent-layered request defaults for this hop (global config default_params <
      // per-entry default_params). ONLY the Bedrock adapter reads it (D14): its wire command is
      // opaque to the pipeline's merged-kwargs fill-absent result, so it rebuilds a sibling command
      // to honor a model override OR any non-empty default (global or entry). The layered spread is
      // required for Python parity — Python's `_build_hop_kwargs` merges `{**global, **entry}` into
      // the boto3 wire request, so a client-level `defaultParams` (e.g. an `inferenceConfig`
      // maxTokens cap) must reach this seam too, not just entry-level defaults (client-base.md #13;
      // command input still WINS over both). Every other adapter ignores this field (their `merged`
      // bag already carries the fill-absent result).
      entryDefaultParams,
      responsesLeaf,
    });
    return dispatch(...passthroughArgs);
  }

  #buildSuccessEvent(
    ctx: EventContext,
    hop: HopAttribution,
    result: {
      tokenDetails: TokenDetails;
      latencyMs: number;
      serviceTier: string | null;
      region: string | null;
    },
  ): MetadataEvent {
    return this.#baseEvent(ctx, hop, {
      status: "success",
      inputTokens: result.tokenDetails.input_tokens,
      outputTokens: result.tokenDetails.output_tokens,
      tokenDetails: result.tokenDetails,
      latencyMs: result.latencyMs,
      serviceTier: result.serviceTier,
      region: result.region,
      failoverErrorClass: null,
      possiblySucceeded: null,
      velocityFlags: ctx.velocityFlags,
    });
  }

  /**
   * The `budget_denied` metadata event (behavior 5): the pre-flight ESTIMATED input
   * tokens (never 0 unless the prompt is truly empty), `output_tokens = 0`, `latency_ms
   * = 0.0`, no token_details, no service tier, `is_(model|provider)_fallback = false`
   * (a deny never fails over — the primary hop), and the PRIMARY hop's region. Reported
   * best-effort before the client throws — a reporting failure must never mask the typed denial.
   */
  #buildBudgetDeniedEvent(
    ctx: DispatchContext,
    hop: HopAttribution,
    region: string | null,
    budget: Pick<BudgetCheckResult, "denySource" | "denyReason" | "deniedByPeriod">,
    velocityFlags?: readonly VelocityFlag[],
  ): MetadataEvent {
    return this.#baseEvent(ctx, hop, {
      status: "budget_denied",
      inputTokens: ctx.estimatedInputTokens,
      outputTokens: 0,
      tokenDetails: null,
      latencyMs: 0,
      serviceTier: null,
      region,
      failoverErrorClass: null,
      possiblySucceeded: null,
      denySource: budget.denySource,
      denyReason: budget.denyReason,
      deniedByPeriod: budget.deniedByPeriod,
      estimatedOutputBound: ctx.estimatedOutputBound,
      velocityFlags: velocityFlags ?? ctx.velocityFlags,
    });
  }

  /**
   * `buildErrorEvent` = a success event with zeroed tokens, null details, status "error",
   * carrying the FAILED hop's attribution. Reported once per non-retried failed hop: a FAIL_FAST
   * abort, a POST_SEND_AMBIGUOUS-not-allowed abort (`possiblySucceeded = true`), and an advancing
   * FAILOVER / PSA-under-"always" hop (#20). It carries `failover_error_class` (the exception's
   * structural class name), the MEASURED elapsed latency (F17), and the FAILED hop's `region` —
   * on a possibly-succeeded abort that region is what the Cloud API needs to reconcile the
   * possibly-landed, never-confirmed spend at the correct regional price (Bedrock is per-(model,
   * region); Python stamps `provider_region=rt.adapter.extract_region(rt.sdk_client)` here).
   * `possiblySucceeded` is `true` ONLY on the not-failed-over post-send-ambiguous abort (#25).
   */
  #buildErrorEvent(
    ctx: EventContext,
    hop: HopAttribution,
    error: unknown,
    latencyMs: number,
    possiblySucceeded: boolean | null,
    region: string | null,
  ): MetadataEvent {
    return this.#baseEvent(ctx, hop, {
      status: "error",
      inputTokens: 0,
      outputTokens: 0,
      tokenDetails: null,
      latencyMs,
      serviceTier: null,
      region,
      failoverErrorClass: safeErrorClassName(error),
      possiblySucceeded,
    });
  }

  /**
   * Mid-stream error event: the stream established (tokens may have been generated and
   * will be billed by the provider) then dropped in flight. Sets `possibly_succeeded:
   * true` (the sole flag-true case — client-base.md #21) with measured latency and the
   * SERVED hop's region so the Cloud API can reconcile the possibly-landed, never-confirmed
   * spend, and NO `failover_error_class` (mid-stream errors never fail over, so no
   * health-signal class name — matches Python's stream `on_error`, F9).
   */
  #buildStreamErrorEvent(
    ctx: EventContext,
    hop: HopAttribution,
    latencyMs: number,
    region: string | null,
  ): MetadataEvent {
    return this.#baseEvent(ctx, hop, {
      status: "error",
      inputTokens: 0,
      outputTokens: 0,
      tokenDetails: null,
      latencyMs,
      serviceTier: null,
      region,
      failoverErrorClass: null,
      possiblySucceeded: true,
    });
  }

  #baseEvent(
    ctx: EventContext,
    hop: HopAttribution,
    fields: {
      status: MetadataEvent["status"];
      inputTokens: number;
      outputTokens: number;
      tokenDetails: TokenDetails | null;
      latencyMs: number;
      serviceTier: string | null;
      region: string | null;
      failoverErrorClass: string | null;
      possiblySucceeded: boolean | null;
    } & EventReceiptFields,
  ): MetadataEvent {
    const event: MetadataEvent = {
      model: hop.model,
      provider: hop.provider,
      input_tokens: wireTokenQuantity(fields.inputTokens),
      output_tokens: wireTokenQuantity(fields.outputTokens),
      token_details: fields.tokenDetails,
      latency_ms: fields.latencyMs,
      status: fields.status,
      is_model_fallback: hop.isModelFallback,
      is_provider_fallback: hop.isProviderFallback,
      // failover_reason is a SUCCESS-event attribution (reactive vs proactive vs model
      // swap); error/budget_denied events leave it null so the wire serializer omits it.
      failover_reason: fields.status === "success" ? hop.failoverReason : null,
      failover_error_class: fields.failoverErrorClass,
      attempt_index: hop.attemptIndex,
      call_id: ctx.callId,
      service_tier: fields.serviceTier,
      sdk_instance_id: this.#sdkInstanceId,
      timestamp: this.#reporter.nextEventTimestamp(),
      provider_region: fields.region,
    };
    // `requested_provider`/`requested_model` are set ONLY when the served hop is a provider
    // fallback (the originally-requested primary provider/model); absent otherwise.
    if (hop.isProviderFallback) {
      event.requested_provider = hop.requestedProvider;
      event.requested_model = hop.requestedModel;
    }
    // `possibly_succeeded` is set only on the mid-stream abort / not-failed-over post-send
    // ambiguous abort (true); left absent otherwise so the wire serializer omits it entirely
    // (client-base.md #22 — a null is never serialized).
    if (fields.possiblySucceeded !== null) {
      event.possibly_succeeded = fields.possiblySucceeded;
    }
    applyEventReceiptFields(event, fields);
    // agent_run_id / agent_run_name are both-set or both-absent (atomic pair). Omitted
    // entirely (not null) when no run scope was active at call entry.
    this.#applyRunReceipt(event, ctx.run);
    return event;
  }

  /** Build one primary-only media event without widening the chat event builder. */
  #buildMediaEvent(
    ctx: MediaEventContext,
    fields: {
      status: MetadataEvent["status"];
      modality: Modality;
      inputTokens: number;
      outputTokens?: number;
      tokenDetails: TokenDetails | null;
      mediaUsage: MediaUsage | null;
      latencyMs: number;
      failoverErrorClass: string | null;
      serviceTier?: string | null;
    } & EventReceiptFields,
  ): MetadataEvent {
    const event: MetadataEvent = {
      model: ctx.model,
      provider: ctx.provider,
      modality: fields.modality,
      input_tokens: wireTokenQuantity(fields.inputTokens),
      output_tokens: wireTokenQuantity(fields.outputTokens ?? 0),
      token_details: fields.tokenDetails,
      latency_ms: fields.latencyMs,
      status: fields.status,
      is_model_fallback: false,
      is_provider_fallback: false,
      failover_reason: null,
      failover_error_class: fields.failoverErrorClass,
      attempt_index: 0,
      call_id: ctx.callId,
      service_tier: fields.serviceTier ?? null,
      sdk_instance_id: this.#sdkInstanceId,
      timestamp: this.#reporter.nextEventTimestamp(),
      provider_region: ctx.region,
    };
    if (fields.mediaUsage !== null) {
      event.media_usage = fields.mediaUsage;
    }
    applyEventReceiptFields(event, fields);
    this.#applyRunReceipt(event, ctx.run);
    return event;
  }

  /**
   * Flush Solwyn state, then forward provider shutdown. Every caller receives the same
   * promise, including after fulfillment or rejection, so concurrent/repeated close and
   * async disposal are one single-flight sequence.
   */
  close(): Promise<void> {
    // Install the shared promise before cleanup begins. Besides ordinary concurrency, this
    // covers synchronous re-entry from a lifecycle hook or hostile thenable getter.
    this.#closePromise ??= Promise.resolve().then(() => this.#closeOnce());
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    // Settlement telemetry takes precedence over the best-effort advisory channel.
    await this.#reporter.close();
    await this.#untrackedSurfaceReporter?.close();
    await this.#budget.close();

    const client = this.#client;
    if ((typeof client !== "object" || client === null) && typeof client !== "function") {
      return;
    }
    const providerClose = Reflect.get(client, "close", client);
    if (typeof providerClose === "function") {
      await Reflect.apply(providerClose, client, []);
    }
  }

  /** `await using` disposal — delegates to {@link close}. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/**
 * Shared per-call context threaded through the walk + dispatch + event building. Stamped
 * ONCE at call entry (the run snapshot, call_id, deadline, primary attribution, and the
 * idempotent-stripped caller kwargs) and never re-read mid-call.
 */
interface DispatchContext {
  surface: InterceptSurface;
  responsesLeaf?: "create" | "parse" | "stream";
  callId: string;
  run: CallAttribution;
  /** Dispatch-level streaming flag, computed once at entry (client-base.md behavior 13). */
  isStreaming: boolean;
  estimatedInputTokens: number;
  estimatedOutputBound: number;
  readonly velocityFlags: readonly VelocityFlag[];
  /** Server price statement for this request only; never retained across calls. */
  priceHints: Record<string, number> | null;
  /** Immutable process-local settlement/release authority captured from preflight. */
  funding: FundingContext;
  /**
   * Trailing arguments the caller passed after the params bag (OpenAI's
   * `RequestOptions`: `signal`/`headers`/`timeout`/`maxRetries`). Captured before admission;
   * endpoint-scoped options stay on their original provider and cancellation maps to the
   * served SDK's native carrier.
   */
  passthroughArgs: readonly unknown[];
  readonly requestDefaults: {
    readonly global: Record<string, unknown>;
    readonly entries: ReadonlyMap<ProviderRuntime, Record<string, unknown>>;
  };
  /** The caller's per-call kwargs, with `solwynIdempotent` already stripped (never mutated). */
  callerKwargs: Record<string, unknown>;
  /** The configured primary runtime (identity anchor for is-primary / model-swap detection). */
  primary: ProviderRuntime;
  /** The primary's attribution NAME (budget check, is_provider_fallback comparison). */
  primaryProvider: ProviderName;
  /** The primary's resolved model (per-call override ?? primary entry model). */
  primaryModel: string;
  /** The primary's wire dialect (the caller-facing shape a cross-dialect hop reshapes back to). */
  primaryDialect: Dialect;
  /** Monotonic window for preflight, Retry-After sleeps, and between-hop advancement. */
  deadline: Deadline;
  /** Frozen server-governed values captured immediately after this call's budget result. */
  tuning: FailoverTuning;
  /** One logical active-stream handle, acquired once immediately before the walk. */
  streamTermination?: StreamTerminationOwner;
  /** A paid buffered outcome already owns its measured or conservatively retained settlement. */
  bufferedSettlementComplete?: boolean;
}

/** The fields event building reads from a {@link DispatchContext}. */
type EventContext = Pick<DispatchContext, "callId" | "run" | "velocityFlags">;

/**
 * What a returned stream's settlement callbacks may retain from its {@link DispatchContext}:
 * estimates, funding, call identity, surface and the primary dialect, but no request content.
 */
type StreamSettlementContext = EventContext &
  Pick<DispatchContext, "surface" | "estimatedInputTokens" | "funding" | "primaryDialect">;

interface AdmissionContext {
  readonly callId: string;
  readonly run: AttributionSnapshot | undefined;
  readonly primary: ProviderRuntime;
  readonly provider: ProviderName;
  readonly model: string;
  readonly inputTokens: number;
  readonly estimatedOutputBound: number | null;
  readonly modality: Modality | undefined;
  readonly estimatedMedia: MediaUsage | null;
}

interface RunControlPrecheck {
  readonly flags: readonly VelocityFlag[];
  readonly pendingLocalReason: VelocityFlag | null;
}

interface StreamTerminationOwner {
  readonly handle: TerminationHandle;
  transferred: boolean;
}

/** Internal policy-order result plus server/runtime-derived success attribution. */
interface CandidateSelection {
  readonly candidates: ProviderCandidate[];
  readonly costRouted: boolean;
}

interface FundingContext {
  readonly reservationId: string | null;
  readonly leaseId: string | null;
  readonly leaseClaimToken: number | null;
}

/** Content-free attribution shared by one media call's confirm/event settlement. */
interface MediaEventContext {
  callId: string;
  model: string;
  provider: ProviderName;
  region: string | null;
  run: CallAttribution;
}

/**
 * One served (or candidate) hop's attribution, computed per hop (invariant 5 — attribution
 * by NAME). Drives the metadata event / budget confirm fallback fields and the SUCCESS-event
 * failover_reason. Carries no content — provider/model names and structural flags only.
 */
interface HopAttribution {
  /** Served provider NAME (attribution axis). */
  provider: ProviderName;
  /** Served model (primary honors a per-call override; a fallback uses its own entry model). */
  model: string;
  /** Whether the served dialect differs from the caller's (drives request/response translation). */
  crossDialect: boolean;
  /** Same-provider model swap (not primary, same provider name). */
  isModelFallback: boolean;
  /** Served provider differs from the primary (regardless of dialect). */
  isProviderFallback: boolean;
  /** Position in the CONFIGURED chain (0 = primary), NOT the health-ordered walk position. */
  attemptIndex: number;
  /** The originally-requested primary provider — only set when `isProviderFallback`. */
  requestedProvider: ProviderName | null;
  /** The originally-requested primary model — only set when `isProviderFallback`. */
  requestedModel: string | null;
  /** SUCCESS-event failover reason (reactive `primary_error` / proactive `circuit_open` / `model_fallback`). */
  failoverReason: FailoverReason | null;
}

/**
 * Attempt-local ownership bridge. Wrapper cleanup may run while result shaping is still
 * provisional; defer that release until commit, and ignore it completely after discard.
 */
class ProvisionalTerminationHandoff {
  readonly #handle: TerminationHandle;
  #state: "pending" | "committed" | "discarded" = "pending";
  #releaseRequested = false;
  #released = false;

  constructor(handle: TerminationHandle) {
    this.#handle = handle;
  }

  readonly abortCheck = (): Error | undefined => {
    const termination = this.#handle.check();
    return termination === undefined
      ? undefined
      : new RunStoppedError({
          agentRunId: this.#handle.runId,
          reason: termination.reason,
          source: termination.source,
        });
  };

  readonly abortRelease = (): void => {
    if (this.#state === "discarded" || this.#released) return;
    if (this.#state === "pending") {
      this.#releaseRequested = true;
      return;
    }
    this.#release();
  };

  commit(): void {
    if (this.#state !== "pending") return;
    this.#state = "committed";
    if (this.#releaseRequested) this.#release();
  }

  discard(): void {
    if (this.#state === "pending") this.#state = "discarded";
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#handle.release();
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

/**
 * A first-chunk-materialized stream that owns the ORIGINAL provider generator. Iterating
 * it replays the buffered first chunk, then drains the SAME already-advanced iterator — so
 * the wrapper observes + yields every chunk EXACTLY ONCE (no double-emit). `aclose()`
 * forwards cleanup to the ORIGINAL source (not to this splice object), so abandoning a
 * materialized stream still releases the real provider connection exactly once — the
 * {@link StreamWrapper}'s close-forwarding reaches THIS object's `aclose`. Ports
 * `client.py::_MaterializedAsyncStream`.
 *
 * The buffered first chunk is owned only until it is handed out: the generator yields it
 * through {@link MaterializedAsyncStream.#takeFirst} (never via a local, which the
 * suspended generator frame would keep alive mid-stream), and `aclose()` drops it when
 * the stream is closed before its first iteration, so a held handle never keeps the
 * delivered or undelivered chunk reachable.
 */
class MaterializedAsyncStream implements AsyncIterable<unknown> {
  #first: unknown;
  #firstPending: boolean;
  readonly #original: unknown;
  readonly #iterator: AsyncIterator<unknown>;
  #closed = false;

  constructor(first: unknown, original: unknown, iterator: AsyncIterator<unknown>, empty: boolean) {
    this.#first = first;
    this.#firstPending = !empty;
    this.#original = original;
    this.#iterator = iterator;
  }

  /** Hand out the buffered first chunk exactly once and release this object's reference. */
  #takeFirst(): unknown {
    const first = this.#first;
    this.#first = undefined;
    this.#firstPending = false;
    return first;
  }

  #dropFirst(): void {
    this.#first = undefined;
    this.#firstPending = false;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    if (!this.#firstPending) {
      return;
    }
    yield this.#takeFirst();
    // Drain the REMAINING items from the iterator already advanced by one in
    // `materializeStream` — never re-iterate the source (that would re-establish / double-emit).
    while (true) {
      const next = await this.#iterator.next();
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }

  /** Close the already-open native iterator once; legacy adapters fall back to source close. */
  async aclose(): Promise<void> {
    this.#dropFirst();
    if (this.#closed) return;
    this.#closed = true;
    if (typeof this.#iterator.return === "function") {
      await this.#iterator.return();
      return;
    }
    const original = this.#original;
    if (typeof original !== "object" || original === null) {
      return;
    }
    const aclose = (original as { aclose?: unknown }).aclose;
    if (typeof aclose === "function") {
      await (aclose as () => unknown).call(original);
      return;
    }
    const close = (original as { close?: unknown }).close;
    if (typeof close === "function") {
      await (close as () => unknown).call(original);
    }
  }
}

/**
 * Google-only first-chunk materialization. The first chunk is replayed once, and cleanup
 * retains the exact iterator advanced here. Native Google HTTP is already established at
 * this point; classification must use positive failure evidence, never first-pull timing.
 * Other native dialects retain their ordinary stream-entry boundary. Ports the replay and
 * ownership semantics of `client.py::_materialize_stream_async` to native JS generators.
 */
async function materializeStream(source: AsyncIterable<unknown>): Promise<MaterializedAsyncStream> {
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done === true) {
    return new MaterializedAsyncStream(undefined, source, iterator, true);
  }
  return new MaterializedAsyncStream(first.value, source, iterator, false);
}
