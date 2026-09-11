/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * Google (genai) dialect: request parse/render, response reshape (including the
 * idiomatic `.text` / `.functionCalls` accessors), and per-chunk stream translation.
 * Pure; no I/O capability of any kind (no network client, no diagnostic sink).
 * Structural labels only ever escape on error.
 */

import {
  asArray,
  coerceToText,
  denormalizeFinishReason,
  get,
  isObject,
  normalizeFinishReason,
  parseStop,
  parseTemperature,
  parseTopP,
  requireObject,
  requireString,
} from "./common";
import { multimodalLabelForMime, validateToolExchange } from "./content";
import {
  checkForbiddenCounts,
  RECOGNIZED_GOOGLE_CONFIG,
  RECOGNIZED_GOOGLE_TOP_LEVEL,
  raise,
  scanScope,
} from "./guardrails";
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  ContentPart,
  StreamDelta,
  ToolChoice,
} from "./models";

const GOOGLE_BUILTIN_TOOL_KEYS = {
  googleSearch: "google.google_search",
  googleSearchRetrieval: "google.google_search_retrieval",
  codeExecution: "google.code_execution",
  urlContext: "google.url_context",
};

function mintCallId(name: string): string {
  return `call_${name}`;
}

function parseGoogleImagePart(part: unknown): ContentPart {
  const inline = get(part, "inlineData");
  if (inline != null) {
    const mime = requireString(get(inline, "mimeType"));
    if (mime.startsWith("image/")) {
      return { type: "image", mediaType: mime, data: requireString(get(inline, "data")) };
    }
    raise("google", "*", multimodalLabelForMime(mime));
  }
  if (get(part, "fileData") != null) raise("google", "*", "image.opaque_handle");
  raise("google", "*", "content_part.unknown");
}

function unwrapGoogleResponse(response: unknown): string {
  if (isObject(response)) {
    const keys = Object.keys(response);
    if (keys.length === 1 && keys[0] === "result") return coerceToText(response["result"]);
  }
  return coerceToText(response);
}

function isGoogleContent(value: unknown): value is Record<string, unknown> & { parts: unknown[] } {
  return isObject(value) && Array.isArray(value["parts"]);
}

/** Match native ContentListUnion grouping without silently discarding shorthand. */
function normalizeGoogleContents(
  value: unknown,
): Array<Record<string, unknown> & { parts: unknown[] }> {
  if (value == null || (Array.isArray(value) && value.length === 0)) {
    raise("google", "*", "malformed_request");
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.some(isGoogleContent)) {
    return values.map((content) => {
      if (!isGoogleContent(content)) raise("google", "*", "malformed_request");
      if (Object.keys(content).some((key) => key !== "role" && key !== "parts")) {
        raise("google", "*", "content_part.unknown");
      }
      return content;
    });
  }
  const parts = values.map((part) => {
    if (typeof part === "string") return { text: part };
    // The native serializer requires explicit Content roles for function parts.
    if (get(part, "functionCall") != null || get(part, "functionResponse") != null) {
      raise("google", "*", "malformed_request");
    }
    return part;
  });
  return [{ role: "user", parts }];
}

/** A native Part is a union, not a bag of independently discardable fields. */
function validateGooglePart(part: unknown): void {
  const fields = Object.entries(requireObject(part)).filter(([, value]) => value != null);
  if (
    fields.length !== 1 ||
    !["text", "functionCall", "functionResponse", "inlineData", "fileData"].includes(
      fields[0]?.[0] ?? "",
    )
  ) {
    raise("google", "*", "content_part.unknown");
  }
}

