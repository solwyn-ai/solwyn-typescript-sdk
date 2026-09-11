/**
 * `OpenAICompatibleAdapter` — one {@link ProviderAdapter} class, many provider
 * *identities*. Every OpenAI-compatible vendor (Groq, DeepSeek, Mistral, xAI, Qwen, Z.ai,
 * Together, Fireworks, Perplexity, Azure OpenAI, OpenRouter, Ollama, vLLM, LM Studio,
 * and a generic catch-all) speaks the OpenAI Chat Completions wire dialect but is a
 * DISTINCT provider for attribution, budgets, pricing, and circuit breaking. The
 * adapter is parameterized by a static {@link CompatProfile} drawn from the ordered
 * {@link COMPAT_PROFILES} table (order is load-bearing — CLAUDE.md invariant 4).
 *
 * The cost path is the whole point: a compat endpoint can return a perfect completion
 * while omitting usage (especially when streaming). Both the non-streaming
 * {@link OpenAICompatibleAdapter.estimateMissingUsage} and the streaming
 * {@link CompatStreamAccumulator} settle usage through a three-tier fallback —
 * real usage → Groq legacy `x_groq.usage` → length-based estimate marked
 * `is_estimated: true` (invariant 6: a compat endpoint can never silently report zero
 * spend).
 *
 * Ported from `solwyn/providers/openai_compatible.py`. Reuses the shared OpenAI-dialect
 * extractors (`extractOpenAIUsage`, `extractServiceTier`, `usageValue`) from
 * `./accumulator` rather than reimplementing Chat-Completions parsing.
 *
 * ZERO provider-SDK imports (CLAUDE.md invariant 3): no vendor package is imported;
 * client detection is duck-typed over `unknown`.
 *
 * PRIVACY: this module lives OUTSIDE the content-privileged allowlist. It never reads
 * `content` / `reasoning_content` / `tool_calls[].function.arguments` directly — every
 * content-length measurement is delegated to `src/privacy.ts` (which returns integer
 * counts only). Only token counts, a tier label, and request/response KEY-level shaping
 * are touched here.
 */

import { ConfigurationError, UnsupportedSurfaceError } from "../errors";
import type { Logger } from "../logging";
import { consoleLogger } from "../logging";
import {
  estimateResponseContentLength,
  estimateStreamChunkContentLength,
  estimateTokensFromLength,
} from "../privacy";
import type { TokenDetails } from "../token-details";
import { buildTokenDetails } from "../token-details";
import type { ProviderName } from "../types";
import { extractOpenAIUsage, extractServiceTier, usageValue } from "./accumulator";
import { COMPAT_PROFILES, type CompatProfile, matchOpenAICompatibleClient } from "./detection";
import { prepareOpenAIDialectMediaCall } from "./openai";
import type {
  CreateStreamAccumulatorOptions,
  Dialect,
  DispatchMethod,
  EstimateMissingUsageOptions,
  MediaSurface,
  PrepareCallOptions,
  PreparedDispatch,
  PreparedMediaCall,
  PrepareMediaCallOptions,
  PrepareStreamingOptions,
  ProviderAdapter,
  StreamUsageAccumulator,
} from "./protocol";
import { mergeProviderRequestOptions, providerTimeoutMilliseconds } from "./protocol";

export type { CompatProfileConfig } from "./detection";
export { COMPAT_PROFILES, CompatProfile } from "./detection";

// ---------------------------------------------------------------------------
// Structural narrowing helpers (duck-typing over `unknown`).
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Safe property read: `undefined` for non-objects or absent keys. */
function getProp(obj: unknown, key: string): unknown {
  return isObject(obj) ? obj[key] : undefined;
}

/**
 * The estimation math's chars/token ratio keys off the coarse provider dialect, not the
 * per-vendor `name`: every compat vendor speaks the OpenAI dialect, so estimation uses
 * the `"openai"` ratio (4.0), mirroring the Python module's `estimate_tokens_from_length(
 * chars, "openai")` call.
 */
const ESTIMATE_RATIO_PROVIDER = "openai";

// ---------------------------------------------------------------------------
// Usage helpers.
// ---------------------------------------------------------------------------

/**
 * Coerce `usage[key]` to a non-negative integer, degrading any garbage — including a
 * null/undefined `usage`, a boolean, a float, a string, or a negative — to `0`. This
 * degrade-to-zero is what routes garbage counts into the estimation fallback instead of
 * raising or being trusted as real spend. Mirrors the Python `_usage_int` helper via the
 * shared {@link usageValue} coercion.
 */
