/**
 * The `ProviderAdapter` structural interface every provider adapter (OpenAI,
 * Anthropic, Google, Bedrock, and all OpenAI-compatible adapters) must satisfy,
 * plus the `Dialect` union and the `StreamUsageAccumulator` interface consumed by
 * streaming.
 *
 * Ported from `solwyn/providers/_protocol.py` + `_accumulator.py`. Python's
 * `@runtime_checkable Protocol` becomes a plain TS `interface`: conformance is a
 * compile-time guarantee (every member is mandatory — there is no optional
 * fallback), not a runtime `isinstance` check.
 *
 * No code path here reads prompt/response CONTENT — only token counts, a tier
 * label, and request/response key-level shaping. This module lives outside the
 * privacy-firewall allowlist and must stay that way.
 */

import { ConfigurationError } from "../errors";
import type { TokenDetails } from "../token-details";
import type { MediaUsage, Modality, ProviderName } from "../types";

/**
 * Reserved kwargs-bag key under which the Bedrock proxy threads the customer's ORIGINAL
 * AWS SDK v3 command (`ConverseCommand` / `ConverseStreamCommand`) through the
 * dialect-agnostic pipeline to {@link ProviderAdapter.prepareCall}.
 *
 * Bedrock's TS dispatch is `client.send(command)` (not boto3-style `converse`/
 * `converse_stream` methods), so the command boundary is the proxy: it renames
 * `command.input.modelId` → the pipeline `model` key (for budget/attribution/estimation)
 * and stashes the untouched command here so the adapter can `send` it. A `symbol` key
 * cannot collide with a Converse input field and is invisible to `estimateContentLength`'s
 * string-key walk. The M3 primary hop passes the command through UNTOUCHED; M4 model
 * override (failover) rebuilds a sibling via `new (command.constructor)({...input, modelId})`.
 */
export const BEDROCK_NATIVE_COMMAND: unique symbol = Symbol("solwyn.bedrock.native-command");
/** Sanitized proxy-time command input, kept internal to the Bedrock dispatch seam. */
export const BEDROCK_NATIVE_INPUT_SNAPSHOT: unique symbol = Symbol(
  "solwyn.bedrock.native-input-snapshot",
);

/**
 * Wire shape / dispatch dialect. Exactly these four literals. Drives
 * dispatch-method selection and cross-dialect translation. Every OpenAI-compatible
 * adapter reports dialect `"openai"` while keeping its own `name`.
 */
export type Dialect = "openai" | "anthropic" | "google" | "bedrock";

/**
 * Which intercepted call surface a request arrived on. Drives per-adapter wire-method
 * selection ({@link ProviderAdapter.prepareCall}) and per-surface accumulator selection
 * ({@link ProviderAdapter.createStreamAccumulator}) WITHOUT the dispatcher knowing any
 * dialect's method shapes. The OpenAI adapter maps `"chat"` → `chat.completions.create`
 * and `"responses"` → `responses.create`; the M3 dialects add `"messages"` (Anthropic
 * `messages.create`), `"models"` (Google `models.generateContent[Stream]`), and
 * `"converse"` (Bedrock — dispatched via AWS SDK v3 `client.send(command)`). The Anthropic/Google/Bedrock
 * adapters ignore the surface value (each dialect has one intercepted surface); only the
 * OpenAI adapter branches on it.
 */
export type DispatchSurface = "chat" | "responses" | "messages" | "models" | "converse";

/** A tracked non-chat provider surface. */
export type MediaSurface =
  | "embeddings"
  | "images"
  | "audio.transcriptions"
  | "audio.speech"
  | "videos";

/** Content-free resolved attribution passed to post-dispatch media usage extraction. */
export interface MediaExtractionContext {
  readonly effectiveModel: string;
  readonly provider: ProviderName;
}

/**
 * The shared measurement contract for one tracked non-chat call. Every hook is total:
 * malformed or unobservable provider/request data degrades to `null`, never an exception.
 * In particular, extraction and settled measurement run after paid dispatch and must never
 * throw in a way that could replace the provider response with a local metering failure.
 */
export interface MediaSurfaceSpec {
  readonly surface: MediaSurface;
  readonly modality: Modality;
  /** Observed token usage for the resolved served attribution, or `null`; never throws. */
  extractUsage(response: unknown, context: MediaExtractionContext): TokenDetails | null;
  /** Privacy-safe request token measurement/fallback, or `null`; never throws. */
  measureRequest(kwargs: Record<string, unknown>): TokenDetails | null;
  /** Settled media usage, or `null` when missing/malformed; never throws after dispatch. */
  measureMedia(kwargs: Record<string, unknown>, response: unknown): MediaUsage | null;
  /** Privacy-safe preflight media estimate, or `null`; never throws. */
  estimateMedia(kwargs: Record<string, unknown>): MediaUsage | null;
}

