/**
 * ES `Proxy` wrapping that turns a {@link SolwynCore} into the public, drop-in
 * `Solwyn` client.
 *
 * Two responsibilities, mirroring `solwyn/_proxies.py` (collapsed to one async
 * client per CLAUDE.md — Python's six sync/async proxy classes become three proxy
 * behaviors):
 *
 *  1. **Full passthrough.** Every attribute NOT explicitly intercepted forwards
 *     straight to the wrapped provider SDK client, preserving its value, identity,
 *     and — at the type level — its exact TypeScript surface (the public `Solwyn`
 *     type intersects with the wrapped client type `C`, so
 *     `new Solwyn(new OpenAI(), { apiKey })` type-checks `.chat.completions.create`
 *     against OpenAI's own parameter types).
 *
 *  2. **Interception.** Text-generation calls route through
 *     {@link SolwynCore.interceptedCall}: OpenAI `chat.completions.create` +
 *     `responses.create` / `responses.parse`, Anthropic `messages.create`, Google
 *     `models.generateContent[Stream]`, and Bedrock AWS SDK v3 `send(command)` for the
 *     Converse family. Tracked non-chat calls route through {@link SolwynCore.mediaCall}:
 *     native/compatible OpenAI `embeddings.create` + `images.generate`/`images.edit`,
 *     and Google `models.embedContent` + `models.generateImages`.
 *     An existing `embeddings` resource on another known dialect is still intercepted so
 *     its adapter fails through the lifecycle with `UnsupportedSurfaceError`, never as an
 *     untracked provider dispatch. Unrelated resources and methods pass through unchanged.
 *
 *     DELIBERATE TYPE DIVERGENCE (F15): an intercepted `create` returns a plain
 *     `Promise` (the async pipeline's result), NOT OpenAI's `APIPromise`. The published
 *     type ({@link SolwynConstructor} via {@link InterceptedClient}) narrows the return
 *     accordingly, so `.withResponse()`/`.asResponse()` on an intercepted path is a
 *     COMPILE error rather than a runtime `TypeError`. Parameters and every
 *     non-intercepted path keep the wrapped client's exact types.
 *
 *     `instanceof` (F22): the top-level proxy's `getPrototypeOf` trap reports the
 *     WRAPPED client's prototype, so `wrapped instanceof OpenAI` holds for libraries
 *     that branch on it. Method identity is STABLE across reads (F23): bound
 *     passthrough methods and the intercept lambdas are memoized per property key.
 *     Successful mutations invalidate the changed passthrough binding only.
 *
 * PRIVACY: every intercepted method forwards its argument bag OPAQUELY — it never
 * destructures or names a content-bearing field. Keep it that way: this module needs
 * no content awareness to do its job.
 */

import {
  __resetUnmeteredSurfaceWarnings as resetUnmeteredSurfaceWarnings,
  SolwynCore,
  type SolwynOptions,
} from "./client";
import { registerCoverageSource } from "./coverage";
import { ConfigurationError, SolwynError } from "./errors";
import {
  estimateEmbeddingInputTokens,
  estimateGoogleEmbeddingInputTokens,
  measureGoogleImageMedia,
  measureImageMedia,
  measureOpenAIVideoMedia,
  measureSpeechMedia,
  measureVideoMedia,
} from "./privacy";
import type { MediaSurfaceSpec } from "./providers/protocol";
import { BEDROCK_NATIVE_COMMAND, BEDROCK_NATIVE_INPUT_SNAPSHOT } from "./providers/protocol";
import type {
  DeferredResponsesStreamMethod,
  PlainResponsesParse,
} from "./providers/translation/response-types";
import { brandSolwynWrapper, isSolwynWrapper } from "./registry";
import { snapshotRequestStructure } from "./request-options";
import { observeEvaluatedProperty } from "./surface-graph";
import type { SurfaceDialect } from "./surfaces";
import { buildReportedTokenDetails, buildTokenDetails, isUsageCount } from "./token-details";
import type { MediaUsage } from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Defensive optional property read (never throws). */
function getProp(obj: unknown, key: string): unknown {
  return isObject(obj) ? obj[key] : undefined;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/** A value is "present" iff it is neither `undefined` nor `null` (matches the codebase idiom). */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Collect the constructor names along a value's PROTOTYPE CHAIN (own class + every
 * superclass), so a SUBCLASS of a known command (`class TracedConverseCommand extends
 * ConverseCommand {}`) is still recognized by its base's name. Skips `Object` and stops at
 * the prototype root; bounded depth guards against exotic/cyclic chains. Content-free —
 * only reads `constructor.name` strings.
 */
function constructorNameChain(value: unknown): string[] {
  const names: string[] = [];
  if (!isObject(value)) {
    return names;
  }
  let proto: object | null = value;
  for (let depth = 0; proto !== null && depth < 20; depth += 1) {
    const ctor = (proto as { constructor?: unknown }).constructor;
    const name = typeof ctor === "function" ? (ctor as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name.length > 0 && name !== "Object") {
      names.push(name);
    }
    proto = Reflect.getPrototypeOf(proto);
  }
  return names;
}

/** How a `client.send(command)` command classifies for the Bedrock interception. */
type BedrockCommandKind =
  | "converse"
  | "converse-stream"
  | "invoke-model"
  | "async-invoke"
  | "other";

/** The outcome of classifying a `send(command)` argument, with diagnostics for the proxy. */
interface BedrockClassification {
  kind: BedrockCommandKind;
  /**
   * The `kind` was inferred from the command's INPUT SHAPE because its constructor names all
   * missed (e.g. bundler-mangled or a standalone re-implementation). For a Converse-family
   * command this is load-bearing: shape alone CANNOT tell `ConverseCommand` from
   * `ConverseStreamCommand`, so the proxy warns and treats it as buffered (see the send seam).
   */
  byShape: boolean;
  /** The command carries `.input.modelId` — used to warn when an unrecognized one passes through. */
  hasModelId: boolean;
}

/**
 * Classify an AWS SDK v3 command WITHOUT `instanceof` or any `@aws-sdk/*` import (CLAUDE.md
 * invariant 3), robust to two real-world shapes the exact-`constructor.name` check missed:
 *
 *  1. **Subclassing** — a `class TracedConverseCommand extends ConverseCommand {}` (from an
 *     instrumentation wrapper) is recognized by walking the PROTOTYPE CHAIN for the base
 *     command's name, not just the instance's own constructor name.
 *  2. **Minified names** — a bundler that mangles class identifiers turns `ConverseCommand`
 *     into `t`, so NO name matches. As a fallback the command's INPUT SHAPE is inspected:
 *     `modelId` + a raw-inference `body`/`contentType`/`accept` ⇒ InvokeModel-family (fail
 *     loud); `modelId` + Converse-structured `messages`/`system`/`promptVariables` and no raw
 *     body ⇒ Converse-family. This keeps budget/metering AND the InvokeModel fail-loud guard
 *     intact under common bundler configs, instead of silently un-instrumenting the traffic.
 *
 * `ConverseCommand` / `ConverseStreamCommand` (or subclasses) run the pipeline; any
 * `InvokeModel*` command fails loud; anything else (or a value with no recognizable Converse/
 * InvokeModel signal) is `"other"` and passes through natively.
 */
