/**
 * OpenAI stream-usage accumulator plus the shared, module-level usage/service-tier
 * extraction helpers used by both the streaming path and {@link OpenAIAdapter}.
 *
 * Ported from `solwyn/providers/openai.py`'s module-level `_extract_openai_usage`,
 * `_usage_value`, `_extract_service_tier`, and the `OpenAIStreamAccumulator` class.
 * These extractors live here (rather than in `openai.ts`) so `openai.ts` can delegate
 * to them without forming an import cycle: `openai.ts -> accumulator.ts`, never the
 * reverse.
 *
 * Usage settles from TERMINAL stream chunks: OpenAI's `include_usage` makes the final
 * streamed chunk carry a `usage` block shape-compatible with a non-streaming response,
 * so streaming and non-streaming share one extraction path.
 *
 * PRIVACY: no code path here reads prompt/response CONTENT — only token counts and a
 * bounded tier label. This module lives outside the privacy-firewall allowlist and
 * must stay that way.
 */

import type { Logger } from "../logging";
import { consoleLogger } from "../logging";
import type { TokenDetails } from "../token-details";
import { buildReportedTokenDetails, isUsageCount } from "../token-details";
import { SERVICE_TIER_MAX_LENGTH } from "../types";
import type { StreamUsageAccumulator } from "./protocol";

// ---------------------------------------------------------------------------
// Small structural narrowing helpers (duck-typing over `unknown`).
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Absent fields read as undefined; unreadable fields retain an invalid numeric sentinel. */
function getProp(obj: unknown, key: string): unknown {
  try {
    return isObject(obj) ? obj[key] : undefined;
  } catch {
    // Keep an unreadable counter distinct from an absent optional counter.
    return Number.NaN;
  }
}

/**
 * Property-PRESENCE check (Python `hasattr` analogue). Critically NOT a
 * nullish/truthiness check — a `usage.prompt_tokens === 0` must still count as
 * present so the correct extraction branch is selected.
 */