/** Timeout/retry shaping passed to an adapter's optional media dispatch seam. */
export interface PrepareMediaCallOptions {
  /** Per-call bound in seconds. */
  timeout: number;
  /** Media calls do not retry; the lifecycle always supplies zero. */
  maxRetries: number;
}

/** Bound method plus the adapter-shaped kwargs it should receive. */
export interface PreparedMediaCall {
  method: DispatchMethod;
  kwargs: Record<string, unknown>;
}

/** Options passed to {@link ProviderAdapter.prepareStreaming}. */
export interface PrepareStreamingOptions {
  /**
   * Marks a failover hop serving a request authored for a *different* provider.
   * An adapter MAY sanitize options meant for the original target under this flag,
   * but is not required to branch on it.
   */
  crossProvider?: boolean;
}

/** Options passed to {@link ProviderAdapter.createStreamAccumulator}. */
export interface CreateStreamAccumulatorOptions {
  /** Consumed only by compat accumulators (length-based estimation); ignored by OpenAI's. */
  estimatedInputTokens?: number;
  /**
   * The surface the streaming call arrived on, so an adapter can pick the accumulator
   * matching the stream's terminal-usage shape (OpenAI Chat Completions settles usage
   * from the final chunk's `usage`; the Responses API settles it from the
   * `response.completed` event's `response.usage`). Defaults to `"chat"` when absent.
   */
  surface?: DispatchSurface;
}

/** Options passed to {@link ProviderAdapter.estimateMissingUsage}. */
export interface EstimateMissingUsageOptions {
  estimatedInputTokens: number;
}

/** Options passed to {@link ProviderAdapter.prepareCall}. */
export interface PrepareCallOptions {
  /** Which intercepted surface the call arrived on; the adapter maps it to a wire method. */
  surface: DispatchSurface;
  /** Concrete Responses resource leaf; absent for every non-Responses surface. */
  responsesLeaf?: "create" | "parse" | "stream";
  isStreaming: boolean;
  /**
   * Marks a failover hop serving a request authored for a *different* provider (M4
   * cross-dialect / same-dialect cross-vendor failover). The adapter owns whatever
   * per-hop sanitization this implies (e.g. dropping a caller-authored `stream_options`
   * a foreign endpoint would 4xx on); the dispatcher never branches on it. Always
   * `false` while only the primary hop is served.
   */
  crossProvider: boolean;
  /**
   * The immutable per-call provider request bound, in **SECONDS**. Every owning adapter converts
   * it exactly once to whole milliseconds for its SDK-specific carrier.
   */
  timeout: number;
  /** Provider transport retry allowance; Solwyn dispatch currently always supplies zero. */
  maxRetries: number;
  /**
   * The served hop's fill-absent request defaults, already LAYERED by the dispatcher as
   * `{ ...globalDefaultParams, ...entryDefaultParams }` (global config defaults < per-entry
   * defaults; the customer's own command input still wins over both). ONLY the Bedrock adapter
   * consumes it (D14): Bedrock's wire command (`ConverseCommand`) is opaque to the pipeline's
   * kwargs merge — the pipeline threads the customer's ORIGINAL command through untouched — so
   * the adapter must rebuild a sibling command to honor a model override OR any non-empty default
   * (global or entry). Every other adapter ignores it (their merged kwargs already carry the
   * fill-absent result). May be non-empty even on the primary hop when a client-level
   * `defaultParams` is configured (the primary entry's own `default_params` is always `{}`).
   */
  entryDefaultParams?: Record<string, unknown>;
}

/** A bound provider-SDK method (never invoked inside an adapter). */
export type DispatchMethod = (...args: unknown[]) => unknown;

/** Portable maximum used by JavaScript's common signed-32-bit timer implementations. */
const MAX_PROVIDER_TIMEOUT_MS = 2_147_483_647;

/** Convert finite-positive protocol seconds once, with portable timer floor/saturation. */
export function providerTimeoutMilliseconds(seconds: number): number {
  return Math.min(MAX_PROVIDER_TIMEOUT_MS, Math.max(1, Math.trunc(seconds * 1000)));
}

/**
 * Copy one SDK request-options record, apply adapter-owned fields, and preserve all tail values.
 * Invalid or unreadable slots fail before the native provider method is invoked.
 */
export function mergeProviderRequestOptions(
  passthroughArgs: readonly unknown[],
  owned: Readonly<Record<string, unknown>>,
): unknown[] {
  const caller = passthroughArgs[0];
  if (caller !== undefined && (typeof caller !== "object" || caller === null)) {
    throw new ConfigurationError("provider request options must be a non-null record", {
      field: "request_options",
    });
  }
  if (caller !== undefined) {
    let isArray: boolean;
    try {
      isArray = Array.isArray(caller);
    } catch {
      throw new ConfigurationError("provider request options must be a readable record", {
        field: "request_options",
      });
    }
    if (isArray) {
      throw new ConfigurationError("provider request options must be a non-null record", {
        field: "request_options",
      });
    }
  }
  try {
    const merged = { ...(caller as Record<string, unknown> | undefined), ...owned };
    return [merged, ...passthroughArgs.slice(1)];
  } catch {
    throw new ConfigurationError("provider request options must be a readable record", {
      field: "request_options",
    });
  }
}

