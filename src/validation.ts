/**
 * Zod 4 strict schemas for every wire model, plus the credential/project-ID
 * validators and the wire-serialization helpers.
 *
 * Requests are validated before send; responses are validated on receipt. Every
 * object schema is `z.strictObject` (extra keys rejected — `extra="forbid"` parity).
 * Response schemas declare every returned field: required unless the spec marks it
 * optional (`.nullable().optional()`).
 *
 * D1 constraints applied: `denied_by_period` optional; `call_id` maxLength 36;
 * TokenDetails bounds 0..100_000_000 (in `token-details.ts`); `failover_error_class`
 * pattern. D7: `price_hints` keys are unrestricted strings. Ported from
 * `solwyn/_types.py` + `solwyn/_validation.py`; cross-checked against
 * the checked-in OpenAPI contract snapshot.
 */

import { z } from "zod";
import { ConfigurationError } from "./errors";
import { copyTags } from "./tags";
import { serializeTokenDetails, TokenDetailsSchema } from "./token-details";
import {
  AGENT_RUN_ID_MAX_LENGTH,
  AGENT_RUN_NAME_MAX_LENGTH,
  BUDGET_MODES,
  type BudgetConfirmRequest,
  CALL_ID_MAX_LENGTH,
  CALL_STATUSES,
  CIRCUIT_STATES,
  DENY_SOURCES,
  FAILOVER_ERROR_CLASS_MAX_LENGTH,
  FAILOVER_ERROR_CLASS_PATTERN,
  FAILOVER_REASONS,
  FALLBACK_MAX_ITEMS,
  INGEST_REJECTION_CODES,
  type LeaseGrantRequest,
  type LeaseRenewRequest,
  type LeaseSurrenderRequest,
  type MetadataEvent,
  MODALITIES,
  MODEL_NAME_MAX_LENGTH,
  PROJECT_ID_PATTERN,
  PROJECT_KEY_PATTERN,
  PROVIDER_NAMES,
  PROVIDER_REGION_MAX_LENGTH,
  SERVICE_TIER_MAX_LENGTH,
  SERVICE_TIERS,
  UNTRACKED_CAPABILITY_SCOPES,
  UNTRACKED_CLIENT_MODES,
  UNTRACKED_CLIENT_SHAPES,
  UNTRACKED_POSTURES,
  UNTRACKED_RULE_KINDS,
  VELOCITY_FLAGS,
} from "./types";

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TagsSchema = z.unknown().transform((value, context): Record<string, string> => {
  try {
    return copyTags(value, "tags") ?? Object.fromEntries<string>([]);
  } catch {
    context.addIssue({
      code: "invalid_type",
      expected: "record",
      message: "Invalid input: expected record",
    });
    return z.NEVER;
  }
});

// ---------------------------------------------------------------------------
// Enum schemas.
// ---------------------------------------------------------------------------

export const ProviderNameSchema = z.enum(PROVIDER_NAMES);
export const BudgetModeSchema = z.enum(BUDGET_MODES);
export const CallStatusSchema = z.enum(CALL_STATUSES);
export const CircuitStateSchema = z.enum(CIRCUIT_STATES);
export const FailoverReasonSchema = z.enum(FAILOVER_REASONS);
export const IngestRejectionCodeSchema = z.enum(INGEST_REJECTION_CODES);
export const ModalitySchema = z.enum(MODALITIES);
/** Value-strict service tier (BudgetConfirmRequest only). */
export const ServiceTierSchema = z.enum(SERVICE_TIERS);

// ---------------------------------------------------------------------------
// ProviderEntry.
// ---------------------------------------------------------------------------

/**
 * Strict ProviderEntry schema. No `api_key`/`base_url` key ever. `default_params`
 * uses a function-form default so each parsed instance gets a fresh `{}` (never a
 * shared object reference).
 */
export const ProviderEntrySchema = z.strictObject({
  provider: ProviderNameSchema,
  model: z.string().max(MODEL_NAME_MAX_LENGTH),
  default_params: z.record(z.string(), z.unknown()).default(() => ({})),
});

// ---------------------------------------------------------------------------
// MediaUsage.
// ---------------------------------------------------------------------------