function usageInt(usage: unknown, key: string): number {
  return usageValue(getProp(usage, key));
}

/**
 * True iff a Chat-Completions-shaped `usage` block parsed to a non-zero prompt OR
 * completion token count — i.e. the provider reported REAL usage. An all-zero, absent,
 * or garbage block is false, routing the caller into estimation.
 */
function hasRealUsage(usage: unknown): boolean {
  return usageInt(usage, "prompt_tokens") > 0 || usageInt(usage, "completion_tokens") > 0;
}

/**
 * Azure "on your data" (RAG) detection: a NON-NULL `data_sources` value at the top level,
 * OR a NON-NULL `data_sources` value inside `extra_body`. The value must actually be present
 * (not `null`/`undefined`), never mere key-presence — matching Python's
 * `extra_body.get("data_sources") is not None` (`openai_compatible.py:241`), so an explicit
 * `extra_body: {data_sources: null}` is NOT treated as using the on-your-data pipeline and
 * `include_usage` injection still happens. That pipeline 422s on `stream_options`, so Azure
 * skips `include_usage` injection when it IS detected (behavior specific to `azure_openai`).
 */
function usesAzureDataSources(kwargs: Record<string, unknown>): boolean {
  const topLevel = kwargs["data_sources"];
  if (topLevel !== undefined && topLevel !== null) {
    return true;
  }
  const extraBody = kwargs["extra_body"];
  // `!= null` is `!== null && !== undefined` — the JS analog of Python's `is not None` over a
  // `.get()` (which yields None for both an absent key and an explicit null).
  return isObject(extraBody) && extraBody["data_sources"] != null;
}

// ---------------------------------------------------------------------------
// OpenAICompatibleAdapter
// ---------------------------------------------------------------------------

/** Options for {@link OpenAICompatibleAdapter}. */
export interface OpenAICompatibleAdapterOptions {
  logger?: Logger;
}

/** Verbatim operational message for the one-time local-port-heuristic INFO notice. */
function portHeuristicMessage(name: string): string {
  return `Detected a local OpenAI-compatible server on its conventional port as provider '${name}'; pass provider=... to Solwyn to override.`;
}

