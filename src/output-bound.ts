import { OutputBoundUnenforceableError, type OutputBoundUnenforceableReason } from "./errors";
import type { Dialect } from "./providers/protocol";

export interface OutputBoundHop {
  readonly provider: string;
  readonly dialect: Dialect;
  readonly model: string;
  readonly defaultParams?: unknown;
}

export interface EffectiveOutputBoundOptions {
  readonly sourceProvider: string;
  readonly sourceDialect: Dialect;
  readonly sourceModel: string;
  readonly globalDefaults: unknown;
  readonly callParams: unknown;
  readonly hops: readonly OutputBoundHop[];
  readonly defaultBound: number;
  readonly responses?: boolean;
}

interface CapSlot {
  readonly value: unknown;
}

interface ProjectedCaps {
  maxTokens?: CapSlot;
  maxCompletionTokens?: CapSlot;
  candidates?: CapSlot;
  enableThinking?: CapSlot;
  thinkingBudget?: CapSlot;
  googleConfigMaxOutputTokens?: CapSlot;
  googleConfigCandidateCount?: CapSlot;
  bedrockMaxTokens?: CapSlot;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function ownSlot(value: unknown, key: string): CapSlot | undefined {
  if (!isObject(value) || !Object.hasOwn(value, key)) {
    return undefined;
  }
  return { value: Reflect.get(value, key) };
}

function nestedSlot(value: unknown, outerKey: string, innerKey: string): CapSlot | undefined {
  const outer = ownSlot(value, outerKey);
  if (outer === undefined) {
    return undefined;
  }
  if (!isObject(outer.value) || Array.isArray(outer.value)) {
    throw new TypeError("malformed structural output-cap object");
  }
  return ownSlot(outer.value, innerKey);
}

function usesOpenaiCompletionTokens(provider: string, model: string): boolean {
  if (provider !== "openai" && provider !== "azure_openai") {
    return false;
  }
  return (
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("gpt-5")
  );
}

/**
 * Normalize one layer before merging, so caller cap aliases override default aliases. An Azure
 * `model` is a deployment name, so Azure keeps the caller's own key and never trades
 * `max_completion_tokens` for the weaker `max_tokens`.
 */
export function normalizeOpenaiOutputCap(
  provider: string,
  model: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const modern = ownSlot(params, "max_completion_tokens");
  const legacy = ownSlot(params, "max_tokens");
  const cap = modern ?? legacy;
  if (cap === undefined) return params;
  const normalized = { ...params };
  delete normalized["max_tokens"];
  delete normalized["max_completion_tokens"];
  const completionKey =
    provider === "azure_openai"
      ? modern !== undefined
      : usesOpenaiCompletionTokens(provider, model);
  normalized[completionKey ? "max_completion_tokens" : "max_tokens"] = cap.value;
  return normalized;
}

/**
 * Azure keeps each layer's own cap key, so merged layers can carry both. Keep the key the
 * highest-precedence layer set (`layers` runs from highest to lowest) and drop the other.
 */
export function resolveAzureCapAliases(
  merged: Record<string, unknown>,
  layers: readonly Record<string, unknown>[],
): Record<string, unknown> {
  if (!Object.hasOwn(merged, "max_tokens") || !Object.hasOwn(merged, "max_completion_tokens")) {
    return merged;
  }
  const owner = layers.find(
    (layer) => Object.hasOwn(layer, "max_completion_tokens") || Object.hasOwn(layer, "max_tokens"),
  );
  const resolved = { ...merged };
  delete resolved[
    owner !== undefined && !Object.hasOwn(owner, "max_completion_tokens")
      ? "max_completion_tokens"
      : "max_tokens"
  ];
  return resolved;
}

// Two providers' OpenAI-compatible output caps leave reasoning out. Qwen thinks by default on many
// models and takes a `thinking_budget`, which the hop bound adds. xAI has no reasoning budget, so
// only its non-reasoning models can be bounded.
function xaiNonReasoning(model: string): boolean {
  return model.includes("non-reasoning");
}

/**
 * Whether a provider's reasoning cannot be bounded from request fields the SDK reads; used where
 * the request shape is opaque (the AI SDK middleware).
 */
export function reasoningOutsideCap(provider: string, model: string): boolean {
  return provider === "qwen" || (provider === "xai" && !xaiNonReasoning(model));
}

function projectCaps(
  value: unknown,
  dialect: Dialect,
  provider: string,
  model: string,
): ProjectedCaps {
  if (dialect === "openai") {
    const maxTokens = ownSlot(value, "max_tokens");
    const maxCompletionTokens = ownSlot(value, "max_completion_tokens");
    const normalized = normalizeOpenaiOutputCap(provider, model, {
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens.value }),
      ...(maxCompletionTokens === undefined
        ? {}
        : { max_completion_tokens: maxCompletionTokens.value }),
    });
    return {
      maxTokens: ownSlot(normalized, "max_tokens"),
      maxCompletionTokens: ownSlot(normalized, "max_completion_tokens"),
      candidates: ownSlot(value, "n"),
      enableThinking: ownSlot(value, "enable_thinking"),
      thinkingBudget: ownSlot(value, "thinking_budget"),
    };
  }
  if (dialect === "anthropic") {
    return { maxTokens: ownSlot(value, "max_tokens") };
  }
  if (dialect === "google") {
    // A layer's `config` replaces lower layers' config whole, so absent keys read as unset.
    if (ownSlot(value, "config") === undefined) return {};
    return {
      googleConfigMaxOutputTokens: nestedSlot(value, "config", "maxOutputTokens") ?? {
        value: undefined,
      },
      googleConfigCandidateCount: nestedSlot(value, "config", "candidateCount") ?? {
        value: undefined,
      },
    };
  }
  return {
    bedrockMaxTokens:
      ownSlot(value, "inferenceConfig") === undefined
        ? undefined
        : (nestedSlot(value, "inferenceConfig", "maxTokens") ?? { value: undefined }),
  };
}

