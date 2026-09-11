/**
 * TokenDetails — the normalized, provider-agnostic token-usage breakdown attached
 * to every budget check/confirm and metadata-ingest call.
 *
 * It is a pure data struct with a single wire-serialization quirk: `is_estimated`
 * is OMITTED from the serialized JSON entirely when `false` (key-absent means
 * provider-reported), and only emitted (`true`) when the counts are SDK-side
 * length-based estimates. It carries zero prompt/response content.
 *
 * Ported from `solwyn/_token_details.py`. Per D1 / wire-contract, every numeric
 * field is bounded `0 <= n <= 100_000_000` (the API's canonical model bound; the
 * vendored Python SDK lacked the upper bound).
 */

import { z } from "zod";

/** Upper bound on every numeric TokenDetails field (spec/D1). */
export const TOKEN_DETAILS_MAX = 100_000_000;

/** The 13 numeric counter field names, in wire order. */
export const TOKEN_DETAILS_COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_5m_tokens",
  "cache_creation_1h_tokens",
  "reasoning_tokens",
  "audio_input_tokens",
  "audio_output_tokens",
  "image_input_tokens",
  "image_output_tokens",
  "accepted_prediction_tokens",
  "rejected_prediction_tokens",
  "tool_use_input_tokens",
] as const;

const counter = () => z.number().int().min(0).max(TOKEN_DETAILS_MAX).default(0);

/**
 * Strict zod schema for TokenDetails. Extra keys are rejected (`extra="forbid"`
 * parity). All 13 counters default to 0; `is_estimated` defaults to false.
 *
 * Note: the schema always includes `is_estimated` after parsing — the
 * omit-when-false wire quirk lives in {@link serializeTokenDetails}, not here.
 */
export const TokenDetailsSchema = z.strictObject({
  input_tokens: counter(),
  output_tokens: counter(),
  cached_input_tokens: counter(),
  cache_creation_5m_tokens: counter(),
  cache_creation_1h_tokens: counter(),
  reasoning_tokens: counter(),
  audio_input_tokens: counter(),
  audio_output_tokens: counter(),
  image_input_tokens: counter(),
  image_output_tokens: counter(),
  accepted_prediction_tokens: counter(),
  rejected_prediction_tokens: counter(),
  tool_use_input_tokens: counter(),
  is_estimated: z.boolean().default(false),
});

/** Parsed TokenDetails shape (all fields present, defaults applied). */
export type TokenDetails = z.infer<typeof TokenDetailsSchema>;

/**
 * Construct a validated TokenDetails from a partial set of counters.
 * Omitted fields default to 0 (or false for `is_estimated`).
 *
 * VALIDATING constructor — throws `ZodError` on an out-of-bound counter. Use it only
 * where the caller can tolerate a throw. The never-throw usage-extraction path
 * ({@link buildTokenDetails}) must NOT use this (a garbage `> TOKEN_DETAILS_MAX`
 * count from a provider response must not crash extraction — see D1 / F10).
 */
export function createTokenDetails(partial: Partial<TokenDetails> = {}): TokenDetails {
  return TokenDetailsSchema.parse(partial);
}

/**
 * Build a TokenDetails as a PLAIN object — applying the same field defaults as the
 * schema (all 13 counters `0`, `is_estimated` false) but WITHOUT any zod parsing, so
 * it NEVER throws, even for a count above `TOKEN_DETAILS_MAX`.
 *
 * This is the constructor for the never-throw usage-extraction / stream-`finalize()`
 * path (provider-openai.md: `extractUsage` must never throw; stream-accumulator.md
 * item 24: `finalize()` must never raise). D1's `0 <= n <= 100_000_000` bound is a
 * WIRE constraint enforced at the reporter boundary (each event is re-validated
 * through `MetadataEventSchema` before send, dropped fail-open per event) — not an
 * extractor crash. An out-of-bound count therefore flows through here unmodified and
 * is caught at that boundary, matching Python's unbounded vendored model.
 */
