/**
 * `OpenAIAdapter` — the {@link ProviderAdapter} for the native OpenAI SDK/API.
 *
 * Extracts normalized {@link TokenDetails} from BOTH OpenAI response shapes (Chat
 * Completions and Responses API), extracts `service_tier`, and owns the OpenAI
 * dispatch/streaming quirks: the `"chat"` surface dispatches through
 * `chat.completions.create` (forcing `stream_options.include_usage` when streaming), the
 * `"responses"` surface through `responses.create` (whose stream settles usage from the
 * terminal `response.completed` event). Pure extraction/shaping — no pricing, no network
 * I/O.
 *
 * Ported from `solwyn/providers/openai.py`. The shared module-level extractors
 * (`_extract_openai_usage`, `_extract_service_tier`) live in `./accumulator` and are
 * delegated to here — the adapter and the stream accumulator share one extraction path.
 *
 * ZERO provider-SDK imports (CLAUDE.md invariant 3): the `openai` package is never
 * imported. Client detection is duck-typed over `unknown`.
 *
 * PRIVACY: only token counts, a tier label, and request/response KEY-level shaping are
 * touched — never message/prompt/tool-argument text. This module lives outside the
 * privacy-firewall allowlist and must stay that way.
 */

import { ConfigurationError, UnsupportedSurfaceError } from "../errors";
import type { Logger } from "../logging";
import { consoleLogger } from "../logging";
import type { TokenDetails } from "../token-details";
import {
  extractOpenAIUsage,
  extractServiceTier,
  OpenAIResponsesStreamAccumulator,
  OpenAIStreamAccumulator,
} from "./accumulator";
import { detectOpenAIClient } from "./detection";
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

// ---------------------------------------------------------------------------
// Structural narrowing helpers (duck-typing over `unknown`).
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProp(obj: unknown, key: string): unknown {
  return isObject(obj) ? obj[key] : undefined;
}

/** Options for {@link OpenAIAdapter}. */
export interface OpenAIAdapterOptions {
  /** Logger for the (rare) service-tier truncation warning. */
  logger?: Logger;
}

/** Adapter identity needed for content-free errors from shared OpenAI-dialect media dispatch. */
export interface OpenAIDialectMediaContext {
  provider: string;
  clientLabel: "OpenAI" | "OpenAI-compatible";
}

/**
 * Shared primary-only media dispatch for native OpenAI and every compatibility profile.
 * The surface switch is deliberately centralized here so later OpenAI-dialect media
 * branches have one binding/shaping boundary.
 */
export function prepareOpenAIDialectMediaCall(
  surface: MediaSurface,
  client: unknown,
  kwargs: Record<string, unknown>,
  options: PrepareMediaCallOptions,
  context: OpenAIDialectMediaContext,
): PreparedMediaCall {
  if (surface === "videos" && context.provider !== "openai") {
    throw new UnsupportedSurfaceError({ surface, provider: context.provider });
  }
  if (
    surface !== "embeddings" &&
    surface !== "images" &&
    surface !== "audio.transcriptions" &&
    surface !== "audio.speech" &&
    surface !== "videos"
  ) {
    throw new UnsupportedSurfaceError({ surface, provider: context.provider });
  }
  const audioOperation = getProp(kwargs, "_solwyn_audio_op");
  const resource = surface.startsWith("audio.")
    ? getProp(getProp(client, "audio"), audioOperation === "speech" ? "speech" : "transcriptions")
    : getProp(client, surface);
  const imageOperation = getProp(kwargs, "_solwyn_image_op");
  const methodName =
    surface === "images" && imageOperation === "edit"
      ? "edit"
      : surface === "images"
        ? "generate"
        : "create";
  const method = getProp(resource, methodName);
  if (typeof method !== "function") {
    throw new ConfigurationError(
      `wrapped ${context.clientLabel} client does not expose ${surface}.${methodName}`,
      { field: null },
    );
  }
  const shaped = { ...kwargs };
  delete shaped["_solwyn_image_op"];
  delete shaped["_solwyn_audio_op"];
  const fn = method as DispatchMethod;
  return {
    method: (request, ...passthroughArgs) =>
      fn.call(
        resource,
        request,
        ...mergeProviderRequestOptions(passthroughArgs, {
          timeout: providerTimeoutMilliseconds(options.timeout),
          maxRetries: 0,
        }),
      ),
    kwargs: shaped,
  };
}

