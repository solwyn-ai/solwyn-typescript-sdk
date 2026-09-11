/**
 * `BedrockAdapter` — the {@link ProviderAdapter} for AWS Bedrock's **Converse** API,
 * plus its streaming counterpart {@link BedrockStreamAccumulator}.
 *
 * Duck-types AWS SDK v3 `bedrock-runtime` clients and Bedrock model identifiers, and
 * extracts normalized {@link TokenDetails} from Converse responses and stream events.
 * Owns the Bedrock-specific dispatch seam.
 *
 * DISPATCH IS AWS SDK v3-SHAPED (`client.send(command)`), NOT boto3 method calls.
 * TS customers use `@aws-sdk/client-bedrock-runtime`, whose client exposes only
 * `send(command)` — there is no `.converse()`/`.converseStream()` method. The proxy
 * therefore intercepts `send(command)`, classifies the command by constructor name
 * (`ConverseCommand` / `ConverseStreamCommand`; InvokeModel variants fail loudly) and the
 * presence of `.input`, and passes the customer's original command through the pipeline.
 * {@link BedrockAdapter.prepareCall} dispatches it unchanged via `client.send(command)`.
 * The proxy reads `command.input.modelId` at that boundary and maps it to the internal
 * `model` key. Streaming intent comes from the command type, not an `isStreaming` flag.
 * A ConverseStream response exposes events through an async-iterable `.stream` property;
 * {@link BedrockAdapter.unwrapStreamSource} and {@link BedrockAdapter.wrapStreamResult}
 * preserve that outer response shape.
 *
 * ZERO provider-SDK imports (CLAUDE.md invariant 3): `@aws-sdk/*` / `aws-sdk` are never
 * imported. Client detection is fully structural/duck-typed over `unknown`, using the
 * `meta.service_model.service_name === "bedrock-runtime"` shape or the AWS SDK v3
 * constructor-name signal; see {@link BedrockAdapter.detectClient}.
 *
 * PRIVACY: this module inspects token counts, a tier label, region, and structural keys only.
 * It does not read content-bearing fields such as `output.message.content[].text` or
 * `contentBlockDelta.delta.text`. It remains outside the privacy-firewall allowlist.
 */

import { ConfigurationError } from "../errors";
import type { Logger } from "../logging";
import { consoleLogger } from "../logging";
import type { TokenDetails } from "../token-details";
import { buildReportedTokenDetails, isUsageCount } from "../token-details";
import { SERVICE_TIER_MAX_LENGTH } from "../types";
import { detectBedrockClient } from "./detection";
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
import {
  BEDROCK_NATIVE_COMMAND,
  BEDROCK_NATIVE_INPUT_SNAPSHOT,
  mergeProviderRequestOptions,
  providerTimeoutMilliseconds,
} from "./protocol";

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

/** A one-argument constructor (an AWS SDK v3 command class). */
type CommandConstructor = new (input: Record<string, unknown>) => unknown;

/**
 * The constructor function of a value (its `constructor` property), or `null` when the value
 * is not an object or carries no callable constructor. Used to rebuild a sibling Converse
 * command of the same class as the customer's original without importing `@aws-sdk/*`.
 */
function commandConstructor(value: unknown): CommandConstructor | null {
  if (!isObject(value)) {
    return null;
  }
  const ctor = value["constructor"];
  return typeof ctor === "function" ? (ctor as CommandConstructor) : null;
}

/**
 * Resolve the command instance to dispatch for one hop, including model overrides.
 *
 * The customer's ORIGINAL command travels through the pipeline under
 * {@link BEDROCK_NATIVE_COMMAND}; its `input.modelId` is the model the customer sent to the
 * PRIMARY. The pipeline's merged `kwargs["model"]` is the model this hop must actually serve
 * (`hop.model` — the primary's own model on the primary hop, a fallback entry's model on a
 * bedrock→bedrock failover hop). `entryDefaults` is the served entry's `default_params`.
 *
 * When no model/cap mutation, reserved tags, or non-empty entry defaults are in play, the
 * customer's original command is returned by identity (passed to `send` untouched, preserving
 * any per-command middleware they attached). Otherwise a sibling command of the same constructor
 * is rebuilt with fill-absent precedence (`{ ...entryDefaults, ...originalInput }`, so the
 * customer's per-call command input wins over entry defaults), with the served model forced
 * onto `modelId` and any stray `stream` key stripped (Converse carries
 * streaming intent in the command TYPE, never an input field). The sibling keeps its
 * constructor-established private brand while the original command's own state (including a
 * caller-customized Smithy `middlewareStack`) is restored descriptor-for-descriptor without
 * replacing the sanitized rebuilt `input` or evaluating accessors.
 */
