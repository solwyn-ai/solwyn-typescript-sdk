/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * Structural guardrails: provider validation, the fail-closed forbidden-key /
 * recognized-kwarg catalogue, and the `guard` helper that converts any non-structural
 * failure into a value-free `UntranslatableRequestError`. Pure; no I/O capability of
 * any kind (no network client, no diagnostic sink). Every label emitted here is a
 * structural identifier only — never prompt/response content, never an offending value.
 */

import { UntranslatableRequestError, type UntranslatableRequestErrorOptions } from "../../errors";

export const PROVIDERS = ["openai", "anthropic", "google", "bedrock"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

// Only private, immutable structural labels are retained. The weak key does not
// keep an escaped error alive, and caller-added fields are never inspected.
const structuralErrors = new WeakMap<object, Readonly<UntranslatableRequestErrorOptions>>();

function structuralProvider(provider: string): ProviderName | "*" {
  switch (provider) {
    case "openai":
    case "anthropic":
    case "google":
    case "bedrock":
      return provider;
    default:
      return "*";
  }
}

function structuralError(
  source: string,
  target: string,
  feature: string,
): UntranslatableRequestError {
  const labels = Object.freeze({
    source: structuralProvider(source),
    target: structuralProvider(target),
    feature,
  });
  const error = new UntranslatableRequestError(labels);
  structuralErrors.set(error, labels);
  return error;
}

/**
 * Validate a provider string. Throws a plain (non-structural) error whose message
 * contains the substring `provider` for an unrecognized value — this guard never
 * touches content and is intentionally NOT an `UntranslatableRequestError`.
 */
export function validateProvider(provider: string): asserts provider is ProviderName {
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`unknown provider: expected one of ${PROVIDERS.join(", ")}`);
  }
}

/** Raise a structural, value-free translation error. */
export function raise(source: string, target: string, feature: string): never {
  throw structuralError(source, target, feature);
}

/**
 * Reconstruct failures from private provenance, preserving known structural labels
 * without trusting an escaped error's mutable fields, constructor, or prototype.
 * Other thrown values use the fixed fallback labels; no original value is retained.
 */
export function guard<T>(source: string, target: string, feature: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const labels =
      (typeof err === "object" && err !== null) || typeof err === "function"
        ? structuralErrors.get(err)
        : undefined;
    throw structuralError(
      labels?.source ?? source,
      labels?.target ?? target,
      labels?.feature ?? feature,
    );
  }
}

/**
 * Universally-forbidden config/request keys. Presence with a non-null value raises with
 * the label equal to the key name, regardless of which dialect parses it.
 */
export const FORBIDDEN_KEYS = new Set<string>([
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "top_k",
  "response_format",
  "response_schema",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "service_tier",
  "reasoning_effort",
  "reasoning",
  "thinking",
  "thinking_config",
  "cache_control",
  "cached_content",
  "response_mime_type",
]);

/** Native Google spellings map to existing fixed structural diagnostics. */
const GOOGLE_FORBIDDEN_KEYS: Readonly<Record<string, string>> = {
  topK: "top_k",
  responseSchema: "response_schema",
  responseJsonSchema: "response_schema",
  responseMimeType: "response_mime_type",
  responseLogprobs: "logprobs",
  frequencyPenalty: "frequency_penalty",
  presencePenalty: "presence_penalty",
  thinkingConfig: "thinking_config",
  cachedContent: "cached_content",
  serviceTier: "service_tier",
};

export const RECOGNIZED_OPENAI_TOP_LEVEL = new Set<string>([
  "model",
  "messages",
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
]);

export const RECOGNIZED_ANTHROPIC_TOP_LEVEL = new Set<string>([
  "model",
  "messages",
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
]);

export const RECOGNIZED_GOOGLE_TOP_LEVEL = new Set<string>([
  "model",
  "contents",
  "config",
  "stream",
]);

export const RECOGNIZED_GOOGLE_CONFIG = new Set<string>([
  "systemInstruction",
  "maxOutputTokens",
  "temperature",
  "topP",
  "stopSequences",
  "tools",
  "toolConfig",
  "candidateCount",
]);

export const RECOGNIZED_BEDROCK_TOP_LEVEL = new Set<string>([
  "model",
  "messages",
  "system",
  "inferenceConfig",
  "toolConfig",
  "stream",
]);

export const RECOGNIZED_BEDROCK_INFERENCE_CONFIG = new Set<string>([
  "maxTokens",
  "temperature",
  "topP",
  "stopSequences",
]);

/**
 * Dedicated forbidden-count checks (Python `_check_forbidden_keys` step 1): `n > 1`
 * (OpenAI) and `candidate_count > 1` (Gemini) each raise their OWN structural label,
 * which takes precedence over the generic `unsupported_kwarg.<key>` fallback. Wired
 * into EVERY dialect's scope(s) — the label is dialect-independent. Only the count is
 * inspected; the value is never read into an error.
 */
export function checkForbiddenCounts(scope: Record<string, unknown>, source: string): void {
  const n = scope["n"];
  if (typeof n === "number" && n > 1) raise(source, "*", "n>1");
  const cc = scope["candidateCount"] ?? scope["candidate_count"];
  if (typeof cc === "number" && cc > 1) raise(source, "*", "candidate_count>1");
}

/**
 * Scan own keys: forbidden keys take precedence. Known API keys retain fixed labels;
 * arbitrary keys use `unsupported_kwarg` because object keys can contain content.
 */
export function scanScope(
  obj: Record<string, unknown>,
  recognized: Set<string>,
  source: string,
): void {
  for (const key of Object.keys(obj)) {
    if (source === "google" && Object.hasOwn(GOOGLE_FORBIDDEN_KEYS, key) && obj[key] != null) {
      raise(source, "*", GOOGLE_FORBIDDEN_KEYS[key] ?? "unsupported_kwarg");
    }
    if (FORBIDDEN_KEYS.has(key) && obj[key] != null) {
      raise(source, "*", key);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!recognized.has(key)) {
      raise(
        source,
        "*",
        SAFE_KNOWN_KEYS.has(key) ? `unsupported_kwarg.${key}` : "unsupported_kwarg",
      );
    }
  }
}

// Closed vocabulary only. A syntactically plausible identifier is still caller data.
const SAFE_KNOWN_KEYS = new Set([
  ...FORBIDDEN_KEYS,
  ...Object.keys(GOOGLE_FORBIDDEN_KEYS),
  ...RECOGNIZED_OPENAI_TOP_LEVEL,
  ...RECOGNIZED_ANTHROPIC_TOP_LEVEL,
  ...RECOGNIZED_GOOGLE_TOP_LEVEL,
  ...RECOGNIZED_GOOGLE_CONFIG,
  ...RECOGNIZED_BEDROCK_TOP_LEVEL,
  ...RECOGNIZED_BEDROCK_INFERENCE_CONFIG,
  "n",
  "candidate_count",
  "max_output_tokens",
]);
