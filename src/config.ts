/**
 * `SolwynConfig` resolution — the single validated settings object every other
 * subsystem reads from (API credentials/endpoint, provider/model failover chain,
 * budget-mode/fail-open policy, circuit-breaker / budget-cache / reporter knobs).
 *
 * Resolution order per field: constructor option → `SOLWYN_*` env var → hard-coded
 * default. Env fallback is a PRESENCE check (D3): an option is consulted from the
 * environment ONLY when it is `undefined` — an explicitly-passed `false`, `0`, or
 * `""` always wins over the env var. Env access goes through `globalThis.process`
 * with optional chaining so the module never hard-fails on edge runtimes without a
 * `process` global (env config simply becomes a no-op there).
 *
 * Pure and synchronous; performs no I/O and never touches prompt/response content.
 * Malformed/incomplete input surfaces as a typed {@link ConfigurationError} (never a
 * raw `ZodError`), matching the way the Python client wraps Pydantic `ValidationError`.
 *
 * Ported from `solwyn/config.py` + `solwyn/_validation.py`. Reuses the shared enums,
 * constants, and `ProviderEntry` schema already defined in `types.ts` / `validation.ts`.
 */

import { z } from "zod";
import { ConfigurationError, SolwynError } from "./errors";
import { DEFAULT_OUTPUT_BOUND } from "./lease";
import { BUDGET_CHECK_TIMEOUT } from "./routing";
import { UNMETERED_POSTURES, type UnmeteredPosture } from "./surface-guard";
import { OPENAI_TTS_ACKNOWLEDGMENT_TOKEN } from "./surface-rules";
import {
  isSurfacePathWireEligible,
  resolveSurfaceRule,
  SURFACE_RULES,
  type SurfaceContext,
} from "./surfaces";
import { copyTags, type Tags } from "./tags";
import type { BudgetMode, ProviderName } from "./types";
import { BudgetModeSchema, ProviderEntrySchema, validateProjectKeyFormat } from "./validation";
import { VELOCITY_HISTORY_LIMIT, type VelocityConfig } from "./velocity";

// ---------------------------------------------------------------------------
// Literal unions / defaults.
// ---------------------------------------------------------------------------

/** Default Solwyn Cloud API endpoint. */
export const DEFAULT_API_URL = "https://api.solwyn.ai";

/** Failover idempotency policy — a closed literal union, not a free string. */
export const FAILOVER_IDEMPOTENCY_VALUES = ["safe", "never", "always"] as const;
export type FailoverIdempotency = (typeof FAILOVER_IDEMPOTENCY_VALUES)[number];
const FailoverIdempotencySchema = z.enum(FAILOVER_IDEMPOTENCY_VALUES);

/** Posture applied before exposing an untracked spend surface. */
export const ON_UNMETERED_VALUES = UNMETERED_POSTURES;
export type OnUnmeteredPosture = UnmeteredPosture;
const OnUnmeteredPostureSchema = z.enum(ON_UNMETERED_VALUES);

const MALFORMED_ACKNOWLEDGMENT_MESSAGE =
  "acknowledge_untracked tokens must be exact wire-eligible public dotted paths";
const KNOWN_ACKNOWLEDGMENT_MESSAGE =
  "acknowledge_untracked token names a known non-acknowledgeable surface";
const RESOURCE_ACKNOWLEDGMENT_MESSAGE = "acknowledge_untracked token names a resource container";

function acknowledgmentError(message: string): never {
  throw new ConfigurationError(message, { field: "acknowledge_untracked" });
}

function validateConfiguredAcknowledgment(token: unknown): asserts token is string {
  if (token === OPENAI_TTS_ACKNOWLEDGMENT_TOKEN) {
    return;
  }
  if (typeof token !== "string") {
    acknowledgmentError(MALFORMED_ACKNOWLEDGMENT_MESSAGE);
  }
  try {
    if (!isSurfacePathWireEligible(token)) {
      acknowledgmentError(MALFORMED_ACKNOWLEDGMENT_MESSAGE);
    }
  } catch {
    acknowledgmentError(MALFORMED_ACKNOWLEDGMENT_MESSAGE);
  }
  if (SURFACE_RULES.some((rule) => rule.acknowledgmentToken === token)) {
    return;
  }
  const knownRules = SURFACE_RULES.filter((rule) => rule.surface === token);
  if (knownRules.some((rule) => rule.kind === "namespace")) {
    acknowledgmentError(RESOURCE_ACKNOWLEDGMENT_MESSAGE);
  }
  if (knownRules.length > 0) {
    acknowledgmentError(KNOWN_ACKNOWLEDGMENT_MESSAGE);
  }
}