function resolveConverseCommand(
  command: Record<string, unknown>,
  kwargs: Record<string, unknown>,
  entryDefaults: Record<string, unknown> | undefined,
): unknown {
  const input = getProp(command, "input");
  const originalInput = isObject(input) ? input : {};
  const inputSnapshot = (kwargs as Record<PropertyKey, unknown>)[BEDROCK_NATIVE_INPUT_SNAPSHOT];
  const sanitizedInput = isObject(inputSnapshot) ? inputSnapshot : originalInput;
  const originalModelId = originalInput["modelId"];
  const servedModel = kwargs["model"];
  const modelOverridden = typeof servedModel === "string" && servedModel !== originalModelId;
  const defaults = isObject(entryDefaults) ? entryDefaults : {};
  const hasDefaults = Object.keys(defaults).length > 0;
  const hasReservedTags = Object.hasOwn(originalInput, "solwyn_tags");
  const capChanged = !Object.is(
    getProp(getProp(originalInput, "inferenceConfig"), "maxTokens"),
    getProp(getProp(sanitizedInput, "inferenceConfig"), "maxTokens"),
  );

  if (!modelOverridden && !hasDefaults && !hasReservedTags && !capChanged) {
    return command;
  }
  const rebuiltInput: Record<string, unknown> = { ...defaults, ...sanitizedInput };
  rebuiltInput["modelId"] = typeof servedModel === "string" ? servedModel : originalModelId;
  delete rebuiltInput["stream"];
  delete rebuiltInput["solwyn_tags"];
  const ctor = commandConstructor(command);
  if (ctor !== null && ctor !== Object) {
    let stateDescriptors: PropertyDescriptorMap;
    try {
      stateDescriptors = Object.getOwnPropertyDescriptors(command);
      Reflect.deleteProperty(stateDescriptors, "input");
    } catch {
      throw new ConfigurationError(
        "Bedrock command reconstruction could not inspect caller-owned command state",
        { field: null },
      );
    }
    let sibling: unknown;
    try {
      sibling = new ctor(rebuiltInput);
    } catch {
      throw new ConfigurationError(
        "Bedrock command reconstruction could not construct a safe sibling",
        { field: null },
      );
    }
    if (sibling === command) {
      throw new ConfigurationError(
        "Bedrock command reconstruction cannot reuse the caller's original command",
        { field: null },
      );
    }
    try {
      Object.defineProperties(sibling as object, stateDescriptors);
    } catch {
      throw new ConfigurationError(
        "Bedrock command reconstruction could not preserve caller-owned command state",
        { field: null },
      );
    }
    return sibling;
  }
  const descriptors = Object.getOwnPropertyDescriptors(command);
  descriptors["input"] = {
    value: rebuiltInput,
    writable: true,
    enumerable: true,
    configurable: true,
  };
  const sibling = Object.create(Object.getPrototypeOf(command)) as Record<PropertyKey, unknown>;
  Object.defineProperties(sibling, descriptors);
  return sibling;
}

// ---------------------------------------------------------------------------
// Bedrock-specific constants. Shared limits are imported from `../types`.
// ---------------------------------------------------------------------------

/**
 * Bedrock vendor namespaces, kept in a stable order for readable diffs. Order does not
 * affect matching.
 */
const BEDROCK_VENDORS = [
  "ai21",
  "amazon",
  "anthropic",
  "cohere",
  "deepseek",
  "google",
  "luma",
  "meta",
  "minimax",
  "mistral",
  "moonshot",
  "nvidia",
  "openai",
  "qwen",
  "stability",
  "twelvelabs",
  "writer",
] as const;