/**
 * A fully-bound wire call returned by {@link ProviderAdapter.prepareCall}. Invoking it
 * with the caller's trailing passthrough arguments (an SDK's per-request options —
 * signal/headers/timeout) performs the provider call and returns its result/promise.
 *
 * The adapter — never the dispatcher — owns how a shaped request becomes a wire call:
 * the closure has already captured the receiver, the target method, the shaped kwargs
 * copy, and the per-dialect argument arrangement (OpenAI's `create(kwargs, opts)` vs
 * Bedrock's `send(command, opts)`). The dispatcher stays dialect-agnostic: it only
 * spreads its passthrough args into the returned callable.
 */
export type PreparedDispatch = (...passthroughArgs: unknown[]) => unknown;

/**
 * Accumulates streaming usage across chunks. A fresh instance is created per
 * streaming call ({@link ProviderAdapter.createStreamAccumulator}) and driven by a
 * single async consumer — never share one instance across concurrent stream reads.
 */
export interface StreamUsageAccumulator {
  /** Called for every chunk yielded by the stream. */
  observe(chunk: unknown): void;
  /** Settle final usage. Returns all-zero TokenDetails if none observed; must never throw. */
  finalize(): TokenDetails;
  /** Service tier settled from observed chunks, or `null`. */
  getServiceTier(): string | null;
}

/**
 * Structural interface every provider adapter must satisfy. All members are
 * mandatory — omitting any one means the implementer does not conform.
 *
 * `name` (attribution: budgets, metadata, breakers) and `dialect` (wire shape:
 * dispatch, translation) are distinct: an OpenAI-compatible adapter has a distinct
 * `name` (e.g. `"groq"`) but dialect `"openai"`.
 */
export interface ProviderAdapter {
  /** Attribution identity (budgets, metadata, circuit breaking). */
  readonly name: string;
  /** Wire shape / dispatch dialect. */
  readonly dialect: Dialect;

  /** Whether this adapter can safely dispatch metered OpenAI Responses create/parse calls. */
  readonly supportsResponses?: boolean;

  /** Duck-typed detection of a genuine client instance for this provider. */
  detectClient(client: unknown): boolean;
  /** Whether a model name belongs to this provider (prefix/shape check). */
  detectModel(model: string): boolean;

  /**
   * Extract normalized usage from a parsed response. Returns all-zero TokenDetails
   * when usage is unavailable; must NEVER throw — any unexpected shape degrades to zeros.
   */
  extractUsage(response: unknown): TokenDetails;

  /**
   * Length-based estimated usage (marked `is_estimated: true`) for adapters whose
   * provider can report NO usage at all. Adapters for always-usage providers
   * (OpenAI) return `null` unconditionally. Must never throw.
   */
  estimateMissingUsage(
    response: unknown,
    options: EstimateMissingUsageOptions,
  ): TokenDetails | null;

  /** Extract the service-tier label from a response, or `null`. */
  extractServiceTier(response: unknown): string | null;

  /**
   * Serving region for cost attribution (Bedrock prices per model+region).
   * Providers without regional pricing return `null`. Required — no adapter may opt out.
   */
  extractRegion(client: unknown): string | null;

  /**
   * Return a NEW kwargs object shaped for a streaming call (never mutate the input).
   */
  prepareStreaming(
    kwargs: Record<string, unknown>,
    options?: PrepareStreamingOptions,
  ): Record<string, unknown>;

  /** Fresh accumulator per streaming call. */
  createStreamAccumulator(options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator;

  /**
   * Dispatch seam: return a fully-bound {@link PreparedDispatch} that, when invoked with
   * the caller's passthrough args, performs the wire call. The adapter owns the whole
   * request→wire-call transformation — surface→method selection, streaming kwargs shaping
   * (e.g. injecting `stream_options.include_usage`, setting `stream: true`), the receiver
   * binding, and the per-dialect argument arrangement — so the dispatcher never learns any
   * dialect's method shapes. Must operate on a shaped COPY of kwargs (never mutate the
   * input) and must never read prompt/response content — key-level shaping only.
   */
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch;

  /**
   * Optional non-chat dispatch seam. Absence, or an unsupported surface branch, is
   * converted by the client lifecycle into {@link UnsupportedSurfaceError}.
   */
  prepareMediaCall?(
    surface: MediaSurface,
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareMediaCallOptions,
  ): PreparedMediaCall;

  /** The iterable to wrap from a streaming call's return value (identity for most dialects). */
  unwrapStreamSource(response: unknown): unknown;

  /** Reshape a wrapped stream into the primary (caller-dialect) shape (identity for most dialects). */
  wrapStreamResult(wrapper: unknown, servedResponse: unknown): unknown;
}
