/**
 * `AnthropicAdapter` — the {@link ProviderAdapter} for the native Anthropic
 * Messages API/SDK — plus its {@link AnthropicStreamAccumulator}.
 *
 * The module's central job is normalizing Anthropic's ADDITIVE usage shape
 * (`input_tokens` + `cache_read_input_tokens` + per-TTL `cache_creation` tokens —
 * all separate, none nested inside another) into the SDK's single `input_tokens`
 * total. It reads ONLY `usage`/`type`/lifecycle-event metadata — never message or
 * content fields — so it lives OUTSIDE the privacy-firewall allowlist and must stay
 * that way (CLAUDE.md invariant 1).
 *
 * Ported from `solwyn/providers/anthropic.py` (+ `_parse_anthropic_cache`).
 *
 * ZERO provider-SDK imports (CLAUDE.md invariant 3): the `@anthropic-ai/sdk`
 * package is never imported. Client detection is duck-typed over `unknown`. The
 * Anthropic TS SDK exposes wire-shaped snake_case usage fields (`input_tokens`,
 * `cache_read_input_tokens`, `cache_creation`, `ephemeral_5m_input_tokens`,
 * `ephemeral_1h_input_tokens`) — read defensively, mirroring Python's
 * `getattr(..., None) or 0`.
 *
 * PRICING: never computed. Extraction/shaping only, no network I/O.
 */