const AcknowledgeUntrackedSchema = z
  .unknown()
  .transform((value, context): readonly string[] => {
    let isCollection: boolean;
    try {
      isCollection = Array.isArray(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "acknowledge_untracked must be a collection of exact tokens",
      });
      return z.NEVER;
    }
    if (!isCollection) {
      context.addIssue({
        code: "custom",
        message: "acknowledge_untracked must be a collection of exact tokens",
      });
      return z.NEVER;
    }

    let snapshot: unknown[];
    try {
      snapshot = Array.from(value as Iterable<unknown>);
    } catch {
      context.addIssue({ code: "custom", message: MALFORMED_ACKNOWLEDGMENT_MESSAGE });
      return z.NEVER;
    }
    for (const token of snapshot) {
      try {
        validateConfiguredAcknowledgment(token);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof ConfigurationError ? error.message : MALFORMED_ACKNOWLEDGMENT_MESSAGE,
        });
        return z.NEVER;
      }
    }
    return Object.freeze([...new Set(snapshot as string[])]);
  })
  .default(() => Object.freeze([]));

/**
 * Validate an acknowledgment token for a concrete provider surface context without
 * reading a live provider object.
 */
export function validateAcknowledgmentForContext(token: string, context: SurfaceContext): void {
  validateConfiguredAcknowledgment(token);

  if (token === OPENAI_TTS_ACKNOWLEDGMENT_TOKEN) {
    const rule = resolveSurfaceRule({
      context,
      path: "audio.speech.create",
      source: "synthetic_policy",
      condition: "openai_untracked_tts_model",
    });
    if (rule?.kind === "unmetered_spend" && rule.acknowledgmentToken === token) {
      return;
    }
    acknowledgmentError(KNOWN_ACKNOWLEDGMENT_MESSAGE);
  }

  const applicable = (["raw", "wrapper"] as const)
    .map((source) => resolveSurfaceRule({ context, path: token, source }))
    .filter((rule) => rule !== undefined);
  if (
    applicable.some((rule) => rule.kind === "unmetered_spend" && rule.acknowledgmentToken === token)
  ) {
    return;
  }
  if (applicable.length > 0) {
    acknowledgmentError(KNOWN_ACKNOWLEDGMENT_MESSAGE);
  }
}

const ConfigTagsSchema = z
  .unknown()
  .transform((value, context): Tags | undefined => {
    try {
      return copyTags(value, "tags");
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof SolwynError ? error.message : "tags are invalid",
      });
      return z.NEVER;
    }
  })
  .optional();

/** Numeric options accept env strings but never coerce booleans into 0/1. */
const PositiveIntegerFromNumberOrStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? Number(value) : value),
  z.number().finite().int().positive(),
);

function numberFromNumberOrStringSchema(schema: z.ZodNumber) {
  return z.preprocess((value) => (typeof value === "string" ? Number(value) : value), schema);
}

/** Pydantic float coercion accepts positive infinity; keep that parity velocity-local. */
function velocityFloatFromNumberOrStringSchema(schema: z.ZodNumber) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }
      const normalized = value.trim().toLowerCase();
      if (normalized.length === 0) {
        return Number.NaN;
      }
      if (/^\+?inf(?:inity)?$/.test(normalized)) {
        return Number.POSITIVE_INFINITY;
      }
      const parsed = Number(value);
      if (
        parsed === Number.POSITIVE_INFINITY &&
        !/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/.test(normalized)
      ) {
        return Number.NaN;
      }
      return parsed;
    },
    z.union([schema, z.literal(Number.POSITIVE_INFINITY)]),
  );
}

const TIMEOUT_BOOLEAN_MESSAGE = "timeout bounds must be numbers, not booleans";

