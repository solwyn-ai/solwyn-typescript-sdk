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
import { ConfigurationError, RunStoppedError, SolwynError } from "../errors";
import { extractUsageFailSoft, hasSettlementFunding } from "../fail-soft";
import { consoleLogger, type Logger } from "../logging";
import { resolveAiSdkOutputBound } from "../output-bound";
import { estimateContentLength, estimateTokensFromLength } from "../privacy";
import { MetadataReporter } from "../reporter";
import { type CurrentRun, getCurrentRun } from "../run-context";
import {
  acquireTerminationHandle,
  postcheckTermination,
  runTermination,
  type TerminationHandle,
} from "../run-control";
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
  ["vertex.anthropic", "anthropic"],
  ["openai-compatible", "openai_compatible"],
  ["lmstudio", "lmstudio"],
  ["vllm", "vllm"],
  ["alibaba", "qwen"],
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
    if (
      prefix === "openai"
        ? lower === prefix || lower.startsWith(`${prefix}.`)
        : lower.startsWith(prefix)
    ) {
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

function callerAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
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
function reportedUsageToTokenDetails(usage: unknown, ctx: UsageContext): TokenDetails | null {
  const input = readUsageTotal(getProp(usage, "inputTokens"));
  const output = readUsageTotal(getProp(usage, "outputTokens"));

  if (input === null && output === null) {
    return null;
  }

  const cached =
    getProp(getProp(usage, "inputTokens"), "cacheRead") ?? getProp(usage, "cachedInputTokens");
  const reasoning =
    getProp(getProp(usage, "outputTokens"), "reasoning") ?? getProp(usage, "reasoningTokens");
  const cacheWrite = getProp(getProp(usage, "inputTokens"), "cacheWrite");
  const inputTokens = isUsageCount(input) ? input : input === null ? ctx.estimatedInputTokens : 0;
  const outputTokens = isUsageCount(output)
    ? output
    : output === null && ctx.outputChars > 0
      ? estimateTokensFromLength(ctx.outputChars, ctx.provider)
      : 0;
  const cachedTokens = Math.min(isUsageCount(cached) ? cached : 0, inputTokens);
  const cacheWriteTokens = Math.min(
    isUsageCount(cacheWrite) ? cacheWrite : 0,
    inputTokens - cachedTokens,
  );

  return buildTokenDetails({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedTokens,
    cache_creation_5m_tokens: cacheWriteTokens,
    reasoning_tokens: isUsageCount(reasoning) ? reasoning : 0,
    is_estimated:
      !isUsageCount(input) ||
      !isUsageCount(output) ||
      (cached != null && !isUsageCount(cached)) ||
      (cacheWrite != null && !isUsageCount(cacheWrite)) ||
      (isUsageCount(cached) && cachedTokens !== cached) ||
      (isUsageCount(cacheWrite) && cacheWriteTokens !== cacheWrite) ||
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
  return reportedUsageToTokenDetails(usage, ctx) ?? estimateUsageFromLength(ctx);
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
  /**
   * Accepted for compatibility but currently has no effect: reporter sends are serial,
   * one request at a time.
   */
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
  /** Reject new calls, drain in-flight work, settle open streams, and flush queued usage. */
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
  /** Abort before forwarding a source chunk when its captured run is stopped. */
  checkTermination(): void;
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
          hooks.checkTermination();
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

interface CallContext {
  provider: ProviderName;
  model: string;
  callId: string;
  run: CurrentRun | undefined;
  estimatedInputTokens: number;
  abortSignal: AbortSignal | undefined;
  /** Immutable process-local settlement/release authority captured from preflight. */
  funding: Readonly<{
    reservationId: string | null;
    leaseId: string | null;
    leaseClaimToken: number | null;
  }>;
}

type StreamSettlementContext = Omit<CallContext, "run" | "abortSignal"> & {
  run: Pick<CurrentRun, "agentRunId" | "agentRunName" | "tags"> | undefined;
};

interface StreamSettlementOwner {
  readonly settlements: Set<MiddlewareStreamSettlement>;
  readonly logger: Logger;
  closed: boolean;
  settleSuccess(
    ctx: StreamSettlementContext,
    tokenDetails: TokenDetails,
    latencyMs: number,
    usageUnmeasured: boolean,
  ): void;
  reportErrorAndRelease(
    ctx: StreamSettlementContext,
    failoverErrorClass: string | null,
    latencyMs: number,
    possiblySucceeded: boolean | null,
  ): void;
  releaseFunding(ctx: StreamSettlementContext): void;
}

function extractStreamUsage(
  ctx: StreamSettlementContext,
  outputChars: number,
  part: unknown,
  logger: Logger,
): ReturnType<typeof extractUsageFailSoft> {
  let providerUsageAbsent = true;
  const usageContext = {
    provider: ctx.provider,
    estimatedInputTokens: ctx.estimatedInputTokens,
    outputChars,
  };
  return extractUsageFailSoft({
    extract: () => {
      const details = reportedUsageToTokenDetails(getProp(part, "usage"), usageContext);
      providerUsageAbsent = details === null;
      return details;
    },
    estimate: () => (providerUsageAbsent ? estimateUsageFromLength(usageContext) : null),
    estimatedInputTokens: ctx.estimatedInputTokens,
    logger,
  });
}

/** Held by the finalizer: counts and attribution only, never a stream, source or run lifetime. */
class MiddlewareStreamSettlement {
  settled = false;
  #finishUsage: ReturnType<typeof extractUsageFailSoft> | undefined;
  #sawErrorPart = false;
  #outputChars = 0;

  constructor(
    readonly owner: StreamSettlementOwner,
    readonly ctx: StreamSettlementContext,
    readonly started: number,
    readonly terminationHandle: TerminationHandle | undefined,
  ) {}

  observe(part: unknown): void {
    if (this.settled) return;
    const type = getProp(part, "type");
    if (type === "finish") {
      // Normalize immediately: even a usage getter or an extra field can retain the source.
      this.#finishUsage = extractStreamUsage(this.ctx, this.#outputChars, part, this.owner.logger);
    } else if (type === "error") {
      this.#sawErrorPart = true;
    } else {
      this.#outputChars += deltaChars(part);
    }
  }

  release(): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.owner.settlements.delete(this);
    collectedStreamSettlements.unregister(this);
    this.terminationHandle?.release();
    return true;
  }

  settle(outcome: "success" | "error" | "interrupted"): void {
    if (!this.release()) return;
    if (this.owner.closed) {
      this.owner.releaseFunding(this.ctx);
      return;
    }
    const latencyMs = performance.now() - this.started;
    if (
      outcome === "error" ||
      (outcome === "success" && this.#sawErrorPart && this.#finishUsage === undefined)
    ) {
      this.owner.reportErrorAndRelease(this.ctx, null, latencyMs, true);
      return;
    }
    try {
      const usage =
        this.#finishUsage ??
        extractStreamUsage(this.ctx, this.#outputChars, undefined, this.owner.logger);
      this.owner.settleSuccess(this.ctx, usage.tokenDetails, latencyMs, usage.usageUnmeasured);
    } catch (error) {
      this.owner.reportErrorAndRelease(this.ctx, null, latencyMs, true);
      throw error;
    }
  }
}

const collectedStreamSettlements = new FinalizationRegistry<MiddlewareStreamSettlement>(
  (settlement) => {
    try {
      // Accounting only: GC timing supplies neither provider health nor routing latency.
      settlement.settle("success");
    } catch {
      // Finalization bookkeeping cannot throw into the host runtime.
    }
  },
);

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
 * success confirms its reservation + reports a success event, an ordinary provider failure
 * reports one error event and sends NO confirm, a hard deny reports one `budget_denied` event.
 * Cooperative stream stops and caller cancellation settle the usage observed so far.
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

  let closePromise: Promise<void> | null = null;
  const inFlightCalls = new Set<Promise<void>>();
  const streamSettlements = new Set<MiddlewareStreamSettlement>();
  const safeWarn = (message: string): void => {
    try {
      logger.warn(message);
    } catch {
      // Lifecycle cleanup must survive caller-owned diagnostics.
    }
  };
  const trackCall = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closePromise !== null) throw new SolwynError("client is closed");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    inFlightCalls.add(pending);
    try {
      return await operation();
    } finally {
      inFlightCalls.delete(pending);
      release();
    }
  };

  // --- Per-call attribution + the pre-flight budget decision. ---

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
    readonly abortSignal?: AbortSignal;
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
    if (params.abortSignal?.aborted) throw callerAbortError(params.abortSignal);
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
        signal: params.abortSignal,
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
      abortSignal: params.abortSignal,
      funding: Object.freeze({
        reservationId: decision.reservationId,
        leaseId: decision.leaseId,
        leaseClaimToken: decision.leaseClaimToken,
      }),
    };
  };

  /** Consume one escaping/non-lease claim boundary without masking its primary outcome. */
  const releaseFunding = (ctx: StreamSettlementContext): void => {
    if (ctx.funding.leaseClaimToken === null) {
      return;
    }
    try {
      budget.releaseReservation(ctx.callId, ctx.funding.leaseClaimToken);
    } catch {
      // Local capability cleanup is best effort; the provider/bookkeeping value wins.
    }
  };

  const stoppedError = (
    ctx: CallContext,
    handle?: TerminationHandle,
  ): RunStoppedError | undefined => {
    if (ctx.run === undefined) return undefined;
    const termination =
      handle?.check() ??
      runTermination(ctx.run.agentRunId) ??
      postcheckTermination(ctx.run.agentRunId);
    return termination === undefined
      ? undefined
      : new RunStoppedError({
          agentRunId: ctx.run.agentRunId,
          reason: termination.reason,
          source: termination.source,
        });
  };

  const assertDispatchAllowed = (ctx: CallContext, handle?: TerminationHandle): void => {
    if (ctx.abortSignal?.aborted) {
      releaseFunding(ctx);
      throw callerAbortError(ctx.abortSignal);
    }
    const error = stoppedError(ctx, handle);
    if (error === undefined) return;
    try {
      reporter.report(
        buildEvent({
          status: "budget_denied",
          provider: ctx.provider,
          model: ctx.model,
          callId: ctx.callId,
          run: ctx.run,
          inputTokens: ctx.estimatedInputTokens,
          outputTokens: 0,
          tokenDetails: null,
          latencyMs: 0,
          failoverErrorClass: null,
          possiblySucceeded: null,
        }),
      );
    } catch {
      // A concurrent run stop remains authoritative if telemetry is unavailable.
    } finally {
      releaseFunding(ctx);
    }
    throw error;
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
    ctx: StreamSettlementContext,
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
    ctx: StreamSettlementContext,
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
    ctx: StreamSettlementContext,
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

  const streamSettlementOwner: StreamSettlementOwner = {
    settlements: streamSettlements,
    logger,
    closed: false,
    settleSuccess: settleBufferedSuccess,
    reportErrorAndRelease,
    releaseFunding,
  };

  const meteredMiddleware = {
    wrapGenerate: async ({ doGenerate, model, params }) => {
      const ctx = await preflight(model, params);
      assertDispatchAllowed(ctx);
      const started = performance.now();
      try {
        const result = await doGenerate();
        const latencyMs = performance.now() - started;
        let providerUsageAbsent = true;
        const usage = extractUsageFailSoft({
          extract: () => {
            const details = reportedUsageToTokenDetails(result.usage, {
              provider: ctx.provider,
              estimatedInputTokens: ctx.estimatedInputTokens,
              outputChars:
                readUsageTotal(getProp(result.usage, "outputTokens")) === null
                  ? measureResponseChars(result.content)
                  : 0,
            });
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
      const terminationHandle =
        ctx.run === undefined ? undefined : acquireTerminationHandle(ctx.run.agentRunId);
      try {
        assertDispatchAllowed(ctx, terminationHandle);
      } catch (error) {
        terminationHandle?.release();
        throw error;
      }
      const started = performance.now();
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (error) {
        // Establishment (pre-first-chunk) failure — carries the class name like a buffered
        // failure (#buildErrorEvent); it is a failover-eligible health signal, unlike a
        // mid-stream drop. Report one error event and propagate.
        terminationHandle?.release();
        reportErrorAndRelease(ctx, safeErrorClassName(error), performance.now() - started, null);
        throw error;
      }

      // Construct the finalizer's held value outside this frame. It must not reach result,
      // params, the source reader, the caller signal or the run's ownership token.
      const settlement = new MiddlewareStreamSettlement(
        streamSettlementOwner,
        {
          provider: ctx.provider,
          model: ctx.model,
          callId: ctx.callId,
          estimatedInputTokens: ctx.estimatedInputTokens,
          funding: ctx.funding,
          run:
            ctx.run === undefined
              ? undefined
              : {
                  agentRunId: ctx.run.agentRunId,
                  agentRunName: ctx.run.agentRunName,
                  tags: ctx.run.tags,
                },
        },
        started,
        terminationHandle,
      );
      let abortSetup = (): Promise<void> => cancelReadableSource(result.stream);
      try {
        const instrumented = await instrumentReadable(result.stream, {
          checkTermination() {
            if (closePromise !== null) throw new SolwynError("client is closed");
            if (ctx.abortSignal?.aborted) throw callerAbortError(ctx.abortSignal);
            const error = stoppedError(ctx, terminationHandle);
            if (error !== undefined) throw error;
          },
          onPart(part) {
            settlement.observe(part);
          },
          onEnd: () => settlement.settle("success"),
          onError: (error) => {
            if (
              error instanceof RunStoppedError ||
              ctx.abortSignal?.aborted ||
              closePromise !== null
            ) {
              settlement.settle("interrupted");
            } else {
              settlement.settle("error");
            }
          },
          onCancel: () => {
            if (ctx.abortSignal?.aborted) settlement.settle("interrupted");
            else settlement.settle("success");
          },
        });
        abortSetup = instrumented.abort;
        const wrappedResult = { ...result, stream: instrumented.stream };
        if (!settlement.settled) {
          streamSettlements.add(settlement);
          collectedStreamSettlements.register(instrumented.stream, settlement, settlement);
        }
        return wrappedResult;
      } catch (error) {
        const released = settlement.release();
        try {
          await abortSetup();
        } catch {
          // Non-success setup cleanup is best effort; preserve the original failure.
        }
        if (released) {
          reportErrorAndRelease(ctx, safeErrorClassName(error), performance.now() - started, null);
        }
        throw error;
      }
    },
  } satisfies LanguageModelMiddleware;

  const close = (): Promise<void> => {
    // Publish one captured identity before cleanup can synchronously re-enter.
    if (closePromise !== null) return closePromise;
    const deadline = performance.now() + config.reporter_shutdown_deadline * 1000;
    closePromise = Promise.resolve().then(async () => {
      const remaining = Math.max(0, deadline - performance.now());
      if (inFlightCalls.size > 0 && remaining > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          void Promise.all(inFlightCalls).then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (inFlightCalls.size > 0) {
        safeWarn(`middleware.close_inflight_timeout: ${inFlightCalls.size} calls still active`);
      }
      for (const settlement of streamSettlements) {
        try {
          settlement.settle("interrupted");
        } catch {
          safeWarn("middleware.close_stream_settlement_failed");
        }
      }
      streamSettlements.clear();
      streamSettlementOwner.closed = true;
      // Reporter first: queued settlement/event delivery precedes the budget
      // enforcer's future lease-surrender point, matching the core client.
      await reporter.close(Math.max(0, deadline - performance.now()));
      await budget.close();
    });
    return closePromise;
  };

  return {
    middleware: {
      wrapGenerate: (args) => trackCall(() => meteredMiddleware.wrapGenerate(args)),
      wrapStream: (args) => trackCall(() => meteredMiddleware.wrapStream(args)),
    },
    close,
    [Symbol.asyncDispose](): Promise<void> {
      return close();
    },
  };
}