/**
 * Model-id detection pattern: a two-branch alternation with both branches explicitly
 * anchored at the start of the string:
 *
 *   Branch 1 (ARN form): any Bedrock ARN regardless of resource, including GovCloud
 *     (`arn:aws-us-gov:bedrock:...`).
 *   Branch 2 (bare / geo-prefixed `vendor.model` form): an optional OPEN-ENDED geo prefix
 *     (1-2 lowercase groups of length 2-6, optionally hyphenated, then a literal `.`) —
 *     matches `us.`, `eu.`, `apac.`, `jp.`, `global.`, `us-gov.`, and any future
 *     region-class prefix structurally — followed by a known vendor namespace, a literal
 *     `.`, then one-or-more non-whitespace chars (so a bare `vendor.` with no model does
 *     NOT match).
 */
const MODEL_ID_PATTERN = new RegExp(
  `^(?:arn:aws(?:-[a-z-]+)?:bedrock:|(?:[a-z]{2,6}(?:-[a-z]{2,6})?\\.)?(?:${BEDROCK_VENDORS.join(
    "|",
  )})\\.\\S+)`,
);

// ---------------------------------------------------------------------------
// Module-level extraction helpers (content-free arithmetic/logic).
// ---------------------------------------------------------------------------

/**
 * Read one usage counter: return `usage[key]` only when it is a non-boolean integer
 * `>= 0`; otherwise (missing, `null`, non-integer, negative, or a boolean) return `0`.
 * Booleans are excluded via `typeof !== "number"`. Never throws.
 */
function count(usage: unknown, key: string): number {
  const value = getProp(usage, key);
  return isUsageCount(value) ? value : 0;
}

/**
 * Split the aggregate `cacheWriteInputTokens` into 1h / 5m buckets using the optional
 * `usage.cacheDetails` itemization (remainder-preserving clamping):
 *  - candidate 1h = sum of `inputTokens` across every `cacheDetails` entry with `ttl === "1h"`;
 *  - clamp it to the aggregate write total (`min(candidate, cacheWrite)`) — a breakdown can
 *    never claim more than the aggregate;
 *  - 5m bucket = the REMAINDER (`cacheWrite - clamped1h`), so the full write count is always
 *    preserved even when `cacheDetails` only partially itemizes;
 *  - when `cacheDetails` is absent or not an array, the whole aggregate goes to the 5m bucket
 *    (Bedrock's default prompt-cache TTL is 5 minutes).
 */
function splitCacheWrite(
  usage: unknown,
  cacheWrite: number,
): { fiveMinute: number; oneHour: number; unmeasured: boolean } {
  const details = getProp(usage, "cacheDetails");
  if (!Array.isArray(details)) {
    return { fiveMinute: cacheWrite, oneHour: 0, unmeasured: details != null };
  }
  let candidate1h = 0;
  let unmeasured = false;
  try {
    for (const entry of details) {
      if (getProp(entry, "ttl") === "1h") {
        const tokens = getProp(entry, "inputTokens");
        if (isUsageCount(tokens)) candidate1h += tokens;
        else unmeasured = true;
      }
    }
  } catch {
    unmeasured = true;
  }
  const clamped1h = Math.min(candidate1h, cacheWrite);
  return { fiveMinute: cacheWrite - clamped1h, oneHour: clamped1h, unmeasured };
}

/**
 * Normalize a Converse `usage` mapping to {@link TokenDetails} using the AWS-documented
 * additive formula: `input_tokens = inputTokens + cacheReadInputTokens + cacheWriteInputTokens`
 * (`inputTokens` covers only the non-cached portion). A non-mapping `usage` yields all zeros.
 * Never throws — plain-built (never validated) so an out-of-bound garbage count is caught
 * fail-open at the reporter wire boundary, not here.
 */
function usageToTokenDetails(usage: unknown): TokenDetails {
  if (!isObject(usage)) {
    return buildReportedTokenDetails({});
  }
  const inputTokens = count(usage, "inputTokens");
  const cacheRead = count(usage, "cacheReadInputTokens");
  const cacheWrite = count(usage, "cacheWriteInputTokens");
  const { fiveMinute, oneHour, unmeasured } = splitCacheWrite(usage, cacheWrite);
  return buildReportedTokenDetails(
    {
      input_tokens: inputTokens + cacheRead + cacheWrite,
      output_tokens: getProp(usage, "outputTokens"),
      cached_input_tokens: getProp(usage, "cacheReadInputTokens"),
      cache_creation_5m_tokens: fiveMinute,
      cache_creation_1h_tokens: oneHour,
    },
    unmeasured ||
      !isUsageCount(getProp(usage, "inputTokens")) ||
      (getProp(usage, "cacheWriteInputTokens") != null &&
        !isUsageCount(getProp(usage, "cacheWriteInputTokens"))),
  );
}