/** Timeout bounds accept numeric env-style strings but reject booleans before coercion. */
function timeoutBoundSchema(positive: boolean) {
  return z.preprocess(
    (value, context) => {
      if (typeof value === "boolean") {
        context.addIssue({ code: "custom", message: TIMEOUT_BOOLEAN_MESSAGE });
        return z.NEVER;
      }
      return typeof value === "string" ? Number(value) : value;
    },
    positive ? z.number().finite().positive() : z.number().finite(),
  );
}

/** Exact eight-field snapshot governed by failover-tuning entitlement. */
export interface FailoverTuningConfig {
  readonly failover_total_timeout: number;
  readonly failover_hop_read_timeout: number;
  readonly failover_idempotency: FailoverIdempotency;
  readonly same_provider_retries: number;
  readonly circuit_breaker_recovery_timeout_jitter: number;
  readonly circuit_breaker_failure_threshold: number;
  readonly circuit_breaker_recovery_timeout: number;
  readonly circuit_breaker_success_threshold: number;
}

/** The single source of SDK defaults for the eight plan-governed fields. */
export const FAILOVER_TUNING_DEFAULTS: FailoverTuningConfig = Object.freeze({
  failover_total_timeout: 30,
  failover_hop_read_timeout: 600,
  failover_idempotency: "safe",
  same_provider_retries: 0,
  circuit_breaker_recovery_timeout_jitter: 0.2,
  circuit_breaker_failure_threshold: 3,
  circuit_breaker_recovery_timeout: 60,
  circuit_breaker_success_threshold: 2,
});

// ---------------------------------------------------------------------------
// Schema (strict — unknown keys are a hard error, `extra="forbid"` parity).
// ---------------------------------------------------------------------------

/**
 * Strict `SolwynConfig` schema with every field's exact default from the spec.
 *
 * Numeric fields use `z.coerce.number()` so env-sourced raw strings (e.g. `"5"`)
 * coerce to numbers at the schema layer, while real numeric options pass through
 * unchanged. `api_key` is a plain string here — its FORMAT is validated separately
 * (via {@link validateProjectKeyFormat}) so a bad key surfaces as `field="api_key"`
 * rather than a generic string issue. The non-empty `providers` invariant is NOT
 * enforced here (the field defaults to `[]` and validates "after construction" — see
 * {@link validateProviderChain}), so `SolwynConfig` builds from `api_key` alone.
 */
