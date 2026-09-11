/**
 * @solwyn/sdk — Solwyn TypeScript SDK.
 *
 * Edge-safe core entry point: web-standard APIs only (fetch, AbortController,
 * crypto.randomUUID, web streams). Node-only conveniences (the `run(...)` scope
 * built on `AsyncLocalStorage`) live in `@solwyn/sdk/node` and are NOT re-exported
 * here — importing this entry must never pull in `node:*`.
 */

export const VERSION = "0.1.0-rc.1";

// Budget enforcement surface (pre-flight check + sans-I/O settlement builder).
export {
  type BudgetCheckResult,
  BudgetEnforcer,
  type BudgetEnforcerOptions,
  type BuildConfirmRequestOptions,
  budgetCheckResult,
  buildBudgetExceededError,
  buildBudgetExceededErrorFromResult,
  type CheckBudgetOptions,
  DEFAULT_COST_PER_TOKEN,
} from "./budget";
// Circuit-breaker surface (per-provider health; state inspection).
export {
  CircuitBreaker,
  CircuitBreakerAdmission,
  CircuitBreakerManager,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
} from "./circuit-breaker";
export type { FallbackEntry, InterceptSurface, SolwynOptions } from "./client";
// Configuration surface.
export {
  DEFAULT_API_URL,
  type FailoverIdempotency,
  type ProviderEntryInput,
  resolveConfig,
  type SolwynConfig,
  type SolwynConfigOptions,
  validateProviderChain,
} from "./config";
export type {
  CoverageAuditEntry,
  CoverageEntry,
  CoverageExpectation,
  CoverageFingerprint,
  CoverageReport,
  CoverageRuntime,
} from "./coverage";
// Local provider-surface coverage.
export { coverage } from "./coverage";
// Typed error hierarchy.
export {
  BudgetExceededError,
  ConfigurationError,
  CoverageMismatchError,
  ProviderUnavailableError,
  RunStoppedError,
  type RunStoppedErrorOptions,
  type RunStoppedSource,
  SolwynError,
  UnsupportedSurfaceError,
  UntrackedSpendSurfaceError,
  UntranslatableModelError,
  UntranslatableRequestError,
} from "./errors";
// Logger abstraction (D6).
export { consoleLogger, type Logger, noopLogger } from "./logging";
// The drop-in client + its public options.
export { Solwyn, type SolwynConstructor } from "./proxies";
// Routing / failover public surface: the injectable SelectionPolicy protocol + the three
// drop-in policies (the constructor's `selectionPolicy` seam), the candidate/request shapes,
// the chain deadline, and the transport-exception classifier the dispatch walk consumes.
export {
  budgetCheckTimeout,
  CostPolicy,
  classifyException,
  Deadline,
  Disposition,
  HealthBasedPolicy,
  hopTimeout,
  type IdempotencyMode,
  LatencyPolicy,
  type ProviderCandidate,
  type RoutingRequest,
  RoutingRequestSchema,
  retryAfterSeconds,
  type SelectionPolicy,
} from "./routing";
// Run-context reader (edge-safe; always "no run" until `@solwyn/sdk/node` is imported).
export { type CurrentRun, getCurrentRun } from "./run-context";
// Process-wide run-termination registry (edge-safe exact-ID state).
export {
  clearRunTermination,
  currentRunTerminated,
  RunTermination,
  runTermination,
} from "./run-control";
export { SurfaceInspectionError } from "./surface-graph";
export { TAG_KEY_MAX_LENGTH, TAG_VALUE_MAX_LENGTH, TAGS_MAX_KEYS } from "./tags";
// Token-usage struct + helpers.
export {
  createTokenDetails,
  serializeTokenDetails,
  type TokenDetails,
  totalTokens,
  zeroTokenDetails,
} from "./token-details";
// Caller-owned control-plane transport seam (type-only; no extra runtime abstraction).
export type { FetchLike } from "./transport";
export { LEASE_GRANT_PATH, LEASE_RENEW_PATH, LEASE_SURRENDER_PATH } from "./transport";
// Wire-model interfaces + enums (snake_case fields).
export type {
  BudgetCheckRequest,
  BudgetCheckResponse,
  BudgetConfirmRequest,
  BudgetMode,
  CallStatus,
  CircuitState,
  DenySource,
  FailoverDirective,
  FailoverReason,
  LeaseGrantRequest,
  LeaseGrantResponse,
  LeasePosture,
  LeaseRenewRequest,
  LeaseSurrenderRequest,
  LeaseSurrenderResponse,
  MediaUsage,
  MetadataEvent,
  Modality,
  ProviderEntry,
  ProviderName,
  RunControlDirective,
  ServiceTier,
  VelocityFlag,
} from "./types";
export { BUDGET_MODES, CALL_STATUSES, CIRCUIT_STATES, MODALITIES, PROVIDER_NAMES } from "./types";
export {
  LeaseGrantRequestObjectSchema,
  LeaseGrantRequestSchema,
  LeaseGrantResponseSchema,
  LeasePostureSchema,
  LeaseRenewRequestObjectSchema,
  LeaseRenewRequestSchema,
  LeaseSurrenderRequestObjectSchema,
  LeaseSurrenderRequestSchema,
  LeaseSurrenderResponseSchema,
} from "./validation";