export function buildTokenDetails(partial: Partial<TokenDetails> = {}): TokenDetails {
  return {
    input_tokens: partial.input_tokens ?? 0,
    output_tokens: partial.output_tokens ?? 0,
    cached_input_tokens: partial.cached_input_tokens ?? 0,
    cache_creation_5m_tokens: partial.cache_creation_5m_tokens ?? 0,
    cache_creation_1h_tokens: partial.cache_creation_1h_tokens ?? 0,
    reasoning_tokens: partial.reasoning_tokens ?? 0,
    audio_input_tokens: partial.audio_input_tokens ?? 0,
    audio_output_tokens: partial.audio_output_tokens ?? 0,
    image_input_tokens: partial.image_input_tokens ?? 0,
    image_output_tokens: partial.image_output_tokens ?? 0,
    accepted_prediction_tokens: partial.accepted_prediction_tokens ?? 0,
    rejected_prediction_tokens: partial.rejected_prediction_tokens ?? 0,
    tool_use_input_tokens: partial.tool_use_input_tokens ?? 0,
    is_estimated: partial.is_estimated ?? false,
  };
}

/** A provider counter must be an explicit non-negative integer; zero is valid. */
export function isUsageCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Normalize reported counters without losing whether paid usage is unknown. Missing
 * primary totals or malformed counters mark the result estimated, while absent optional
 * breakdowns remain zero. Valid counts, including values above the wire bound, survive
 * for settlement validation. This helper neither prices usage nor reads provider content.
 */
export function buildReportedTokenDetails(
  reported: Partial<Record<(typeof TOKEN_DETAILS_COUNTERS)[number], unknown>>,
  usageUnmeasured = false,
): TokenDetails {
  const details = buildTokenDetails({
    is_estimated:
      usageUnmeasured ||
      !isUsageCount(reported.input_tokens) ||
      !isUsageCount(reported.output_tokens),
  });
  for (const field of TOKEN_DETAILS_COUNTERS) {
    const value = reported[field];
    if (isUsageCount(value)) details[field] = value;
    else if (value !== undefined && value !== null) details.is_estimated = true;
  }
  return details;
}

/**
 * A fresh all-zero, provider-reported (`is_estimated: false`) TokenDetails.
 * Use only for known zero usage. Missing provider usage must be explicitly estimated.
 * Plain-constructed (never throws) since it sits on the usage-extraction path.
 */
export function zeroTokenDetails(): TokenDetails {
  return buildTokenDetails();
}

/**
 * Derived, non-serialized total. `total_tokens = input_tokens + output_tokens`.
 * Never appears on the wire — a computed convenience only.
 */
export function totalTokens(td: TokenDetails): number {
  return td.input_tokens + td.output_tokens;
}

/**
 * Serialize a TokenDetails to its wire object.
 *
 * Mirrors the Python `model_serializer(mode="wrap")`: every counter is emitted,
 * but `is_estimated` is dropped entirely when `false` (never `"is_estimated": false`)
 * and present as `true` only when `true`. Use this at every call site that puts a
 * TokenDetails on the wire (embedded in BudgetConfirmRequest / MetadataEvent).
 */
export function serializeTokenDetails(td: TokenDetails): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {
    input_tokens: td.input_tokens,
    output_tokens: td.output_tokens,
    cached_input_tokens: td.cached_input_tokens,
    cache_creation_5m_tokens: td.cache_creation_5m_tokens,
    cache_creation_1h_tokens: td.cache_creation_1h_tokens,
    reasoning_tokens: td.reasoning_tokens,
    audio_input_tokens: td.audio_input_tokens,
    audio_output_tokens: td.audio_output_tokens,
    image_input_tokens: td.image_input_tokens,
    image_output_tokens: td.image_output_tokens,
    accepted_prediction_tokens: td.accepted_prediction_tokens,
    rejected_prediction_tokens: td.rejected_prediction_tokens,
    tool_use_input_tokens: td.tool_use_input_tokens,
  };
  if (td.is_estimated) {
    out["is_estimated"] = true;
  }
  return out;
}