export const SolwynConfigSchema = z.strictObject({
  api_key: z.string(),
  api_url: z.string().default(DEFAULT_API_URL),
  fail_open: z.boolean().default(true),
  budget_mode: BudgetModeSchema.default("alert_only"),
  providers: z.array(ProviderEntrySchema).default(() => []),
  default_params: z.record(z.string(), z.unknown()).default(() => ({})),
  tags: ConfigTagsSchema,
  failover_total_timeout: timeoutBoundSchema(false).default(
    FAILOVER_TUNING_DEFAULTS.failover_total_timeout,
  ),
  failover_hop_read_timeout: timeoutBoundSchema(true).default(
    FAILOVER_TUNING_DEFAULTS.failover_hop_read_timeout,
  ),
  failover_idempotency: FailoverIdempotencySchema.default(
    FAILOVER_TUNING_DEFAULTS.failover_idempotency,
  ),
  same_provider_retries: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(FAILOVER_TUNING_DEFAULTS.same_provider_retries),
  circuit_breaker_recovery_timeout_jitter: z.coerce
    .number()
    .default(FAILOVER_TUNING_DEFAULTS.circuit_breaker_recovery_timeout_jitter),
  circuit_breaker_failure_threshold: z.coerce
    .number()
    .int()
    .default(FAILOVER_TUNING_DEFAULTS.circuit_breaker_failure_threshold),
  circuit_breaker_recovery_timeout: z.coerce
    .number()
    .int()
    .default(FAILOVER_TUNING_DEFAULTS.circuit_breaker_recovery_timeout),
  circuit_breaker_success_threshold: z.coerce
    .number()
    .int()
    .default(FAILOVER_TUNING_DEFAULTS.circuit_breaker_success_threshold),
  budget_check_cache_ttl: z.coerce.number().int().default(5),
  budget_check_timeout: z.coerce.number().default(BUDGET_CHECK_TIMEOUT),
  control_plane_failure_threshold: z.coerce.number().int().default(3),
  control_plane_recovery_timeout: z.coerce.number().default(30.0),
  breaker_reporting_enabled: z.boolean().default(true),
  lease_enabled: z.boolean().default(true),
  lease_output_bound_default: PositiveIntegerFromNumberOrStringSchema.default(DEFAULT_OUTPUT_BOUND),
  // Reporter knobs must be strictly positive: a non-positive value deadlocks or
  // spins the background flush loop (batchSize=0 → i+=0 infinite loop; maxInFlight=0
  // → Promise.race over an empty set never settles), so reject it as a typed
  // ConfigurationError at construction rather than hanging at runtime.
  reporter_batch_size: z.coerce.number().int().positive().default(50),
  reporter_flush_interval: z.coerce.number().positive().default(5.0),
  reporter_max_queue_size: z.coerce.number().int().positive().default(10_000),
  reporter_max_in_flight: z.coerce.number().int().positive().default(3),
  reporter_max_send_attempts: z.coerce.number().int().min(1).default(5),
  reporter_retry_backoff_base: z.coerce.number().finite().positive().default(1.0),
  reporter_retry_backoff_cap: z.coerce.number().finite().positive().default(60.0),
  reporter_shutdown_deadline: z.coerce.number().finite().nonnegative().default(5.0),
  breaker_report_heartbeat: z.coerce.number().finite().positive().default(60.0),
  on_unmetered: OnUnmeteredPostureSchema.default("warn"),
  acknowledge_untracked: AcknowledgeUntrackedSchema,
  report_untracked_surfaces: z.boolean().default(true),
  velocity_mode: z.enum(["off", "warn", "deny"]).default("warn"),
  velocity_repeat_count: numberFromNumberOrStringSchema(
    z.number().finite().int().min(2).max(VELOCITY_HISTORY_LIMIT),
  ).default(5),
  velocity_repeat_window_s: velocityFloatFromNumberOrStringSchema(
    z.number().finite().positive(),
  ).default(60),
  velocity_growth_streak: numberFromNumberOrStringSchema(
    z.number().finite().int().min(3).max(VELOCITY_HISTORY_LIMIT),
  ).default(8),
  velocity_growth_factor: velocityFloatFromNumberOrStringSchema(z.number().finite().gt(1)).default(
    3,
  ),
  velocity_accel_floor_per_min: numberFromNumberOrStringSchema(
    z.number().finite().int().min(1).max(VELOCITY_HISTORY_LIMIT),
  ).default(30),
  velocity_accel_factor: velocityFloatFromNumberOrStringSchema(z.number().finite().gt(1)).default(
    3,
  ),
});

/** Fully resolved, validated configuration (post-defaults). */
export type SolwynConfig = z.infer<typeof SolwynConfigSchema>;

/** Take an immutable value snapshot before any server directive mutates the resolved config. */
export function pickFailoverTuning(config: SolwynConfig): FailoverTuningConfig {
  return Object.freeze({
    failover_total_timeout: config.failover_total_timeout,
    failover_hop_read_timeout: config.failover_hop_read_timeout,
    failover_idempotency: config.failover_idempotency,
    same_provider_retries: config.same_provider_retries,
    circuit_breaker_recovery_timeout_jitter: config.circuit_breaker_recovery_timeout_jitter,
    circuit_breaker_failure_threshold: config.circuit_breaker_failure_threshold,
    circuit_breaker_recovery_timeout: config.circuit_breaker_recovery_timeout,
    circuit_breaker_success_threshold: config.circuit_breaker_success_threshold,
  });
}

/** Take the monitor's immutable, construction-time seven-field settings snapshot. */
export function pickVelocityConfig(config: VelocityConfig): VelocityConfig {
  return Object.freeze({
    velocity_mode: config.velocity_mode,
    velocity_repeat_count: config.velocity_repeat_count,
    velocity_repeat_window_s: config.velocity_repeat_window_s,
    velocity_growth_streak: config.velocity_growth_streak,
    velocity_growth_factor: config.velocity_growth_factor,
    velocity_accel_floor_per_min: config.velocity_accel_floor_per_min,
    velocity_accel_factor: config.velocity_accel_factor,
  });
}

/** A provider+model routing entry as supplied by the caller (default_params optional). */
export interface ProviderEntryInput {
  provider: ProviderName;
  model: string;
  default_params?: Record<string, unknown>;
}

