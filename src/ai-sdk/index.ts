/**
 * PRIVACY-CRITICAL — content-privileged module.
 *
 * `@solwyn/sdk/ai-sdk` — the Vercel AI SDK language-model middleware entry.
 *
 * This is one of exactly three content-touching locations in the SDK (the others are
 * `src/privacy.ts` and the whole `src/providers/translation/` package). It is the ONLY
 * place under this entry allowed to reference prompt/response content fields (`prompt`,
 * `content`, `messages`, `text`, `delta`) — because the AI SDK hands the middleware the
 * fully-normalized request `params.prompt` and the model result/stream parts, and Solwyn
 * must SIZE a pre-flight budget estimate from them and settle usage afterward. Every
 * content touch here is measured to an INTEGER (delegated to `privacy.ts`, or a local
 * char-length count on a streamed delta) and immediately discarded: content is NEVER
 * logged, stored, concatenated, or transmitted. Only token *counts* and model/provider
 * *name* strings ever leave this module (through the shared budget enforcer + reporter,
 * which are themselves content-free).
 *
 * NET-NEW subsystem (no Python counterpart). It composes the existing, content-free core
 * machinery — {@link BudgetEnforcer} (pre-flight check + confirm builder), {@link MetadataReporter}
 * (usage telemetry), config resolution, and the privacy length estimators — behind the
 * documented AI SDK middleware interface (`LanguageModelV2Middleware`, exported by the `ai`
 * package as the version-relaxed `LanguageModelMiddleware`): `wrapGenerate` /
 * `wrapStream`.
 *
 * EDGE-SAFE: web-standard APIs only (`crypto.randomUUID`, `performance.now`, web
 * `ReadableStream`, `Date`). No `node:*`. The `ai` package is imported TYPE-ONLY
 * (fully erased under `verbatimModuleSyntax`), so this module has ZERO runtime dependency
 * on `ai` — the middleware object is a plain object the `ai` package reads structurally,
 * and the package installs/builds/runs with `ai` absent.
 */

import type { LanguageModelMiddleware } from "ai";
import { BudgetEnforcer, type BuildConfirmRequestOptions, budgetCheckResult } from "../budget";
import { CircuitBreaker } from "../circuit-breaker";
import { resolveConfig, type SolwynConfigOptions } from "../config";
import { safeErrorClassName } from "../error-class";
import { ConfigurationError } from "../errors";
import { extractUsageFailSoft, hasSettlementFunding } from "../fail-soft";
import { consoleLogger, type Logger } from "../logging";
import { resolveAiSdkOutputBound } from "../output-bound";
import { estimateContentLength, estimateTokensFromLength } from "../privacy";
import { MetadataReporter } from "../reporter";
import { type CurrentRun, getCurrentRun } from "../run-context";
import { buildTokenDetails, isUsageCount, type TokenDetails } from "../token-details";
import type { FetchLike } from "../transport";
import type { BudgetMode, MetadataEvent, ProviderName } from "../types";

// ---------------------------------------------------------------------------
// Provider attribution — AI SDK provider id → Solwyn ProviderName.
// ---------------------------------------------------------------------------

/**
 * Ordered prefix → {@link ProviderName} table. The AI SDK stamps each model with a
 * `provider` string that is either a bare vendor id (`"openai"`, `"anthropic"`) or a
 * dotted variant naming the surface (`"openai.chat"`, `"anthropic.messages"`,
 * `"google.generative-ai"`, `"google.vertex"`). We match the LOWERCASED provider string
 * by `startsWith` in this order (first hit wins), so every surface of one vendor collapses
 * to a single attribution name. Unknown providers fall back to the generic
 * `"openai_compatible"` catch-all (the same terminal name the core registry uses).
 *
 * Order note: no listed prefix is a prefix of a conflicting entry (`openrouter` does not
 * start with `openai`; `azure`/`amazon-bedrock` are disjoint from `openai`), so the table
 * order is not load-bearing beyond first-hit determinism.
 */
export const AI_SDK_PROVIDER_PREFIXES: ReadonlyArray<readonly [string, ProviderName]> = [
  ["openai", "openai"],
  ["azure", "azure_openai"],
  ["anthropic", "anthropic"],
  ["amazon-bedrock", "bedrock"],
  ["bedrock", "bedrock"],
  ["google", "google"],
  ["xai", "xai"],
  ["deepseek", "deepseek"],
  ["mistral", "mistral"],
  ["zai", "zai"],
  ["groq", "groq"],
  ["together", "together"],
  ["fireworks", "fireworks"],
  ["perplexity", "perplexity"],
  ["openrouter", "openrouter"],
  ["ollama", "ollama"],
];

/** The catch-all attribution for an AI SDK provider id we do not recognize. */
export const FALLBACK_PROVIDER_NAME: ProviderName = "openai_compatible";

/** First prefix hit for a lowercased provider/vendor string, or `null` when unrecognized. */
function matchProviderPrefix(lower: string): ProviderName | null {
  for (const [prefix, name] of AI_SDK_PROVIDER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return name;
    }
  }
  return null;
}