export const MediaUsageSchema = z.strictObject({
  image_count: z.number().int().min(0).max(100_000_000).nullable().optional(),
  generation_count: z.number().int().min(0).max(100_000_000).nullable().optional(),
  video_seconds: z.number().min(0).max(100_000_000).nullable().optional(),
  audio_seconds: z.number().min(0).max(100_000_000).nullable().optional(),
  input_characters: z.number().int().min(0).max(100_000_000).nullable().optional(),
  resolution: z.string().max(32).nullable().optional(),
  quality: z.string().max(32).nullable().optional(),
  is_estimated: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// MetadataEvent.
// ---------------------------------------------------------------------------

export const MetadataEventSchema = z
  .strictObject({
    model: z.string().max(MODEL_NAME_MAX_LENGTH),
    provider: ProviderNameSchema,
    modality: ModalitySchema.default("text"),
    input_tokens: z.number().int().min(0).max(100_000_000),
    output_tokens: z.number().int().min(0).max(100_000_000),
    token_details: TokenDetailsSchema.nullable().optional(),
    media_usage: MediaUsageSchema.nullable().optional(),
    latency_ms: z.number(),
    status: CallStatusSchema,
    is_model_fallback: z.boolean(),
    is_provider_fallback: z.boolean().default(false),
    requested_provider: ProviderNameSchema.nullable().optional(),
    requested_model: z.string().max(MODEL_NAME_MAX_LENGTH).nullable().optional(),
    failover_reason: FailoverReasonSchema.nullable().optional(),
    failover_error_class: z
      .string()
      .max(FAILOVER_ERROR_CLASS_MAX_LENGTH)
      .regex(FAILOVER_ERROR_CLASS_PATTERN)
      .nullable()
      .optional(),
    attempt_index: z.number().int().min(0).default(0),
    call_id: z.string().max(CALL_ID_MAX_LENGTH).regex(CANONICAL_UUID_PATTERN),
    possibly_succeeded: z.boolean().nullable().optional(),
    service_tier: z.string().max(SERVICE_TIER_MAX_LENGTH).nullable().optional(),
    sdk_instance_id: z.string(),
    timestamp: z.string(),
    agent_run_id: z.string().max(AGENT_RUN_ID_MAX_LENGTH).nullable().optional(),
    parent_agent_run_id: z.string().max(AGENT_RUN_ID_MAX_LENGTH).nullable().optional(),
    agent_run_name: z.string().max(AGENT_RUN_NAME_MAX_LENGTH).nullable().optional(),
    provider_region: z.string().max(PROVIDER_REGION_MAX_LENGTH).nullable().optional(),
    tags: TagsSchema.nullable().optional(),
    deny_source: z.enum(DENY_SOURCES).nullable().optional(),
    deny_reason: z.string().max(64).nullable().optional(),
    denied_by_period: z.string().max(32).nullable().optional(),
    estimated_output_bound: z.number().int().min(0).max(100_000_000).nullable().optional(),
    velocity_flags: z.array(z.enum(VELOCITY_FLAGS)).max(8).nullable().optional(),
    receipt_aggregate_count: z.number().int().min(1).max(100_000_000).nullable().optional(),
    receipt_pricing_input_tokens: z.number().int().min(0).max(100_000_000).nullable().optional(),
  })
  .superRefine((event, context) => {
    if (
      event.receipt_pricing_input_tokens !== null &&
      event.receipt_pricing_input_tokens !== undefined &&
      (event.receipt_aggregate_count === null || event.receipt_aggregate_count === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "receipt_pricing_input_tokens requires receipt_aggregate_count",
        path: ["receipt_pricing_input_tokens"],
      });
    }
  });

// ---------------------------------------------------------------------------
// BudgetCheckRequest (with cross-field alignment).
// ---------------------------------------------------------------------------

/** Base object schema (introspectable via `.shape`); the alignment check is layered on below. */
export const BudgetCheckRequestObjectSchema = z.strictObject({
  estimated_input_tokens: z.number().int().min(0),
  estimated_media: MediaUsageSchema.nullable().optional(),
  model: z.string().max(MODEL_NAME_MAX_LENGTH),
  provider: ProviderNameSchema,
  modality: ModalitySchema.default("text"),
  fallback_providers: z.array(ProviderNameSchema).default(() => []),
  fallback_models: z
    .array(z.string().max(MODEL_NAME_MAX_LENGTH))
    .max(FALLBACK_MAX_ITEMS)
    .default(() => []),
  agent_run_id: z.string().max(AGENT_RUN_ID_MAX_LENGTH).nullable().optional(),
  tags: TagsSchema.nullable().optional(),
  failover_directive_version: z.literal("1").nullable().optional(),
  price_hints_version: z.literal("1").nullable().optional(),
  run_directive_version: z.literal("1").nullable().optional(),
});

/**
 * Full BudgetCheckRequest schema: enforces `fallback_providers.length ===
 * fallback_models.length` (cross-field invariant not expressible per-field). The
 * 8-element cap lives on `fallback_models` itself, so a 9-aligned pair still fails.
 */
export const BudgetCheckRequestSchema = BudgetCheckRequestObjectSchema.refine(
  (value) => value.fallback_providers.length === value.fallback_models.length,
  {
    message: "fallback_providers and fallback_models must have the same length",
    path: ["fallback_models"],
  },
).transform((value) => {
  const { estimated_media: estimatedMedia, ...rest } = value;
  return omitNullish(
    estimatedMedia === null || estimatedMedia === undefined
      ? rest
      : { ...rest, estimated_media: estimatedMedia },
  );
});

// ---------------------------------------------------------------------------
// BudgetCheckResponse (inbound / parse-only).
// ---------------------------------------------------------------------------

export const FailoverDirectiveSchema = z.strictObject({
  version: z.literal("1"),
  failover_tuning_allowed: z.boolean(),
});

export const RunControlDirectiveSchema = z.strictObject({
  version: z.literal("1"),
  action: z.literal("terminate"),
  agent_run_id: z.string().max(AGENT_RUN_ID_MAX_LENGTH),
  reason: z.string().max(64),
});

export const BudgetCheckResponseSchema = z.strictObject({
  allowed: z.boolean(),
  remaining_budget: z.number(),
  reservation_id: z.string().nullable().optional(),
  mode: BudgetModeSchema,
  budget_limit: z.number(),
  current_usage: z.number(),
  // D1: required in the vendored Python model, but OPTIONAL per the spec (the key
  // may be entirely absent). Nullable value.
  denied_by_period: z.string().nullable().optional(),
  project_id: z.string(),
  // D7: keys are unrestricted strings (unknown providers in hints must not fail).
  price_hints: z.record(z.string(), z.number()).nullable().optional(),
  failover_directive: FailoverDirectiveSchema.nullable().optional(),
  run_control: RunControlDirectiveSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// BudgetConfirmRequest.
// ---------------------------------------------------------------------------

export const BudgetConfirmRequestObjectSchema = z.strictObject({
  reservation_id: z.string().nullable().optional(),
  lease_id: z.string().max(64).nullable().optional(),
  model: z.string().max(MODEL_NAME_MAX_LENGTH),
  provider: ProviderNameSchema,
  modality: ModalitySchema.default("text"),
  is_provider_fallback: z.boolean().default(false),
  call_id: z.string().max(CALL_ID_MAX_LENGTH).regex(CANONICAL_UUID_PATTERN),
  token_details: TokenDetailsSchema,
  media_usage: MediaUsageSchema.nullable().optional(),
  provider_region: z.string().max(PROVIDER_REGION_MAX_LENGTH).nullable().optional(),
  // Value-strict enum (unlike MetadataEvent.service_tier, a free string).
  service_tier: ServiceTierSchema.nullable().optional(),
});

export const BudgetConfirmRequestSchema = BudgetConfirmRequestObjectSchema.refine(
  (value) => (value.reservation_id != null) !== (value.lease_id != null),
  {
    message: "exactly one of reservation_id or lease_id must be set",
    path: ["reservation_id"],
  },
);

// ---------------------------------------------------------------------------
// Lease requests and responses (A4.1).
// ---------------------------------------------------------------------------

const LEASE_ID_MAX_LENGTH = 64;
const HOLDER_ID_MAX_LENGTH = 64;
// JavaScript Numbers preserve only safe integers; Zod rejects unsafe integers before send.
const LeaseCounterSchema = z.number().int().min(0);
const LeaseFallbackProvidersSchema = z.array(ProviderNameSchema).max(FALLBACK_MAX_ITEMS);
const LeaseFallbackModelsSchema = z
  .array(z.string().max(MODEL_NAME_MAX_LENGTH))
  .max(FALLBACK_MAX_ITEMS);

function alignedLeaseFallbacks(value: {
  fallback_providers: readonly unknown[];
  fallback_models: readonly unknown[];
}): boolean {
  return value.fallback_providers.length === value.fallback_models.length;
}

const alignedLeaseFallbacksIssue = {
  message: "fallback_providers and fallback_models must have the same length",
  path: ["fallback_models"],
};

/** Introspectable grant object; fallback alignment is applied by {@link LeaseGrantRequestSchema}. */
export const LeaseGrantRequestObjectSchema = z.strictObject({
  agent_run_id: z.string().min(1).max(AGENT_RUN_ID_MAX_LENGTH),
  holder_id: z.string().max(HOLDER_ID_MAX_LENGTH),
  model: z.string().max(MODEL_NAME_MAX_LENGTH),
  provider: ProviderNameSchema,
  fallback_providers: LeaseFallbackProvidersSchema.default(() => []),
  fallback_models: LeaseFallbackModelsSchema.default(() => []),
  fail_open: z.boolean().default(true),
  estimated_input_tokens: LeaseCounterSchema.default(0),
  run_directive_version: z.literal("1").nullable().optional(),
});

/** Strict grant request with aligned fallback arrays and None-skipping output. */
export const LeaseGrantRequestSchema = LeaseGrantRequestObjectSchema.refine(
  alignedLeaseFallbacks,
  alignedLeaseFallbacksIssue,
).transform((value) => omitNullish(value) as unknown as LeaseGrantRequest);

export const LeasePostureSchema = z.strictObject({
  mode: BudgetModeSchema,
  on_unreachable: z.enum(["fail_open", "local_enforce"]),
});

/** Grant and renewal response. Response lease IDs intentionally have no max length per OpenAPI. */
export const LeaseGrantResponseSchema = z.strictObject({
  eligible: z.boolean(),
  ineligible_reason: z.string().nullable().optional(),
  allowed: z.boolean(),
  denied_by_period: z.string().nullable().optional(),
  run_control: RunControlDirectiveSchema.nullable().optional(),
  lease_id: z.string().nullable().optional(),
  generation: z.number().int().nullable().optional(),
  granted_tokens: z.number().int().nullable().optional(),
  refresh_interval_s: z.number().nullable().optional(),
  lease_length_s: z.number().nullable().optional(),
  headroom_share_tokens: z.number().int().nullable().optional(),
  posture: LeasePostureSchema.nullable().optional(),
  final_grant: z.boolean().nullable().optional(),
  project_id: z.string(),
  mode: BudgetModeSchema,
  budget_limit: z.number(),
  current_usage: z.number(),
  remaining_budget: z.number(),
});

/** Introspectable renew object; fallback alignment is applied by {@link LeaseRenewRequestSchema}. */
export const LeaseRenewRequestObjectSchema = z.strictObject({
  lease_id: z.string().max(LEASE_ID_MAX_LENGTH),
  holder_id: z.string().max(HOLDER_ID_MAX_LENGTH),
  generation: z.number().int().min(1),
  spent_tokens: LeaseCounterSchema.default(0),
  reserved_tokens: LeaseCounterSchema.default(0),
  uncounted_calls: LeaseCounterSchema.default(0),
  uncounted_tokens: LeaseCounterSchema.default(0),
  model: z.string().max(MODEL_NAME_MAX_LENGTH).nullable().optional(),
  provider: ProviderNameSchema.nullable().optional(),
  fallback_providers: LeaseFallbackProvidersSchema.default(() => []),
  fallback_models: LeaseFallbackModelsSchema.default(() => []),
  run_directive_version: z.literal("1").nullable().optional(),
});

/** Strict renew request with aligned fallback arrays and None-skipping output. */
export const LeaseRenewRequestSchema = LeaseRenewRequestObjectSchema.refine(
  alignedLeaseFallbacks,
  alignedLeaseFallbacksIssue,
).transform((value) => omitNullish(value) as unknown as LeaseRenewRequest);

export const LeaseSurrenderRequestObjectSchema = z.strictObject({
  lease_id: z.string().max(LEASE_ID_MAX_LENGTH),
  holder_id: z.string().max(HOLDER_ID_MAX_LENGTH),
  generation: z.number().int().min(1),
  spent_tokens: LeaseCounterSchema.default(0),
});

export const LeaseSurrenderRequestSchema = LeaseSurrenderRequestObjectSchema.transform(
  (value) => omitNullish(value) as unknown as LeaseSurrenderRequest,
);

export const LeaseSurrenderResponseSchema = z.strictObject({
  released_tokens: z.number().int(),
});

// ---------------------------------------------------------------------------
// Ingest response shapes (derived from the spec — no vendored Python model).
// ---------------------------------------------------------------------------

export const IngestRejectionSchema = z.strictObject({
  index: z.number().int().min(0),
  code: IngestRejectionCodeSchema,
  model: z.string(),
  message: z.string(),
});

export const IngestResponseSchema = z.strictObject({
  ingested: z.number().int().min(0),
  rejected: z.array(IngestRejectionSchema),
});

export const RateLimitErrorResponseSchema = z.strictObject({
  detail: z.string(),
  retry_after: z.number().int(),
});

/**
 * Generic FastAPI error body for the undocumented statuses (403/404 on budgets,
 * 400 on oversized ingest — D10). NOT `HTTPValidationError` (whose `detail` is an array).
 */
export const GenericErrorSchema = z.object({ detail: z.string() });

// ---------------------------------------------------------------------------
// Content-free advisory testing-plane models.
// ---------------------------------------------------------------------------

const Rfc3339DateTimeSchema = z.iso.datetime({ offset: true });

function compareRfc3339Instants(left: string, right: string): number {
  const leftFraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(left)?.[1] ?? "";
  const rightFraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(right)?.[1] ?? "";
  const leftSecond = Date.parse(left.replace(`.${leftFraction}`, leftFraction ? "" : "."));
  const rightSecond = Date.parse(right.replace(`.${rightFraction}`, rightFraction ? "" : "."));
  if (leftSecond !== rightSecond) return leftSecond < rightSecond ? -1 : 1;

  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftPadded = leftFraction.padEnd(width, "0");
  const rightPadded = rightFraction.padEnd(width, "0");
  return leftPadded < rightPadded ? -1 : leftPadded > rightPadded ? 1 : 0;
}

/** Strict object form kept separately so contract-fidelity can introspect `.shape`. */
export const UntrackedSurfaceReportObjectSchema = z.strictObject({
  provider: ProviderNameSchema,
  client_shape: z.enum(UNTRACKED_CLIENT_SHAPES),
  mode: z.enum(UNTRACKED_CLIENT_MODES),
  surface: z
    .string()
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/),
  rule_kind: z.enum(UNTRACKED_RULE_KINDS),
  capability_scope: z.enum(UNTRACKED_CAPABILITY_SCOPES).nullable().optional(),
  posture: z.enum(UNTRACKED_POSTURES),
  occurrences: z.number().int().min(1).max(1_000_000_000),
  first_seen_at: Rfc3339DateTimeSchema,
  last_seen_at: Rfc3339DateTimeSchema,
  sdk_instance_id: z.string().max(100),
  report_id: z.string().max(36).regex(CANONICAL_UUID_PATTERN),
});

export const UntrackedSurfaceReportSchema = UntrackedSurfaceReportObjectSchema.superRefine(
  (report, context) => {
    if (compareRfc3339Instants(report.last_seen_at, report.first_seen_at) < 0) {
      context.addIssue({
        code: "custom",
        message: "last_seen_at must be greater than or equal to first_seen_at",
        path: ["last_seen_at"],
      });
    }
  },
);

export const UntrackedSurfaceAcceptedSchema = z.strictObject({
  accepted: z.number().int().min(0),
});

export const BreakerStateReportSchema = z.strictObject({
  provider: ProviderNameSchema,
  state: CircuitStateSchema,
  failure_count: z.number().int().min(0),
  success_count: z.number().int().min(0),
  reported_at: Rfc3339DateTimeSchema,
  sdk_instance_id: z.string().max(100),
});

export const BreakerReportAcceptedSchema = z.strictObject({
  accepted: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Credential / project-ID validators.
// ---------------------------------------------------------------------------

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Shared security checks, in order: (1) empty check, (2) NFC normalization,
 * (3) ASCII-only enforcement, (4) path-traversal substring rejection. Returns the
 * normalized value on success; throws {@link ConfigurationError} otherwise.
 */
function securityCheck(value: string, field: string): string {
  if (value.length === 0) {
    throw new ConfigurationError(`${field} must not be empty`, { field });
  }
  const normalized = value.normalize("NFC");
  if (!isAscii(normalized)) {
    throw new ConfigurationError(`${field} must contain only ASCII characters`, { field });
  }
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
    throw new ConfigurationError(`${field} must not contain path separators`, { field });
  }
  return normalized;
}

/**
 * Validate a public project ID (`proj_` + 24 lowercase hex). Returns the
 * NFC-normalized input unchanged on success; throws {@link ConfigurationError} otherwise.
 */
export function validateProjectId(projectId: string): string {
  const normalized = securityCheck(projectId, "project_id");
  if (!PROJECT_ID_PATTERN.test(normalized)) {
    throw new ConfigurationError(
      "Invalid project ID: expected 'proj_' followed by 24 lowercase hex characters",
      { field: "project_id" },
    );
  }
  return normalized;
}

/**
 * Format-only validation of a project API key (`sk_proj_` + 64 lowercase hex).
 * Does NOT authenticate against the API. Returns the normalized input on success;
 * throws {@link ConfigurationError} otherwise.
 *
 * There is intentionally NO `validateApiKeyFormat` — that legacy symbol must not exist.
 */
export function validateProjectKeyFormat(apiKey: string): string {
  const normalized = securityCheck(apiKey, "api_key");
  if (!PROJECT_KEY_PATTERN.test(normalized)) {
    throw new ConfigurationError(
      "Invalid API key format: expected 'sk_proj_' followed by 64 lowercase hex characters",
      { field: "api_key" },
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Wire-serialization helpers (None-skipping / omit-when-false).
// ---------------------------------------------------------------------------

/**
 * Drop every key whose value is `null` or `undefined` (the None-skipping serializer).
 * Non-null falsy values (`false`, `0`, `""`) are preserved.
 */
export function omitNullish(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Serialize a MetadataEvent to its wire object: null/undefined optional fields are
 * dropped; `is_provider_fallback: false` and `attempt_index: 0` stay; `call_id` is
 * always present; embedded `token_details` follows the omit-`is_estimated`-when-false rule.
 */
export function serializeMetadataEvent(event: MetadataEvent): Record<string, unknown> {
  if (
    event.receipt_pricing_input_tokens !== null &&
    event.receipt_pricing_input_tokens !== undefined &&
    (event.receipt_aggregate_count === null || event.receipt_aggregate_count === undefined)
  ) {
    throw new ConfigurationError("receipt_pricing_input_tokens requires receipt_aggregate_count", {
      field: "receipt_pricing_input_tokens",
    });
  }
  const { token_details: tokenDetails, ...rest } = event;
  const base: Record<string, unknown> = { ...rest, modality: event.modality ?? "text" };
  if (tokenDetails !== null && tokenDetails !== undefined) {
    base["token_details"] = serializeTokenDetails(tokenDetails);
  }
  return omitNullish(base);
}

/**
 * Serialize a BudgetConfirmRequest to its wire object: `provider_region`/`service_tier`
 * dropped when null/undefined; embedded `token_details` follows the omit-`is_estimated`
 * -when-false rule. Keeps the payload byte-identical to the pre-region-field wire shape
 * for non-Bedrock providers.
 */
export function serializeBudgetConfirmRequest(
  request: BudgetConfirmRequest,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...request,
    modality: request.modality ?? "text",
    token_details: serializeTokenDetails(request.token_details),
  };
  return omitNullish(base);
}

/** Serialize a lease grant request, retaining defaulted arrays and zero/false values. */
export function serializeLeaseGrantRequest(request: LeaseGrantRequest): Record<string, unknown> {
  return omitNullish({
    ...request,
    fallback_providers: request.fallback_providers ?? [],
    fallback_models: request.fallback_models ?? [],
    fail_open: request.fail_open ?? true,
    estimated_input_tokens: request.estimated_input_tokens ?? 0,
  });
}

/** Serialize a lease renewal request, retaining defaulted counters and arrays. */
export function serializeLeaseRenewRequest(request: LeaseRenewRequest): Record<string, unknown> {
  return omitNullish({
    ...request,
    spent_tokens: request.spent_tokens ?? 0,
    reserved_tokens: request.reserved_tokens ?? 0,
    uncounted_calls: request.uncounted_calls ?? 0,
    uncounted_tokens: request.uncounted_tokens ?? 0,
    fallback_providers: request.fallback_providers ?? [],
    fallback_models: request.fallback_models ?? [],
  });
}

/** Serialize a lease surrender request, retaining the server-defaulted zero spend. */
export function serializeLeaseSurrenderRequest(
  request: LeaseSurrenderRequest,
): Record<string, unknown> {
  return omitNullish({ ...request, spent_tokens: request.spent_tokens ?? 0 });
}
