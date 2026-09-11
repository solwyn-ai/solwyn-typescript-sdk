/**
 * `GoogleAdapter` — the {@link ProviderAdapter} for the Google/Gemini SDK/API
 * (`@google/genai`, and the legacy `@google/generative-ai`).
 *
 * Pure, side-effect-free extraction of normalized {@link TokenDetails} from Google
 * `usageMetadata` shapes plus the small set of dispatch-shaping seams (client/model
 * detection, per-call HTTP-bound injection, streaming method selection) the registry
 * and router drive a Google client with. It computes no cost and never reads
 * prompt/response content — only `usageMetadata` numeric counters and `config` key
 * *shapes*, never message bodies.
 *
 * The one Google-specific normalization subtlety: Gemini reports
 * `candidatesTokenCount` and `thoughtsTokenCount` as SEPARATE counters —
 * `candidatesTokenCount` does NOT include thinking tokens — so `output_tokens` is the
 * SUM of the two, while `reasoning_tokens` carries the raw thinking count as well.
 *
 * Ported from `solwyn/providers/google.py`. Its companion `GoogleStreamAccumulator`
 * lives in this same file (both share the module-level `extractGoogleUsage` path).
 *
 * ZERO provider-SDK imports (CLAUDE.md invariant 3): neither `@google/genai` nor
 * `@google/generative-ai` is ever imported. Client detection is duck-typed over
 * `unknown` (Python keyed off `type(client).__module__`, which has no JS analogue —
 * the structural signal used here mirrors the exact two methods `prepareCall`
 * dispatches to: `models.generateContent` / `models.generateContentStream`).
 *
 * PRIVACY: only token counts and request/config KEY-level shaping are touched — never
 * message/prompt/tool-argument text. This module lives outside the privacy-firewall
 * allowlist and must stay that way.
 */

import { ConfigurationError, UnsupportedSurfaceError } from "../errors";
import type { TokenDetails } from "../token-details";
import { buildReportedTokenDetails, isUsageCount } from "../token-details";
import { detectGoogleClient } from "./detection";
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
import { providerTimeoutMilliseconds } from "./protocol";

// ---------------------------------------------------------------------------
// Structural narrowing helpers (duck-typing over `unknown`).
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProp(obj: unknown, key: string): unknown {
  try {
    return isObject(obj) ? obj[key] : undefined;
  } catch {
    return Number.NaN;
  }
}

/**
 * Read a non-negative token-count field. Mirrors Python's `getattr(..., k, None) or 0`
 * for valid counters: missing/malformed values degrade to `0`; a non-negative integer
 * (including explicit `0`) passes through. Extraction separately retains uncertainty.
 */