/**
 * Constructor options for building a {@link SolwynConfig}. Every field is optional
 * here — any absent field falls back to its env var (where mapped) then its default.
 * There is deliberately NO `project_id` field (removed from the tier-zero API).
 */
export interface SolwynConfigOptions {
  api_key?: string;
  api_url?: string;
  fail_open?: boolean;
  budget_mode?: BudgetMode;
  providers?: ProviderEntryInput[];
  default_params?: Record<string, unknown>;
  tags?: Record<string, string> | null;
  failover_total_timeout?: number;
  failover_hop_read_timeout?: number;
  failover_idempotency?: FailoverIdempotency;
  same_provider_retries?: number;
  circuit_breaker_recovery_timeout_jitter?: number;
  circuit_breaker_failure_threshold?: number;
  circuit_breaker_recovery_timeout?: number;
  circuit_breaker_success_threshold?: number;
  budget_check_cache_ttl?: number;
  budget_check_timeout?: number;
  control_plane_failure_threshold?: number;
  control_plane_recovery_timeout?: number;
  breaker_reporting_enabled?: boolean;
  lease_enabled?: boolean;
  lease_output_bound_default?: number;
  reporter_batch_size?: number;
  reporter_flush_interval?: number;
  reporter_max_queue_size?: number;
  reporter_max_in_flight?: number;
  reporter_max_send_attempts?: number;
  reporter_retry_backoff_base?: number;
  reporter_retry_backoff_cap?: number;
  reporter_shutdown_deadline?: number;
  breaker_report_heartbeat?: number;
  on_unmetered?: OnUnmeteredPosture;
  acknowledge_untracked?: readonly string[];
  report_untracked_surfaces?: boolean;
  velocity_mode?: VelocityConfig["velocity_mode"];
  velocity_repeat_count?: number;
  velocity_repeat_window_s?: number;
  velocity_growth_streak?: number;
  velocity_growth_factor?: number;
  velocity_accel_floor_per_min?: number;
  velocity_accel_factor?: number;
}

// ---------------------------------------------------------------------------
// Env-var loading (D3: presence check, never truthiness; edge-safe access).
// ---------------------------------------------------------------------------

/**
 * The EXACT `SOLWYN_*` field map. Only these fields are auto-loaded from the
 * environment; notably `providers`, `default_params`, the failover knobs, and
 * `circuit_breaker_recovery_timeout_jitter` are constructor-only. `SOLWYN_PROJECT_ID`
 * is intentionally absent — it is read by nothing.
 */
export const ENV_FIELD_MAP: Readonly<Record<string, string>> = {
  api_key: "SOLWYN_API_KEY",
  api_url: "SOLWYN_API_URL",
  tags: "SOLWYN_TAGS",
  fail_open: "SOLWYN_FAIL_OPEN",
  budget_mode: "SOLWYN_BUDGET_MODE",
  budget_check_timeout: "SOLWYN_BUDGET_CHECK_TIMEOUT",
  control_plane_failure_threshold: "SOLWYN_CONTROL_PLANE_FAILURE_THRESHOLD",
  control_plane_recovery_timeout: "SOLWYN_CONTROL_PLANE_RECOVERY_TIMEOUT",
  breaker_reporting_enabled: "SOLWYN_BREAKER_REPORTING_ENABLED",
  lease_enabled: "SOLWYN_LEASE_ENABLED",
  lease_output_bound_default: "SOLWYN_LEASE_OUTPUT_BOUND_DEFAULT",
  circuit_breaker_failure_threshold: "SOLWYN_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
  circuit_breaker_recovery_timeout: "SOLWYN_CIRCUIT_BREAKER_RECOVERY_TIMEOUT",
  circuit_breaker_success_threshold: "SOLWYN_CIRCUIT_BREAKER_SUCCESS_THRESHOLD",
  budget_check_cache_ttl: "SOLWYN_BUDGET_CHECK_CACHE_TTL",
  reporter_batch_size: "SOLWYN_REPORTER_BATCH_SIZE",
  reporter_flush_interval: "SOLWYN_REPORTER_FLUSH_INTERVAL",
  reporter_max_queue_size: "SOLWYN_REPORTER_MAX_QUEUE_SIZE",
  reporter_max_in_flight: "SOLWYN_REPORTER_MAX_IN_FLIGHT",
  reporter_max_send_attempts: "SOLWYN_REPORTER_MAX_SEND_ATTEMPTS",
  reporter_retry_backoff_base: "SOLWYN_REPORTER_RETRY_BACKOFF_BASE",
  reporter_retry_backoff_cap: "SOLWYN_REPORTER_RETRY_BACKOFF_CAP",
  reporter_shutdown_deadline: "SOLWYN_REPORTER_SHUTDOWN_DEADLINE",
  breaker_report_heartbeat: "SOLWYN_BREAKER_REPORT_HEARTBEAT",
  on_unmetered: "SOLWYN_ON_UNMETERED",
  acknowledge_untracked: "SOLWYN_ACKNOWLEDGE_UNTRACKED",
  report_untracked_surfaces: "SOLWYN_REPORT_UNTRACKED_SURFACES",
  velocity_mode: "SOLWYN_VELOCITY_MODE",
  velocity_repeat_count: "SOLWYN_VELOCITY_REPEAT_COUNT",
  velocity_repeat_window_s: "SOLWYN_VELOCITY_REPEAT_WINDOW_S",
  velocity_growth_streak: "SOLWYN_VELOCITY_GROWTH_STREAK",
  velocity_growth_factor: "SOLWYN_VELOCITY_GROWTH_FACTOR",
  velocity_accel_floor_per_min: "SOLWYN_VELOCITY_ACCEL_FLOOR_PER_MIN",
  velocity_accel_factor: "SOLWYN_VELOCITY_ACCEL_FACTOR",
};

