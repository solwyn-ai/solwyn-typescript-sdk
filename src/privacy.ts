/**
 * PRIVACY-CRITICAL — content-privileged module.
 *
 * This is one of exactly three content-touching locations in the SDK (the others
 * are the whole `src/providers/translation/` package and the `src/ai-sdk/` entry).
 * It is the ONLY place outside those that may reference prompt/response content
 * fields (`content`, `text`, `messages`, `system`, `contents`, `reasoning_content`,
 * `tool_calls`).
 *
 * Every function here takes content in and returns a plain non-negative `number`
 * out — never a string, never the original object. It computes character counts
 * and token estimates so the rest of the SDK can size pre-flight budget checks and
 * post-hoc usage estimates WITHOUT ever materializing, joining, logging, storing,
 * or transmitting the underlying text.
 * Media helpers follow the same boundary: they return a complete plain
 * `MediaUsage` value containing only counts and bounded non-content selectors.
 *
 * Ported from `solwyn/_privacy.py`. Deliberately imports NOTHING (no logger, no
 * zod, no I/O) — enforced by the privacy-firewall test. Do NOT add a `import`
 * for logging here, and do NOT wrap these inputs in a zod strict parse: this is
 * the one module in the port where duck-typed defensive access (mirroring Python's
 * `isinstance` / `getattr(..., default)`) is the correct choice, because the inputs
 * are arbitrary/untrusted provider-SDK request kwargs and response objects whose
 * "malformed shape" is exactly what the never-raises paths must tolerate.
 */

/**
 * Per-provider character-per-token ratios (D8 — preserve Python's exact table).
 * Unknown providers fall back to 4.0.
 */
const RATIO_TABLE: Record<string, number> = {
  openai: 4.0,
  anthropic: 3.8,
  google: 4.0,
  bedrock: 4.0,
};

/** Default chars/token ratio for a provider key not in {@link RATIO_TABLE}. */
const DEFAULT_RATIO = 4.0;

/** `len(value)` when `value` is a string, else 0. */
function stringLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/** True for a plain object (not null, not an array) — mirrors Python `isinstance(x, dict)`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sum `len(block["text"])` across a list of content-block dicts, skipping any
 * non-dict entry and any block whose `text` is not a string (Bedrock `cachePoint`,
 * `guardContent`, etc. contribute 0 and never short-circuit siblings).
 */
function sumTextBlockList(blocks: readonly unknown[]): number {
  let total = 0;
  for (const block of blocks) {
    if (isRecord(block)) {
      const text = block["text"];
      if (typeof text === "string") {
        total += text.length;
      }
    }
  }
  return total;
}

/**
 * Defensive optional attribute read (mirrors Python `getattr(obj, name, None)`):
 * works whether `obj` is null/undefined, a plain object, or a class instance, and
 * follows the prototype chain via runtime property access. A missing attribute
 * yields `undefined`, never throws.
 */
function getProp(obj: unknown, name: string): unknown {
  try {
    if (obj !== null && typeof obj === "object") {
      return (obj as Record<string, unknown>)[name];
    }
  } catch {
    // Arbitrary provider objects may expose hostile getters or proxies. Treat
    // an unreadable selector exactly like a missing one and retain nothing.
  }
  return undefined;
}

/** Complete wire-shaped media carrier; every key stays explicit when serialized. */
type CompleteMediaUsage = Required<import("./types").MediaUsage>;

/** Build a plain media carrier without retaining any source request object. */
function mediaUsage(overrides: Partial<CompleteMediaUsage>): CompleteMediaUsage {
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

/** Keep only bounded selector labels; empty strings are valid labels. */
function boundedSelector(value: unknown): string | null {
  return typeof value === "string" && value.length <= 32 ? value : null;
}

/** Positive integer count with Python-compatible bool exclusion. */
function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Finite non-negative numeric duration; no coercion and no bool acceptance. */
function nonnegativeDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Sum the string lengths from one delta/message-like object's three text-bearing
 * surfaces, all additive:
 *  1. `content` — if a string, its length.
 *  2. `reasoning_content` — if a string, its length (DeepSeek-style reasoning text).
 *  3. `tool_calls[].function.arguments` — each tool-call's argument string length
 *     (tool-only responses from a usage-less endpoint live entirely here).
 *
 * All access is defensive; a missing/mistyped field contributes 0 and never raises.
 * Private — not exported (Python's `_part_text_length`).
 */
function partTextLength(part: unknown): number {
  let total = 0;
  total += stringLength(getProp(part, "content"));
  total += stringLength(getProp(part, "reasoning_content"));
  const toolCalls = getProp(part, "tool_calls");
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      const fn = getProp(toolCall, "function");
      total += stringLength(getProp(fn, "arguments"));
    }
  }
  return total;
}