import { ConfigurationError } from "../errors";
import type { Logger } from "../logging";
import { consoleLogger } from "../logging";
import type { TokenDetails } from "../token-details";
import { buildReportedTokenDetails, isUsageCount } from "../token-details";
import { detectAnthropicClient } from "./detection";
import type {
  CreateStreamAccumulatorOptions,
  Dialect,
  DispatchMethod,
  EstimateMissingUsageOptions,
  PrepareCallOptions,
  PreparedDispatch,
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

/** Absent fields read as undefined; unreadable fields retain an invalid numeric sentinel. */
function getProp(obj: unknown, key: string): unknown {
  try {
    return isObject(obj) ? obj[key] : undefined;
  } catch {
    return Number.NaN;
  }
}

/**
 * Coerce one raw usage field to a token count, mirroring Python's
 * `getattr(x, name, None) or 0`: any non-number (missing, `null`, string, boolean)
 * degrades to `0`. Only non-negative integers pass through unchanged; the raw
 * validity signal is retained separately by the usage builder.
 */
function numberOrZero(value: unknown): number {
  return isUsageCount(value) ? value : 0;
}

/**
 * Shared cache-parsing helper (`_parse_anthropic_cache` in Python). Given a `usage`
 * object, returns the per-TTL cache-creation buckets.
 *
 * The presence of the `cache_creation` sub-object PERMANENTLY overrides the flat
 * `cache_creation_input_tokens` aggregate — checked by presence (not-null), NOT by
 * whether the sub-object's own values are zero. Once the sub-object exists at all,
 * the aggregate is ignored even if it carries a large nonzero value.
 *
 *  1. `cache_creation` present → `5m = ephemeral_5m_input_tokens`,
 *     `1h = ephemeral_1h_input_tokens` (each `or 0`).
 *  2. else → `5m = cache_creation_input_tokens` (whole aggregate → default 5m TTL
 *     bucket), `1h = 0` always.
 */
function parseAnthropicCache(usage: unknown): { cache5m: unknown; cache1h: unknown } {
  const cacheCreation = getProp(usage, "cache_creation");
  if (cacheCreation !== undefined && cacheCreation !== null) {
    if (!isObject(cacheCreation)) return { cache5m: Number.NaN, cache1h: Number.NaN };
    return {
      cache5m: getProp(cacheCreation, "ephemeral_5m_input_tokens"),
      cache1h: getProp(cacheCreation, "ephemeral_1h_input_tokens"),
    };
  }
  return {
    cache5m: getProp(usage, "cache_creation_input_tokens"),
    cache1h: 0,
  };
}

/**
 * Normalize an Anthropic `usage` object into {@link TokenDetails}. Never throws.
 *
 * `input_tokens` is the SUM of four additive components:
 *   base `input_tokens` + `cache_read_input_tokens` + cache-creation 5m + 1h.
 * None of these overlap on Anthropic's wire; they are all summed. `cache_read` also
 * maps 1:1 to `cached_input_tokens` at the output.
 *
 * All OpenAI/Google-only fields (`reasoning_tokens`, audio, prediction,
 * `tool_use_input_tokens`) stay at their `0` default — Anthropic never reports them
 * (extended-thinking tokens are folded into `output_tokens`, a permanent blind spot).
 */
function extractAnthropicUsage(usage: unknown): TokenDetails {
  const baseInput = getProp(usage, "input_tokens");
  const output = getProp(usage, "output_tokens");
  const cacheRead = getProp(usage, "cache_read_input_tokens");
  const { cache5m, cache1h } = parseAnthropicCache(usage);
  // Plain build (never validates): an out-of-bound garbage count must not throw out
  // of extraction — it is caught fail-open at the reporter's wire boundary (F10).
  return buildReportedTokenDetails(
    {
      input_tokens:
        numberOrZero(baseInput) +
        numberOrZero(cacheRead) +
        numberOrZero(cache5m) +
        numberOrZero(cache1h),
      output_tokens: output,
      cached_input_tokens: cacheRead,
      cache_creation_5m_tokens: cache5m,
      cache_creation_1h_tokens: cache1h,
    },
    !isUsageCount(baseInput),
  );
}

/** Options for {@link AnthropicAdapter}. */
export interface AnthropicAdapterOptions {
  /** Logger for the stream-shape warnings raised by the accumulator. */
  logger?: Logger;
}

/**
 * {@link ProviderAdapter} implementation for the native Anthropic SDK/API. Stateless
 * aside from an injected logger; `name` and `dialect` are always `"anthropic"`.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  readonly dialect: Dialect = "anthropic";
  readonly #logger: Logger;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.#logger = options.logger ?? consoleLogger;
  }

  /**
   * Duck-typed detection of a genuine Anthropic SDK client.
   *
   * Python keyed off `"anthropic" in type(client).__module__`, which has no JS
   * analogue. The structural signal used is: an Anthropic client exposes a
   * `messages.create` function; a constructor-name containing `"anthropic"` is
   * accepted as a secondary signal. A `FakeClient` shaped with `messages.create`
   * (module `"anthropic.resources"`) matches; a plain OpenAI client (no
   * `messages.create`, constructor `"openai"`) does not.
   */
  detectClient(client: unknown): boolean {
    return detectAnthropicClient(client);
  }

  /** `claude-*` prefix match. Case-sensitive, no trimming. */
  detectModel(model: string): boolean {
    return model.startsWith("claude-");
  }

  /**
   * Extract normalized usage. Never throws — `null`/absent/unexpected-shape `usage`
   * degrades to all-zero {@link TokenDetails}.
   */
  extractUsage(response: unknown): TokenDetails {
    const usage = getProp(response, "usage");
    if (usage === undefined || usage === null) {
      return buildReportedTokenDetails({});
    }
    return extractAnthropicUsage(usage);
  }

  /**
   * ALWAYS `null` — Anthropic always reports usage, so there is no length-based
   * estimation fallback path for this adapter (contrast: OpenAI-compatible adapters
   * return a real `is_estimated: true` estimate here).
   */
  estimateMissingUsage(
    _response: unknown,
    _options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    return null;
  }

  /** ALWAYS `null` — Anthropic responses expose no service-tier concept. */
  extractServiceTier(_response: unknown): string | null {
    return null;
  }

  /** ALWAYS `null` — Anthropic pricing is not regional. */
  extractRegion(_client: unknown): string | null {
    return null;
  }

  /**
   * Return a NEW kwargs object shaped for a streaming call — a shallow defensive
   * copy, unchanged. Anthropic streams carry `message_start`/`message_delta` usage
   * events by default, so no request flag is added. `crossProvider` is accepted but
   * ignored (no sanitization needed for this dialect).
   */
  prepareStreaming(
    kwargs: Record<string, unknown>,
    _options?: PrepareStreamingOptions,
  ): Record<string, unknown> {
    return { ...kwargs };
  }

  /**
   * Fresh {@link AnthropicStreamAccumulator} per streaming call. `estimatedInputTokens`
   * is accepted (protocol-required) but ignored — Anthropic streams always carry real
   * usage, so no estimate fallback is ever needed.
   */
  createStreamAccumulator(_options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    return new AnthropicStreamAccumulator(this.#logger);
  }

  /**
   * Dispatch seam. Returns a {@link PreparedDispatch} bound to `client.messages.create`
   * over a shaped COPY of kwargs (the input is never mutated or aliased). When
   * streaming, the copy additionally has `stream: true` set — the original `kwargs`
   * never gains a `stream` key. `surface`/`timeout`/`maxRetries` are accepted but
   * ignored (Anthropic has one call surface; HTTP bounds are the transport layer's job).
   */
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    const shaped: Record<string, unknown> = { ...kwargs };
    if (options.isStreaming) {
      shaped["stream"] = true;
    }
    const messages = getProp(client, "messages");
    const method = getProp(messages, "create");
    if (typeof method !== "function") {
      throw new ConfigurationError("wrapped Anthropic client does not expose messages.create", {
        field: null,
      });
    }
    const fn = method as DispatchMethod;
    return (...passthroughArgs) =>
      fn.call(
        messages,
        shaped,
        ...mergeProviderRequestOptions(passthroughArgs, {
          timeout: providerTimeoutMilliseconds(options.timeout),
          maxRetries: 0,
        }),
      );
  }

  /** Identity — Anthropic streaming calls return the iterable directly. */
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }

  /** Identity — Anthropic-dialect callers iterate the stream object directly. */
  wrapStreamResult(wrapper: unknown, _servedResponse: unknown): unknown {
    return wrapper;
  }
}