/**
 * Map an AI SDK `model.provider` string to a Solwyn {@link ProviderName} for attribution
 * (budgets, metadata, breakers). Case-insensitive prefix match against
 * {@link AI_SDK_PROVIDER_PREFIXES}; anything unrecognized (or empty) →
 * {@link FALLBACK_PROVIDER_NAME}.
 *
 * Vercel AI Gateway special-case (D15): `ai` v7 routes every string model id
 * (`generateText({ model: "anthropic/claude-..." })`) through its default gateway provider,
 * which stamps `provider: "gateway"` while keeping the true vendor as the `vendor/model`
 * prefix of `modelId`. A bare `startsWith("gateway")` fall-through would collapse ALL
 * gateway-routed spend — Anthropic, OpenAI, Google — onto `openai_compatible`, splitting
 * per-vendor budgets (invariant 5). So when the provider id is `gateway`/`gateway.*`,
 * attribution is derived from `modelId`'s leading `vendor/` segment through the SAME prefix
 * table; only an absent/unrecognized vendor falls back to {@link FALLBACK_PROVIDER_NAME}.
 */
export function resolveProviderName(provider: string, modelId?: string): ProviderName {
  const lower = provider.toLowerCase();
  if (lower.startsWith("gateway")) {
    const vendor = typeof modelId === "string" ? modelId.split("/")[0] : "";
    const fromVendor = vendor ? matchProviderPrefix(vendor.toLowerCase()) : null;
    return fromVendor ?? FALLBACK_PROVIDER_NAME;
  }
  return matchProviderPrefix(lower) ?? FALLBACK_PROVIDER_NAME;
}

// ---------------------------------------------------------------------------
// Duck-typed structural readers (the AI SDK usage/stream shapes are version-drifting:
// V2 reported flat `usage.inputTokens: number`; V3/V4 report nested
// `usage.inputTokens: { total, cacheRead, ... }`. Read BOTH defensively so the middleware
// is robust across `ai` major versions — the same duck-typing discipline as privacy.ts).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProp(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

/**
 * Read a usage total from either the flat V2 shape (a bare `number`) or the nested V3/V4
 * shape (`{ total: number }`). Returns `null` when neither is a number (usage absent).
 */
function readUsageTotal(field: unknown): number | null {
  if (typeof field === "number") {
    return field;
  }
  const total = getProp(field, "total");
  return typeof total === "number" ? total : null;
}

// ---------------------------------------------------------------------------
// Usage → TokenDetails.
// ---------------------------------------------------------------------------

interface UsageContext {
  provider: ProviderName;
  /** Pre-flight length-based input estimate (used only if the provider reports no usage). */
  estimatedInputTokens: number;
  /** Measured response output characters (used only for the no-usage estimate). */
  outputChars: number;
}

/**
 * Normalize an AI SDK usage object to a {@link TokenDetails}. Reads the nested V3/V4 shape
 * (`inputTokens.total`, `outputTokens.total`, `inputTokens.cacheRead`,
 * `outputTokens.reasoning`) AND the flat V2 shape (`inputTokens`, `cachedInputTokens`,
 * `reasoningTokens`) defensively.
 *
 * No-silent-zero (CLAUDE.md invariant 6): when the provider reports NO usage at all (both
 * input and output totals absent), fall back to a LENGTH-based estimate — input from the
 * pre-flight token estimate, output from the measured response characters — marked
 * `is_estimated: true`. Partially reported or malformed usage is explicitly estimated;
 * its known counters remain useful but cannot refund unknown lease authority. Built via the never-throw
 * {@link buildTokenDetails}; a garbage out-of-bound count flows through unmodified and is
 * caught (dropped fail-open) at the reporter's wire-validation boundary, matching the core.
 */
function reportedUsageToTokenDetails(usage: unknown): TokenDetails | null {
  const input = readUsageTotal(getProp(usage, "inputTokens"));
  const output = readUsageTotal(getProp(usage, "outputTokens"));

  if (input === null && output === null) {
    return null;
  }

  const cached =
    getProp(getProp(usage, "inputTokens"), "cacheRead") ?? getProp(usage, "cachedInputTokens");
  const reasoning =
    getProp(getProp(usage, "outputTokens"), "reasoning") ?? getProp(usage, "reasoningTokens");

  return buildTokenDetails({
    input_tokens: isUsageCount(input) ? input : 0,
    output_tokens: isUsageCount(output) ? output : 0,
    cached_input_tokens: isUsageCount(cached) ? cached : 0,
    reasoning_tokens: isUsageCount(reasoning) ? reasoning : 0,
    is_estimated:
      !isUsageCount(input) ||
      !isUsageCount(output) ||
      (cached != null && !isUsageCount(cached)) ||
      (reasoning != null && !isUsageCount(reasoning)),
  });
}

function estimateUsageFromLength(ctx: UsageContext): TokenDetails {
  return buildTokenDetails({
    input_tokens: ctx.estimatedInputTokens,
    output_tokens:
      ctx.outputChars > 0 ? estimateTokensFromLength(ctx.outputChars, ctx.provider) : 0,
    is_estimated: true,
  });
}

export function usageToTokenDetails(usage: unknown, ctx: UsageContext): TokenDetails {
  return reportedUsageToTokenDetails(usage) ?? estimateUsageFromLength(ctx);
}

// ---------------------------------------------------------------------------
// Content measurement (privacy: content in, INTEGER out — never retained).
// ---------------------------------------------------------------------------

