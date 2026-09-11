/**
 * Wire-format enums, constants, and TypeScript interfaces shared between the SDK
 * and the Solwyn Cloud API.
 *
 * Field names on the wire stay snake_case (these objects are serialized directly
 * as JSON request/response bodies). Enums are modeled as `const` value arrays plus
 * string-literal union types so they compare `===` against plain JSON strings.
 *
 * Ported from `solwyn/_types.py` + `solwyn/_constants.py`. The zod schemas that
 * validate these shapes live in `validation.ts`; the exceptions in `errors.ts`.
 */

import type { TokenDetails } from "./token-details";

// ---------------------------------------------------------------------------
// Enums (string-valued) — exact wire values.
// ---------------------------------------------------------------------------

/**
 * Supported LLM provider identifiers. The first four are native API dialects; the
 * remaining providers are OpenAI-compatible (Chat Completions dialect) but remain distinct
 * `name` values for attribution / budgets / circuit breaking. `openai_compatible`
 * is the generic catch-all for unrecognized OpenAI-compatible endpoints.
 */
export const PROVIDER_NAMES = [
  "openai",
  "anthropic",
  "google",
  "bedrock",
  "xai",
  "deepseek",
  "mistral",
  "qwen",
  "groq",
  "together",
  "fireworks",
  "perplexity",
  "azure_openai",
  "openrouter",
  "zai",
  "ollama",
  "vllm",
  "lmstudio",
  "openai_compatible",
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Billing/usage modality for one model call. */
export const MODALITIES = ["text", "image", "audio", "video", "embedding"] as const;
export type Modality = (typeof MODALITIES)[number];

/** How the SDK reacts when a budget limit is reached. */
export const BUDGET_MODES = ["alert_only", "hard_deny"] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];

/** Circuit-breaker states. */
export const CIRCUIT_STATES = ["closed", "open", "half_open"] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

/** SDK client families accepted by the content-free untracked-surface endpoint. */
export const UNTRACKED_CLIENT_SHAPES = [
  "openai_sdk",
  "native_together",
  "anthropic_sdk",
  "google_generativeai",
  "google_genai",
  "bedrock_boto3",
  "bedrock_aioboto3",
] as const;
export type UntrackedClientShape = (typeof UNTRACKED_CLIENT_SHAPES)[number];

export const UNTRACKED_CLIENT_MODES = ["sync", "async"] as const;
export type UntrackedClientMode = (typeof UNTRACKED_CLIENT_MODES)[number];

export const UNTRACKED_RULE_KINDS = ["unmetered_spend", "unknown"] as const;
export type UntrackedRuleKind = (typeof UNTRACKED_RULE_KINDS)[number];

export const UNTRACKED_CAPABILITY_SCOPES = [
  "operation",
  "client",
  "resource",
  "raw_response",
  "arbitrary_endpoint",
] as const;
export type UntrackedCapabilityScope = (typeof UNTRACKED_CAPABILITY_SCOPES)[number];

export const UNTRACKED_POSTURES = ["warn", "allow"] as const;
export type UntrackedPosture = (typeof UNTRACKED_POSTURES)[number];