function classifyBedrockCommand(command: unknown): BedrockClassification {
  const input = getProp(command, "input");
  const hasModelId = isPresent(getProp(input, "modelId"));
  if (!isObject(command)) {
    return { kind: "other", byShape: false, hasModelId: false };
  }
  // 1. Exact/base name over the whole prototype chain (handles subclasses).
  const names = constructorNameChain(command);
  if (names.includes("ConverseStreamCommand")) {
    return { kind: "converse-stream", byShape: false, hasModelId };
  }
  if (names.includes("ConverseCommand")) {
    return { kind: "converse", byShape: false, hasModelId };
  }
  if (names.includes("StartAsyncInvokeCommand")) {
    return { kind: "async-invoke", byShape: false, hasModelId };
  }
  if (names.some((name) => name.startsWith("InvokeModel"))) {
    return { kind: "invoke-model", byShape: false, hasModelId };
  }
  // 2. Names all missed (minified / foreign / standalone) — fall back to input SHAPE.
  if (isObject(input) && hasModelId) {
    if (isPresent(input["outputDataConfig"])) {
      return { kind: "async-invoke", byShape: true, hasModelId: true };
    }
    if (isPresent(input["body"]) || isPresent(input["contentType"]) || isPresent(input["accept"])) {
      return { kind: "invoke-model", byShape: true, hasModelId: true };
    }
    if (
      isPresent(input["messages"]) ||
      isPresent(input["system"]) ||
      isPresent(input["promptVariables"])
    ) {
      // Converse-family, but shape can't distinguish streaming from buffered — the send seam
      // warns and treats it as buffered (the safest choice: never discards a paid dispatch,
      // never throws post-spend; worst case a warned usage undercount on a streamed call).
      return { kind: "converse", byShape: true, hasModelId: true };
    }
  }
  return { kind: "other", byShape: false, hasModelId };
}

/**
 * Bedrock's command boundary: turn a Converse(Stream)Command into the pipeline's uniform
 * kwargs bag. Reads `command.input.modelId`, renames it to the pipeline `model` key (a
 * shallow copy of `command.input`; the command and its input are never mutated), and stashes
 * the ORIGINAL command under {@link BEDROCK_NATIVE_COMMAND} so
 * {@link BedrockAdapter.prepareCall} can `client.send(command)` it untouched. Throws before
 * any pipeline work when `modelId` is absent — mirroring `_bedrock_internal_kwargs`. Python
 * raises a bare `TypeError`; per CLAUDE.md invariant 10 the TS port uses a typed
 * {@link ConfigurationError} (message still names `modelId`).
 *
 * A stray `stream` key on the copied input is STRIPPED (provider-bedrock.md behavior #16 /
 * TS v3 note): streaming intent is carried by the command TYPE, never a kwarg. Without this,
 * a `ConverseCommand` that happens to carry `input.stream: true` (a plausible leftover from
 * OpenAI-style code) would drive the streaming pipeline against a buffered dispatch — the paid
 * Converse response discarded and reported as an error. Only the metadata-side COPY is touched;
 * the customer's original command still reaches the wire untouched.
 */