/**
 * Edge-safe env snapshot: reads `globalThis.process.env` via optional chaining so a
 * runtime without a `process` global (edge/browser) yields an empty map instead of a
 * `ReferenceError`. `process` is not typed here (`tsconfig` sets `types: []`), hence
 * the narrow structural cast.
 */
export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

export function getEnvSnapshot(): EnvSnapshot {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return Object.freeze({ ...(proc?.env ?? {}) });
}

/**
 * Coerce a `SOLWYN_FAIL_OPEN` env string to a boolean: case-insensitive `"true"`,
 * `"1"`, `"yes"` → `true`; anything else (including `"false"`, `"0"`, `"no"`) → `false`.
 */
function coerceFailOpen(raw: string): boolean {
  return raw.toLowerCase() === "true" || raw === "1" || raw.toLowerCase() === "yes";
}

function parseEnvTags(raw: string): Tags | undefined {
  const entries: Array<readonly [string, string]> = [];
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator < 0) {
      throw new SolwynError("SOLWYN_TAGS entries must use key=value");
    }
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    entries.push([key, value]);
  }
  return copyTags(Object.fromEntries(entries), "SOLWYN_TAGS");
}

function parseEnvAcknowledgments(raw: string): readonly string[] {
  const tokens = raw.split(",").map((token) => token.trim());
  if (tokens.some((token) => token.length === 0)) {
    throw new ConfigurationError("SOLWYN_ACKNOWLEDGE_UNTRACKED must not contain empty elements", {
      field: "acknowledge_untracked",
    });
  }
  return Object.freeze([...new Set(tokens)]);
}

/**
 * Merge constructor options with `SOLWYN_*` env vars into a raw kwargs object for the
 * schema. D3: an env var is consulted ONLY when the corresponding option is `undefined`
 * — an explicitly-passed `false`/`0`/`""` is present and therefore wins. Unmapped
 * option fields (providers, default_params, failover knobs) pass straight through.
 * Numeric env values are handed to the schema as raw strings, `fail_open` applies its
 * dedicated string→bool rule, and `SOLWYN_TAGS` is parsed before schema validation.
 */