/** `value.length` when it is a string, else 0. */
function stringLen(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/**
 * Byte-length of one JSON-serializable arguments value: its own `.length` when already a
 * string (a stream/content `tool-call.input` is a stringified JSON string), else the length
 * of its `JSON.stringify` form (a prompt `tool-call.input` is a plain object). Measured to
 * an integer and discarded — never materialized, logged, or transmitted. Returns 0 on an
 * absent value or a `JSON.stringify` failure (a circular argument object must never break
 * budget sizing).
 */
function argsLen(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined || value === null) {
    return 0;
  }
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Chars in one AI SDK `tool-result` part's `output` (`LanguageModelV4ToolResultOutput`): a
 * `text`/`error-text` output's string `value`, a `json`/`error-json` output's stringified
 * `value`, or a `content` output's nested `{ type: 'text', text }` items summed. Integer out.
 */
function toolResultOutputLen(output: unknown): number {
  if (getProp(output, "type") === "content") {
    const value = getProp(output, "value");
    if (!Array.isArray(value)) {
      return 0;
    }
    let total = 0;
    for (const item of value) {
      if (getProp(item, "type") === "text") {
        total += stringLen(getProp(item, "text"));
      }
    }
    return total;
  }
  return argsLen(getProp(output, "value"));
}

/**
 * EXTRA chars carried by an AI SDK message/content PART that the shared privacy walker
 * ({@link estimateContentLength} and its `{ text }`-block sum) does NOT count: a `tool-call`
 * part's `input` arguments, a `tool-result` part's `output`, and a `file` part's inline
 * `data.text`. These carry real prompt/response bytes on agentic (tool-invoking) calls, so
 * omitting them under-sizes budget estimates by orders of magnitude on multi-step loops
 * (and zero-estimates a tool-only response under the invariant-6 no-usage fallback — the
 * same intent privacy.ts already honors on the core OpenAI dialect via
 * `tool_calls[].function.arguments`). Content in, INTEGER out — every string is read for
 * its `.length` only and immediately discarded.
 */
function partExtraChars(part: unknown): number {
  switch (getProp(part, "type")) {
    case "tool-call":
      return argsLen(getProp(part, "input"));
    case "tool-result":
      return toolResultOutputLen(getProp(part, "output"));
    case "file": {
      const data = getProp(part, "data");
      return getProp(data, "type") === "text" ? stringLen(getProp(data, "text")) : 0;
    }
    default:
      return 0;
  }
}

/** Sum {@link partExtraChars} across an array of parts (a message's or a result's content). */
function sumPartExtras(parts: unknown): number {
  if (!Array.isArray(parts)) {
    return 0;
  }
  let total = 0;
  for (const part of parts) {
    total += partExtraChars(part);
  }
  return total;
}

/**
 * Length of one AI SDK prompt, measured for a pre-flight budget estimate. The base text
 * (system strings + `{ text }` parts) goes through the shared {@link estimateContentLength}
 * walker; then each message's part array contributes its {@link partExtraChars} — the
 * tool-call/tool-result/inline-file-text bytes the shared walker skips, which dominate
 * agentic multi-step prompts. Content in, integer out; no text is materialized here.
 */
function measurePromptChars(prompt: unknown): number {
  let total = estimateContentLength({ messages: prompt });
  if (Array.isArray(prompt)) {
    for (const message of prompt) {
      total += sumPartExtras(getProp(message, "content"));
    }
  }
  return total;
}

/**
 * Length of a buffered response's generated content (the no-usage output estimate). Text
 * parts go through {@link estimateContentLength}; {@link partExtraChars} then adds the
 * `tool-call` argument bytes so a tool-call-only response (finishReason `tool-calls`) is
 * not zero-estimated under the invariant-6 fallback. Content in, integer out.
 */
function measureResponseChars(content: unknown): number {
  return estimateContentLength({ messages: [{ content }] }) + sumPartExtras(content);
}

/**
 * Char length contributed by one streamed part — a `text-delta` / `reasoning-delta` /
 * `tool-input-delta`'s `delta` string, else 0. `tool-input-delta` carries the streamed
 * tool-call arguments (identical `delta: string` shape) and MUST be counted so a streamed
 * tool call from a usage-less endpoint is not zero-estimated (invariant 6); the terminal
 * aggregate `tool-call` part is deliberately NOT counted here, to avoid double-counting the
 * deltas it re-assembles. Content-privileged local measurement (the `delta` string is read
 * for its `.length` only and immediately discarded — the same content→integer contract
 * privacy.ts upholds; kept inline to avoid a privacy.ts call per streamed chunk).
 */
function deltaChars(part: unknown): number {
  const type = getProp(part, "type");
  if (type === "text-delta" || type === "reasoning-delta" || type === "tool-input-delta") {
    const delta = getProp(part, "delta");
    return typeof delta === "string" ? delta.length : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Options + handle.
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link createSolwynMiddleware}. A focused subset of the client's
 * `SolwynOptions`: failover/routing knobs are irrelevant here (the AI SDK owns the single
 * wrapped model — Solwyn never re-routes it). Field names mirror the client's camelCase
 * surface; resolution (env-var fallback via `SOLWYN_*`, `api_key` format validation,
 * defaults) reuses {@link resolveConfig} verbatim.
 */
export interface SolwynMiddlewareOptions {
  /** Solwyn project API key (`sk_proj_` + 64 hex). Falls back to `SOLWYN_API_KEY` on Node. */
  apiKey?: string;
  /** Solwyn Cloud API base URL. Defaults to `https://api.solwyn.ai`. */
  apiUrl?: string;
  /** Budget fail-open policy (default true). */
  failOpen?: boolean;
  /** Budget mode (default `alert_only`). */
  budgetMode?: BudgetMode;
  /** Enable run-scoped local token leases (default true). */
  leaseEnabled?: boolean;
  /** Output-token reservation when `maxOutputTokens` is absent (default 4096). */
  leaseOutputBoundDefault?: number;
  /** Allow-decision cache TTL in SECONDS (default 5). */
  budgetCheckCacheTtl?: number;
  /** Budget-check timeout in seconds (default 1). */
  budgetCheckTimeout?: number;
  /** Consecutive check/confirm outages before the shared breaker opens. */
  controlPlaneFailureThreshold?: number;
  /** Control-plane breaker recovery timeout in seconds (default 30). */
  controlPlaneRecoveryTimeout?: number;
  /** Accepted for config parity; AI SDK has no provider-breaker snapshot supplier. */
  breakerReportingEnabled?: boolean;
  /** Injectable logger (D6). Defaults to a console-backed logger. */
  logger?: Logger;
  /** Injectable `fetch` for the enforcer + reporter transport (tests). */
  fetch?: FetchLike;
  /** Reporter batch size (events per ingest POST). */
  reporterBatchSize?: number;
  /** Reporter background flush interval in SECONDS (default 5). */
  reporterFlushInterval?: number;
  /** Reporter queue cap (drop-oldest on overflow). */
  reporterMaxQueueSize?: number;
  /** Reporter max concurrent in-flight batch sends. */
  reporterMaxInFlight?: number;
  /** Reporter attempts before disposing retryable telemetry (default 5). */
  reporterMaxSendAttempts?: number;
  /** Reporter retry backoff base in seconds (default 1). */
  reporterRetryBackoffBase?: number;
  /** Reporter retry backoff cap in seconds (default 60). */
  reporterRetryBackoffCap?: number;
  /** Reporter shutdown deadline in seconds (default 5; zero is legal). */
  reporterShutdownDeadline?: number;
  /** Breaker report full-refresh heartbeat in seconds (default 60). */
  breakerReportHeartbeat?: number;
}

const KNOWN_OPTION_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "apiUrl",
  "failOpen",
  "budgetMode",
  "leaseEnabled",
  "leaseOutputBoundDefault",
  "budgetCheckCacheTtl",
  "budgetCheckTimeout",
  "controlPlaneFailureThreshold",
  "controlPlaneRecoveryTimeout",
  "breakerReportingEnabled",
  "logger",
  "fetch",
  "reporterBatchSize",
  "reporterFlushInterval",
  "reporterMaxQueueSize",
  "reporterMaxInFlight",
  "reporterMaxSendAttempts",
  "reporterRetryBackoffBase",
  "reporterRetryBackoffCap",
  "reporterShutdownDeadline",
  "breakerReportHeartbeat",
]);