function bedrockCommandKwargs(command: unknown): Record<string, unknown> {
  const input = getProp(command, "input");
  const modelId = getProp(input, "modelId");
  if (modelId === undefined || modelId === null) {
    throw new ConfigurationError("converse() requires the 'modelId' keyword argument", {
      field: "modelId",
    });
  }
  const inputRecord = isObject(input) ? input : undefined;
  const next: Record<string, unknown> = {};
  const tagDescriptor =
    inputRecord === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(inputRecord, "solwyn_tags");
  for (const key of inputRecord === undefined ? [] : Reflect.ownKeys(inputRecord)) {
    if (key === "solwyn_tags" || !Object.prototype.propertyIsEnumerable.call(inputRecord, key))
      continue;
    Object.defineProperty(next, key, {
      value: inputRecord?.[key as keyof typeof inputRecord],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  if (tagDescriptor !== undefined) {
    Object.defineProperty(next, "solwyn_tags", {
      value: inputRecord?.["solwyn_tags"],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const inputSnapshot = snapshotRequestStructure({ ...next });
  delete inputSnapshot["solwyn_tags"];
  Object.defineProperty(next, BEDROCK_NATIVE_INPUT_SNAPSHOT, {
    value: inputSnapshot,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  next["model"] = modelId;
  delete next["modelId"];
  delete next["stream"];
  (next as Record<PropertyKey, unknown>)[BEDROCK_NATIVE_COMMAND] = command;
  return next;
}

/**
 * The exact `ConfigurationError` guidance raised when an `InvokeModelCommand` /
 * `InvokeModelWithResponseStreamCommand` is sent to a Bedrock-dialect client. Preserves the
 * substantive claims a test might assert on (`"Converse API"`, `"consume-once"`,
 * `"buffering response content"`, and `"Converse"`).
 */
const INVOKE_MODEL_GUIDANCE =
  "Solwyn intercepts Bedrock through the Converse API only — send a ConverseCommand / " +
  "ConverseStreamCommand, which work across all Bedrock chat models. InvokeModel responses " +
  "carry usage inside a consume-once body, so Solwyn cannot budget-track them without " +
  "buffering response content. To make untracked calls anyway, use the unwrapped AWS SDK " +
  "client directly.";

const ASYNC_INVOKE_GUIDANCE =
  "StartAsyncInvokeCommand is not budget-tracked by Solwyn. To make this call anyway, use " +
  "the unwrapped client directly.";

/** Test-only reset for the module-level, process-wide posture latch. */
export function __resetUnmeteredSurfaceWarnings(): void {
  resetUnmeteredSurfaceWarnings();
  warnedMissingTranscriptionUsage = false;
}

let warnedMissingTranscriptionUsage = false;

const TRANSCRIPTION_FORMAT_HINT =
  "Audio transcription response included no usage; request response_format 'json' or " +
  "'verbose_json' so Solwyn can meter it.";

/**
 * An identity-stable getter plus the narrow invalidation seam used by proxy mutation
 * traps. Ordinary methods are bound to `target` and memoized per property key together
 * with the raw function they bind, so `proxy.foo === proxy.foo` across unchanged reads
 * (F23). Non-function values are re-read live. A cached binding is reused only while the
 * live raw value is the same function; a method replaced directly on the raw object or
 * patched on its prototype is rebound instead of being shadowed by its old binding. A
 * successful proxy mutation also invalidates only its own key.
 * Separate presentation lets public reads validate raw values before binding; classes
 * remain unbound so their shape and identity are not disguised as ordinary functions.
 */
interface BoundGetter {
  (prop: string | symbol): unknown;
  present(prop: string | symbol, value: unknown): unknown;
  invalidate(prop: string | symbol): void;
}

function makeBoundGetter(target: object): BoundGetter {
  const boundMethods = new Map<
    string | symbol,
    {
      readonly raw: (...args: unknown[]) => unknown;
      readonly bound: (...args: unknown[]) => unknown;
    }
  >();
  const present = (prop: string | symbol, value: unknown): unknown => {
    if (
      prop === "constructor" ||
      typeof value !== "function" ||
      observeEvaluatedProperty("method", "field", value).returnShape !== "function"
    ) {
      return value;
    }
    const raw = value as (...args: unknown[]) => unknown;
    const cached = boundMethods.get(prop);
    if (cached?.raw === raw) {
      return cached.bound;
    }
    const bound = raw.bind(target);
    boundMethods.set(prop, { raw, bound });
    return bound;
  };
  const get = ((prop: string | symbol): unknown =>
    present(prop, Reflect.get(target, prop, target))) as BoundGetter;
  get.present = present;
  get.invalidate = (prop): void => {
    boundMethods.delete(prop);
  };
  return get;
}

const UNSAFE_REFLECTED_SURFACE_DESCRIPTOR =
  "provider descriptor cannot expose an unguarded fixed surface";

function guardedSurfaceDescriptor(
  descriptor: PropertyDescriptor,
  property: PropertyKey,
  read: () => unknown,
  receiver: object,
  onSet?: () => void,
): PropertyDescriptor {
  if (typeof property !== "string" || property === "constructor") {
    return descriptor;
  }
  if (!("value" in descriptor) && descriptor.get === undefined && descriptor.set === undefined) {
    return descriptor;
  }
  if (descriptor.configurable === false) {
    if ("value" in descriptor) {
      const guardedValue = read();
      if (Object.is(guardedValue, descriptor.value)) return descriptor;
    }
    throw new SolwynError(UNSAFE_REFLECTED_SURFACE_DESCRIPTOR);
  }
  if ("value" in descriptor) {
    return { ...descriptor, value: read() };
  }
  const setter = descriptor.set;
  return {
    ...descriptor,
    get:
      descriptor.get === undefined
        ? undefined
        : function guardedProviderGetter(): unknown {
            return read();
          },
    set:
      setter === undefined
        ? undefined
        : function guardedProviderSetter(value: unknown): unknown {
            const result = Reflect.apply(setter, receiver, [value]);
            onSet?.();
            return result;
          },
  };
}

/** Keep namespace reflection guarded and mutations on the raw target, outside read posture. */
function createSurfaceProxy(
  target: object,
  invalidate: BoundGetter["invalidate"],
  handler: ProxyHandler<object>,
): object {
  const set = (current: object, property: string | symbol, value: unknown): boolean => {
    const updated = Reflect.set(current, property, value, current);
    if (updated) invalidate(property);
    return updated;
  };
  let proxy: object;
  proxy = new Proxy(target, {
    ...handler,
    set,
    deleteProperty(current, property): boolean {
      const deleted = Reflect.deleteProperty(current, property);
      if (deleted) invalidate(property);
      return deleted;
    },
    defineProperty(current, property, descriptor): boolean {
      const defined = Reflect.defineProperty(current, property, descriptor);
      if (defined) invalidate(property);
      return defined;
    },
    getOwnPropertyDescriptor(current, property): PropertyDescriptor | undefined {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
      if (descriptor === undefined) return undefined;
      return guardedSurfaceDescriptor(
        descriptor,
        property,
        () => Reflect.get(proxy, property, proxy),
        current,
        () => invalidate(property),
      );
    },
  });
  return proxy;
}

/** Route one provider-owned fallback through the surface contract before evaluating it. */
function resolveRawGet(
  core: SolwynCore,
  target: object,
  boundGet: BoundGetter,
  prop: string | symbol,
  path: string,
): unknown {
  if (typeof prop !== "string" || prop === "constructor") {
    return boundGet(prop);
  }
  const value = core.resolveSurfaceRead(target, prop, path, "raw", () =>
    Reflect.get(target, prop, target),
  );
  return boundGet.present(prop, value);
}

/** Total property read for arbitrary provider response shapes, including hostile getters. */
function safeProp(obj: unknown, key: string): unknown {
  try {
    return getProp(obj, key);
  } catch {
    return undefined;
  }
}

/** OpenAI embeddings preserve explicit zero; missing or malformed usage is unobservable. */
function extractOpenAIEmbeddingUsage(response: unknown) {
  try {
    const count = getProp(getProp(response, "usage"), "prompt_tokens");
    return !isUsageCount(count)
      ? null
      : buildTokenDetails({ input_tokens: count, output_tokens: 0, is_estimated: false });
  } catch {
    return null;
  }
}

/** Google embeddings preserve explicit zero; unknown counts use request measurement. */
function extractGoogleEmbeddingUsage(response: unknown) {
  try {
    const count = getProp(getProp(response, "usageMetadata"), "promptTokenCount");
    return !isUsageCount(count)
      ? null
      : buildTokenDetails({ input_tokens: count, output_tokens: 0, is_estimated: false });
  } catch {
    return null;
  }
}

/** Content-safe embedding measurement shared by native and compatible OpenAI dialects. */
function embeddingSpec(dialect: "openai" | "google"): MediaSurfaceSpec {
  return {
    surface: "embeddings",
    modality: "embedding",
    extractUsage: dialect === "google" ? extractGoogleEmbeddingUsage : extractOpenAIEmbeddingUsage,
    measureRequest(kwargs) {
      return buildTokenDetails({
        input_tokens:
          dialect === "google"
            ? estimateGoogleEmbeddingInputTokens(kwargs, dialect)
            : estimateEmbeddingInputTokens(kwargs, dialect),
        output_tokens: 0,
        is_estimated: true,
      });
    },
    measureMedia: () => null,
    estimateMedia: () => null,
  };
}

/** Native gpt-image usage preserves reported totals and uncertainty in partial usage. */
function extractNativeImageUsage(response: unknown) {
  try {
    const usage = getProp(response, "usage");
    if (!isObject(usage)) {
      return null;
    }
    const inputTokens = getProp(usage, "input_tokens");
    const outputTokens = getProp(usage, "output_tokens");
    if (!isUsageCount(inputTokens) && !isUsageCount(outputTokens)) {
      return null;
    }
    return buildReportedTokenDetails({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      image_input_tokens: getProp(getProp(usage, "input_tokens_details"), "image_tokens"),
      image_output_tokens: getProp(getProp(usage, "output_tokens_details"), "image_tokens"),
    });
  } catch {
    return null;
  }
}

/** Image media lifecycle contract; content inspection remains isolated in privacy.ts. */
function imageSpec(dialect: "openai" | "google"): MediaSurfaceSpec {
  const measure = dialect === "google" ? measureGoogleImageMedia : measureImageMedia;
  return {
    surface: "images",
    modality: "image",
    extractUsage(response, context) {
      return dialect === "openai" &&
        context.provider === "openai" &&
        context.effectiveModel.startsWith("gpt-image")
        ? extractNativeImageUsage(response)
        : null;
    },
    measureRequest: () => null,
    measureMedia: (kwargs) => measure(kwargs),
    estimateMedia: (kwargs) => measure(kwargs),
  };
}

/** Video initiation contract: estimated media only, settled immediately from selectors. */
function videoSpec(dialect: "openai" | "google"): MediaSurfaceSpec {
  const measure = dialect === "openai" ? measureOpenAIVideoMedia : measureVideoMedia;
  return {
    surface: "videos",
    modality: "video",
    extractUsage: () => null,
    measureRequest: () => null,
    measureMedia: (kwargs) => measure(kwargs),
    estimateMedia: (kwargs) => measure(kwargs),
  };
}

/** Complete audio media carrier, retaining nulls when the nested object is serialized. */
function audioMedia(overrides: Partial<MediaUsage>): MediaUsage {
  return {
    image_count: null,
    generation_count: null,
    video_seconds: null,
    audio_seconds: null,
    input_characters: null,
    resolution: null,
    quality: null,
    is_estimated: false,
    ...overrides,
  };
}

/** Transcription token extraction preserves valid totals and flags partial unknown usage. */
function extractTranscriptionUsage(response: unknown) {
  try {
    const usage = safeProp(response, "usage");
    if (safeProp(usage, "type") !== "tokens") {
      return null;
    }
    const inputTokens = safeProp(usage, "input_tokens");
    const outputTokens = safeProp(usage, "output_tokens");
    if (!isUsageCount(inputTokens) && !isUsageCount(outputTokens)) {
      return null;
    }
    return buildReportedTokenDetails({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      audio_input_tokens: safeProp(safeProp(usage, "input_token_details"), "audio_tokens"),
    });
  } catch {
    return null;
  }
}

/** OpenAI transcription contract: observed tokens OR observed duration, never request estimates. */
function transcriptionSpec(core: SolwynCore): MediaSurfaceSpec {
  return {
    surface: "audio.transcriptions",
    modality: "audio",
    extractUsage(response) {
      const usage = safeProp(response, "usage");
      if (usage === undefined || usage === null) {
        if (!warnedMissingTranscriptionUsage) {
          warnedMissingTranscriptionUsage = true;
          core.logger.warn(TRANSCRIPTION_FORMAT_HINT);
        }
        return null;
      }
      return extractTranscriptionUsage(response);
    },
    measureRequest: () => null,
    measureMedia(_kwargs, response) {
      try {
        const usage = safeProp(response, "usage");
        if (safeProp(usage, "type") !== "duration") {
          return null;
        }
        const seconds = safeProp(usage, "seconds");
        return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
          ? audioMedia({ audio_seconds: seconds })
          : null;
      } catch {
        return null;
      }
    },
    estimateMedia: () => null,
  };
}

/** Character-billed speech contract; privacy.ts is the sole request-content reader. */
function speechSpec(): MediaSurfaceSpec {
  return {
    surface: "audio.speech",
    modality: "audio",
    extractUsage: () => null,
    measureRequest: () => null,
    measureMedia: (kwargs) => measureSpeechMedia(kwargs),
    estimateMedia: (kwargs) => measureSpeechMedia(kwargs),
  };
}

/** `embeddings` sub-proxy: intercept `.create`, pass every other attribute through. */
function makeEmbeddingsProxy(core: SolwynCore, resource: unknown, spec: MediaSurfaceSpec): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  const create = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("embeddings.create");
    return core.mediaCall(spec, kwargs ?? {}, rest);
  };
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_target, prop): unknown {
      if (prop === "create") {
        return create;
      }
      return resolveRawGet(core, target, boundGet, prop, `embeddings.${String(prop)}`);
    },
  });
}

/** `images` sub-proxy: generate/edit are tracked; every other method is transparent. */
function makeImagesProxy(core: SolwynCore, resource: unknown): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  const generate = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("images.generate");
    const request = kwargs ?? {};
    return core.mediaCall(imageSpec("openai"), request, rest, undefined, {
      _solwyn_image_op: "generate",
    });
  };
  const edit = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("images.edit");
    const request = kwargs ?? {};
    return core.mediaCall(imageSpec("openai"), request, rest, undefined, {
      _solwyn_image_op: "edit",
    });
  };
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_target, prop): unknown {
      if (prop === "generate") {
        return generate;
      }
      if (prop === "edit") {
        return edit;
      }
      return resolveRawGet(core, target, boundGet, prop, `images.${String(prop)}`);
    },
  });
}