export function googleToCanonical(kwargs: Record<string, unknown>): CanonicalRequest {
  const config = get(kwargs, "config");
  // Dedicated n>1 / candidateCount>1 checks run across both scopes before the
  // fail-closed unsupported-kwarg scan (Python `_check_forbidden_keys`).
  checkForbiddenCounts(kwargs, "google");
  if (isObject(config)) checkForbiddenCounts(config, "google");
  scanScope(kwargs, RECOGNIZED_GOOGLE_TOP_LEVEL, "google");
  if (isObject(config)) scanScope(config, RECOGNIZED_GOOGLE_CONFIG, "google");

  const cfg = isObject(config) ? config : {};
  const maxTokens = cfg["maxOutputTokens"];
  if (maxTokens == null) raise("google", "*", "missing_max_tokens");

  const messages: CanonicalMessage[] = [];
  for (const content of normalizeGoogleContents(get(kwargs, "contents"))) {
    // A missing role defaults to "user" (Python `turn.get("role", "user")`).
    const role = get(content, "role") ?? "user";
    const parts = content.parts;
    if (role === "model") {
      messages.push({ role: "assistant", content: parseGoogleModelParts(parts) });
    } else if (role === "user" || role === "tool" || role === "function") {
      // user/tool/function turns all share one parser that accepts text,
      // functionResponse, and inlineData parts (Python `_google_user_to_canonical`).
      messages.push({ role: "user", content: parseGoogleUserParts(parts) });
    } else {
      raise("google", "*", "unknown_message_role");
    }
  }

  validateToolExchange(messages, "google");

  const canonical: CanonicalRequest = {
    messages,
    maxTokens: maxTokens as number,
    stream: get(kwargs, "stream") === true,
    parallelToolCalls: true,
  };
  const system = cfg["systemInstruction"];
  if (system != null && typeof system !== "string") {
    raise("google", "*", "system_block_list");
  }
  if (typeof system === "string") canonical.system = system;
  const temperature = parseTemperature(cfg["temperature"], "google");
  if (temperature !== null) canonical.temperature = temperature;
  const topP = parseTopP(cfg["topP"]);
  if (topP !== null) canonical.topP = topP;
  const stop = parseStop(cfg["stopSequences"], "google");
  if (stop !== null) canonical.stop = stop;

  const tools = parseGoogleTools(cfg["tools"]);
  if (tools !== null) canonical.tools = tools;
  const toolChoice = parseGoogleToolConfig(cfg["toolConfig"]);
  if (toolChoice !== null) canonical.toolChoice = toolChoice;

  return canonical;
}

function parseGoogleModelParts(parts: unknown[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const part of parts) {
    validateGooglePart(part);
    const text = get(part, "text");
    const fnCall = get(part, "functionCall");
    if (fnCall != null) {
      const name = requireString(get(fnCall, "name"));
      const id = get(fnCall, "id");
      out.push({
        type: "tool_use",
        id: typeof id === "string" ? id : mintCallId(name),
        name,
        input: requireObject(get(fnCall, "args") ?? {}),
      });
    } else if (typeof text === "string") {
      out.push({ type: "text", text });
    } else if (get(part, "inlineData") != null || get(part, "fileData") != null) {
      // A model-turn generated/inline image is provider-bound — RAISE per Python
      // `_google_model_to_canonical` (never accept-then-silently-drop toward OpenAI).
      raise("google", "*", "image.opaque_handle");
    } else {
      raise("google", "*", "content_part.unknown");
    }
  }
  return out;
}

function parseGoogleUserParts(parts: unknown[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const part of parts) {
    validateGooglePart(part);
    const text = get(part, "text");
    const fnResp = get(part, "functionResponse");
    if (typeof text === "string") {
      out.push({ type: "text", text });
    } else if (fnResp != null) {
      const name = requireString(get(fnResp, "name"));
      const id = get(fnResp, "id");
      out.push({
        type: "tool_result",
        toolUseId: typeof id === "string" ? id : mintCallId(name),
        content: unwrapGoogleResponse(get(fnResp, "response")),
      });
    } else {
      // inlineData image, fileData handle, or an unknown part.
      out.push(parseGoogleImagePart(part));
    }
  }
  return out;
}