function hasProp(obj: unknown, key: string): boolean {
  try {
    return isObject(obj) && key in obj;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Usage-field coercion.
// ---------------------------------------------------------------------------

/**
 * Coerce one raw usage field to a non-negative integer, degrading any garbage to `0`.
 *
 * Passes through ONLY a clean non-negative integer; everything else — booleans
 * (`typeof` is not `"number"`), floats (`Number.isInteger` is false), strings,
 * `null`/`undefined`, and negatives — degrades to `0`. This specifically guards
 * against a naive `value || 0` coercion (which would let a truthy string like
 * `"abc"` through) and against treating a boolean as a valid count.
 */
export function usageValue(value: unknown): number {
  return isUsageCount(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Usage extraction (shared by adapter + accumulator).
// ---------------------------------------------------------------------------

/** Chat Completions usage shape → normalized {@link TokenDetails}. */
function extractChatCompletions(usage: unknown): TokenDetails {
  const promptDetails = getProp(usage, "prompt_tokens_details");
  const completionDetails = getProp(usage, "completion_tokens_details");
  const cachedTokens = hasProp(usage, "prompt_tokens_details")
    ? getProp(promptDetails, "cached_tokens")
    : getProp(usage, "cached_tokens");
  // Plain build (never validates): an out-of-bound garbage count must not throw out
  // of extraction — it is caught fail-open at the reporter's wire boundary (F10).
  return buildReportedTokenDetails(
    {
      input_tokens: getProp(usage, "prompt_tokens"),
      output_tokens: getProp(usage, "completion_tokens"),
      cached_input_tokens: cachedTokens,
      cache_creation_5m_tokens: getProp(promptDetails, "cache_write_tokens"),
      audio_input_tokens: getProp(promptDetails, "audio_tokens"),
      reasoning_tokens: getProp(completionDetails, "reasoning_tokens"),
      audio_output_tokens: getProp(completionDetails, "audio_tokens"),
      accepted_prediction_tokens: getProp(completionDetails, "accepted_prediction_tokens"),
      rejected_prediction_tokens: getProp(completionDetails, "rejected_prediction_tokens"),
    },
    [promptDetails, completionDetails].some((details) => details != null && !isObject(details)),
  );
}

/** Responses API usage shape → normalized {@link TokenDetails} (field-for-field mirror). */
function extractResponsesApi(usage: unknown): TokenDetails {
  const inputDetails = getProp(usage, "input_tokens_details");
  const outputDetails = getProp(usage, "output_tokens_details");
  // Plain build (never validates) — see extractChatCompletions (F10).
  return buildReportedTokenDetails(
    {
      input_tokens: getProp(usage, "input_tokens"),
      output_tokens: getProp(usage, "output_tokens"),
      cached_input_tokens: getProp(inputDetails, "cached_tokens"),
      cache_creation_5m_tokens: getProp(inputDetails, "cache_write_tokens"),
      audio_input_tokens: getProp(inputDetails, "audio_tokens"),
      reasoning_tokens: getProp(outputDetails, "reasoning_tokens"),
      audio_output_tokens: getProp(outputDetails, "audio_tokens"),
      accepted_prediction_tokens: getProp(outputDetails, "accepted_prediction_tokens"),
      rejected_prediction_tokens: getProp(outputDetails, "rejected_prediction_tokens"),
    },
    [inputDetails, outputDetails].some((details) => details != null && !isObject(details)),
  );
}

/**
 * Extract normalized usage from an OpenAI response OR a terminal stream chunk.
 * NEVER throws — unexpected shapes degrade to estimated zero counters.
 *
 * Shape detection is by property PRESENCE (first match wins), never truthiness:
 *   1. `usage` absent/null → estimated zeros.
 *   2. `usage` has either chat total → Chat Completions extraction.
 *   3. else `usage` has either Responses total → Responses API extraction.
 *   4. else → estimated zeros.
 */
export function extractOpenAIUsage(response: unknown): TokenDetails {
  return extractUsageBlock(getProp(response, "usage"));
}

/** Shape-detect and extract one already-read `usage` block (see {@link extractOpenAIUsage}). */
function extractUsageBlock(usage: unknown): TokenDetails {
  if (usage === undefined || usage === null) {
    return buildReportedTokenDetails({});
  }
  if (hasProp(usage, "prompt_tokens") || hasProp(usage, "completion_tokens")) {
    return extractChatCompletions(usage);
  }
  if (hasProp(usage, "input_tokens") || hasProp(usage, "output_tokens")) {
    return extractResponsesApi(usage);
  }
  return buildReportedTokenDetails({});
}

/**
 * Extract the `service_tier` label from a response/chunk, or `null`.
 *
 * Absent, `null`, or non-string → `null`. A string longer than
 * {@link SERVICE_TIER_MAX_LENGTH} is truncated to exactly that many characters
 * (never nulled, never thrown) with a warning logged through the injected logger.
 */
export function extractServiceTier(
  response: unknown,
  logger: Logger = consoleLogger,
): string | null {
  const tier = boundServiceTier(getProp(response, "service_tier"));
  if (tier.truncated) warnServiceTierTruncated(logger);
  return tier.value;
}

/** A bounded tier label plus whether bounding truncated it (the warning is the caller's). */
interface BoundedServiceTier {
  readonly value: string | null;
  readonly truncated: boolean;
}

const NO_SERVICE_TIER: BoundedServiceTier = { value: null, truncated: false };

function boundServiceTier(tier: unknown): BoundedServiceTier {
  if (typeof tier !== "string") {
    return NO_SERVICE_TIER;
  }
  if (tier.length > SERVICE_TIER_MAX_LENGTH) {
    return { value: tier.slice(0, SERVICE_TIER_MAX_LENGTH), truncated: true };
  }
  return { value: tier, truncated: false };
}

function warnServiceTierTruncated(logger: Logger): void {
  logger.warn(`openai: service_tier exceeds ${SERVICE_TIER_MAX_LENGTH} characters; truncating`);
}

// ---------------------------------------------------------------------------
// OpenAIStreamAccumulator
// ---------------------------------------------------------------------------

/**
 * Accumulates OpenAI streaming usage. Constructed fresh per streaming call.
 *
 * State is the `usage` block and the bounded `service_tier` label of the last
 * usage-bearing chunk observed, never the chunk itself, so a caller holding a completed
 * stream does not keep its payload reachable. Non-usage chunks are skipped without
 * clearing it (last-usage-wins). `finalize`/`getServiceTier` apply the same extraction
 * the non-streaming path uses, and a truncated tier warns once per `getServiceTier` call.
 *
 * CONCURRENCY: one instance must never be shared across two concurrent stream reads
 * (a single async consumer of one stream's chunks is the only supported driver).
 */
export class OpenAIStreamAccumulator implements StreamUsageAccumulator {
  /** `usage` of the last usage-bearing chunk; `null` until one is observed. */
  #usage: unknown = null;
  /** Bounded `service_tier` read off that same chunk. */
  #serviceTier: BoundedServiceTier = NO_SERVICE_TIER;
  readonly #logger: Logger;

  constructor(logger: Logger = consoleLogger) {
    this.#logger = logger;
  }

  observe(chunk: unknown): void {
    // Presence (not truthiness) of a non-null usage block selects the chunk, so an
    // all-zero usage still wins.
    const usage = getProp(chunk, "usage");
    if (usage === undefined || usage === null) return;
    this.#usage = usage;
    this.#serviceTier = boundServiceTier(getProp(chunk, "service_tier"));
  }

  finalize(): TokenDetails {
    return extractUsageBlock(this.#usage);
  }

  getServiceTier(): string | null {
    return settledServiceTier(this.#serviceTier, this.#logger);
  }
}

/** The retained tier label, warning (once per call) when bounding truncated it. */
function settledServiceTier(tier: BoundedServiceTier, logger: Logger): string | null {
  if (tier.truncated) warnServiceTierTruncated(logger);
  return tier.value;
}

// ---------------------------------------------------------------------------
// OpenAIResponsesStreamAccumulator
// ---------------------------------------------------------------------------

/**
 * Accumulates OpenAI **Responses API** streaming usage. Constructed fresh per streaming
 * call on the `responses` surface.
 *
 * The Responses stream is a sequence of semantic events (`response.created`,
 * `response.output_text.delta`, …, `response.completed`) rather than usage-carrying chat
 * chunks. Usage settles from the terminal event: `response.completed` (and the failure
 * variants `response.incomplete`/`response.failed`) each carry a nested `response` object
 * whose `usage` block is the Responses-API shape (`input_tokens`/`output_tokens`/…). The
 * intermediate `response.created`/`response.in_progress` events carry a `response` with
 * `usage: null` and are correctly skipped — the last event bearing a NON-null
 * `response.usage` wins, mirroring {@link OpenAIStreamAccumulator}'s last-usage-wins rule
 * one level down.
 *
 * The nested `response` exposes `.usage` and `.service_tier` exactly like a non-streaming
 * Responses-API response, so the same projection as {@link OpenAIStreamAccumulator} applies
 * one level down and the Responses-API branch of {@link extractOpenAIUsage} settles
 * it with no duplicated field mapping. The snapshot itself is never retained.
 *
 * CONCURRENCY: one instance must never be shared across two concurrent stream reads (a
 * single async consumer of one stream's events is the only supported driver).
 */
export class OpenAIResponsesStreamAccumulator implements StreamUsageAccumulator {
  /** `response.usage` of the last usage-bearing event; `null` until one is observed. */
  #usage: unknown = null;
  /** Bounded `response.service_tier` read off that same event. */
  #serviceTier: BoundedServiceTier = NO_SERVICE_TIER;
  readonly #logger: Logger;

  constructor(logger: Logger = consoleLogger) {
    this.#logger = logger;
  }

  observe(chunk: unknown): void {
    // A Responses stream event nests the response snapshot under `response`; only the
    // terminal events populate its `usage`. Presence (not truthiness) of a non-null usage
    // block selects the usage-bearing event, so a `usage` present but all-zero still wins.
    // Only that usage block and tier label are kept: the snapshot also carries generated
    // output and echoed instructions and tools.
    const response = getProp(chunk, "response");
    const usage = getProp(response, "usage");
    if (usage === undefined || usage === null) return;
    this.#usage = usage;
    this.#serviceTier = boundServiceTier(getProp(response, "service_tier"));
  }

  finalize(): TokenDetails {
    return extractUsageBlock(this.#usage);
  }

  getServiceTier(): string | null {
    return settledServiceTier(this.#serviceTier, this.#logger);
  }
}