/** OpenAI `videos` sub-proxy: create is tracked; every other method is transparent. */
function makeVideosProxy(core: SolwynCore, resource: unknown): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  const create = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("videos.create");
    return core.mediaCall(videoSpec("openai"), kwargs ?? {}, rest);
  };
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_target, prop): unknown {
      if (prop === "create") {
        return create;
      }
      return resolveRawGet(core, target, boundGet, prop, `videos.${String(prop)}`);
    },
  });
}

/** One audio child resource: tracked create plus identity-stable passthrough siblings. */
function makeAudioChildProxy(
  core: SolwynCore,
  child: unknown,
  operation: "transcriptions" | "speech",
  dialect: SurfaceDialect,
): object {
  const target = isObject(child) ? child : {};
  const boundGet = makeBoundGetter(target);
  const create = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    const request = kwargs ?? {};
    if (operation === "speech" && dialect === "openai") {
      return core.resolveMediaRequest(request, { _solwyn_audio_op: "speech" }).then((resolved) => {
        if (resolved.model.startsWith("gpt-4o-mini-tts")) {
          core.enforceExplicitSurface(
            "audio.speech.create",
            "synthetic_policy",
            "openai_untracked_tts_model",
          );
          const nativeCreate = boundGet("create");
          if (typeof nativeCreate !== "function") {
            throw new ConfigurationError("wrapped audio.speech resource does not expose create()", {
              field: "client",
            });
          }
          const shaped = { ...resolved.kwargs };
          delete shaped["_solwyn_audio_op"];
          return nativeCreate(shaped, ...rest);
        }
        core.enforceExplicitSurface("audio.speech.create");
        return core.mediaCall(speechSpec(), request, rest, resolved);
      });
    }
    core.enforceExplicitSurface(
      operation === "speech" ? "audio.speech.create" : "audio.transcriptions.create",
    );
    const marker = operation === "speech" ? "speech" : "transcriptions";
    return core.mediaCall(
      operation === "speech" ? speechSpec() : transcriptionSpec(core),
      request,
      rest,
      undefined,
      { _solwyn_audio_op: marker },
    );
  };
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_target, prop): unknown {
      if (prop === "create") {
        return create;
      }
      return resolveRawGet(core, target, boundGet, prop, `audio.${operation}.${String(prop)}`);
    },
  });
}

/** Audio posture proxy: tracked speech/transcriptions, warned translations, silent siblings. */
function makeAudioProxy(core: SolwynCore, resource: unknown, dialect: SurfaceDialect): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  let transcriptionsProxy: object | undefined;
  let speechProxy: object | undefined;
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_target, prop): unknown {
      if (prop === "transcriptions") {
        if (transcriptionsProxy !== undefined) return transcriptionsProxy;
        return boundGet.present(
          "transcriptions",
          core.resolveSurfaceRead(
            target,
            "transcriptions",
            "audio.transcriptions",
            "wrapper",
            () => Reflect.get(target, "transcriptions", target),
            (value) => {
              transcriptionsProxy ??= makeAudioChildProxy(core, value, "transcriptions", dialect);
              return transcriptionsProxy;
            },
          ),
        );
      }
      if (prop === "speech") {
        if (speechProxy !== undefined) return speechProxy;
        return boundGet.present(
          "speech",
          core.resolveSurfaceRead(
            target,
            "speech",
            "audio.speech",
            "wrapper",
            () => Reflect.get(target, "speech", target),
            (value) => {
              speechProxy ??= makeAudioChildProxy(core, value, "speech", dialect);
              return speechProxy;
            },
          ),
        );
      }
      return resolveRawGet(core, target, boundGet, prop, `audio.${String(prop)}`);
    },
  });
}