/**
 * {@link ProviderAdapter} implementation for the native OpenAI SDK/API. Stateless
 * aside from an injected logger; `name` and `dialect` are always `"openai"`.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";
  readonly dialect: Dialect = "openai";
  readonly supportsResponses = true;
  readonly #logger: Logger;

  constructor(options: OpenAIAdapterOptions = {}) {
    this.#logger = options.logger ?? consoleLogger;
  }

  /**
   * Duck-typed detection of a genuine OpenAI SDK client.
   *
   * Python keyed off `"openai" in type(client).__module__`, which has no JS analogue.
   * The registry (a separate subsystem) registers this adapter AFTER every
   * OpenAI-compatible adapter, so any `baseURL`-overridden compat client has already
   * been claimed by the time detection reaches here. The structural signal used is: a
   * genuine OpenAI client exposes a `chat.completions.create` function; a
   * constructor-name containing `"openai"` is accepted as a secondary signal.
   */
  detectClient(client: unknown): boolean {
    return detectOpenAIClient(client);
  }

  /** `gpt-*` / `o3*` / `o4*` prefix match. Case-sensitive, no trimming. */
  detectModel(model: string): boolean {
    return model.startsWith("gpt-") || model.startsWith("o3") || model.startsWith("o4");
  }

  /** Delegates to the shared extractor. Never throws. */
  extractUsage(response: unknown): TokenDetails {
    return extractOpenAIUsage(response);
  }

  /**
   * ALWAYS `null` — OpenAI itself always reports usage, so there is no estimated
   * fallback path for this adapter (contrast: OpenAI-compatible adapters implement one).
   */
  estimateMissingUsage(
    _response: unknown,
    _options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    return null;
  }

  /** Delegates to the shared extractor (truncation warnings go through the logger). */
  extractServiceTier(response: unknown): string | null {
    return extractServiceTier(response, this.#logger);
  }

  /** ALWAYS `null` — OpenAI pricing is not regional. */
  extractRegion(_client: unknown): string | null {
    return null;
  }

  /**
   * Return a NEW kwargs object with `stream_options.include_usage = true` so the final
   * streamed chunk carries a `usage` block. The input `kwargs` (and its original
   * `stream_options`, if any) are left untouched. `crossProvider` is accepted but not
   * branched on — OpenAI always wants `include_usage` regardless of hop origin.
   */
  prepareStreaming(
    kwargs: Record<string, unknown>,
    _options?: PrepareStreamingOptions,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = { ...kwargs };
    const existing = kwargs["stream_options"];
    const streamOptions: Record<string, unknown> = isObject(existing) ? { ...existing } : {};
    streamOptions["include_usage"] = true;
    next["stream_options"] = streamOptions;
    return next;
  }

  /**
   * Fresh accumulator matching the stream's terminal-usage shape: the Chat Completions
   * {@link OpenAIStreamAccumulator} for the `"chat"` surface (usage on the final chunk),
   * the {@link OpenAIResponsesStreamAccumulator} for the `"responses"` surface (usage on
   * the `response.completed` event's `response.usage`). Defaults to the chat accumulator
   * when no surface is given. The estimate option is accepted but ignored (OpenAI streams
   * always carry real usage).
   */
  createStreamAccumulator(options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    if (options?.surface === "responses") {
      return new OpenAIResponsesStreamAccumulator(this.#logger);
    }
    return new OpenAIStreamAccumulator(this.#logger);
  }

  /**
   * Dispatch seam. Maps the intercepted surface to a wire method — `"chat"` →
   * `client.chat.completions.create`, `"responses"` → `client.responses.create` — and
   * returns a {@link PreparedDispatch} already bound to that receiver over a shaped COPY
   * of kwargs (the input is never mutated). For a streaming CHAT call it folds in the
   * `stream_options.include_usage` injection ({@link prepareStreaming}) and sets
   * `stream: true`; for a streaming RESPONSES call it only sets `stream: true` (the
   * Responses API settles usage from the terminal `response.completed` event, not via
   * `stream_options`). `timeout`/`maxRetries` are accepted but ignored (the caller applies
   * HTTP bounds via the SDK client itself).
   */
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    if (options.surface === "responses") {
      return this.#prepareResponsesCall(client, kwargs, options);
    }
    return this.#prepareChatCall(client, kwargs, options);
  }

  /** Bound primary-only dispatch for tracked OpenAI non-chat surfaces. */
  prepareMediaCall(
    surface: MediaSurface,
    client: unknown,
    kwargs: Record<string, unknown>,
    _options: PrepareMediaCallOptions,
  ): PreparedMediaCall {
    return prepareOpenAIDialectMediaCall(surface, client, kwargs, _options, {
      provider: this.name,
      clientLabel: "OpenAI",
    });
  }

  #prepareChatCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    // Streaming kwargs shaping lives HERE (not in the dispatcher) so the client stays
    // dialect-agnostic: inject include_usage via prepareStreaming, then flag the stream.
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
        "wrapped OpenAI client does not expose chat.completions.create",
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

  #prepareResponsesCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    const leaf = options.responsesLeaf ?? "create";
    if (leaf !== "create" && leaf !== "parse" && leaf !== "stream") {
      throw new ConfigurationError(`unsupported OpenAI Responses leaf: ${leaf}`, { field: null });
    }
    const shaped: Record<string, unknown> = { ...kwargs };
    if (options.isStreaming && leaf !== "stream") {
      shaped["stream"] = true;
    }
    const responses = getProp(client, "responses");
    const method = getProp(responses, leaf);
    if (typeof method !== "function") {
      throw new ConfigurationError(`wrapped OpenAI client does not expose responses.${leaf}`, {
        field: null,
      });
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

  /** Identity — OpenAI streaming calls return the iterable directly. */
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }

  /** Identity — OpenAI-dialect callers iterate the stream object directly. */
  wrapStreamResult(wrapper: unknown, _servedResponse: unknown): unknown {
    return wrapper;
  }
}