function overlayCaps(target: ProjectedCaps, source: ProjectedCaps): void {
  // A layer that sets either OpenAI cap key replaces both, so a lower layer's alias cannot win.
  if (source.maxTokens !== undefined || source.maxCompletionTokens !== undefined) {
    target.maxTokens = source.maxTokens;
    target.maxCompletionTokens = source.maxCompletionTokens;
  }
  for (const key of Object.keys(source) as (keyof ProjectedCaps)[]) {
    const slot = source[key];
    if (slot !== undefined) target[key] = slot;
  }
}

export function positiveOutputBound(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function positiveCap(slot: CapSlot | undefined): number | null {
  return positiveOutputBound(slot?.value);
}

function resolvedProjectedCap(caps: ProjectedCaps, dialect: Dialect): number | null {
  if (dialect === "openai") {
    return positiveCap(caps.maxCompletionTokens ?? caps.maxTokens);
  }
  if (dialect === "anthropic") {
    return positiveCap(caps.maxTokens);
  }
  if (dialect === "google") {
    return positiveCap(caps.googleConfigMaxOutputTokens);
  }
  return positiveCap(caps.bedrockMaxTokens);
}

/** Candidates the request asks for; an absent or malformed count reads as one. */
function projectedCandidates(caps: ProjectedCaps, dialect: Dialect): number {
  if (dialect === "openai") return positiveCap(caps.candidates) ?? 1;
  if (dialect === "google") return positiveCap(caps.googleConfigCandidateCount) ?? 1;
  return 1;
}

/** Qwen reasoning tokens a candidate may spend outside its output cap. */
function projectedReasoning(caps: ProjectedCaps, dialect: Dialect, provider: string): number {
  if (dialect !== "openai" || provider !== "qwen") return 0;
  if (caps.enableThinking?.value === false) return 0;
  return positiveCap(caps.thinkingBudget) ?? 0;
}

function resolveHop(options: EffectiveOutputBoundOptions, hop: OutputBoundHop): number {
  const crossDialect = hop.dialect !== options.sourceDialect;
  const dialect = crossDialect ? options.sourceDialect : hop.dialect;
  const provider = crossDialect ? options.sourceProvider : hop.provider;
  const model = crossDialect ? options.sourceModel : hop.model;
  const caps: ProjectedCaps = {};
  overlayCaps(caps, projectCaps(options.globalDefaults, dialect, provider, model));
  overlayCaps(caps, projectCaps(hop.defaultParams, dialect, provider, model));
  overlayCaps(caps, projectCaps(options.callParams, dialect, provider, model));
  const cap = resolvedProjectedCap(caps, dialect) ?? options.defaultBound;
  return (cap + projectedReasoning(caps, dialect, provider)) * projectedCandidates(caps, dialect);
}

export function resolveEffectiveOutputBound(options: EffectiveOutputBoundOptions): number {
  if (options.responses === true) {
    try {
      return positiveCap(ownSlot(options.callParams, "max_output_tokens")) ?? options.defaultBound;
    } catch {
      return options.defaultBound;
    }
  }

  let largest = 0;
  let sawHop = false;
  try {
    for (const hop of options.hops) {
      sawHop = true;
      let contribution: number;
      try {
        contribution = resolveHop(options, hop);
      } catch {
        contribution = options.defaultBound;
      }
      largest = Math.max(largest, contribution);
    }
  } catch {
    return options.defaultBound;
  }
  return sawHop ? largest : options.defaultBound;
}

export function resolveAiSdkOutputBound(params: unknown, defaultBound: number): number {
  try {
    return positiveCap(ownSlot(params, "maxOutputTokens")) ?? defaultBound;
  } catch {
    return defaultBound;
  }
}

function withPositiveCap(
  request: Record<string, unknown>,
  key: string,
  bound: number,
): Record<string, unknown> {
  if (positiveOutputBound(request[key]) !== null) return request;
  return { ...request, [key]: bound };
}

function withNestedPositiveCap(
  request: Record<string, unknown>,
  outerKey: string,
  innerKey: string,
  bound: number,
): Record<string, unknown> {
  const outer = request[outerKey];
  if (outer !== undefined && outer !== null && (!isObject(outer) || Array.isArray(outer))) {
    return request;
  }
  const inner = isObject(outer) ? (outer as Record<string, unknown>) : {};
  if (positiveOutputBound(inner[innerKey]) !== null) return request;
  return { ...request, [outerKey]: { ...inner, [innerKey]: bound } };
}

export interface ApplyOutputBoundOptions {
  readonly dialect: Dialect;
  readonly provider: string;
  readonly model: string;
  readonly bound: number;
  readonly responses?: boolean;
}

/**
 * Make the reserved output bound true on one final provider request. A request that already
 * carries a positive output cap is returned untouched. Otherwise the dialect's cap key is set to
 * `bound`, replacing an absent, null, non-positive or non-integer value. A malformed Google
 * `config` or Bedrock `inferenceConfig` container is left for the provider SDK to reject.
 */
export function applyOutputBound(
  request: Record<string, unknown>,
  options: ApplyOutputBoundOptions,
): Record<string, unknown> {
  const { dialect, provider, model, bound } = options;
  if (options.responses === true) return withPositiveCap(request, "max_output_tokens", bound);
  if (dialect === "openai") {
    const cap = Object.hasOwn(request, "max_completion_tokens")
      ? request["max_completion_tokens"]
      : request["max_tokens"];
    if (positiveOutputBound(cap) !== null) return request;
    const capped = { ...request };
    delete capped["max_tokens"];
    delete capped["max_completion_tokens"];
    // An Azure `model` is a deployment name, so it cannot identify a model family.
    const completionKey =
      provider === "azure_openai" || usesOpenaiCompletionTokens(provider, model);
    capped[completionKey ? "max_completion_tokens" : "max_tokens"] = bound;
    return capped;
  }
  if (dialect === "anthropic") return withPositiveCap(request, "max_tokens", bound);
  if (dialect === "google")
    return withNestedPositiveCap(request, "config", "maxOutputTokens", bound);
  return withNestedPositiveCap(request, "inferenceConfig", "maxTokens", bound);
}

// Under hard_deny admission a body-extension channel may carry only keys the SDK accounts for in the
// bound. JavaScript provider SDKs send unknown create params as top-level body keys, so for the
// OpenAI and Anthropic dialects the extension is every key outside the typed create params
// (openai 7.36 and @anthropic-ai/sdk 0.135).
const OPENAI_CHAT_PARAMS = new Set([
  "audio",
  "frequency_penalty",
  "function_call",
  "functions",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "messages",
  "metadata",
  "modalities",
  "model",
  "moderation",
  "n",
  "parallel_tool_calls",
  "prediction",
  "presence_penalty",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "reasoning_effort",
  "response_format",
  "safety_identifier",
  "seed",
  "service_tier",
  "stop",
  "store",
  "stream",
  "stream_options",
  "temperature",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "user",
  "verbosity",
  "web_search_options",
]);
const OPENAI_RESPONSES_PARAMS = new Set([
  "access_programs",
  "background",
  "context_management",
  "conversation",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "metadata",
  "model",
  "moderation",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "reasoning",
  "safety_identifier",
  "service_tier",
  "store",
  "stream",
  "stream_options",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
]);
const ANTHROPIC_PARAMS = new Set([
  "cache_control",
  "container",
  "diagnostics",
  "inference_geo",
  "max_tokens",
  "messages",
  "metadata",
  "model",
  "output_config",
  "service_tier",
  "speed",
  "stop_sequences",
  "stream",
  "system",
  "temperature",
  "thinking",
  "tool_choice",
  "tools",
  "top_k",
  "top_p",
  "user_profile_id",
  "workspace_id",
]);
/** Qwen's reasoning switches are body extensions the bound folds in. */
const QWEN_EXTENSION_KEYS = new Set(["enable_thinking", "thinking_budget"]);
/** Bedrock `additionalModelRequestFields` keys: Anthropic `thinking`, bounded by maxTokens. */
const BEDROCK_EXTENSION_KEYS = new Set(["thinking"]);

function onlyKnownKeys(
  request: Record<string, unknown>,
  known: ReadonlySet<string>,
  extensions: ReadonlySet<string>,
  provider: string,
): void {
  for (const key of Object.keys(request)) {
    if (!known.has(key) && !extensions.has(key)) refuse(provider, "unsupported_override");
  }
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** Azure api-versions from this date accept `max_completion_tokens` for every chat deployment. */
const AZURE_COMPLETION_TOKENS_SINCE = "2024-09-01";

/**
 * Whether an Azure client accepts an injected `max_completion_tokens`. The v1 API carries no
 * dated version; an older or unparseable dated version is not trusted.
 */
export function azureAcceptsCompletionTokens(apiVersion: unknown): boolean {
  if (apiVersion === undefined || apiVersion === null) return true;
  if (typeof apiVersion !== "string") return false;
  if (apiVersion === "v1" || apiVersion === "preview" || apiVersion === "latest") return true;
  const date = /^(\d{4}-\d{2}-\d{2})(?:-preview)?$/.exec(apiVersion)?.[1];
  return date !== undefined && date >= AZURE_COMPLETION_TOKENS_SINCE;
}

export interface HopOutputEnforcement {
  readonly dialect: Dialect;
  readonly provider: string;
  readonly model: string;
  readonly responses?: boolean;
  /** Cap injected when the request has no positive one. */
  readonly defaultCap: number;
  /** Output tokens the budget check reserved for the whole call. */
  readonly reserved: number;
  /** The wrapped Azure client's api-version, when the provider is Azure OpenAI. */
  readonly azureApiVersion?: unknown;
  /** A client-level body override can rewrite the output limit after serialization. */
  readonly clientBodyOverride?: boolean;
}

function refuse(provider: string, reason: OutputBoundUnenforceableReason): never {
  throw new OutputBoundUnenforceableError({ provider, reason });
}

function presentValue(request: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(request, key) ? request[key] : undefined;
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

/** A present count must be a positive integer; null and absent mean one. */
function candidateCount(provider: string, value: unknown): number {
  if (value === undefined || value === null) return 1;
  return positiveOutputBound(value) ?? refuse(provider, "malformed_candidate_count");
}

/**
 * Hold one final hop request to the call's reserved output bound under hard_deny admission.
 * Returns the request to send, with the default cap injected when it has none, or throws
 * {@link OutputBoundUnenforceableError} when its possible output cannot be proven within the
 * reservation: (cap + reasoning outside the cap) x candidates.
 */
export function enforceOutputBound(
  request: Record<string, unknown>,
  hop: HopOutputEnforcement,
): Record<string, unknown> {
  const { dialect, provider } = hop;
  if (hop.clientBodyOverride === true) refuse(provider, "unsupported_override");
  if (hop.responses === true) {
    onlyKnownKeys(request, OPENAI_RESPONSES_PARAMS, NO_KEYS, provider);
  } else if (dialect === "openai") {
    onlyKnownKeys(
      request,
      OPENAI_CHAT_PARAMS,
      provider === "qwen" ? QWEN_EXTENSION_KEYS : NO_KEYS,
      provider,
    );
  } else if (dialect === "anthropic") {
    onlyKnownKeys(request, ANTHROPIC_PARAMS, NO_KEYS, provider);
  }
  if (dialect === "google") {
    const config = presentValue(request, "config");
    if (config !== undefined && config !== null && !isPlainContainer(config)) {
      refuse(provider, "malformed_cap_container");
    }
  }
  if (dialect === "bedrock") {
    const config = presentValue(request, "inferenceConfig");
    if (config !== undefined && config !== null && !isPlainContainer(config)) {
      refuse(provider, "malformed_cap_container");
    }
    const extra = presentValue(request, "additionalModelRequestFields");
    if (extra !== undefined && extra !== null) {
      if (!isPlainContainer(extra)) refuse(provider, "malformed_cap_container");
      onlyKnownKeys(extra, NO_KEYS, BEDROCK_EXTENSION_KEYS, provider);
    }
  }
  const before = request;
  const capped = applyOutputBound(request, {
    dialect,
    provider,
    model: hop.model,
    bound: hop.defaultCap,
    responses: hop.responses === true,
  });
  if (
    capped !== before &&
    provider === "azure_openai" &&
    hop.responses !== true &&
    !azureAcceptsCompletionTokens(hop.azureApiVersion)
  ) {
    refuse(provider, "azure_api_version");
  }

  let cap: unknown;
  let count = 1;
  let reasoning = 0;
  if (hop.responses === true) {
    cap = capped["max_output_tokens"];
  } else if (dialect === "openai") {
    cap = Object.hasOwn(capped, "max_completion_tokens")
      ? capped["max_completion_tokens"]
      : capped["max_tokens"];
    count = candidateCount(provider, presentValue(capped, "n"));
    if (provider === "qwen" && presentValue(capped, "enable_thinking") !== false) {
      // Qwen thinks by default on many models, and its caps leave reasoning out.
      reasoning =
        positiveOutputBound(presentValue(capped, "thinking_budget")) ??
        refuse(provider, "reasoning_without_budget");
    }
    if (provider === "xai" && !xaiNonReasoning(hop.model)) {
      refuse(provider, "reasoning_without_budget");
    }
  } else if (dialect === "anthropic") {
    cap = capped["max_tokens"];
  } else if (dialect === "google") {
    const config = capped["config"] as Record<string, unknown>;
    cap = config["maxOutputTokens"];
    count = candidateCount(provider, presentValue(config, "candidateCount"));
  } else {
    cap = (capped["inferenceConfig"] as Record<string, unknown>)["maxTokens"];
  }
  const perCandidate = positiveOutputBound(cap) ?? refuse(provider, "bound_exceeded");
  if ((perCandidate + reasoning) * count > hop.reserved) refuse(provider, "bound_exceeded");
  return capped;
}

/**
 * Whether AI SDK `providerOptions` carry any key. Provider options are a body-extension channel
 * the middleware cannot account for, so under hard_deny their allowlist is empty. An unreadable
 * options object counts as an override.
 */
export function aiSdkBodyOverride(params: unknown): boolean {
  try {
    const options = isObject(params) ? Reflect.get(params, "providerOptions") : undefined;
    if (options === undefined || options === null) return false;
    if (!isObject(options)) return true;
    for (const scope of Object.values(options)) {
      if (!isObject(scope)) continue;
      if (Object.keys(scope).length > 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether an AI SDK call-level `reasoning` effort can raise the wire cap above `maxOutputTokens`.
 * Only the OpenAI and Azure adapters keep reasoning inside the cap; other adapters may add a
 * thinking budget on top of it, so any effort other than `none` cannot be bounded there.
 */
export function aiSdkReasoningRaisesCap(params: unknown, provider: string): boolean {
  const reasoning = isObject(params) ? Reflect.get(params, "reasoning") : undefined;
  if (reasoning === undefined || reasoning === null || reasoning === "none") return false;
  return provider !== "openai" && provider !== "azure_openai";
}