/** Outcome status for LLM call metadata events. */
export const CALL_STATUSES = ["success", "error", "budget_denied"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/** Why the router advanced past the requested primary target. */
export const FAILOVER_REASONS = [
  "circuit_open",
  "primary_error",
  "model_fallback",
  "cost_routed",
] as const;
export type FailoverReason = (typeof FAILOVER_REASONS)[number];

/**
 * Value-strict service tier — used ONLY by `BudgetConfirmRequest.service_tier`
 * (it settles a tier-repriced budget rate). `MetadataEvent.service_tier` is instead
 * a free-form bounded string, NOT this closed set.
 */
export const SERVICE_TIERS = [
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
  "standard",
  "optimized",
] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/** Closed enum of per-event ingest rejection codes. */
export const INGEST_REJECTION_CODES = [
  "unknown_model",
  "unknown_service_tier",
  "invalid_tags",
  "tag_cardinality_exceeded",
  "unsupported_modality",
] as const;
export type IngestRejectionCode = (typeof INGEST_REJECTION_CODES)[number];

// ---------------------------------------------------------------------------
// Constants (exact values from `_constants.py` / D1).
// ---------------------------------------------------------------------------

/** Max model-name length — sized for a full Bedrock Converse `modelId` ARN. */
export const MODEL_NAME_MAX_LENGTH = 2048;
/** Max `agent_run_id` length. */
export const AGENT_RUN_ID_MAX_LENGTH = 256;
/** Max `agent_run_name` length. */
export const AGENT_RUN_NAME_MAX_LENGTH = 255;
/** Max `provider_region` length. */
export const PROVIDER_REGION_MAX_LENGTH = 32;
/** Max `service_tier` (telemetry, free-form) length. */
export const SERVICE_TIER_MAX_LENGTH = 32;
/** Max `failover_error_class` length (hardcoded inline in `_types.py`). */
export const FAILOVER_ERROR_CLASS_MAX_LENGTH = 64;
/** Max `call_id` length (D1) — a `crypto.randomUUID()` is exactly 36 chars. */
export const CALL_ID_MAX_LENGTH = 36;
/** Max `fallback_models` / `fallback_providers` list length. */
export const FALLBACK_MAX_ITEMS = 8;

/**
 * Privacy guard for `failover_error_class`: admits `type(exc).__name__`-shaped
 * class names but rejects leaked message bodies (spaces, punctuation, etc.). (D1)
 */
export const FAILOVER_ERROR_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*$/;

/** Public copy project-ID format: `proj_` + 24 lowercase hex. */
export const PROJECT_ID_PATTERN = /^proj_[a-f0-9]{24}$/;
/** Project API-key format: `sk_proj_` + 64 lowercase hex. */
export const PROJECT_KEY_PATTERN = /^sk_proj_[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Wire-model interfaces (snake_case fields; parsed/post-default shape).
// ---------------------------------------------------------------------------

/**
 * A configured provider+model routing entry. Deliberately has NO `api_key` /
 * `base_url` field — Solwyn never accepts, stores, or logs a provider credential.
 */
export interface ProviderEntry {
  provider: ProviderName;
  model: string;
  default_params: Record<string, unknown>;
}

/** Observable non-text billing quantities for one call. */
export interface MediaUsage {
  image_count?: number | null;
  generation_count?: number | null;
  video_seconds?: number | null;
  audio_seconds?: number | null;
  input_characters?: number | null;
  resolution?: string | null;
  quality?: string | null;
  is_estimated?: boolean;
}

/** Versioned server policy for SDK-managed provider failover. */
export interface FailoverDirective {
  version: "1";
  failover_tuning_allowed: boolean;
}

/** Versioned server instruction to terminate an agent run. */
export interface RunControlDirective {
  version: "1";
  action: "terminate";
  agent_run_id: string;
  reason: string;
}

export const DENY_SOURCES = [
  "server",
  "sticky_replay",
  "local_enforcement",
  "lease_exhausted",
  "local_velocity",
  "run_terminated",
  "aggregate_replay",
] as const;
export type DenySource = (typeof DENY_SOURCES)[number];

export const VELOCITY_FLAGS = ["repeat_size", "monotonic_growth", "rate_acceleration"] as const;
export type VelocityFlag = (typeof VELOCITY_FLAGS)[number];

/** Telemetry event sent after each LLM call to `POST /api/v1/metadata/ingest`. */
export interface MetadataEvent {
  model: string;
  provider: ProviderName;
  modality?: Modality;
  input_tokens: number;
  output_tokens: number;
  token_details?: TokenDetails | null;
  media_usage?: MediaUsage | null;
  latency_ms: number;
  status: CallStatus;
  is_model_fallback: boolean;
  is_provider_fallback: boolean;
  requested_provider?: ProviderName | null;
  requested_model?: string | null;
  failover_reason?: FailoverReason | null;
  failover_error_class?: string | null;
  attempt_index: number;
  call_id: string;
  possibly_succeeded?: boolean | null;
  service_tier?: string | null;
  sdk_instance_id: string;
  timestamp: string;
  agent_run_id?: string | null;
  parent_agent_run_id?: string | null;
  agent_run_name?: string | null;
  provider_region?: string | null;
  tags?: Record<string, string> | null;
  deny_source?: DenySource | null;
  deny_reason?: string | null;
  denied_by_period?: string | null;
  estimated_output_bound?: number | null;
  velocity_flags?: VelocityFlag[] | null;
  receipt_aggregate_count?: number | null;
  receipt_pricing_input_tokens?: number | null;
}

/** Pre-flight budget check sent to `POST /api/v1/budgets/check`. */
export interface BudgetCheckRequest {
  estimated_input_tokens: number;
  estimated_media?: MediaUsage | null;
  model: string;
  provider: ProviderName;
  modality?: Modality;
  fallback_providers?: ProviderName[];
  fallback_models?: string[];
  agent_run_id?: string | null;
  tags?: Record<string, string> | null;
  failover_directive_version?: "1" | null;
  price_hints_version?: "1" | null;
  run_directive_version?: "1" | null;
}

/** API response to a budget check. Inbound (parse-only) — no None-skipping. */
export interface BudgetCheckResponse {
  allowed: boolean;
  remaining_budget: number;
  reservation_id?: string | null;
  mode: BudgetMode;
  budget_limit: number;
  current_usage: number;
  denied_by_period?: string | null;
  project_id: string;
  price_hints?: Record<string, number> | null;
  failover_directive?: FailoverDirective | null;
  run_control?: RunControlDirective | null;
}

/** Post-call confirmation sent to `POST /api/v1/budgets/confirm`. */
export interface BudgetConfirmRequest {
  reservation_id?: string | null;
  lease_id?: string | null;
  model: string;
  provider: ProviderName;
  modality?: Modality;
  is_provider_fallback: boolean;
  call_id: string;
  token_details: TokenDetails;
  media_usage?: MediaUsage | null;
  provider_region?: string | null;
  service_tier?: ServiceTier | null;
}

/** Request a token lease for an agent run. */
export interface LeaseGrantRequest {
  agent_run_id: string;
  holder_id: string;
  model: string;
  provider: ProviderName;
  fallback_providers?: ProviderName[];
  fallback_models?: string[];
  fail_open?: boolean;
  estimated_input_tokens?: number;
  run_directive_version?: "1" | null;
}

/** Lease outage posture returned as part of a successful grant. */
export interface LeasePosture {
  mode: BudgetMode;
  on_unreachable: "fail_open" | "local_enforce";
}

/** Grant and renewal response. Lease fields are absent for ineligible and deny verdicts. */
export interface LeaseGrantResponse {
  eligible: boolean;
  ineligible_reason?: string | null;
  allowed: boolean;
  denied_by_period?: string | null;
  run_control?: RunControlDirective | null;
  lease_id?: string | null;
  generation?: number | null;
  granted_tokens?: number | null;
  refresh_interval_s?: number | null;
  lease_length_s?: number | null;
  headroom_share_tokens?: number | null;
  posture?: LeasePosture | null;
  final_grant?: boolean | null;
  project_id: string;
  mode: BudgetMode;
  budget_limit: number;
  current_usage: number;
  remaining_budget: number;
}

/** Acknowledge a lease grant and report its drawdown before requesting a successor. */
export interface LeaseRenewRequest {
  lease_id: string;
  holder_id: string;
  generation: number;
  spent_tokens?: number;
  reserved_tokens?: number;
  uncounted_calls?: number;
  uncounted_tokens?: number;
  model?: string | null;
  provider?: ProviderName | null;
  fallback_providers?: ProviderName[];
  fallback_models?: string[];
  run_directive_version?: "1" | null;
}

/** Release a lease's outstanding float during shutdown. */
export interface LeaseSurrenderRequest {
  lease_id: string;
  holder_id: string;
  generation: number;
  spent_tokens?: number;
}

/** Server acknowledgement of a lease surrender. */
export interface LeaseSurrenderResponse {
  released_tokens: number;
}

/** 202 body for metadata ingest: per-event dispositions. */
export interface IngestResponse {
  ingested: number;
  rejected: IngestRejection[];
}

/** Per-event rejection disposition returned in the 202 ingest body. */
export interface IngestRejection {
  index: number;
  code: IngestRejectionCode;
  model: string;
  message: string;
}

/** 429 body for metadata ingest. */
export interface RateLimitErrorResponse {
  detail: string;
  retry_after: number;
}

/** Content-free SDK observation for a provider surface Solwyn does not meter. */
export interface UntrackedSurfaceReport {
  provider: ProviderName;
  client_shape: UntrackedClientShape;
  mode: UntrackedClientMode;
  surface: string;
  rule_kind: UntrackedRuleKind;
  capability_scope?: UntrackedCapabilityScope | null;
  posture: UntrackedPosture;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  sdk_instance_id: string;
  report_id: string;
}

/** Receipt for one accepted untracked-surface batch. */
export interface UntrackedSurfaceAccepted {
  accepted: number;
}

/** One SDK instance's content-free provider breaker snapshot. */
export interface BreakerStateReport {
  provider: ProviderName;
  state: CircuitState;
  failure_count: number;
  success_count: number;
  reported_at: string;
  sdk_instance_id: string;
}

/** OpenAPI-named response for an accepted breaker snapshot. */
export interface BreakerReportAccepted {
  accepted?: boolean;
}