/** `chat.completions` sub-proxy: intercept `.create`, pass everything else through. */
function makeCompletionsProxy(core: SolwynCore, resource: unknown): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  // One stable intercept lambda per proxy (F23). It forwards the params bag AND every
  // trailing argument (OpenAI's RequestOptions: signal/headers/timeout/maxRetries)
  // verbatim into the pipeline, so per-request cancellation/headers still work (F13).
  const create = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("chat.completions.create");
    return core.interceptedCall("chat", kwargs ?? {}, {}, rest);
  };
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_t, prop): unknown {
      if (prop === "create") {
        return create;
      }
      return resolveRawGet(core, target, boundGet, prop, `chat.completions.${String(prop)}`);
    },
  });
}

/**
 * `chat` sub-proxy: exposes the intercepting `.completions` and passes every other
 * attribute through to the wrapped client's `chat`. `chat` is the always-attached
 * synthetic OpenAI-dialect surface (proxies-run.md), so it exists regardless of the
 * wrapped client's own dialect.
 *
 * Behavior 9 (proxies-run.md): on a NON-OpenAI-dialect client, accessing any `.chat`
 * attribute OTHER than `.completions` is a misuse and must fail loud — naming the attribute
 * and pointing at the correct dialect-specific surface — rather than silently returning
 * `undefined` from the (empty) target. OpenAI-dialect clients (including every compat vendor)
 * keep full passthrough to their real `chat`. `then` is exempted so accidental thenable
 * probing (`await someChat`) does not throw. Python raises `AttributeError`; per CLAUDE.md
 * invariant 10 the TS port raises a typed {@link ConfigurationError}.
 */
function makeChatProxy(core: SolwynCore, resource: unknown, dialect: SurfaceDialect): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  let completionsProxy: object | undefined;
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_t, prop): unknown {
      if (prop === "completions") {
        if (completionsProxy !== undefined) return completionsProxy;
        const resolved = core.resolveSurfaceRead(
          target,
          "completions",
          "chat.completions",
          "wrapper",
          () => Reflect.get(target, "completions", target),
          (value) => {
            completionsProxy ??= makeCompletionsProxy(core, value);
            return completionsProxy;
          },
          () => {
            completionsProxy ??= makeCompletionsProxy(core, undefined);
            return completionsProxy;
          },
        );
        if (resolved !== undefined) return boundGet.present("completions", resolved);
        completionsProxy ??= makeCompletionsProxy(core, undefined);
        return completionsProxy;
      }
      if (dialect !== "openai" && typeof prop === "string" && prop !== "then") {
        throw new ConfigurationError(
          `'chat.${prop}' is not supported. The Solwyn chat proxy is OpenAI-dialect-specific; ` +
            "Anthropic uses 'messages' and Google uses 'models'.",
          { field: null },
        );
      }
      return resolveRawGet(core, target, boundGet, prop, `chat.${String(prop)}`);
    },
  });
}

function hasExistingResponseSelector(value: unknown): boolean {
  return (
    isObject(value) && (Reflect.has(value, "response_id") || Reflect.has(value, "starting_after"))
  );
}

/** `responses` sub-proxy: meter new responses; retain existing-response raw helpers. */
function makeResponsesProxy(core: SolwynCore, resource: unknown): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  const create = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("responses.create");
    return core.interceptedCall("responses", kwargs ?? {}, { responsesLeaf: "create" }, rest);
  };
  const parse = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("responses.parse");
    return core.interceptedCall("responses", kwargs ?? {}, { responsesLeaf: "parse" }, rest);
  };
  let rawStreamResolved = false;
  let rawStream: unknown;
  const getRawStream = (): unknown => {
    if (!rawStreamResolved) {
      rawStream = boundGet("stream");
      rawStreamResolved = true;
    }
    return rawStream;
  };
  const stream = (...args: unknown[]): unknown => {
    core.enforceExplicitSurface("responses.stream");
    if (hasExistingResponseSelector(args[0])) {
      const raw = getRawStream();
      return isFunction(raw) ? raw(...args) : raw;
    }
    return core.prepareResponsesStreamCall(
      (args[0] ?? {}) as Record<string, unknown>,
      args.slice(1),
    );
  };
  const invalidate = (property: string | symbol): void => {
    boundGet.invalidate(property);
    if (property === "stream") {
      rawStreamResolved = false;
      rawStream = undefined;
    }
  };
  return createSurfaceProxy(target, invalidate, {
    get(_t, prop): unknown {
      if (prop === "create") {
        return create;
      }
      if (prop === "parse") {
        return parse;
      }
      if (prop === "stream") {
        return stream;
      }
      return resolveRawGet(core, target, boundGet, prop, `responses.${String(prop)}`);
    },
  });
}

/**
 * `messages` sub-proxy (Anthropic dialect): intercept `.create`, pass everything else
 * (e.g. `count_tokens`) straight through to the wrapped client's `messages`.
 */
function makeMessagesProxy(core: SolwynCore, resource: unknown): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  const create = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("messages.create");
    return core.interceptedCall("messages", kwargs ?? {}, {}, rest);
  };
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_t, prop): unknown {
      if (prop === "create") {
        return create;
      }
      return resolveRawGet(core, target, boundGet, prop, `messages.${String(prop)}`);
    },
  });
}

/**
 * `models` sub-proxy (Google dialect): intercept `.generateContent` (non-streaming),
 * `.generateContentStream` (which forces the streaming pipeline via `forceStream`), and
 * `.embedContent` (the explicit camelCase embeddings boundary), `.generateImages`, and
 * `.generateVideos`.
 * Everything else (e.g. `list`) passes straight through. Only a Google-dialect client's
 * `models` is proxied — an OpenAI client's `.models` returns by identity (never wrapped).
 */