/** Read `response.usage` and normalize it. Non-mapping response / missing usage → zeros. */
function extractConverseUsage(response: unknown): TokenDetails {
  return usageToTokenDetails(getProp(response, "usage"));
}

/**
 * Extract the service-tier label from a Converse response dict OR a stream `metadata`
 * event dict (same algorithm, different carrier), or `null`:
 *  1. non-mapping carrier → `null`;
 *  2. `carrier.serviceTier.type` (when `serviceTier` is a mapping with a `type` key);
 *  3. else `carrier.performanceConfig.latency` — `serviceTier.type` WINS over
 *     `performanceConfig.latency` when both yield a string;
 *  4. non-string result → `null` (not coerced);
 *  5. a string longer than {@link SERVICE_TIER_MAX_LENGTH} is TRUNCATED to that length
 *     (never rejected) with a warning logged through the injected logger.
 * Never throws.
 */
function extractTier(carrier: unknown, logger: Logger): string | null {
  if (!isObject(carrier)) {
    return null;
  }
  let tier: unknown;
  const serviceTier = getProp(carrier, "serviceTier");
  if (isObject(serviceTier) && "type" in serviceTier) {
    tier = serviceTier["type"];
  }
  if (typeof tier !== "string") {
    const performanceConfig = getProp(carrier, "performanceConfig");
    if (isObject(performanceConfig) && "latency" in performanceConfig) {
      tier = performanceConfig["latency"];
    }
  }
  if (typeof tier !== "string") {
    return null;
  }
  if (tier.length > SERVICE_TIER_MAX_LENGTH) {
    logger.warn(`Bedrock service tier exceeds ${SERVICE_TIER_MAX_LENGTH} characters; truncating`);
    return tier.slice(0, SERVICE_TIER_MAX_LENGTH);
  }
  return tier;
}

/** Options for {@link BedrockAdapter}. */
export interface BedrockAdapterOptions {
  /** Logger for the (rare) service-tier truncation warning + stream-abandonment warning. */
  logger?: Logger;
}

/**
 * {@link ProviderAdapter} implementation for AWS Bedrock's Converse API. Stateless aside
 * from an injected logger; `name` and `dialect` are always `"bedrock"`.
 */
export class BedrockAdapter implements ProviderAdapter {
  readonly name = "bedrock";
  readonly dialect: Dialect = "bedrock";
  readonly #logger: Logger;

  constructor(options: BedrockAdapterOptions = {}) {
    this.#logger = options.logger ?? consoleLogger;
  }

  /**
   * Duck-typed detection of a genuine `bedrock-runtime` client.
   *
   * Detection uses either of two structural signals:
   *  - the boto3/aioboto3 shape `client.meta.service_model.service_name === "bedrock-runtime"`, or
   *  - an AWS SDK v3 constructor name containing `"bedrockruntime"` (the v3 client class is
   *    `BedrockRuntimeClient`; the control-plane `BedrockClient` does NOT contain the substring).
   *
   * Accepts: boto3 + aioboto3 + AWS SDK v3 `bedrock-runtime` clients.
   * Rejects: the control-plane `bedrock` client (`service_name === "bedrock"`), any other AWS
   * service client (e.g. `s3`), any foreign-SDK client, and any object missing `.meta`.
   * Never throws.
   */
  detectClient(client: unknown): boolean {
    return detectBedrockClient(client);
  }

  /** True for Bedrock model-identity strings (ARN form or geo-prefixed `vendor.model`). Never throws. */
  detectModel(model: string): boolean {
    return typeof model === "string" && MODEL_ID_PATTERN.test(model);
  }

  /** Additive Converse-usage extraction. Never throws. */
  extractUsage(response: unknown): TokenDetails {
    return extractConverseUsage(response);
  }