/**
 * Sum character lengths of all recognizable prompt-content fields in an LLM call's
 * kwargs, WITHOUT ever joining them into a string. All recognized shapes are
 * additive (one call can match several):
 *
 * - `messages`: list of message dicts. Each message's `content` is a string
 *   (add its length) or a list of `{text}` blocks (add each `text` length — covers
 *   both Anthropic `{"type":"text","text":...}` and Bedrock `{"text":...}` blocks;
 *   no `type` key required).
 * - `system`: a string (Anthropic — add its length) OR a list of `{text}` blocks
 *   (Bedrock `SystemContentBlock` list — sum each `text`, skip non-text blocks).
 * - `contents` (Google): a string, or a list of strings and/or `{text}` dicts.
 *
 * Missing/empty kwargs, or kwargs with none of these keys, returns 0. Result is
 * always a non-negative integer. Content in, integer out — never the text itself.
 */
export function estimateContentLength(kwargs: Record<string, unknown>): number {
  let total = 0;

  const messages = kwargs["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (isRecord(message)) {
        const content = message["content"];
        if (typeof content === "string") {
          total += content.length;
        } else if (Array.isArray(content)) {
          total += sumTextBlockList(content);
        }
      }
    }
  }

  const system = kwargs["system"];
  if (typeof system === "string") {
    total += system.length;
  } else if (Array.isArray(system)) {
    total += sumTextBlockList(system);
  }

  const contents = kwargs["contents"];
  if (typeof contents === "string") {
    total += contents.length;
  } else if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item === "string") {
        total += item.length;
      } else if (isRecord(item)) {
        const text = item["text"];
        if (typeof text === "string") {
          total += text.length;
        }
      }
    }
  }

  return total;
}

/**
 * Responses-specific preflight character count. Content in, integer out: this walker
 * never joins, retains, logs, or returns any text and ignores every non-text shape.
 */
export function estimateResponsesContentLength(value: Record<string, unknown>): number {
  let total = stringLength(value["instructions"]);
  const input = value["input"];
  if (typeof input === "string") {
    return total + input.length;
  }
  if (!Array.isArray(input)) {
    return total;
  }
  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }
    for (const key of ["content", "output"] as const) {
      const content = item[key];
      if (typeof content === "string") {
        total += content.length;
      } else if (Array.isArray(content)) {
        total += sumTextBlockList(content);
      }
    }
  }
  return total;
}

/**
 * Convert a character count to a token estimate via a fixed per-provider
 * chars/token ratio (D8). Formula: `max(1, trunc(charCount / ratio))` — truncate
 * toward zero (Python `int()`), floored to a minimum of 1. Keys only off the coarse
 * `provider` string; ignores model-specific tables entirely.
 *
 * NOTE: this floors at 1, so a `charCount` of 0 still returns 1. The caller
 * (`client.ts`) special-cases genuinely-empty content to 0 tokens by NOT calling
 * this function when `charCount` is falsy — do not "fix" the floor here (D8).
 */
export function estimateTokensFromLength(charCount: number, provider: string): number {
  const ratio = RATIO_TABLE[provider] ?? DEFAULT_RATIO;
  return Math.max(1, Math.trunc(charCount / ratio));
}

/**
 * PRIVACY-CRITICAL embedding request measurement. Reads only `input`, returns
 * only a bare integer, and never joins or retains content-bearing strings.
 */
export function estimateEmbeddingInputTokens(
  kwargs: Record<string, unknown>,
  provider: string,
): number {
  try {
    const input = getProp(kwargs, "input");
    if (typeof input === "string") {
      return input.length === 0 ? 0 : estimateTokensFromLength(input.length, provider);
    }
    if (!Array.isArray(input)) {
      return 0;
    }

    if (input.every((item) => typeof item === "string")) {
      let characters = 0;
      for (const item of input) {
        characters += item.length;
      }
      return characters === 0 ? 0 : estimateTokensFromLength(characters, provider);
    }

    if (input.every((item) => typeof item === "number" && Number.isInteger(item))) {
      return input.length;
    }

    if (
      input.every(
        (item) =>
          Array.isArray(item) &&
          item.every((tokenId) => typeof tokenId === "number" && Number.isInteger(tokenId)),
      )
    ) {
      let tokens = 0;
      for (const item of input) {
        tokens += item.length;
      }
      return tokens;
    }
  } catch {
    // Malformed arrays/proxies are unobservable, never an application failure.
  }
  return 0;
}

/**
 * PRIVACY-CRITICAL Google embedding request measurement. Reads only the real
 * Google `contents` request shape, descending through Content `parts` and text
 * Part `text` fields. Returns only a bare integer and retains no request data.
 */
export function estimateGoogleEmbeddingInputTokens(
  kwargs: Record<string, unknown>,
  provider: string,
): number {
  let characters = 0;

  const countContent = (content: unknown): void => {
    if (typeof content === "string") {
      characters += content.length;
      return;
    }
    if (content === null || typeof content !== "object" || Array.isArray(content)) {
      return;
    }
    const parts = getProp(content, "parts");
    if (!Array.isArray(parts)) {
      const text = getProp(content, "text");
      if (typeof text === "string") {
        characters += text.length;
      }
      return;
    }
    for (const part of parts) {
      const text = getProp(part, "text");
      if (typeof text === "string") {
        characters += text.length;
      }
    }
  };

  try {
    const contents = getProp(kwargs, "contents");
    if (Array.isArray(contents)) {
      for (const content of contents) {
        countContent(content);
      }
    } else {
      countContent(contents);
    }
  } catch {
    // Malformed arrays/proxies are unobservable, never an application failure.
  }

  return characters === 0 ? 0 : estimateTokensFromLength(characters, provider);
}