function makeModelsProxy(core: SolwynCore, resource: unknown): object {
  const target = isObject(resource) ? resource : {};
  const boundGet = makeBoundGetter(target);
  const generateContent = (
    kwargs?: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<unknown> => {
    core.enforceExplicitSurface("models.generateContent");
    return core.interceptedCall("models", kwargs ?? {}, {}, rest);
  };
  const generateContentStream = (
    kwargs?: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<unknown> => {
    core.enforceExplicitSurface("models.generateContentStream");
    return core.interceptedCall("models", kwargs ?? {}, { forceStream: true }, rest);
  };
  const embedContent = (kwargs?: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
    core.enforceExplicitSurface("models.embedContent");
    return core.mediaCall(embeddingSpec("google"), kwargs ?? {}, rest);
  };
  const generateImages = (
    kwargs?: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<unknown> => {
    core.enforceExplicitSurface("models.generateImages");
    return core.mediaCall(imageSpec("google"), kwargs ?? {}, rest);
  };
  const generateVideos = (
    kwargs?: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<unknown> => {
    core.enforceExplicitSurface("models.generateVideos");
    return core.mediaCall(videoSpec("google"), kwargs ?? {}, rest);
  };
  const optionalMethod = (property: string, intercepted: unknown): unknown => {
    const value = core.resolveSurfaceRead(
      target,
      property,
      `models.${property}`,
      "raw",
      () => Reflect.get(target, property, target),
      undefined,
      undefined,
      () => intercepted,
    );
    // Even an unreviewed callable getter remains intercepted when posture permits it.
    return isFunction(value) ? intercepted : value;
  };
  return createSurfaceProxy(target, boundGet.invalidate, {
    get(_t, prop): unknown {
      if (prop === "generateContent") {
        return generateContent;
      }
      if (prop === "generateContentStream") {
        return generateContentStream;
      }
      if (prop === "embedContent") {
        return optionalMethod(prop, embedContent);
      }
      if (prop === "generateImages") {
        return optionalMethod(prop, generateImages);
      }
      if (prop === "generateVideos") {
        return optionalMethod(prop, generateVideos);
      }
      return resolveRawGet(core, target, boundGet, prop, `models.${String(prop)}`);
    },
  });
}

/** Solwyn-owned members that always win over a same-named wrapped-client attribute. */
const CUSTOM_INSPECT = Symbol.for("nodejs.util.inspect.custom");

const CORE_OWNED: ReadonlySet<string | symbol> = new Set<string | symbol>([
  "close",
  Symbol.asyncDispose,
  CUSTOM_INSPECT,
]);

/**
 * Wrap a {@link SolwynCore} in the top-level attribute-passthrough `Proxy`.
 *
 * Lifecycle (`close`, `[Symbol.asyncDispose]`) resolves to the core. `chat` is ALWAYS the
 * synthetic OpenAI-dialect intercepting surface (matching Python's always-attached `chat`
 * proxy). The remaining intercepting surfaces are gated on the wrapped client's probed
 * DIALECT so exactly one dialect's surface is instrumented:
 *   - openai   → `responses`, `embeddings.create`, and image generation/edit intercepts;
 *   - anthropic → `messages` intercepts;
 *   - google   → `models.generateContent[Stream]`, `embedContent`, and `generateImages`;
 *   - bedrock  → `send` intercepts (AWS SDK v3): a `ConverseCommand`/`ConverseStreamCommand`
 *                runs the pipeline, an `InvokeModel*` command fails loud, and any other
 *                command passes through to the wrapped client's native `send`.
 * An existing top-level `embeddings` resource is proxied across dialects: OpenAI-shaped
 * adapters dispatch it, while adapters without an embeddings media seam report and rethrow
 * `UnsupportedSurfaceError`. Every other non-instrumented surface forwards unchanged.
 * Sub-proxies and intercept methods are built once, lazily, keeping identity stable (F23).
 */
export function createClientProxy(core: SolwynCore, wrappedClient: unknown): object {
  const dialect = core.surfaceContext.dialect;
  const providerTarget = isObject(wrappedClient) ? wrappedClient : null;
  let chatProxy: object | undefined;
  let responsesProxy: object | undefined;
  let messagesProxy: object | undefined;
  let modelsProxy: object | undefined;
  let embeddingsProxy: object | undefined;
  let imagesProxy: object | undefined;
  let videosProxy: object | undefined;
  let audioProxy: object | undefined;
  // Bedrock's single intercepted surface is AWS SDK v3 `send(command)` — built once for
  // identity stability (F23). It classifies the command by constructor name (+ `.input`):
  // a `ConverseCommand`/`ConverseStreamCommand` renames `command.input.modelId` → the
  // pipeline `model` key (throwing before the pipeline when absent) and runs the shared
  // interception (streaming forced for the stream command); an `InvokeModel*` command fails
  // loud (never dispatched, never budget-checked); any OTHER command is forwarded to the
  // wrapped client's native `send` untouched (full-surface passthrough).
  const bedrockSend = async (command?: unknown, ...rest: unknown[]): Promise<unknown> => {
    const { kind, byShape, hasModelId } = classifyBedrockCommand(command);
    const intercepted =
      kind === "converse" ||
      kind === "converse-stream" ||
      kind === "invoke-model" ||
      kind === "async-invoke";
    // Callback-style `send(command, cb)` / `send(command, options, cb)` (a supported v3 Smithy
    // calling convention): the SDK delivers the response via the callback and `send()` resolves
    // undefined, so on the intercepted path usage would settle at zero (buffered) or the stream
    // path would throw AFTER the paid dispatch. Fail loud EARLY — before any budget check or
    // dispatch — pointing the caller at the Promise form. Non-intercepted commands keep full
    // passthrough (callbacks included).
    if (intercepted && rest.length > 0 && isFunction(rest[rest.length - 1])) {
      throw new ConfigurationError(
        "Solwyn intercepts AWS SDK v3 send(command) via its Promise form only — a callback-style " +
          "send(command, callback) cannot be budget-tracked. Await the returned Promise instead.",
        { field: null },
      );
    }
    if (kind === "converse" || kind === "converse-stream") {
      core.enforceExplicitSurface(
        kind === "converse-stream" ? "ConverseStreamCommand" : "ConverseCommand",
      );
      if (byShape) {
        core.logger.warn(
          "Solwyn could not read the Bedrock command's class name (it was likely minified or " +
            "subclassed) and classified it as a Converse call by input shape. Streaming intent " +
            "cannot be determined from shape alone, so it is treated as a buffered (non-streaming) " +
            "call; if it is a ConverseStreamCommand, disable class-name mangling for the AWS SDK " +
            "command classes so streaming usage settles correctly.",
        );
      }
      return core.interceptedCall(
        "converse",
        bedrockCommandKwargs(command),
        kind === "converse-stream" ? { forceStream: true } : {},
        rest,
      );
    }
    if (kind === "invoke-model") {
      throw new ConfigurationError(INVOKE_MODEL_GUIDANCE, { field: null });
    }
    if (kind === "async-invoke") {
      throw new ConfigurationError(ASYNC_INVOKE_GUIDANCE, { field: null });
    }
    // Any other command: native passthrough (the SDK's own `send` handles/validates it). If it
    // still carries `input.modelId`, it is an unrecognized inference-shaped command escaping
    // budget/metering — warn (never silent) that it passes through untracked.
    if (hasModelId) {
      core.logger.warn(
        "Solwyn is passing an unrecognized Bedrock command that carries input.modelId through " +
          "UNTRACKED (no budget check, no usage metering). If this is a Converse call, send a " +
          "ConverseCommand / ConverseStreamCommand so Solwyn can meter it.",
      );
    }
    const currentSend = isObject(wrappedClient)
      ? Reflect.get(wrappedClient, "send", wrappedClient)
      : undefined;
    if (typeof currentSend === "function") {
      return Reflect.apply(currentSend, wrappedClient, [command, ...rest]);
    }
    throw new ConfigurationError("wrapped Bedrock client does not expose send()", { field: null });
  };
  // Two identity-stable getters (F23): one over the Solwyn core (lifecycle members),
  // one over the wrapped client (full passthrough surface).
  const boundCore = makeBoundGetter(core);
  const boundWrapped = providerTarget === null ? null : makeBoundGetter(providerTarget);
  const resolveTopLevel = (
    property: string,
    source: "raw" | "wrapper",
    transform?: (value: object) => unknown,
    missingNamespace?: () => object,
  ): unknown => {
    if (providerTarget === null || boundWrapped === null) return undefined;
    const value = core.resolveSurfaceRead(
      providerTarget,
      property,
      property,
      source,
      () => Reflect.get(providerTarget, property, providerTarget),
      transform,
      missingNamespace,
    );
    return boundWrapped.present(property, value);
  };
  const proxy = new Proxy(core, {
    get(target, prop): unknown {
      // Proxy invariants require these target-own descriptor values even though ordinary
      // reads belong to the provider/interception surface.
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (targetDescriptor?.configurable === false) {
        if ("value" in targetDescriptor && targetDescriptor.writable === false) {
          return targetDescriptor.value;
        }
        if (!("value" in targetDescriptor) && targetDescriptor.get === undefined) {
          return undefined;
        }
      }
      if (CORE_OWNED.has(prop)) {
        return boundCore(prop);
      }
      if (prop === "constructor" && boundWrapped !== null) {
        return boundWrapped(prop);
      }
      if (prop === "chat") {
        if (chatProxy !== undefined) return chatProxy;
        const resolved = resolveTopLevel(
          "chat",
          "wrapper",
          (value) => {
            chatProxy ??= makeChatProxy(core, value, dialect);
            return chatProxy;
          },
          () => {
            chatProxy ??= makeChatProxy(core, undefined, dialect);
            return chatProxy;
          },
        );
        if (resolved !== undefined) return resolved;
        chatProxy ??= makeChatProxy(core, undefined, dialect);
        return chatProxy;
      }
      if (prop === "responses") {
        if (core.usesNativeResponsesSurface) {
          if (responsesProxy !== undefined) return responsesProxy;
          return resolveTopLevel("responses", "raw", (value) => {
            responsesProxy ??= makeResponsesProxy(core, value);
            return responsesProxy;
          });
        }
        return resolveTopLevel("responses", "raw");
      }
      if (prop === "embeddings") {
        if (embeddingsProxy !== undefined) return embeddingsProxy;
        return resolveTopLevel("embeddings", "wrapper", (value) => {
          embeddingsProxy ??= makeEmbeddingsProxy(core, value, embeddingSpec("openai"));
          return embeddingsProxy;
        });
      }
      if (dialect === "openai" && prop === "images") {
        if (imagesProxy !== undefined) return imagesProxy;
        return resolveTopLevel("images", "wrapper", (value) => {
          imagesProxy ??= makeImagesProxy(core, value);
          return imagesProxy;
        });
      }
      if (dialect === "openai" && prop === "videos") {
        if (videosProxy !== undefined) return videosProxy;
        return resolveTopLevel("videos", "wrapper", (value) => {
          videosProxy ??= makeVideosProxy(core, value);
          return videosProxy;
        });
      }
      if (prop === "audio") {
        if (audioProxy !== undefined) return audioProxy;
        return resolveTopLevel("audio", "wrapper", (value) => {
          audioProxy ??= makeAudioProxy(core, value, dialect);
          return audioProxy;
        });
      }
      if (dialect === "anthropic" && prop === "messages") {
        if (messagesProxy !== undefined) return messagesProxy;
        return resolveTopLevel("messages", "wrapper", (value) => {
          messagesProxy ??= makeMessagesProxy(core, value);
          return messagesProxy;
        });
      }
      if (dialect === "google" && prop === "models") {
        if (modelsProxy !== undefined) return modelsProxy;
        return resolveTopLevel("models", "wrapper", (value) => {
          modelsProxy ??= makeModelsProxy(core, value);
          return modelsProxy;
        });
      }
      if (dialect === "bedrock" && prop === "send") {
        return bedrockSend;
      }
      if (boundWrapped !== null && providerTarget !== null) {
        return resolveRawGet(core, providerTarget, boundWrapped, prop, String(prop));
      }
      return undefined;
    },
    has(target, prop): boolean {
      if (Reflect.getOwnPropertyDescriptor(target, prop) !== undefined) {
        return true;
      }
      if (CORE_OWNED.has(prop) || prop === "chat") {
        return true;
      }
      if (prop === "responses") {
        return isObject(wrappedClient) && Reflect.has(wrappedClient, prop);
      }
      if (prop === "embeddings") {
        return isObject(wrappedClient) && Reflect.has(wrappedClient, prop);
      }
      if ((dialect === "openai" && (prop === "images" || prop === "videos")) || prop === "audio") {
        return isObject(wrappedClient) && Reflect.has(wrappedClient, prop);
      }
      if (dialect === "anthropic" && prop === "messages") {
        return true;
      }
      if (dialect === "google" && prop === "models") {
        return true;
      }
      if (dialect === "bedrock" && prop === "send") {
        return true;
      }
      return isObject(wrappedClient) && Reflect.has(wrappedClient, prop);
    },
    set(target, prop, value): boolean {
      if (!isObject(wrappedClient)) {
        return false;
      }
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (targetDescriptor?.configurable === false) {
        if (
          "value" in targetDescriptor &&
          targetDescriptor.writable === false &&
          !Object.is(value, targetDescriptor.value)
        ) {
          return false;
        }
        if (!("value" in targetDescriptor) && targetDescriptor.set === undefined) {
          return false;
        }
      }
      const updated = Reflect.set(wrappedClient, prop, value, wrappedClient);
      if (updated) {
        boundWrapped?.invalidate(prop);
      }
      return updated;
    },
    deleteProperty(target, prop): boolean {
      if (!isObject(wrappedClient)) {
        return false;
      }
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (
        targetDescriptor !== undefined &&
        (targetDescriptor.configurable === false || !Reflect.isExtensible(target))
      ) {
        return false;
      }
      const deleted = Reflect.deleteProperty(wrappedClient, prop);
      if (deleted) {
        boundWrapped?.invalidate(prop);
      }
      return deleted;
    },
    defineProperty(target, prop, descriptor): boolean {
      if (!isObject(wrappedClient)) {
        return false;
      }
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (
        (!Reflect.isExtensible(target) && targetDescriptor === undefined) ||
        (descriptor.configurable === false && targetDescriptor?.configurable !== false) ||
        targetDescriptor?.configurable === false
      ) {
        return false;
      }
      const defined = Reflect.defineProperty(wrappedClient, prop, descriptor);
      if (defined) {
        boundWrapped?.invalidate(prop);
      }
      return defined;
    },
    ownKeys(target): ArrayLike<string | symbol> {
      const keys = Reflect.ownKeys(target);
      if (!Reflect.isExtensible(target) || !isObject(wrappedClient)) {
        return keys;
      }
      return [...new Set([...keys, ...Reflect.ownKeys(wrappedClient)])];
    },
    getOwnPropertyDescriptor(target, prop): PropertyDescriptor | undefined {
      const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (targetDescriptor !== undefined) {
        return targetDescriptor;
      }
      if (!Reflect.isExtensible(target) || !isObject(wrappedClient)) {
        return undefined;
      }
      const wrappedDescriptor = Reflect.getOwnPropertyDescriptor(wrappedClient, prop);
      if (wrappedDescriptor === undefined) return undefined;
      const reported = { ...wrappedDescriptor, configurable: true };
      return guardedSurfaceDescriptor(
        reported,
        prop,
        () => Reflect.get(proxy, prop, proxy),
        wrappedClient,
        () => boundWrapped?.invalidate(prop),
      );
    },
    // Make `instanceof` honor the static `Solwyn & C` type: report the WRAPPED client's
    // prototype so `wrapped instanceof OpenAI` (and `.constructor`) hold, matching what
    // third-party libraries branch on (F22). The proxy target (`core`) is extensible,
    // so returning a foreign prototype does not violate the Proxy invariant. Method
    // resolution is unaffected — it flows through the `get` trap above, not this chain.
    getPrototypeOf(target): object | null {
      return Reflect.isExtensible(target) && isObject(wrappedClient)
        ? Reflect.getPrototypeOf(wrappedClient)
        : Reflect.getPrototypeOf(target);
    },
  });
  brandSolwynWrapper(proxy);
  registerCoverageSource(proxy, core.surfaceCoverageSource(), () => core.surfaceCoverageSource());
  return proxy;
}

// ---------------------------------------------------------------------------
// Public `Solwyn` constructor + type.
// ---------------------------------------------------------------------------

/** The Solwyn-owned surface added on top of the wrapped client's own surface. */
export interface Solwyn {
  /** Flush reporter work, close budget-enforcer resources, then forward provider shutdown. */
  close(): Promise<void>;
  /** `await using` lifecycle — delegates to {@link Solwyn.close}. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * A `create`-style method with its return type de-`APIPromise`d to a plain `Promise`.
 * Each native overload is preserved; only its return is narrowed from the provider's
 * `APIPromise<T>` (which carries `.withResponse()`/`.asResponse()`) down to
 * `Promise<Awaited<T>>`. See {@link InterceptedClient} for why (F15).
 */
/** Keep non-call members in the visitation guard so callable objects also terminate. */
type NonCallMembers<F> = Pick<F, keyof F> &
  (F extends new (...args: infer Args) => infer Result ? new (...args: Args) => Result : unknown);

/** Rotate intersected signatures until every original overload has been visited. */
type OverloadUnion<F, Seen = NonCallMembers<F>> = F extends (...args: infer Args) => infer Return
  ? Seen extends F
    ? never
    : OverloadUnion<Seen & F, Seen & ((...args: Args) => Return)> | ((...args: Args) => Return)
  : never;

type PlainOverload<F> = F extends (...args: infer Args) => infer Return
  ? (...args: Args) => Promise<Awaited<Return>>
  : never;

type IntersectOverloads<Signatures> = (
  Signatures extends unknown
    ? (signature: Signatures) => void
    : never
) extends (signature: infer Overloads) => void
  ? Overloads
  : never;

type PlainPromiseOverloads<F> = IntersectOverloads<PlainOverload<OverloadUnion<F>>>;

/** Ordinary promises need no transformation: retaining F also retains its generics. */
type PlainPromiseReturn<F> = F extends (...args: never[]) => infer R
  ? [R] extends [Promise<unknown>]
    ? Exclude<keyof R, keyof Promise<unknown>> extends never
      ? F
      : PlainPromiseOverloads<F>
    : PlainPromiseOverloads<F>
  : F;

/** Map only intercepted leaves, retaining absent/optional/readonly native members. */
type WithPlainCreate<T> = {
  [P in keyof T]: P extends "create" ? PlainPromiseReturn<T[P]> : T[P];
};

type WithPlainResponsesMethods<T> = {
  [P in keyof T]: P extends "create"
    ? PlainPromiseReturn<T[P]>
    : P extends "parse"
      ? PlainResponsesParse<T[P]>
      : P extends "stream"
        ? DeferredResponsesStreamMethod<T[P]>
        : T[P];
};

type WithPlainImageMethods<T> = {
  [P in keyof T]: P extends "generate" | "edit" ? PlainPromiseReturn<T[P]> : T[P];
};

type WithPlainAudioMethods<T> = {
  [P in keyof T]: P extends "transcriptions" | "speech" ? WithPlainCreate<T[P]> : T[P];
};

type WithPlainCompletions<T> = {
  [P in keyof T]: P extends "completions" ? WithPlainCreate<T[P]> : T[P];
};

/**
 * The wrapped client type `C` with intercepted OpenAI-style call paths
 * (`chat.completions.create`, `responses.create` / `responses.parse`, `embeddings.create`,
 * `images.generate`/`images.edit`, `videos.create`, and
 * `audio.transcriptions.create`/`audio.speech.create`, and Anthropic `messages.create`)
 * re-typed to return a plain `Promise`
 * instead of a provider's `APIPromise`. Native overloads retain their request/result
 * relationships; Responses parsing retains its schema inference. Ordinary Promise
 * methods, including Google and Bedrock methods, retain their exact generic types.
 *
 * DELIBERATE DIVERGENCE (F15): the runtime returns the plain promise from the async
 * interception pipeline, so `.withResponse()`/`.asResponse()`/`._thenUnwrap()` do NOT
 * exist on an intercepted result. Inheriting `APIPromise` unchanged from `C` would make
 * `client.chat.completions.create(...).withResponse()` compile clean and then crash at
 * runtime with `TypeError: withResponse is not a function`. Narrowing the return here
 * turns that runtime crash into a compile error. Every NON-intercepted path keeps `C`'s
 * exact types (full drop-in), and the intercepted paths keep `C`'s parameter types —
 * only the response-envelope helpers are surrendered. Native schema-dependent parse
 * fields are projected by erased structural types in the content-privileged package.
 */
export type InterceptedClient<C> = {
  [P in keyof C]: P extends "messages" | "embeddings" | "videos"
    ? WithPlainCreate<C[P]>
    : P extends "chat"
      ? WithPlainCompletions<C[P]>
      : P extends "responses"
        ? WithPlainResponsesMethods<C[P]>
        : P extends "images"
          ? WithPlainImageMethods<C[P]>
          : P extends "audio"
            ? WithPlainAudioMethods<C[P]>
            : C[P];
};

/**
 * Construct signature for the public client. The returned instance intersects the
 * Solwyn surface with {@link InterceptedClient} of the wrapped client type `C`, so
 * `new Solwyn(new OpenAI(), { apiKey })` type-checks chat, responses, embeddings, images,
 * videos, and audio calls against OpenAI's PARAMETER types while intercepted returns are
 * honest Promises (no `APIPromise` `.withResponse()` — see {@link InterceptedClient}). Other
 * provider dialects preserve their native method types while the runtime proxy intercepts the
 * corresponding Anthropic, Google, or Bedrock surfaces.
 */
export interface SolwynConstructor {
  new <C>(client: C, options: SolwynOptions): Solwyn & InterceptedClient<C>;
  [Symbol.hasInstance](value: unknown): boolean;
}

/**
 * Regular function (NOT an arrow — arrows have no `[[Construct]]`) used as the public
 * constructor. When invoked with `new`, it returns the wrapping `Proxy`, which becomes
 * the constructed value.
 */
function solwynConstructor(client: unknown, options: SolwynOptions): Solwyn {
  const core = new SolwynCore(client, options);
  return createClientProxy(core, client) as unknown as Solwyn;
}

Object.defineProperty(solwynConstructor, Symbol.hasInstance, {
  value: (value: unknown): boolean => isSolwynWrapper(value),
});

/** The public, drop-in Solwyn client. */
export const Solwyn = solwynConstructor as unknown as SolwynConstructor;

export type { SolwynOptions } from "./client";