function parseGoogleTools(value: unknown): CanonicalTool[] | null {
  if (value == null) return null;
  const tools: CanonicalTool[] = [];
  for (const tool of asArray(value)) {
    for (const [key, feature] of Object.entries(GOOGLE_BUILTIN_TOOL_KEYS)) {
      if (get(tool, key) != null) raise("google", "*", feature);
    }
    if (Object.keys(requireObject(tool)).some((key) => key !== "functionDeclarations")) {
      raise("google", "*", "google.unsupported_tool");
    }
    for (const decl of asArray(get(tool, "functionDeclarations"))) {
      const canonicalTool: CanonicalTool = {
        name: requireString(get(decl, "name")),
        // The genai SDK's alternative field is `parameters`; keep it when
        // `parametersJsonSchema` is absent (Python `..._json_schema or parameters`).
        parameters: requireObject(
          get(decl, "parametersJsonSchema") ?? get(decl, "parameters") ?? {},
        ),
      };
      const description = get(decl, "description");
      if (typeof description === "string") canonicalTool.description = description;
      tools.push(canonicalTool);
    }
  }
  return tools;
}

function parseGoogleToolConfig(value: unknown): ToolChoice | null {
  if (value == null) return null;
  const fcc = get(value, "functionCallingConfig");
  const mode = get(fcc, "mode");
  if (mode === "AUTO") return { mode: "auto" };
  if (mode === "NONE") return { mode: "none" };
  if (mode === "ANY") {
    const allowed = asArray(get(fcc, "allowedFunctionNames"));
    if (allowed.length > 0) return { mode: "force", name: requireString(allowed[0]) };
    return { mode: "required" };
  }
  raise("google", "*", "tool_choice.unknown");
}

export function canonicalToGoogle(
  canonical: CanonicalRequest,
  model: string,
): Record<string, unknown> {
  if (canonical.parallelToolCalls === false) {
    raise("*", "google", "parallel_tool_calls=False");
  }
  const nameById = new Map<string, string>();
  const contents: unknown[] = [];
  for (const message of canonical.messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool_use") nameById.set(part.id, part.name);
      }
      contents.push({ role: "model", parts: renderGoogleModelParts(message.content) });
      continue;
    }
    const toolResults = message.content.filter((p) => p.type === "tool_result");
    const others = message.content.filter((p) => p.type !== "tool_result");
    if (toolResults.length > 0 && others.length > 0) {
      raise("*", "google", "tool_result.mixed_content");
    }
    if (toolResults.length > 0) {
      contents.push({ role: "user", parts: renderGoogleToolParts(toolResults, nameById) });
    } else {
      contents.push({ role: "user", parts: renderGoogleUserParts(message.content) });
    }
  }

  const config: Record<string, unknown> = { maxOutputTokens: canonical.maxTokens };
  if (canonical.system != null) config["systemInstruction"] = canonical.system;
  if (canonical.temperature != null) config["temperature"] = canonical.temperature;
  if (canonical.topP != null) config["topP"] = canonical.topP;
  if (canonical.stop != null) config["stopSequences"] = canonical.stop;
  if (canonical.tools != null) {
    config["tools"] = [
      {
        functionDeclarations: canonical.tools.map((t) => ({
          name: t.name,
          ...(t.description != null ? { description: t.description } : {}),
          parametersJsonSchema: t.parameters,
        })),
      },
    ];
  }
  if (canonical.toolChoice != null) {
    config["toolConfig"] = renderGoogleToolConfig(canonical.toolChoice);
  }

  return { model, contents, config };
}

function renderGoogleModelParts(parts: ContentPart[]): unknown[] {
  const out: unknown[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push({ text: part.text });
    else if (part.type === "image") out.push(renderGoogleImagePart(part));
    else if (part.type === "tool_use") {
      out.push({ functionCall: { id: part.id, name: part.name, args: part.input } });
    }
  }
  return out;
}

function renderGoogleUserParts(parts: ContentPart[]): unknown[] {
  const out: unknown[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push({ text: part.text });
    else if (part.type === "image") out.push(renderGoogleImagePart(part));
  }
  return out;
}

function renderGoogleToolParts(parts: ContentPart[], nameById: Map<string, string>): unknown[] {
  const out: unknown[] = [];
  for (const part of parts) {
    if (part.type === "tool_result") {
      const name = nameById.get(part.toolUseId) ?? part.toolUseId;
      out.push({
        functionResponse: { id: part.toolUseId, name, response: { result: part.content } },
      });
    }
  }
  return out;
}