// ---------------------------------------------------------------------------
// AnthropicStreamAccumulator
// ---------------------------------------------------------------------------

/**
 * Accumulates Anthropic streaming usage across chunks. Constructed fresh per
 * streaming call.
 *
 * Usage settles from two terminal-ish lifecycle events:
 *   - `message_start.message.usage` → input side (base + cache_read + cache-creation),
 *     parsed by the same additive-sum + presence-priority rules as the non-streaming
 *     path ({@link parseAnthropicCache}).
 *   - `message_delta.usage.output_tokens` → output side.
 * Every other event type (`content_block_delta`, `message_stop`, `ping`, …) is a
 * complete no-op. This accumulator never reads `delta.text` or any content field.
 *
 * CONCURRENCY: one instance must never be shared across two concurrent stream reads
 * (a single async consumer of one stream's chunks is the only supported driver).
 */
export class AnthropicStreamAccumulator implements StreamUsageAccumulator {
  #baseInput = 0;
  #cacheRead = 0;
  #cache5m = 0;
  #cache1h = 0;
  #output = 0;
  #sawMessageStart = false;
  #sawMessageDelta = false;
  #inputMeasured = false;
  #outputMeasured = false;
  readonly #logger: Logger;

  constructor(logger: Logger = consoleLogger) {
    this.#logger = logger;
  }

  observe(chunk: unknown): void {
    const type = getProp(chunk, "type");
    if (type === "message_start") {
      this.#sawMessageStart = true;
      const usage = getProp(getProp(chunk, "message"), "usage");
      if (usage !== undefined && usage !== null) {
        const details = extractAnthropicUsage({
          input_tokens: getProp(usage, "input_tokens"),
          output_tokens: 0,
          cache_read_input_tokens: getProp(usage, "cache_read_input_tokens"),
          cache_creation: getProp(usage, "cache_creation"),
          cache_creation_input_tokens: getProp(usage, "cache_creation_input_tokens"),
        });
        this.#baseInput = numberOrZero(getProp(usage, "input_tokens"));
        this.#cacheRead = details.cached_input_tokens;
        this.#cache5m = details.cache_creation_5m_tokens;
        this.#cache1h = details.cache_creation_1h_tokens;
        this.#inputMeasured = !details.is_estimated;
      } else {
        this.#inputMeasured = false;
      }
      return;
    }
    if (type === "message_delta") {
      this.#sawMessageDelta = true;
      const usage = getProp(chunk, "usage");
      if (usage !== undefined && usage !== null) {
        const output = getProp(usage, "output_tokens");
        this.#output = numberOrZero(output);
        this.#outputMeasured = isUsageCount(output);
      } else {
        this.#outputMeasured = false;
      }
    }
    // Any other type (content_block_delta, message_stop, ping, …) is a no-op.
  }

  finalize(): TokenDetails {
    const inputTotal = this.#baseInput + this.#cacheRead + this.#cache5m + this.#cache1h;
    // Both warnings can fire independently; neither prevents a return, neither throws.
    // No content risk — these describe a stream-shape anomaly only, so the full
    // message is logged verbatim (parity with Python's literal strings).
    if (this.#output > 0 && !this.#sawMessageStart) {
      this.#logger.warn(
        "Anthropic stream finalized without message_start; input token counts may be incomplete",
      );
    }
    if (inputTotal > 0 && !this.#sawMessageDelta) {
      this.#logger.warn(
        "Anthropic stream finalized without message_delta; output token counts may be incomplete",
      );
    }
    // Plain build (never validates) — see F10.
    return buildReportedTokenDetails(
      {
        input_tokens: inputTotal,
        output_tokens: this.#output,
        cached_input_tokens: this.#cacheRead,
        cache_creation_5m_tokens: this.#cache5m,
        cache_creation_1h_tokens: this.#cache1h,
      },
      !this.#inputMeasured || !this.#outputMeasured,
    );
  }

  /** ALWAYS `null` — Anthropic has no service-tier concept. */
  getServiceTier(): string | null {
    return null;
  }
}