/**
 * {@link ProviderAdapter} for one OpenAI-compatible vendor. `name` is the vendor's
 * attribution identity; `dialect` is always `"openai"`.
 *
 * Instance-local one-time-log latches (adapters are registry singletons, one per
 * profile): `#warnedMissingUsage` gates the WARNING logged the first time estimation
 * fires; `#notedPortHeuristic` gates the INFO logged the first time a local-port-based
 * detection fires. Node's single-threaded event loop makes these latches race-free — no
 * lock needed (stricter than Python's "rare double-log acceptable" note).
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: ProviderName;
  readonly dialect: Dialect = "openai";
  readonly supportsResponses: boolean;
  readonly profile: CompatProfile;
  readonly #logger: Logger;
  #warnedMissingUsage = false;
  #notedPortHeuristic = false;

  constructor(profile: CompatProfile, options: OpenAICompatibleAdapterOptions = {}) {
    this.profile = profile;
    this.name = profile.name;
    this.supportsResponses = profile.supportsResponses;
    this.#logger = options.logger ?? consoleLogger;
  }

  /**
   * Emit the missing-usage WARNING exactly once per adapter instance. Called by BOTH the
   * non-streaming estimation path and the streaming accumulator the first time either
   * settles on a length-based estimate. The message carries only the provider name — never
   * any content.
   */
  warnMissingUsageOnce(): void {
    if (this.#warnedMissingUsage) {
      return;
    }
    this.#warnedMissingUsage = true;
    this.#logger.warn(
      `Provider '${this.name}' returned no token usage; settling with a length-based estimate (is_estimated=true).`,
    );
  }

  /**
   * Duck-typed detection of an OpenAI-SDK-shaped client configured for this vendor.
   *
   * Gate: a genuine OpenAI-dialect client exposes `chat.completions.create` OR has a
   * constructor name containing `"openai"` (mirrors {@link OpenAIAdapter.detectClient};
   * the real module-path check has no JS analogue). A client failing the gate (e.g. an
   * Anthropic client) is rejected even if its base URL happens to match a compat host.
   *
   * Then: class-name-prefix match (Azure's dedicated client classes) is checked FIRST,
   * independent of base URL. Otherwise the base URL is parsed and delegated to
   * {@link CompatProfile.matchesUrl}. On a first local-port heuristic match, one INFO is
   * logged (provider name only — never the URL, which may carry credentials).
   */
  detectClient(client: unknown): boolean {
    const match = matchOpenAICompatibleClient(client, this.profile);
    if (match.matchedByLocalPort && !this.#notedPortHeuristic) {
      this.#notedPortHeuristic = true;
      this.#logger.info(portHeuristicMessage(this.name));
    }
    return match.matched;
  }

  /** True iff `model` starts with one of this profile's prefixes (case-sensitive). */
  detectModel(model: string): boolean {
    return this.profile.modelPrefixes.some((prefix) => model.startsWith(prefix));
  }

  /** Delegates to the shared OpenAI-dialect extractor. Never throws. */
  extractUsage(response: unknown): TokenDetails {
    return extractOpenAIUsage(response);
  }

  /**
   * Length-based estimated usage for a compat response that reported NO usable usage.
   * Returns `null` when the provider reported real usage, or when an all-zero usage block
   * accompanies genuinely empty content (that zero is provider truth). Otherwise returns a
   * `TokenDetails` marked `is_estimated: true` with `input_tokens` = the caller's pre-call
   * estimate and `output_tokens` = length-based estimate of the visible response content.
   * Never throws.
   */
  estimateMissingUsage(
    response: unknown,
    options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    try {
      const usage = getProp(response, "usage");
      if (hasRealUsage(usage)) {
        // Provider reported real usage — never override it with an estimate.
        return null;
      }
      const outputChars = estimateResponseContentLength(response);
      const usagePresent = usage !== undefined && usage !== null;
      if (usagePresent && outputChars === 0) {
        // An all-zero usage block with no visible content is provider truth (empty
        // response), NOT a gap — trust the zero.
        return null;
      }
      // Either usage is absent, or a reported zero is contradicted by visible content
      // (the anti-silent-zero-spend case). Estimate and flag.
      const outputTokens =
        outputChars > 0 ? estimateTokensFromLength(outputChars, ESTIMATE_RATIO_PROVIDER) : 0;
      this.warnMissingUsageOnce();
      return buildTokenDetails({
        input_tokens: options.estimatedInputTokens,
        output_tokens: outputTokens,
        is_estimated: true,
      });
    } catch {
      // Never throw out of the settlement path.
      return null;
    }
  }

  /** Delegates to the shared extractor (bounded to 32 chars, truncation warns). */
  extractServiceTier(response: unknown): string | null {
    return extractServiceTier(response, this.#logger);
  }

  /** ALWAYS `null` — compat providers carry no per-region pricing contract. */
  extractRegion(_client: unknown): string | null {
    return null;
  }

  /**
   * Return a NEW kwargs object shaped for a streaming call — never mutating the input.
   *
   * Injection policy is per-profile: providers with `supportsIncludeUsage` get
   * `stream_options.include_usage = true` merged in (Azure additionally skips injection
   * when its "on your data" pipeline is detected). For non-injecting providers the drop-in
   * contract applies: a caller's OWN `stream_options` is preserved untouched on their own
   * target (`crossProvider: false`), but STRIPPED on a cross-provider failover hop
   * (`crossProvider: true`) because it was authored for a different endpoint.
   */
  prepareStreaming(
    kwargs: Record<string, unknown>,
    options?: PrepareStreamingOptions,
  ): Record<string, unknown> {
    if (this.#shouldInjectIncludeUsage(kwargs)) {
      const next: Record<string, unknown> = { ...kwargs };
      const existing = kwargs["stream_options"];
      const streamOptions: Record<string, unknown> = isObject(existing) ? { ...existing } : {};
      streamOptions["include_usage"] = true;
      next["stream_options"] = streamOptions;
      return next;
    }
    const crossProvider = options?.crossProvider ?? false;
    const next: Record<string, unknown> = { ...kwargs };
    if (crossProvider && "stream_options" in next) {
      // A cross-vendor hop: a caller-supplied stream_options was authored for the ORIGINAL
      // target and this endpoint may 4xx on it — strip it (on the copy, never the input).
      delete next["stream_options"];
    }
    return next;
  }

  /** Whether to inject `stream_options.include_usage` for this call. */
  #shouldInjectIncludeUsage(kwargs: Record<string, unknown>): boolean {
    if (!this.profile.supportsIncludeUsage) {
      return false;
    }
    if (this.profile.name === "azure_openai" && usesAzureDataSources(kwargs)) {
      return false;
    }
    return true;
  }

  /** Fresh accumulator per streaming call (length-based estimation on missing usage). */
  createStreamAccumulator(options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    return new CompatStreamAccumulator({
      adapter: this,
      estimatedInputTokens: options?.estimatedInputTokens ?? 0,
      logger: this.#logger,
    });
  }

  /**
   * Dispatch seam. Maps the `chat` surface to `client.chat.completions.create` and returns a
   * {@link PreparedDispatch} bound to that receiver over a shaped COPY of kwargs (input never
   * mutated). For a streaming call it folds in this profile's `stream_options` injection policy
   * ({@link prepareStreaming}) and sets `stream: true`. `timeout`/`maxRetries` are accepted but
   * ignored (the caller applies HTTP bounds).
   *
   * Responses dispatch is capability-gated by the static profile table. Azure OpenAI binds
   * create/parse directly; every other compatibility profile fails loud rather than silently
   * rewriting a Responses-shaped request onto Chat Completions.
   */
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    if (options.surface === "responses") {
      if (!this.supportsResponses) {
        throw new UnsupportedSurfaceError({
          surface: `responses.${options.responsesLeaf ?? "create"}`,
          provider: this.name,
        });
      }
      const leaf = options.responsesLeaf ?? "create";
      if (leaf !== "create" && leaf !== "parse" && leaf !== "stream") {
        throw new ConfigurationError(`unsupported Azure OpenAI Responses leaf: ${leaf}`, {
          field: null,
        });
      }
      const shaped = { ...kwargs };
      if (options.isStreaming && leaf !== "stream") {
        shaped["stream"] = true;
      }
      const responses = getProp(client, "responses");
      const method = getProp(responses, leaf);
      if (typeof method !== "function") {
        throw new ConfigurationError(
          `wrapped OpenAI-compatible client does not expose responses.${leaf}`,
          { field: null },
        );
      }
      const fn = method as DispatchMethod;
      return (...passthroughArgs) =>
        fn.call(
          responses,
          shaped,
          ...mergeProviderRequestOptions(passthroughArgs, {
            timeout: providerTimeoutMilliseconds(options.timeout),
            maxRetries: 0,
          }),
        );
    }
    const shaped: Record<string, unknown> = options.isStreaming
      ? this.prepareStreaming(kwargs, { crossProvider: options.crossProvider })
      : { ...kwargs };
    if (options.isStreaming) {
      shaped["stream"] = true;
    }
    const completions = getProp(getProp(client, "chat"), "completions");
    const method = getProp(completions, "create");
    if (typeof method !== "function") {
      throw new ConfigurationError(
        "wrapped OpenAI-compatible client does not expose chat.completions.create",
        { field: null },
      );
    }
    const fn = method as DispatchMethod;
    return (...passthroughArgs) =>
      fn.call(
        completions,
        shaped,
        ...mergeProviderRequestOptions(passthroughArgs, {
          timeout: providerTimeoutMilliseconds(options.timeout),
          maxRetries: 0,
        }),
      );
  }

  /** Bound primary-only embeddings dispatch shared by every compatibility profile. */
  prepareMediaCall(
    surface: MediaSurface,
    client: unknown,
    kwargs: Record<string, unknown>,
    _options: PrepareMediaCallOptions,
  ): PreparedMediaCall {
    return prepareOpenAIDialectMediaCall(surface, client, kwargs, _options, {
      provider: this.name,
      clientLabel: "OpenAI-compatible",
    });
  }

  /** Identity — the streaming call's return value is already the iterable. */
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }

  /** Identity — OpenAI-dialect callers iterate the stream object directly. */
  wrapStreamResult(wrapper: unknown, _servedResponse: unknown): unknown {
    return wrapper;
  }
}