/**
 * The result of {@link createSolwynMiddleware}: the plain `LanguageModelMiddleware` object
 * to hand to the AI SDK's `wrapLanguageModel`, plus a lifecycle handle that OWNS the
 * enforcer + reporter instances. Call {@link close} (or use `await using`) to flush queued
 * telemetry and release resources.
 */
export interface SolwynMiddlewareHandle {
  /** Pass to `wrapLanguageModel({ model, middleware })`. */
  readonly middleware: LanguageModelMiddleware;
  /** Flush queued confirms/events and shut down. Safe to call more than once. */
  close(): Promise<void>;
  /** `await using` lifecycle — delegates to {@link close}. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Translate camelCase middleware options to the snake_case config-resolution input. */
function toConfigOptions(options: SolwynMiddlewareOptions): SolwynConfigOptions {
  const config: SolwynConfigOptions = {};
  if (options.apiKey !== undefined) config.api_key = options.apiKey;
  if (options.apiUrl !== undefined) config.api_url = options.apiUrl;
  if (options.failOpen !== undefined) config.fail_open = options.failOpen;
  if (options.budgetMode !== undefined) config.budget_mode = options.budgetMode;
  if (options.leaseEnabled !== undefined) config.lease_enabled = options.leaseEnabled;
  if (options.leaseOutputBoundDefault !== undefined) {
    config.lease_output_bound_default = options.leaseOutputBoundDefault;
  }
  if (options.budgetCheckCacheTtl !== undefined) {
    config.budget_check_cache_ttl = options.budgetCheckCacheTtl;
  }
  if (options.budgetCheckTimeout !== undefined) {
    config.budget_check_timeout = options.budgetCheckTimeout;
  }
  if (options.controlPlaneFailureThreshold !== undefined) {
    config.control_plane_failure_threshold = options.controlPlaneFailureThreshold;
  }
  if (options.controlPlaneRecoveryTimeout !== undefined) {
    config.control_plane_recovery_timeout = options.controlPlaneRecoveryTimeout;
  }
  if (options.breakerReportingEnabled !== undefined) {
    config.breaker_reporting_enabled = options.breakerReportingEnabled;
  }
  if (options.reporterBatchSize !== undefined)
    config.reporter_batch_size = options.reporterBatchSize;
  if (options.reporterFlushInterval !== undefined) {
    config.reporter_flush_interval = options.reporterFlushInterval;
  }
  if (options.reporterMaxQueueSize !== undefined) {
    config.reporter_max_queue_size = options.reporterMaxQueueSize;
  }
  if (options.reporterMaxInFlight !== undefined) {
    config.reporter_max_in_flight = options.reporterMaxInFlight;
  }
  if (options.reporterMaxSendAttempts !== undefined) {
    config.reporter_max_send_attempts = options.reporterMaxSendAttempts;
  }
  if (options.reporterRetryBackoffBase !== undefined) {
    config.reporter_retry_backoff_base = options.reporterRetryBackoffBase;
  }
  if (options.reporterRetryBackoffCap !== undefined) {
    config.reporter_retry_backoff_cap = options.reporterRetryBackoffCap;
  }
  if (options.reporterShutdownDeadline !== undefined) {
    config.reporter_shutdown_deadline = options.reporterShutdownDeadline;
  }
  if (options.breakerReportHeartbeat !== undefined) {
    config.breaker_report_heartbeat = options.breakerReportHeartbeat;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Stream instrumentation — pass every chunk through UNCHANGED, observe usage/errors.
// ---------------------------------------------------------------------------

interface StreamHooks<T> {
  /** Called for every source part, in order, BEFORE it is enqueued to the consumer. */
  onPart(part: T): void;
  /** Called once when the source completes normally (all parts delivered). */
  onEnd(): void;
  /** Called once when the source stream errors (the error also propagates to the consumer). */
  onError(error: unknown): void;
  /** Called once if the consumer cancels the stream early. */
  onCancel(): void;
}

/**
 * Wrap a web `ReadableStream` so the caller iterates it UNCHANGED (every part is enqueued
 * verbatim, backpressure preserved via one source `read()` per `pull`) while the hooks
 * observe completion / error / cancel for settlement. Never buffers the stream and never
 * mutates a part.
 */
interface InstrumentedReadable<T> {
  readonly stream: ReadableStream<T>;
  /** Construction-failure cleanup: cancel the acquired reader without success hooks. */
  abort(): Promise<void>;
}

async function cancelReadableSource(source: unknown): Promise<void> {
  if ((typeof source !== "object" || source === null) && typeof source !== "function") {
    return;
  }
  const cancel = Reflect.get(source, "cancel", source);
  if (typeof cancel === "function") {
    await Reflect.apply(cancel, source, []);
  }
}

async function instrumentReadable<T>(
  source: ReadableStream<T>,
  hooks: StreamHooks<T>,
): Promise<InstrumentedReadable<T>> {
  const reader = source.getReader();
  let aborted = false;
  try {
    const stream = new ReadableStream<T>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (aborted) {
            return;
          }
          if (done) {
            hooks.onEnd();
            controller.close();
            return;
          }
          hooks.onPart(value);
          controller.enqueue(value);
        } catch (error) {
          try {
            hooks.onError(error);
          } catch {
            // Hook bookkeeping is contained; the original stream/observation error wins.
          }
          try {
            await reader.cancel();
          } catch {
            // Mid-stream cleanup is best effort; preserve the original failure.
          }
          controller.error(error);
        }
      },
      async cancel(reason) {
        let hookError: unknown;
        try {
          hooks.onCancel();
        } catch (error) {
          hookError = error;
        }
        try {
          await reader.cancel(reason);
        } catch (error) {
          if (hookError === undefined) {
            throw error;
          }
        }
        if (hookError !== undefined) {
          throw hookError;
        }
      },
    });
    return {
      stream,
      abort: () => {
        aborted = true;
        return reader.cancel();
      },
    };
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Construction cleanup is best effort; preserve the original setup failure.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

/**
 * Build a Solwyn language-model middleware plus its lifecycle handle.
 *
 * The returned {@link SolwynMiddlewareHandle.middleware} runs a pre-flight budget check
 * BEFORE `doGenerate`/`doStream` (a hard deny throws the applicable typed denial error to the
 * caller and the model is never invoked) and settles usage AFTER — one `call_id` per call,
 * exactly-once settlement including error paths (mirroring `src/client.ts`): a served
 * success confirms its reservation + reports a success event, a thrown call reports one
 * error event and sends NO confirm, a hard deny reports one `budget_denied` event.
 *
 * Attribution is derived from the wrapped model's `provider`/`modelId` (see
 * {@link resolveProviderName}); there is no failover (the AI SDK owns the model), so every
 * event is a primary hop (`attempt_index: 0`, both fallback flags false).
 *
 * @example
 * ```ts
 * import { wrapLanguageModel } from "ai";
 * import { openai } from "@ai-sdk/openai";
 * import { createSolwynMiddleware } from "@solwyn/sdk/ai-sdk";
 *
 * const solwyn = createSolwynMiddleware({ apiKey: process.env.SOLWYN_API_KEY! });
 * const model = wrapLanguageModel({ model: openai("gpt-4o"), middleware: solwyn.middleware });
 * const { text } = await generateText({ model, prompt: "Hello" });
 * await solwyn.close();
 * ```
 */
export function createSolwynMiddleware(
  options: SolwynMiddlewareOptions = {},
): SolwynMiddlewareHandle {
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTION_KEYS.has(key)) {
      throw new ConfigurationError(`unexpected option '${key}'`, { field: key });
    }
  }
  const config = resolveConfig(toConfigOptions(options));
  const logger: Logger = options.logger ?? consoleLogger;
  const sdkInstanceId = crypto.randomUUID();
  const controlPlaneBreaker = new CircuitBreaker({
    failureThreshold: config.control_plane_failure_threshold,
    recoveryTimeout: config.control_plane_recovery_timeout,
    successThreshold: 1,
    name: "control-plane",
    logger,
  });

  const budget = new BudgetEnforcer({
    apiUrl: config.api_url,
    apiKey: config.api_key,
    budgetMode: config.budget_mode,
    failOpen: config.fail_open,
    cacheTtl: config.budget_check_cache_ttl,
    fetch: options.fetch,
    logger,
    controlPlaneBreaker,
    holderId: sdkInstanceId,
    leaseEnabled: config.lease_enabled,
    leaseOutputBoundDefault: config.lease_output_bound_default,
  });

  const reporter = new MetadataReporter(config.api_url, config.api_key, {
    batchSize: config.reporter_batch_size,
    flushInterval: config.reporter_flush_interval * 1000,
    maxQueueSize: config.reporter_max_queue_size,
    maxInFlight: config.reporter_max_in_flight,
    maxSendAttempts: config.reporter_max_send_attempts,
    retryBackoffBase: config.reporter_retry_backoff_base * 1000,
    retryBackoffCap: config.reporter_retry_backoff_cap * 1000,
    shutdownDeadline: config.reporter_shutdown_deadline * 1000,
    breakerReportHeartbeat: config.breaker_report_heartbeat * 1000,
    fetch: options.fetch,
    logger,
    controlPlaneBreaker,
    sdkInstanceId,
    breakerReportingEnabled: config.breaker_reporting_enabled,
  });
  reporter.start();

  // --- Per-call attribution + the pre-flight budget decision. ---

  interface CallContext {
    provider: ProviderName;
    model: string;
    callId: string;
    run: CurrentRun | undefined;
    estimatedInputTokens: number;
    /** Immutable process-local settlement/release authority captured from preflight. */
    funding: Readonly<{
      reservationId: string | null;
      leaseId: string | null;
      leaseClaimToken: number | null;
    }>;
  }

  // Minimal STRUCTURAL views of the wrapped model + call params — the only fields the
  // pre-flight reads (attribution name strings + the prompt to size). Structural (not the
  // `ai` package's version-specific `LanguageModelV2/V3/V4` names) so the middleware stays
  // decoupled from the `ai` major version and needs only the erased `LanguageModelMiddleware`
  // type. The AI SDK's model + call-options satisfy these at every version.
  interface WrappedModelInfo {
    readonly provider: string;
    readonly modelId: string;
  }
  interface WrappedCallParams {
    readonly prompt: unknown;
    readonly maxOutputTokens?: unknown;
  }

  /**
   * Resolve attribution, size the pre-flight estimate, and run the budget check. On a deny:
   * report the `budget_denied` event and throw the applicable typed denial error (the model is
   * never invoked). On an allow: return the call context carrying the reservation id.
   */
  const preflight = async (
    model: WrappedModelInfo,
    params: WrappedCallParams,
  ): Promise<CallContext> => {
    const modelId = typeof model.modelId === "string" ? model.modelId : "";
    const provider = resolveProviderName(
      typeof model.provider === "string" ? model.provider : "",
      modelId,
    );
    const callId = crypto.randomUUID();
    const current = getCurrentRun();
    const run =
      current === undefined
        ? undefined
        : {
            ...current,
            lifetime: current.lifetime,
            tags: current.tags == null ? current.tags : { ...current.tags },
          };
    budget.observeRun(run);

    // Content -> integer (privacy.ts), then the length ratio keyed off the resolved
    // provider. Zero content estimates 0 (bypassing the min-1 floor, D8).
    const charCount = measurePromptChars(params.prompt);
    const estimatedInputTokens = charCount > 0 ? estimateTokensFromLength(charCount, provider) : 0;
    const estimatedOutputBound = resolveAiSdkOutputBound(params, config.lease_output_bound_default);

    const decision = budgetCheckResult(
      await budget.checkBudget({
        agentRunId: run?.agentRunId,
        runLifetime: run?.lifetime,
        tags: run?.tags,
        callId,
        estimatedInputTokens,
        estimatedOutputBound,
        model: modelId,
        provider,
        timeout: config.budget_check_timeout,
      }),
    );
    reporter.observeProjectId(decision.projectId);

    if (!decision.allowed) {
      try {
        reporter.report(
          buildEvent({
            status: "budget_denied",
            provider,
            model: modelId,
            callId,
            run,
            inputTokens: estimatedInputTokens,
            outputTokens: 0,
            tokenDetails: null,
            latencyMs: 0,
            failoverErrorClass: null,
            possiblySucceeded: null,
          }),
        );
      } catch {
        // The typed denial remains authoritative if telemetry construction/enqueue is unavailable.
      }
      throw budget.buildDenialError(decision, estimatedInputTokens, run?.agentRunId);
    }

    return {
      provider,
      model: modelId,
      callId,
      run,
      estimatedInputTokens,
      funding: Object.freeze({
        reservationId: decision.reservationId,
        leaseId: decision.leaseId,
        leaseClaimToken: decision.leaseClaimToken,
      }),
    };
  };

  /** Consume one escaping/non-lease claim boundary without masking its primary outcome. */
  const releaseFunding = (ctx: CallContext): void => {
    if (ctx.funding.leaseClaimToken === null) {
      return;
    }
    try {
      budget.releaseReservation(ctx.callId, ctx.funding.leaseClaimToken);
    } catch {
      // Local capability cleanup is best effort; the provider/bookkeeping value wins.
    }
  };

  /** Build a content-free {@link MetadataEvent} for one call (single primary hop). */
  function buildEvent(fields: {
    status: MetadataEvent["status"];
    provider: ProviderName;
    model: string;
    callId: string;
    run: CurrentRun | undefined;
    inputTokens: number;
    outputTokens: number;
    tokenDetails: TokenDetails | null;
    latencyMs: number;
    failoverErrorClass: string | null;
    possiblySucceeded: boolean | null;
  }): MetadataEvent {
    const event: MetadataEvent = {
      model: fields.model,
      provider: fields.provider,
      input_tokens: fields.inputTokens,
      output_tokens: fields.outputTokens,
      token_details: fields.tokenDetails,
      latency_ms: fields.latencyMs,
      status: fields.status,
      is_model_fallback: false,
      is_provider_fallback: false,
      failover_reason: null,
      failover_error_class: fields.failoverErrorClass,
      attempt_index: 0,
      call_id: fields.callId,
      service_tier: null,
      sdk_instance_id: sdkInstanceId,
      timestamp: reporter.nextEventTimestamp(),
      provider_region: null,
    };
    if (fields.possiblySucceeded !== null) {
      event.possibly_succeeded = fields.possiblySucceeded;
    }
    if (fields.run !== undefined) {
      event.agent_run_id = fields.run.agentRunId;
      event.agent_run_name = fields.run.agentRunName;
      if (fields.run.tags != null) event.tags = { ...fields.run.tags };
    }
    return event;
  }

  /** Buffered-path settlement uses the same ordered reporter queue as streaming (D18). */
  const settlePaidSuccess = (event: MetadataEvent, options: BuildConfirmRequestOptions): void => {
    try {
      const confirm = budget.buildConfirmRequest(options);
      reporter.reportSettlement(confirm, event);
    } catch {
      budget.consumeUnknownUsage(options.callId, options.leaseClaimToken ?? null);
      try {
        logger.warn("budget.confirm_construction_failed: paid usage retained conservatively");
      } catch {
        /* Diagnostics cannot replace provider success. */
      }
      try {
        reporter.report(event);
      } catch {
        /* Reporter validates independently. */
      }
    }
  };

  /** Buffered-path settlement uses the same ordered reporter queue as streaming (D18). */
  const settleBufferedSuccess = (
    ctx: CallContext,
    tokenDetails: TokenDetails,
    latencyMs: number,
    usageUnmeasured: boolean,
  ): void => {
    const event = buildEvent({
      status: "success",
      provider: ctx.provider,
      model: ctx.model,
      callId: ctx.callId,
      run: ctx.run,
      inputTokens: tokenDetails.input_tokens,
      outputTokens: tokenDetails.output_tokens,
      tokenDetails,
      latencyMs,
      failoverErrorClass: null,
      possiblySucceeded: null,
    });
    if (hasSettlementFunding(ctx.funding)) {
      settlePaidSuccess(event, {
        reservationId: ctx.funding.reservationId,
        leaseId: ctx.funding.leaseId,
        leaseClaimToken: ctx.funding.leaseClaimToken,
        model: ctx.model,
        tokenDetails,
        provider: ctx.provider,
        isProviderFallback: false,
        callId: ctx.callId,
        providerRegion: null,
        serviceTier: null,
        floorAtReservation: usageUnmeasured,
      });
    } else {
      reporter.report(event);
    }
    if (ctx.funding.leaseId === null) {
      releaseFunding(ctx);
    }
  };

  /**
   * Report one error event for a failed call (no confirm — the reservation is left to
   * expire). `failoverErrorClass` is the health-signal structural class name on an
   * establishment / buffered failure (mirrors client.ts `#buildErrorEvent`), but MUST be
   * `null` on a mid-stream drop of an already-established stream (mirrors
   * `#buildStreamErrorEvent` / F9 — a mid-stream error never fails over, so it carries no
   * health-signal class name; the same event's `possibly_succeeded: true` reconciles the
   * possibly-landed, never-confirmed spend).
   */
  const reportError = (
    ctx: CallContext,
    failoverErrorClass: string | null,
    latencyMs: number,
    possiblySucceeded: boolean | null,
  ): void => {
    reporter.report(
      buildEvent({
        status: "error",
        provider: ctx.provider,
        model: ctx.model,
        callId: ctx.callId,
        run: ctx.run,
        inputTokens: 0,
        outputTokens: 0,
        tokenDetails: null,
        latencyMs,
        failoverErrorClass,
        possiblySucceeded,
      }),
    );
  };

  /** Error reporting and capability release are both best effort; callers rethrow original. */
  const reportErrorAndRelease = (
    ctx: CallContext,
    failoverErrorClass: string | null,
    latencyMs: number,
    possiblySucceeded: boolean | null,
  ): void => {
    try {
      reportError(ctx, failoverErrorClass, latencyMs, possiblySucceeded);
    } catch {
      // Telemetry construction/enqueue must not mask the provider/bookkeeping failure.
    } finally {
      releaseFunding(ctx);
    }
  };

  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, model, params }) => {
      const ctx = await preflight(model, params);
      const started = performance.now();
      try {
        const result = await doGenerate();
        const latencyMs = performance.now() - started;
        let providerUsageAbsent = true;
        const usage = extractUsageFailSoft({
          extract: () => {
            const details = reportedUsageToTokenDetails(result.usage);
            providerUsageAbsent = details === null;
            return details;
          },
          estimate: () =>
            providerUsageAbsent
              ? estimateUsageFromLength({
                  provider: ctx.provider,
                  estimatedInputTokens: ctx.estimatedInputTokens,
                  outputChars: measureResponseChars(result.content),
                })
              : null,
          estimatedInputTokens: ctx.estimatedInputTokens,
          logger,
        });
        settleBufferedSuccess(ctx, usage.tokenDetails, latencyMs, usage.usageUnmeasured);
        return result;
      } catch (error) {
        reportErrorAndRelease(ctx, safeErrorClassName(error), performance.now() - started, null);
        throw error;
      }
    },

    wrapStream: async ({ doStream, model, params }) => {
      const ctx = await preflight(model, params);
      const started = performance.now();
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        // Establishment (pre-first-chunk) failure — carries the class name like a buffered
        // failure (#buildErrorEvent); it is a failover-eligible health signal, unlike a
        // mid-stream drop. Report one error event and propagate.
        reportErrorAndRelease(ctx, safeErrorClassName(error), performance.now() - started, null);
        throw error;
      }

      // Streaming settlement state, settled EXACTLY ONCE at stream end (behaviors 25/26):
      // usage settles from the terminal `finish` part; a mid-stream error part or a stream
      // rejection settles an error event with possibly_succeeded (the stream established).
      let settled = false;
      let capturedFinishPart: unknown;
      let sawErrorPart = false;
      let outputChars = 0;

      const settleStreamSuccess = (): void => {
        const latencyMs = performance.now() - started;
        let providerUsageAbsent = true;
        const usage = extractUsageFailSoft({
          extract: () => {
            const details = reportedUsageToTokenDetails(getProp(capturedFinishPart, "usage"));
            providerUsageAbsent = details === null;
            return details;
          },
          estimate: () =>
            providerUsageAbsent
              ? estimateUsageFromLength({
                  provider: ctx.provider,
                  estimatedInputTokens: ctx.estimatedInputTokens,
                  outputChars,
                })
              : null,
          estimatedInputTokens: ctx.estimatedInputTokens,
          logger,
        });
        const tokenDetails = usage.tokenDetails;
        const event = buildEvent({
          status: "success",
          provider: ctx.provider,
          model: ctx.model,
          callId: ctx.callId,
          run: ctx.run,
          inputTokens: tokenDetails.input_tokens,
          outputTokens: tokenDetails.output_tokens,
          tokenDetails,
          latencyMs,
          failoverErrorClass: null,
          possiblySucceeded: null,
        });
        // Streaming path routes the built confirm + its event through the reporter's queue as
        // ONE settlement (behavior 26) — never a bare inline confirm.
        if (hasSettlementFunding(ctx.funding)) {
          settlePaidSuccess(event, {
            reservationId: ctx.funding.reservationId,
            leaseId: ctx.funding.leaseId,
            leaseClaimToken: ctx.funding.leaseClaimToken,
            model: ctx.model,
            tokenDetails,
            provider: ctx.provider,
            isProviderFallback: false,
            callId: ctx.callId,
            providerRegion: null,
            serviceTier: null,
            floorAtReservation: usage.usageUnmeasured,
          });
        } else {
          reporter.report(event);
        }
        if (ctx.funding.leaseId === null) {
          releaseFunding(ctx);
        }
      };

      const settleOnce = (isStreamRejection: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        // A finish part with usage settles success; a mid-stream error part or a stream
        // rejection settles an error event (possibly_succeeded — the stream established, so
        // the provider may have generated billable output) and sends NO confirm. Mid-stream
        // errors never fail over, so the event carries NO failover_error_class (F9 /
        // #buildStreamErrorEvent) — passing `null` regardless of the underlying error.
        if (isStreamRejection || (sawErrorPart && capturedFinishPart === undefined)) {
          reportErrorAndRelease(ctx, null, performance.now() - started, true);
          return;
        }
        try {
          settleStreamSuccess();
        } catch (error) {
          reportErrorAndRelease(ctx, null, performance.now() - started, true);
          throw error;
        }
      };

      let abortSetup = (): Promise<void> => cancelReadableSource(result.stream);
      try {
        const instrumented = await instrumentReadable(result.stream, {
          onPart(part) {
            const type = getProp(part, "type");
            if (type === "finish") {
              capturedFinishPart = part;
            } else if (type === "error") {
              sawErrorPart = true;
            } else {
              outputChars += deltaChars(part);
            }
          },
          onEnd: () => settleOnce(false),
          onError: () => settleOnce(true),
          onCancel: () => settleOnce(false),
        });
        abortSetup = instrumented.abort;
        return { ...result, stream: instrumented.stream };
      } catch (error) {
        try {
          await abortSetup();
        } catch {
          // Non-success setup cleanup is best effort; preserve the original failure.
        }
        reportErrorAndRelease(ctx, safeErrorClassName(error), performance.now() - started, null);
        throw error;
      }
    },
  };

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    // Publish one captured identity before cleanup can synchronously re-enter.
    closePromise ??= Promise.resolve().then(async () => {
      // Reporter first: queued settlement/event delivery precedes the budget
      // enforcer's future lease-surrender point, matching the core client.
      await reporter.close();
      await budget.close();
    });
    return closePromise;
  };

  return {
    middleware,
    close,
    [Symbol.asyncDispose](): Promise<void> {
      return close();
    },
  };
}