function numField(obj: Record<string, unknown>, key: string): number {
  const value = getProp(obj, key);
  return isUsageCount(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Numeric floors for the per-call HTTP bound (inline literals in Python).
// ---------------------------------------------------------------------------

/** `attempts` is retries-plus-the-original-call, floored at 1 (never 0). */
const MIN_ATTEMPTS = 1;

// ---------------------------------------------------------------------------
// Module-level extraction/shaping helpers (shared by adapter + accumulator).
// ---------------------------------------------------------------------------

/**
 * Normalize a Google `usageMetadata` object into {@link TokenDetails}. Takes the
 * usage-metadata sub-object directly (NOT the full response). Never throws — any
 * missing/`null`/unexpected shape yields an all-zero {@link TokenDetails}.
 *
 * The `output_tokens = candidatesTokenCount + thoughtsTokenCount` sum is the critical
 * normalization: Gemini reports candidates and thoughts as separate counters, so both
 * must be added for a complete output count, while `reasoning_tokens` preserves the raw
 * thoughts count on its own.
 */
function extractGoogleUsage(usageMetadata: unknown): TokenDetails {
  if (!isObject(usageMetadata)) {
    return buildReportedTokenDetails({});
  }
  const candidates = numField(usageMetadata, "candidatesTokenCount");
  const thoughts = numField(usageMetadata, "thoughtsTokenCount");
  const inputModalities = modalityTokenCounts(getProp(usageMetadata, "promptTokensDetails"));
  const outputModalities = modalityTokenCounts(getProp(usageMetadata, "candidatesTokensDetails"));
  return buildReportedTokenDetails(
    {
      input_tokens: getProp(usageMetadata, "promptTokenCount"),
      // candidatesTokenCount does NOT already include thinking tokens — sum them.
      output_tokens: candidates + thoughts,
      reasoning_tokens: getProp(usageMetadata, "thoughtsTokenCount"),
      cached_input_tokens: getProp(usageMetadata, "cachedContentTokenCount"),
      tool_use_input_tokens: getProp(usageMetadata, "toolUsePromptTokenCount"),
      image_input_tokens: inputModalities.image,
      image_output_tokens: outputModalities.image,
      audio_input_tokens: inputModalities.audio,
      audio_output_tokens: outputModalities.audio,
      // Google exposes no cache-creation-split / prediction token fields — all 0.
    },
    !isUsageCount(getProp(usageMetadata, "candidatesTokenCount")) ||
      inputModalities.unmeasured ||
      outputModalities.unmeasured,
  );
}

/** Sum valid modality detail counts without disturbing Google's aggregate counters. */
function modalityTokenCounts(value: unknown): {
  image: number;
  audio: number;
  unmeasured: boolean;
} {
  const totals = { image: 0, audio: 0, unmeasured: false };
  if (!Array.isArray(value)) {
    totals.unmeasured = value !== null && value !== undefined;
    return totals;
  }
  try {
    for (const entry of value) {
      const count = getProp(entry, "tokenCount");
      if (!isUsageCount(count)) {
        totals.unmeasured = true;
        continue;
      }
      const wrapped = getProp(entry, "modality");
      const valueName = getProp(wrapped, "value");
      const raw =
        typeof wrapped === "string"
          ? wrapped
          : typeof valueName === "string"
            ? valueName
            : getProp(wrapped, "name");
      if (typeof raw !== "string") {
        continue;
      }
      const modality = raw.toUpperCase();
      if (modality === "IMAGE") {
        totals.image += count;
      } else if (modality === "AUDIO") {
        totals.audio += count;
      }
    }
  } catch {
    totals.unmeasured = true;
  }
  return totals;
}

/**
 * Coerce a config-like value into a plain shallow dict copy: `undefined`/`null` → `{}`,
 * a plain object → a shallow-spread copy, anything else → `{}`. Pure, no I/O.
 *
 * (Python's `_mapping_from_config` also handled Pydantic-`model_dump`/`__dict__` object
 * shapes; `@google/genai`'s `GenerateContentConfig`/`HttpOptions`/`HttpRetryOptions` are
 * plain object literals with no TS analogue for those branches, so they are dropped.)
 */
function mappingFromConfig(value: unknown): Record<string, unknown> {
  return isObject(value) ? { ...value } : {};
}

/**
 * Return a NEW kwargs dict (input never mutated) with `config.httpOptions` set/overridden
 * to enforce Solwyn's immutable provider-request timeout and retry bound:
 * - `httpOptions.timeout` retains the finite native bound for all SDK versions. The
 *   dispatch owner disables it only when inspected native SDK metadata positively
 *   identifies a version with verified request-signal support.
 * - `httpOptions.retryOptions.attempts = 1` — the original call only.
 *
 * Every other caller-supplied key under `config`, `config.httpOptions`, and
 * `config.httpOptions.retryOptions` is preserved untouched (only `timeout` and
 * `retryOptions.attempts` are overwritten). The SDK's own `HttpRetryOptions.attempts`
 * default (5) is always overridden regardless.
 */
function withGoogleHttpBound(
  kwargs: Record<string, unknown>,
  timeout: number,
): Record<string, unknown> {
  const config = mappingFromConfig(kwargs["config"]);
  const httpOptions = mappingFromConfig(config["httpOptions"]);
  const retryOptions = mappingFromConfig(httpOptions["retryOptions"]);

  retryOptions["attempts"] = MIN_ATTEMPTS;
  httpOptions["timeout"] = providerTimeoutMilliseconds(timeout);
  httpOptions["retryOptions"] = retryOptions;
  config["httpOptions"] = httpOptions;

  return { ...kwargs, config };
}

/** Read constructor-created metadata without invoking optional methods or getters. */
function ownDataPath(value: unknown, path: readonly string[]): unknown {
  try {
    let current = value;
    for (const key of path) {
      if (!isObject(current)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      current = descriptor.value;
    }
    return current;
  } catch {
    return undefined;
  }
}

/** Unknown metadata retains native timeout safety; version recognition only permits cleanup. */
function hasVerifiedGoogleSignalSupport(models: unknown): boolean {
  const headers = ownDataPath(models, ["apiClient", "clientOptions", "httpOptions", "headers"]);
  const userAgent = ownDataPath(headers, ["User-Agent"]);
  const apiClient = ownDataPath(headers, ["x-goog-api-client"]);
  if (typeof userAgent !== "string" || typeof apiClient !== "string") return false;
  const pattern = /^google-genai-sdk\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/;
  const userVersion = pattern.exec(userAgent);
  const apiVersion = pattern.exec(apiClient);
  if (userVersion === null || apiVersion === null || userVersion[0] !== apiVersion[0]) return false;
  // The checked native package verifies the complete 2.20 transport surface. Older and
  // unreviewed versions keep their finite native carrier rather than guessing support.
  return Number(userVersion[1]) === 2 && Number(userVersion[2]) === 20;
}

/** Own the request timer until the buffered response or exact streaming iterator ends. */
function googleDispatch(
  method: DispatchMethod,
  receiver: unknown,
  timeout: number,
  isStreaming: boolean,
): DispatchMethod {
  return (kwargs, ...args) => {
    const params = kwargs as Record<string, unknown>;
    const config = mappingFromConfig(params["config"]);
    if (hasVerifiedGoogleSignalSupport(receiver)) {
      config["httpOptions"] = { ...mappingFromConfig(config["httpOptions"]), timeout: 0 };
    }
    const caller = config["abortSignal"] as AbortSignal | undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => controller.abort(caller?.reason);
    const dispose = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      try {
        caller?.removeEventListener("abort", onAbort);
      } catch {
        // Caller-owned signal cleanup cannot replace the provider's outcome.
      }
    };
    const finish = (result: unknown): unknown => {
      if (
        isStreaming &&
        isObject(result) &&
        typeof Reflect.get(result, Symbol.asyncIterator) === "function"
      ) {
        return deadlineStream(result as unknown as AsyncIterable<unknown>, dispose);
      }
      dispose();
      return result;
    };
    try {
      if (caller?.aborted) onAbort();
      else caller?.addEventListener("abort", onAbort, { once: true });
      if (!controller.signal.aborted) {
        timer = setTimeout(() => controller.abort(), providerTimeoutMilliseconds(timeout));
        (timer as { unref?: () => void })?.unref?.();
      }
      config["abortSignal"] = controller.signal;
      const result = method.call(receiver, { ...params, config }, ...args);
      if (isObject(result) && typeof result["then"] === "function") {
        return Promise.resolve(result)
          .then(finish)
          .catch((error: unknown) => {
            dispose();
            throw error;
          });
      }
      return finish(result);
    } catch (error) {
      dispose();
      throw error;
    }
  };
}

/** Keep timer ownership even before first pull, without reopening the native iterator. */
function deadlineStream(
  source: AsyncIterable<unknown>,
  dispose: () => void,
): AsyncIterableIterator<unknown> {
  const iterator = source[Symbol.asyncIterator]();
  let closed = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (closed) return { done: true, value: undefined };
      try {
        const result = await iterator.next();
        if (result.done) {
          closed = true;
          dispose();
        }
        return result;
      } catch (error) {
        closed = true;
        dispose();
        throw error;
      }
    },
    async return(value?: unknown) {
      if (closed) return { done: true, value };
      closed = true;
      try {
        return (await iterator.return?.(value)) ?? { done: true, value };
      } finally {
        dispose();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// GoogleAdapter
// ---------------------------------------------------------------------------

/**
 * {@link ProviderAdapter} implementation for the Google/Gemini SDK/API. Stateless (no
 * instance fields); a single shared instance is safe across concurrent async calls.
 * `name` and `dialect` are both `"google"` (distinct concepts per CLAUDE.md invariant 5,
 * identical literals here: `name` = attribution, `dialect` = wire shape).
 */
export class GoogleAdapter implements ProviderAdapter {
  readonly name = "google";
  readonly dialect: Dialect = "google";

  /**
   * Duck-typed detection of a genuine Google GenAI client.
   *
   * Python keyed off `"google.genai"` / `"google.generativeai"` in
   * `type(client).__module__`, which has no JS analogue (module paths don't survive
   * bundling). The structural signal used mirrors the exact two methods `prepareCall`
   * dispatches to: a genuine client exposes `models.generateContent` and
   * `models.generateContentStream` functions. The registry registers this adapter after
   * the OpenAI/Anthropic/compat adapters, so collision risk is low in practice.
   */
  detectClient(client: unknown): boolean {
    return detectGoogleClient(client);
  }

  /** `gemini-*` prefix match. Case-sensitive, prefix-only, no trimming. */
  detectModel(model: string): boolean {
    return model.startsWith("gemini-");
  }

  /**
   * Read `response.usageMetadata` and delegate to the shared extractor. Never throws;
   * returns an all-zero {@link TokenDetails} for any missing/`null` usage metadata or
   * unexpected response shape.
   */
  extractUsage(response: unknown): TokenDetails {
    return extractGoogleUsage(getProp(response, "usageMetadata"));
  }

  /**
   * ALWAYS `null` — Google always reports `usageMetadata`, so there is no length-based
   * estimation fallback for this provider (contrast: OpenAI-compatible adapters).
   */
  estimateMissingUsage(
    _response: unknown,
    _options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    return null;
  }

  /** ALWAYS `null` — Google responses expose no service-tier concept. */
  extractServiceTier(_response: unknown): string | null {
    return null;
  }

  /** ALWAYS `null` — Gemini API pricing is not regional (contrast: Bedrock). */
  extractRegion(_client: unknown): string | null {
    return null;
  }

  /**
   * Return a shallow copy of the input kwargs, UNCHANGED (regardless of `crossProvider`).
   * Google streams carry `usageMetadata` by default; no `stream_options`-style flag is
   * needed. The input is never mutated.
   */
  prepareStreaming(
    kwargs: Record<string, unknown>,
    _options?: PrepareStreamingOptions,
  ): Record<string, unknown> {
    return { ...kwargs };
  }

  /**
   * A fresh {@link GoogleStreamAccumulator} per streaming call. The estimate/surface
   * options are ignored entirely — Google chunks always carry their own `usageMetadata`,
   * so no pre-call estimate is needed as a fallback seed.
   */
  createStreamAccumulator(_options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    return new GoogleStreamAccumulator();
  }

  /**
   * Dispatch seam. Injects the mandatory HTTP bound (timeout/retry) into a shaped COPY of
   * kwargs, strips any `"stream"` key (the `@google/genai` `generateContent` /
   * `generateContentStream` methods take NO `stream` kwarg — streaming intent is expressed
   * purely by which method is selected), and returns a {@link PreparedDispatch} bound to
   * `client.models.generateContentStream` (streaming) or `client.models.generateContent`
   * (non-streaming). The input `kwargs` object is never mutated.
   */
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    const shaped = withGoogleHttpBound(kwargs, options.timeout);
    // `stream` is not a valid Google kwarg — remove it from the shaped COPY (input is
    // untouched: `shaped` is a fresh object).
    delete shaped["stream"];

    const models = getProp(client, "models");
    const methodName = options.isStreaming ? "generateContentStream" : "generateContent";
    const method = getProp(models, methodName);
    if (typeof method !== "function") {
      throw new ConfigurationError(`wrapped Google client does not expose models.${methodName}`, {
        field: null,
      });
    }
    const dispatch = googleDispatch(
      method as DispatchMethod,
      models,
      options.timeout,
      options.isStreaming,
    );
    return (...passthroughArgs) => dispatch(shaped, ...passthroughArgs);
  }

  /** Bound embeddings/image dispatch with Google's mandatory timeout/retry shaping. */
  prepareMediaCall(
    surface: MediaSurface,
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareMediaCallOptions,
  ): PreparedMediaCall {
    if (surface !== "embeddings" && surface !== "images" && surface !== "videos") {
      throw new UnsupportedSurfaceError({ surface, provider: this.name });
    }
    const shaped = withGoogleHttpBound(kwargs, options.timeout);
    const models = getProp(client, "models");
    const methodName =
      surface === "images"
        ? "generateImages"
        : surface === "videos"
          ? "generateVideos"
          : "embedContent";
    const method = getProp(models, methodName);
    if (typeof method !== "function") {
      throw new ConfigurationError(`wrapped Google client does not expose models.${methodName}`, {
        field: null,
      });
    }
    return {
      method: googleDispatch(method as DispatchMethod, models, options.timeout, false),
      kwargs: shaped,
    };
  }

  /** Identity — Google's streaming call already returns the iterable itself. */
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }

  /** Identity — Google-dialect callers iterate the stream wrapper object directly. */
  wrapStreamResult(wrapper: unknown, _servedResponse: unknown): unknown {
    return wrapper;
  }
}

// ---------------------------------------------------------------------------
// GoogleStreamAccumulator
// ---------------------------------------------------------------------------

/**
 * {@link StreamUsageAccumulator} for Google streams. Retains only the most recent
 * non-`null` `usageMetadata` sub-object seen across all chunks (NEVER the full chunk —
 * that would retain candidate text / safety ratings / other content-bearing fields in
 * memory). `finalize` applies the same {@link extractGoogleUsage} normalization used by
 * {@link GoogleAdapter.extractUsage}. A fresh instance is created per streaming call.
 */
export class GoogleStreamAccumulator implements StreamUsageAccumulator {
  #lastUsageMetadata: unknown = null;

  /**
   * Retain the chunk's `usageMetadata` iff present (non-`null`/`undefined`). A later chunk
   * with no `usageMetadata` does NOT erase a previously observed value (last non-null wins,
   * not last-chunk-unconditionally).
   */
  observe(chunk: unknown): void {
    const usageMetadata = getProp(chunk, "usageMetadata");
    if (usageMetadata != null) {
      this.#lastUsageMetadata = usageMetadata;
    }
  }

  /**
   * Settle final usage from the last-retained `usageMetadata`, or all-zero
   * {@link TokenDetails} if no chunk ever carried usage. Never throws.
   */
  finalize(): TokenDetails {
    return extractGoogleUsage(this.#lastUsageMetadata);
  }

  /** ALWAYS `null` — Google streams expose no service-tier concept. */
  getServiceTier(): string | null {
    return null;
  }
}