export function loadConfigFromEnv(
  options: SolwynConfigOptions,
  env: EnvSnapshot = getEnvSnapshot(),
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  // Copy every explicitly-provided (non-undefined) option. Presence — not truthiness.
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      raw[key] = value;
    }
  }
  // Fill mapped fields from the environment only where the option was absent.
  for (const [field, envName] of Object.entries(ENV_FIELD_MAP)) {
    if (raw[field] !== undefined) {
      continue; // constructor kwarg wins
    }
    const envValue = env[envName];
    if (envValue === undefined) {
      continue; // fall through to the schema default
    }
    if (
      field === "fail_open" ||
      field === "lease_enabled" ||
      field === "report_untracked_surfaces" ||
      field === "breaker_reporting_enabled"
    ) {
      raw[field] = coerceFailOpen(envValue);
    } else if (field === "tags") {
      raw[field] = parseEnvTags(envValue);
    } else if (field === "acknowledge_untracked") {
      raw[field] = parseEnvAcknowledgments(envValue);
    } else {
      raw[field] = envValue;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve constructor options + env vars + defaults into a validated
 * {@link SolwynConfig}.
 *
 * Validation order (mirrors the Python "first error wins" surfacing):
 *   1. `api_key` presence, then FORMAT — a missing or malformed key throws
 *      `ConfigurationError(field="api_key")`.
 *   2. Schema parse — applies defaults, coerces env strings, and validates numeric /
 *      enum constraints (e.g. `same_provider_retries >= 0`). A schema failure is
 *      wrapped into `ConfigurationError` whose `field` is the last path segment of the
 *      first zod issue (unknown/extra keys → `extra="forbid"` rejection).
 *
 * Does NOT enforce a non-empty `providers` chain (the field validates "after
 * construction" — see {@link validateProviderChain}), so `api_key` alone is sufficient
 * to construct a valid config object.
 */
/** Internal deterministic resolver used by the private testing apparatus. */
export function resolveConfigFromEnvSnapshot(
  options: SolwynConfigOptions,
  env: EnvSnapshot,
): SolwynConfig {
  let raw: Record<string, unknown>;
  try {
    raw = loadConfigFromEnv(options, env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    if (error instanceof SolwynError) {
      throw new ConfigurationError(error.message, { field: "tags" });
    }
    throw error;
  }

  // 1. api_key: presence + format. Missing key mirrors "field required" but with our
  //    typed error and stable field label.
  const apiKey = raw["api_key"];
  if (apiKey === undefined || apiKey === null) {
    throw new ConfigurationError("api_key is required", { field: "api_key" });
  }
  if (typeof apiKey !== "string") {
    throw new ConfigurationError("api_key must be a string", { field: "api_key" });
  }
  // Throws ConfigurationError(field="api_key") on empty/non-ASCII/traversal/bad-format.
  // Returns the NFC-normalized key (identity for valid ASCII hex keys).
  raw["api_key"] = validateProjectKeyFormat(apiKey);

  // 2. Schema parse — wrap any zod failure into a ConfigurationError naming the field.
  const result = SolwynConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue === undefined) {
      throw new ConfigurationError("Invalid configuration", { field: null });
    }
    const lastSegment = issue.path.length > 0 ? issue.path[issue.path.length - 1] : undefined;
    const field = lastSegment === undefined ? null : String(lastSegment);
    throw new ConfigurationError(issue.message, { field });
  }
  return result.data;
}

/** Resolve configuration through the ambient environment snapshot. */
export function resolveConfig(options: SolwynConfigOptions = {}): SolwynConfig {
  return resolveConfigFromEnvSnapshot(options, getEnvSnapshot());
}

/**
 * Enforce the non-empty `providers` invariant "after construction": an empty chain
 * throws `ConfigurationError(field="providers")`. The client populates `providers`
 * from the detected wrapped-client chain before invoking this; a hand-built config
 * must satisfy it directly. Returns the config unchanged for fluent use.
 */
export function validateProviderChain(config: SolwynConfig): SolwynConfig {
  if (config.providers.length === 0) {
    throw new ConfigurationError("at least one provider entry required", { field: "providers" });
  }
  return config;
}

// ---------------------------------------------------------------------------
// Re-exports (shared cross-subsystem symbols live in types.ts / validation.ts).
// ---------------------------------------------------------------------------

export type { BudgetMode, ProviderEntry, ProviderName } from "./types";
export {
  AGENT_RUN_ID_MAX_LENGTH,
  AGENT_RUN_NAME_MAX_LENGTH,
  MODEL_NAME_MAX_LENGTH,
  PROVIDER_REGION_MAX_LENGTH,
  SERVICE_TIER_MAX_LENGTH,
} from "./types";
export { ProviderEntrySchema, validateProjectKeyFormat } from "./validation";