// ---------------------------------------------------------------------------
// CompatStreamAccumulator
// ---------------------------------------------------------------------------

/** Constructor options for {@link CompatStreamAccumulator}. */
export interface CompatStreamAccumulatorOptions {
  adapter: OpenAICompatibleAdapter;
  estimatedInputTokens?: number;
  logger?: Logger;
}

/**
 * Settles streaming usage through the three-tier fallback:
 *   1. standard `usage` on any chunk (last non-zero wins),
 *   2. else Groq legacy `x_groq.usage` (last non-zero wins),
 *   3. else a length-based estimate from accumulated delta content (marks
 *      `is_estimated: true` and fires the owning adapter's one-time WARNING).
 *
 * Content length is accumulated on every observed chunk until real standard or legacy usage
 * latches, so tier 3 always has a length to work from. `observe` never throws — a malformed
 * chunk must never convert a healthy, deliverable stream into a recorded provider failure.
 *
 * CONCURRENCY: one instance must never be shared across two concurrent stream reads.
 */
export class CompatStreamAccumulator implements StreamUsageAccumulator {
  readonly #adapter: OpenAICompatibleAdapter;
  readonly #estimatedInputTokens: number;
  readonly #logger: Logger;
  /** Last standard-usage TokenDetails latched from a non-zero chunk `usage`. */
  #standardUsage: TokenDetails | null = null;
  /** Last `x_groq`-derived TokenDetails latched from a non-zero legacy field. */
  #xGroqUsage: TokenDetails | null = null;
  /** Explicit zero totals are trustworthy only if the completed stream emitted no content. */
  #zeroUsage: TokenDetails | null = null;
  /** Last non-null `service_tier` observed on any chunk. */
  #serviceTier: string | null = null;
  /** Accumulated delta content character length across all observed chunks. */
  #contentChars = 0;