function renderGoogleImagePart(part: ContentPart & { type: "image" }): unknown {
  if (part.data != null) {
    return { inlineData: { mimeType: part.mediaType ?? "", data: part.data } };
  }
  raise("*", "google", "image.url_unsupported_google");
}

function renderGoogleToolConfig(choice: ToolChoice): unknown {
  switch (choice.mode) {
    case "auto":
      return { functionCallingConfig: { mode: "AUTO" } };
    case "none":
      return { functionCallingConfig: { mode: "NONE" } };
    case "required":
      return { functionCallingConfig: { mode: "ANY" } };
    case "force":
      return {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name ?? ""] },
      };
  }
}

// ---------------------------------------------------------------------------
// Response.
// ---------------------------------------------------------------------------

export function googleResponseToCanonical(response: unknown): CanonicalResponse {
  const candidate = asArray(get(response, "candidates"))[0];
  const parts = asArray(get(get(candidate, "content"), "parts"));
  const out: CanonicalResponse = {};
  const texts: string[] = [];
  const toolCalls: CanonicalResponse["toolCalls"] = [];
  let hasFunctionCall = false;
  for (const part of parts) {
    const text = get(part, "text");
    const fnCall = get(part, "functionCall");
    if (fnCall != null) {
      hasFunctionCall = true;
      const name = requireString(get(fnCall, "name"));
      const id = get(fnCall, "id");
      toolCalls.push({
        id: typeof id === "string" ? id : mintCallId(name),
        name,
        arguments: requireObject(get(fnCall, "args") ?? {}),
      });
    } else if (typeof text === "string") {
      texts.push(text);
    }
  }
  if (texts.length > 0) out.text = texts.join("");
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  const finish = get(candidate, "finishReason");
  let canonical = normalizeFinishReason("google", finish == null ? null : requireString(finish));
  if (canonical === "stop" && hasFunctionCall) canonical = "tool_use";
  out.finishReason = canonical;
  const model = get(response, "modelVersion");
  if (typeof model === "string") out.model = model;
  return out;
}

export function canonicalToGoogleResponse(canonical: CanonicalResponse): unknown {
  const parts: unknown[] = [];
  if (canonical.text != null) parts.push({ text: canonical.text });
  for (const tc of canonical.toolCalls ?? []) {
    parts.push({ functionCall: { id: tc.id, name: tc.name, args: tc.arguments } });
  }
  const finishReason = denormalizeFinishReason("google", canonical.finishReason ?? null);
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: finishReason }],
    ...(canonical.model != null ? { modelVersion: canonical.model } : {}),
    get text(): string | undefined {
      const collected = parts
        .map((p) => get(p, "text"))
        .filter((t): t is string => typeof t === "string");
      return collected.length > 0 ? collected.join("") : undefined;
    },
    get functionCalls(): unknown[] | undefined {
      const calls = parts
        .map((p) => get(p, "functionCall"))
        .filter((fc): fc is unknown => fc != null);
      return calls.length > 0 ? calls : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Stream.
// ---------------------------------------------------------------------------

export function googleChunkToDeltas(
  served: string,
  requested: string,
  chunk: unknown,
): StreamDelta[] {
  const candidate = asArray(get(chunk, "candidates"))[0];
  const parts = asArray(get(get(candidate, "content"), "parts"));
  const deltas: StreamDelta[] = [];
  for (const part of parts) {
    if (get(part, "functionCall") != null) {
      raise(served, requested, "cross_provider_tool_stream");
    }
    if (get(part, "inlineData") != null || get(part, "fileData") != null) {
      raise(served, requested, "cross_provider_multimodal_stream");
    }
    const text = get(part, "text");
    if (typeof text === "string" && text.length > 0) deltas.push({ text });
  }
  const finish = get(candidate, "finishReason");
  if (finish != null) {
    const canonical = normalizeFinishReason("google", requireString(finish));
    if (canonical !== null) deltas.push({ finishReason: canonical });
  }
  return deltas;
}

export function deltaToGoogleChunk(delta: StreamDelta): unknown {
  if (delta.text !== undefined) {
    return canonicalToGoogleResponse({ text: delta.text });
  }
  return {
    candidates: [{ finishReason: denormalizeFinishReason("google", delta.finishReason ?? null) }],
  };
}