  /**
   * ALWAYS `null` — Converse responses are contractually guaranteed to carry a `usage`
   * block, so there is no length-based estimated fallback for Bedrock (contrast:
   * OpenAI-compatible adapters). A Bedrock adapter must never synthesize an estimated count.
   */
  estimateMissingUsage(
    _response: unknown,
    _options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    return null;
  }

  /** Extract the service-tier label (truncation warnings go through the logger). */
  extractServiceTier(response: unknown): string | null {
    return extractTier(response, this.#logger);
  }

  /**
   * Serving region for per-(model, region) pricing. Accepts both client shapes:
   *  - metadata-shaped clients: `client.meta.region_name` (a plain string), and
   *  - AWS SDK v3: `client.config.region` — read ONLY when it is a plain string (the
   *    synchronous case). A v3 client frequently resolves `config.region` to an ASYNC
   *    provider (a `() => Promise<string>`); that is deliberately NOT awaited (region
   *    extraction is synchronous and non-blocking) and resolves to `null` here.
   * Returns `null` when neither shape yields a non-empty string. Never throws.
   */
  extractRegion(client: unknown): string | null {
    const boto = getProp(getProp(client, "meta"), "region_name");
    if (typeof boto === "string" && boto.length > 0) {
      return boto;
    }
    const v3 = getProp(getProp(client, "config"), "region");
    if (typeof v3 === "string" && v3.length > 0) {
      return v3;
    }
    return null;
  }

  /**
   * Return a shallow COPY of `kwargs`, unchanged. Converse always emits the terminal
   * `metadata` event carrying usage, so there is no `stream_options`-style opt-in to inject
   * (contrast: OpenAI). Never mutates the input; `crossProvider` is accepted but unused.
   */
  prepareStreaming(
    kwargs: Record<string, unknown>,
    _options?: PrepareStreamingOptions,
  ): Record<string, unknown> {
    return { ...kwargs };
  }

  /**
   * Fresh {@link BedrockStreamAccumulator} per streaming call. The estimated-input-tokens
   * and surface hints are accepted (protocol conformance) but ignored — Converse streams
   * always carry terminal usage.
   */
  createStreamAccumulator(_options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    return new BedrockStreamAccumulator(this.#logger);
  }

  /**
   * Dispatch seam (AWS SDK v3 `client.send(command)`). The customer's ORIGINAL command —
   * a `ConverseCommand` / `ConverseStreamCommand` — is threaded through the pipeline kwargs
   * bag under {@link BEDROCK_NATIVE_COMMAND} by the proxy (which already read
   * `command.input.modelId`, renamed it to the pipeline `model` key, and decided streaming
   * intent from the command TYPE). This method:
   *  - pulls the untouched command back out of `kwargs` and returns a bound dispatch that
   *    calls `client.send(command, ...passthroughArgs)`; an unchanged primary command keeps
   *    its identity, so any per-command middleware the caller attached survives;
   *  - throws {@link ConfigurationError} when no native command was threaded (a Converse
   *    call must arrive via `send(command)`) or when the client exposes no `send()`.
   *
   * The command carries streaming intent. The adapter converts `options.timeout` once and
   * overwrites AWS SDK v3's structural second-argument `requestTimeout`; no retry key is invented.
   * That carrier is not claimed as a universal hard stream abort for every Smithy Node handler.
   *
   * For model overrides, a same-dialect Bedrock-to-Bedrock hop that must swap
   * the served model (or a hop whose entry carries a non-empty `default_params`) rebuilds a
   * sibling command via `new (command.constructor)({ ...entryDefaults, ...command.input,
   * modelId: servedModel })` and sends THAT — the command boundary is the single place the
   * modelId lives. When no reshaping is needed (the primary hop: same model, empty entry
   * `default_params`), the customer's ORIGINAL command is sent by identity, untouched. The
   * served model rides in `kwargs["model"]` (the pipeline's merged `hop.model`); the entry
   * `default_params` ride in `options.entryDefaultParams`. See {@link resolveConverseCommand}.
   */
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    options: PrepareCallOptions,
  ): PreparedDispatch {
    const command = (kwargs as Record<PropertyKey, unknown>)[BEDROCK_NATIVE_COMMAND];
    if (!isObject(command)) {
      throw new ConfigurationError(
        "Bedrock dispatch requires a native Converse command sent via client.send(command)",
        { field: null },
      );
    }
    const send = getProp(client, "send");
    if (typeof send !== "function") {
      throw new ConfigurationError("wrapped Bedrock client does not expose send()", {
        field: null,
      });
    }
    const fn = send as DispatchMethod;
    const dispatchCommand = resolveConverseCommand(command, kwargs, options.entryDefaultParams);
    return (...passthroughArgs) =>
      fn.call(
        client,
        dispatchCommand,
        ...mergeProviderRequestOptions(passthroughArgs, {
          requestTimeout: providerTimeoutMilliseconds(options.timeout),
        }),
      );
  }

  /**
   * Return the identity of `response["stream"]` — the INNER event-stream object of an AWS
   * SDK v3 ConverseStream response (`{ stream: AsyncIterable<...>, $metadata }`), whose
   * `close()`/iterator `return()` releases the underlying connection. This is the object the
   * stream wrapper must own, not the outer response.
   */
  unwrapStreamSource(response: unknown): unknown {
    return getProp(response, "stream");
  }

  /**
   * Rebuild the AWS SDK v3 ConverseStream response shape around the wrapped iterable:
   *  - same-dialect (mapping `servedResponse`): spread-preserve every other top-level key
   *    (e.g. `$metadata`) and overwrite `stream`;
   *  - cross-provider (non-mapping `servedResponse` — a foreign stream object): return a minimal
   *    `{ stream: wrapper }` with nothing else to preserve.
   */
  wrapStreamResult(wrapper: unknown, servedResponse: unknown): unknown {
    if (isObject(servedResponse)) {
      return { ...servedResponse, stream: wrapper };
    }
    return { stream: wrapper };
  }
}

// ---------------------------------------------------------------------------
// BedrockStreamAccumulator
// ---------------------------------------------------------------------------

/**
 * Accumulates ConverseStream usage, settling from the single terminal `metadata` event.
 * Constructed fresh per streaming call.
 *
 * State: the last observed `usage` mapping (or `null`), the last observed service tier (or
 * `null`), and a `sawEvent` flag set on EVERY mapping-shaped chunk — including a bare
 * `{ metadata: {...} }` chunk. The `sawEvent`-on-metadata behavior is load-bearing (regression
 * pin): it distinguishes "a stream ran but usage never arrived" (warn) from "nothing was ever
 * observed" (silent).
 *
 * CONCURRENCY: one instance must never be shared across two concurrent stream reads (a single
 * async consumer of one stream's events is the only supported driver).
 */
export class BedrockStreamAccumulator implements StreamUsageAccumulator {
  #usage: Record<string, unknown> | null = null;
  #serviceTier: string | null = null;
  #sawEvent = false;
  readonly #logger: Logger;

