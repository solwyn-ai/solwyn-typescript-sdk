/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * Shared, dialect-agnostic helpers: duck-typed structural access, scalar parsing
 * (temperature ceiling, stop-cap), the finish-reason lookup tables, image URI
 * handling, and the "coerce tool-result payload to text" rule. Pure; no I/O capability
 * of any kind (no network client, no diagnostic sink). Structural labels only.
 */

import { raise } from "./guardrails";
import type { CanonicalFinishReason } from "./models";

// ---------------------------------------------------------------------------
// Duck-typed structural access (never `instanceof`, never a provider SDK class).
// ---------------------------------------------------------------------------

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Read a property off an unknown value without throwing; missing → undefined. */
export function get(obj: unknown, key: string): unknown {
  if (obj !== null && typeof obj === "object") {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Assert-and-narrow a value to `string`; a non-string is treated as malformed. */
export function requireString(v: unknown): string {
  if (typeof v !== "string") throw new Error("malformed: expected string");
  return v;
}

/** Assert-and-narrow a value to a plain object; anything else is malformed. */
export function requireObject(v: unknown): Record<string, unknown> {
  if (!isObject(v)) throw new Error("malformed: expected object");
  return v;
}

// ---------------------------------------------------------------------------
// Shared scalar parsing (identical across all four dialects).
// ---------------------------------------------------------------------------

export function parseTemperature(value: unknown, source: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number") throw new Error("malformed: temperature");
  if (value > 1.0) raise(source, "*", "temperature>1.0");
  return value;
}

export function parseTopP(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number") throw new Error("malformed: top_p");
  return value;
}

/** Normalize a bare string to a 1-element array; more than 4 entries raises `stop>4`. */
export function parseStop(value: unknown, source: string): string[] | null {
  if (value == null) return null;
  const arr = typeof value === "string" ? [value] : value;
  if (!Array.isArray(arr)) throw new Error("malformed: stop");
  const out = arr.map(requireString);
  if (out.length > 4) raise(source, "*", "stop>4");
  return out;
}

// ---------------------------------------------------------------------------
// Finish-reason tables.
// ---------------------------------------------------------------------------

const FINISH_TO_CANONICAL: Record<string, Record<string, CanonicalFinishReason>> = {
  openai: {
    stop: "stop",
    length: "length",
    tool_calls: "tool_use",
    function_call: "tool_use",
    content_filter: "content_filter",
  },
  anthropic: {
    end_turn: "stop",
    stop_sequence: "stop",
    pause_turn: "stop",
    max_tokens: "length",
    tool_use: "tool_use",
    refusal: "content_filter",
  },
  google: {
    STOP: "stop",
    MAX_TOKENS: "length",
    SAFETY: "content_filter",
    RECITATION: "content_filter",
    PROHIBITED_CONTENT: "content_filter",
    BLOCKLIST: "content_filter",
  },
  bedrock: {
    end_turn: "stop",
    stop_sequence: "stop",
    max_tokens: "length",
    model_context_window_exceeded: "length",
    tool_use: "tool_use",
    guardrail_intervened: "content_filter",
    content_filtered: "content_filter",
  },
};

const CANONICAL_TO_FINISH: Record<string, Record<CanonicalFinishReason, string>> = {
  openai: {
    stop: "stop",
    length: "length",
    tool_use: "tool_calls",
    content_filter: "content_filter",
  },
  anthropic: {
    stop: "end_turn",
    length: "max_tokens",
    tool_use: "tool_use",
    content_filter: "refusal",
  },
  google: { stop: "STOP", length: "MAX_TOKENS", tool_use: "STOP", content_filter: "SAFETY" },
  bedrock: {
    stop: "end_turn",
    length: "max_tokens",
    tool_use: "tool_use",
    content_filter: "content_filtered",
  },
};

/** Pure lookup: served-dialect raw finish reason → canonical, or `null` if none. */
export function normalizeFinishReason(
  served: string,
  raw: string | null,
): CanonicalFinishReason | null {
  if (raw === null) return null;
  const table = FINISH_TO_CANONICAL[served];
  if (table === undefined) return null;
  return table[raw] ?? null;
}

/** Reverse: canonical finish reason → requested-dialect native token, or `null`. */
export function denormalizeFinishReason(
  requested: string,
  canonical: CanonicalFinishReason | null,
): string | null {
  if (canonical === null) return null;
  const table = CANONICAL_TO_FINISH[requested];
  if (table === undefined) return null;
  return table[canonical] ?? null;
}

// ---------------------------------------------------------------------------
// Base64 <-> bytes (edge-safe; atob/btoa are web-standard globals).
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array | string): string {
  if (typeof bytes === "string") return btoa(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Image URI parsing (shared across every dialect's image path).
// ---------------------------------------------------------------------------

export interface ParsedImage {
  mediaType: string | null;
  data: string | null;
  url: string | null;
}

const DATA_URI_RE = /^data:([^;,]*);base64,(.*)$/s;

/**
 * Parse an image reference string. A `data:<media-type>;base64,<data>` URI keeps its
 * media type VERBATIM; an `https://` URL becomes a url-image; anything else (http://,
 * bare handles) raises `image.insecure_url` — never echoing the offending value.
 */
export function parseImageUrl(url: unknown, source: string): ParsedImage {
  const s = requireString(url);
  if (s.startsWith("data:")) {
    const m = DATA_URI_RE.exec(s);
    if (m === null) throw new Error("malformed: data uri");
    return { mediaType: m[1] ?? "", data: m[2] ?? "", url: null };
  }
  if (s.startsWith("https://")) {
    return { mediaType: null, data: null, url: s };
  }
  raise(source, "*", "image.insecure_url");
}

// ---------------------------------------------------------------------------
// Tool-result payload -> plain string (behavior 34).
// ---------------------------------------------------------------------------

/**
 * Decode a tool-call `arguments` value to a JSON object. OpenAI encodes arguments
 * as a JSON STRING; Anthropic/Google as an object. A null / non-string / malformed /
 * non-object-decoding payload degrades to an EMPTY object structurally (Python
 * `_loads_args`) — never an abort. Never reads the value into any error.
 */
export function loadsArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (isObject(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const decoded: unknown = JSON.parse(raw);
      return isObject(decoded) ? decoded : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Coerce a tool-result payload to a plain string: a string stays itself; a list
 * concatenates each entry's `text` (or a bare string entry); any other object is
 * JSON-stringified.
 */
export function coerceToText(content: unknown): string {
  // None/undefined → "" (Python `_as_text`); guards against `JSON.stringify(undefined)`
  // returning a non-string and `null` becoming the literal "null".
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (typeof block === "string") {
        out += block;
      } else {
        const t = get(block, "text");
        if (typeof t === "string") out += t;
      }
    }
    return out;
  }
  return JSON.stringify(content);
}