  constructor(options: CompatStreamAccumulatorOptions) {
    this.#adapter = options.adapter;
    this.#estimatedInputTokens = options.estimatedInputTokens ?? 0;
    this.#logger = options.logger ?? consoleLogger;
  }

  observe(chunk: unknown): void {
    // Tier 3 needs structural content only until real usage has settled either authoritative
    // tier. Afterwards retain usage/tier extraction below, but avoid walking later delta bodies.
    if (this.#standardUsage === null && this.#xGroqUsage === null) {
      this.#contentChars += estimateStreamChunkContentLength(chunk);
    }
    try {
      const usage = getProp(chunk, "usage");
      let usageHolder = chunk;
      if (usage !== undefined && usage !== null && !hasRealUsage(usage)) {
        const details = extractOpenAIUsage(chunk);
        this.#zeroUsage = details.is_estimated ? null : details;
      }
      if (hasRealUsage(usage)) {
        // Tier 1: a chunk with real standard usage. Last non-zero wins (an all-zero
        // placeholder or a trailing usage-less terminal chunk never latches/clears).
        this.#standardUsage = extractOpenAIUsage(chunk);
      } else {
        const response = getProp(chunk, "response");
        const nestedUsage = getProp(response, "usage");
        if (nestedUsage !== null && nestedUsage !== undefined) {
          // Responses terminal events carry usage and service tier on the nested response.
          // Preserve an all-zero block here: the Responses settlement policy in the client
          // owns conversion to an unmeasured preflight estimate, while chat zero placeholders
          // above retain their existing non-latching behavior.
          usageHolder = response;
          this.#standardUsage = extractOpenAIUsage(response);
        }
      }
      const xGroqUsage = getProp(getProp(chunk, "x_groq"), "usage");
      if (hasRealUsage(xGroqUsage)) {
        // Tier 2: Groq's legacy field. Wrapped so the shared extractor reads it off `.usage`.
        this.#xGroqUsage = extractOpenAIUsage({ usage: xGroqUsage });
      } else if (xGroqUsage !== undefined && xGroqUsage !== null) {
        const details = extractOpenAIUsage({ usage: xGroqUsage });
        this.#zeroUsage = details.is_estimated ? null : details;
      }
      const tier =
        extractServiceTier(usageHolder, this.#logger) ?? extractServiceTier(chunk, this.#logger);
      if (tier !== null) {
        this.#serviceTier = tier;
      }
    } catch {
      // Best-effort: never raise out of observe(); content length is already accumulated.
    }
  }

  finalize(): TokenDetails {
    if (this.#standardUsage !== null) {
      return this.#standardUsage;
    }
    if (this.#xGroqUsage !== null) {
      return this.#xGroqUsage;
    }
    if (this.#zeroUsage !== null && this.#contentChars === 0) return this.#zeroUsage;
    // Tier 3: no usable usage anywhere — settle from accumulated content length.
    const outputTokens =
      this.#contentChars > 0
        ? estimateTokensFromLength(this.#contentChars, ESTIMATE_RATIO_PROVIDER)
        : 0;
    this.#adapter.warnMissingUsageOnce();
    return buildTokenDetails({
      input_tokens: this.#estimatedInputTokens,
      output_tokens: outputTokens,
      is_estimated: true,
    });
  }

  getServiceTier(): string | null {
    return this.#serviceTier;
  }
}

// ---------------------------------------------------------------------------
// buildCompatAdapters
// ---------------------------------------------------------------------------

/**
 * Build one {@link OpenAICompatibleAdapter} per entry in {@link COMPAT_PROFILES}, in the
 * same order — exactly 15 adapters, `xai` first, `openai_compatible` last.
 */
export function buildCompatAdapters(
  options: OpenAICompatibleAdapterOptions = {},
): OpenAICompatibleAdapter[] {
  return COMPAT_PROFILES.map((profile) => new OpenAICompatibleAdapter(profile, options));
}