/** OpenAI-dialect image request measurement using non-content selectors only. */
export function measureImageMedia(kwargs: Record<string, unknown>): CompleteMediaUsage {
  const size = getProp(kwargs, "size");
  const resolution = size === undefined ? getProp(kwargs, "resolution") : size;
  return mediaUsage({
    image_count: positiveIntegerOrDefault(getProp(kwargs, "n"), 1),
    resolution: boundedSelector(resolution),
    quality: boundedSelector(getProp(kwargs, "quality")),
  });
}

/** Google image request measurement using duck-typed `config.numberOfImages`. */
export function measureGoogleImageMedia(kwargs: Record<string, unknown>): CompleteMediaUsage {
  const config = getProp(kwargs, "config");
  return mediaUsage({
    image_count: positiveIntegerOrDefault(getProp(config, "numberOfImages"), 1),
  });
}

/** PRIVACY-CRITICAL speech measurement: input string in, character count out. */
export function measureSpeechMedia(kwargs: Record<string, unknown>): CompleteMediaUsage {
  const input = getProp(kwargs, "input");
  return mediaUsage({
    input_characters: typeof input === "string" ? input.length : null,
  });
}

/** Google Veo request measurement using non-content config selectors only. */
export function measureVideoMedia(kwargs: Record<string, unknown>): CompleteMediaUsage {
  const config = getProp(kwargs, "config");
  return mediaUsage({
    video_seconds: nonnegativeDuration(getProp(config, "durationSeconds")),
    resolution: boundedSelector(getProp(config, "resolution")),
    is_estimated: true,
  });
}

/** OpenAI Sora seconds normalization with conservative default-on-absence semantics. */
function openAIVideoSeconds(value: unknown): number | null {
  if (value === undefined || value === null) {
    return 4;
  }
  if (typeof value === "number") {
    return nonnegativeDuration(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : null;
  }
  return null;
}

/** OpenAI Sora size normalization; short unparseable strings pass through raw. */
function openAIVideoResolution(value: unknown): string | null {
  const size = value === undefined || value === null ? "720x1280" : value;
  if (typeof size !== "string" || size.length > 32) {
    return null;
  }
  const match = /^(\d+)[xX](\d+)$/.exec(size);
  if (match !== null) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
      return `${Math.min(width, height)}p`;
    }
  }
  return size;
}

/** OpenAI Sora request measurement using seconds and size only. */
export function measureOpenAIVideoMedia(kwargs: Record<string, unknown>): CompleteMediaUsage {
  return mediaUsage({
    video_seconds: openAIVideoSeconds(getProp(kwargs, "seconds")),
    resolution: openAIVideoResolution(getProp(kwargs, "size")),
    is_estimated: true,
  });
}

/**
 * Whether `value` exposes an iterator method. Callers invoke it inside their own
 * try/catch, so a hostile `Symbol.iterator` getter still lands in the never-raise path.
 */
function isIterable(value: unknown): value is Iterable<unknown> {
  if (value === null || value === undefined) return false;
  return typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
}

/**
 * Length-only measurement of one OpenAI-dialect streaming delta chunk (the
 * missing-usage fallback accumulator for compat providers that never emit usage
 * mid-stream). Walks `chunk.choices`, summing `partTextLength(choice.delta)`.
 *
 * NEVER RAISES: any exception during the walk (missing/malformed `choices`,
 * non-iterable, etc.) is swallowed and the partial total (or 0) is returned. This
 * runs on arbitrary live endpoint output inside the stream path — a malformed
 * chunk must never turn a deliverable stream into a hard failure. The caught value
 * is never inspected or logged (its message could embed a content fragment).
 */
export function estimateStreamChunkContentLength(chunk: unknown): number {
  let total = 0;
  try {
    const choices = getProp(chunk, "choices");
    // Responses events carry no `choices`: return without iterating, so the common
    // shape never constructs (and discards) a not-iterable TypeError per event.
    if (!isIterable(choices)) return total;
    for (const choice of choices) {
      total += partTextLength(getProp(choice, "delta"));
    }
    return total;
  } catch {
    return total;
  }
}

/**
 * Length-only measurement of one OpenAI-dialect NON-streaming response's message
 * text (the missing-usage fallback for buffered calls). Walks `response.choices`,
 * summing `partTextLength(choice.message)`. Same never-raises contract as
 * {@link estimateStreamChunkContentLength}.
 */
export function estimateResponseContentLength(response: unknown): number {
  let total = 0;
  try {
    const choices = getProp(response, "choices");
    if (!isIterable(choices)) return total;
    for (const choice of choices) {
      total += partTextLength(getProp(choice, "message"));
    }
    return total;
  } catch {
    return total;
  }
}