  constructor(logger: Logger = consoleLogger) {
    this.#logger = logger;
  }

  observe(chunk: unknown): void {
    // Non-mapping chunk (including null/undefined/arbitrary object): safe no-op — never
    // throws, does not set sawEvent.
    if (!isObject(chunk)) {
      return;
    }
    // Every mapping chunk marks the stream as observed — INCLUDING a metadata-keyed chunk.
    this.#sawEvent = true;
    const metadata = getProp(chunk, "metadata");
    if (isObject(metadata)) {
      const usage = getProp(metadata, "usage");
      if (isObject(usage)) {
        this.#usage = usage;
      }
      const tier = extractTier(metadata, this.#logger);
      if (tier !== null) {
        this.#serviceTier = tier;
      }
    }
  }

  finalize(): TokenDetails {
    if (this.#usage === null) {
      if (this.#sawEvent) {
        // Missing terminal usage remains estimated and holds the paid reservation floor.
        // The fixed warning preserves a content-free metadata diagnostic.
        this.#logger.warn(
          "Bedrock stream settled at zero tokens: no usage in the terminal metadata event " +
            "(stream abandoned, or the metadata event carried no usage)",
        );
      }
      return buildReportedTokenDetails({});
    }
    return usageToTokenDetails(this.#usage);
  }

  getServiceTier(): string | null {
    return this.#serviceTier;
  }
}
