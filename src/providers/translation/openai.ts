/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * OpenAI (Chat Completions) dialect: request parse/render, response reshape, and
 * per-chunk stream translation. Pure; no I/O capability of any kind (no network
 * client, no diagnostic sink). Structural labels only ever escape on error.
 */

import {
  asArray,
  coerceToText,
  denormalizeFinishReason,
  get,
  isObject,
  loadsArgs,
  normalizeFinishReason,
  parseImageUrl,
  parseStop,
  parseTemperature,
  parseTopP,
  requireObject,
  requireString,
} from "./common";
import { multimodalLabelForType, validateToolExchange } from "./content";
import { checkForbiddenCounts, RECOGNIZED_OPENAI_TOP_LEVEL, raise, scanScope } from "./guardrails";
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  ContentPart,
  StreamDelta,
  ToolChoice,
} from "./models";

const OPENAI_KNOWN_NON_FUNCTION_TOOLS = new Set<string>([
  "file_search",
  "web_search",
  "web_search_preview",
  "computer_use_preview",
  "code_interpreter",
  "image_generation",
  "mcp",
]);

/**
 * OpenAI image_url parsing (Python `_openai_image_to_canonical`): a `data:` URI is
 * parsed verbatim; an `http`-prefixed URL goes through the secure check (only
 * `https://` is accepted, `http://` raises `image.insecure_url`); anything else — a
 * bare provider handle like `file-abc123` — raises `image.opaque_handle`.
 */
function parseOpenAIImage(url: unknown): ContentPart {
  const s = requireString(url);
  if (s.startsWith("data:")) return { type: "image", ...parseImageUrl(s, "openai") };
  if (s.startsWith("http")) {
    if (s.startsWith("https://")) return { type: "image", ...parseImageUrl(s, "openai") };
    raise("openai", "*", "image.insecure_url");
  }
  raise("openai", "*", "image.opaque_handle");
}

function parseOpenAIBlocks(content: unknown): ContentPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const parts: ContentPart[] = [];
  for (const block of asArray(content)) {
    const type = get(block, "type");
    if (type === "text") {
      parts.push({ type: "text", text: requireString(get(block, "text")) });
    } else if (type === "image_url") {
      parts.push(parseOpenAIImage(get(get(block, "image_url"), "url")));
    } else {
      raise("openai", "*", multimodalLabelForType(requireString(type)));
    }
  }
  return parts;
}

export function openaiToCanonical(kwargs: Record<string, unknown>): CanonicalRequest {
  if ("input" in kwargs || "instructions" in kwargs) {
    raise("openai", "*", "responses_api");
  }
  checkForbiddenCounts(kwargs, "openai");
  scanScope(kwargs, RECOGNIZED_OPENAI_TOP_LEVEL, "openai");

  const maxCompletion = get(kwargs, "max_completion_tokens");
  const maxLegacy = get(kwargs, "max_tokens");
  const maxTokens = maxCompletion ?? maxLegacy;
  if (maxTokens == null) raise("openai", "*", "missing_max_tokens");

  const systemParts: string[] = [];
  const messages: CanonicalMessage[] = [];
  for (const message of asArray(get(kwargs, "messages"))) {
    const role = get(message, "role");
    if (role === "system" || role === "developer") {
      // Only a plain-string system/developer message is in the subset; a list-shaped
      // (block-list) content RAISES per Python `_openai_system_text` (never coerced).
      const content = get(message, "content");
      if (typeof content !== "string") raise("openai", "*", "system_block_list");
      systemParts.push(content);
    } else if (role === "user") {
      messages.push({ role: "user", content: parseOpenAIBlocks(get(message, "content")) });
    } else if (role === "assistant") {
      const parts: ContentPart[] = parseOpenAIBlocks(get(message, "content"));
      for (const tc of asArray(get(message, "tool_calls"))) {
        const fn = get(tc, "function");
        parts.push({
          type: "tool_use",
          id: requireString(get(tc, "id")),
          name: requireString(get(fn, "name")),
          input: loadsArgs(get(fn, "arguments")),
        });
      }
      messages.push({ role: "assistant", content: parts });
    } else if (role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: requireString(get(message, "tool_call_id")),
            content: coerceToText(get(message, "content")),
          },
        ],
      });
    } else {
      raise("openai", "*", "unknown_message_role");
    }
  }

  validateToolExchange(messages, "openai");

  const canonical: CanonicalRequest = {
    messages,
    maxTokens: maxTokens as number,
    stream: get(kwargs, "stream") === true,
    parallelToolCalls: get(kwargs, "parallel_tool_calls") !== false,
  };
  if (systemParts.length > 0) canonical.system = systemParts.join("\n\n");
  const temperature = parseTemperature(get(kwargs, "temperature"), "openai");
  if (temperature !== null) canonical.temperature = temperature;
  const topP = parseTopP(get(kwargs, "top_p"));
  if (topP !== null) canonical.topP = topP;
  const stop = parseStop(get(kwargs, "stop"), "openai");
  if (stop !== null) canonical.stop = stop;

  const tools = parseOpenAITools(get(kwargs, "tools"));
  if (tools !== null) canonical.tools = tools;
  const toolChoice = parseOpenAIToolChoice(get(kwargs, "tool_choice"));
  if (toolChoice !== null) canonical.toolChoice = toolChoice;

  return canonical;
}

function parseOpenAITools(value: unknown): CanonicalTool[] | null {
  if (value == null) return null;
  const tools: CanonicalTool[] = [];
  for (const tool of asArray(value)) {
    const type = get(tool, "type");
    if (type !== "function") {
      const t = requireString(type);
      raise(
        "openai",
        "*",
        OPENAI_KNOWN_NON_FUNCTION_TOOLS.has(t) ? `openai.${t}` : "openai.unsupported_tool",
      );
    }
    const fn = get(tool, "function");
    const canonicalTool: CanonicalTool = {
      name: requireString(get(fn, "name")),
      parameters: requireObject(get(fn, "parameters") ?? {}),
    };
    const description = get(fn, "description");
    if (typeof description === "string") canonicalTool.description = description;
    tools.push(canonicalTool);
  }
  return tools;
}

function parseOpenAIToolChoice(value: unknown): ToolChoice | null {
  if (value == null) return null;
  if (value === "auto") return { mode: "auto" };
  if (value === "required") return { mode: "required" };
  if (value === "none") return { mode: "none" };
  if (isObject(value) && get(value, "type") === "function") {
    return { mode: "force", name: requireString(get(get(value, "function"), "name")) };
  }
  raise("openai", "*", "tool_choice.unknown");
}

export function canonicalToOpenAI(
  canonical: CanonicalRequest,
  model: string,
): Record<string, unknown> {
  const messages: unknown[] = [];
  if (canonical.system != null) messages.push({ role: "system", content: canonical.system });

  for (const message of canonical.messages) {
    if (message.role === "user") {
      const toolResults = message.content.filter((p) => p.type === "tool_result");
      const others = message.content.filter((p) => p.type !== "tool_result");
      if (toolResults.length > 0 && others.length > 0) {
        raise("*", "openai", "tool_result.mixed_content");
      }
      if (toolResults.length > 0) {
        for (const part of toolResults) {
          if (part.type === "tool_result") {
            messages.push({ role: "tool", tool_call_id: part.toolUseId, content: part.content });
          }
        }
      } else {
        messages.push({ role: "user", content: renderOpenAIUserContent(message.content) });
      }
    } else {
      const texts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const part of message.content) {
        if (part.type === "text") texts.push(part.text);
        else if (part.type === "tool_use") {
          toolCalls.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          });
        }
      }
      const assistant: Record<string, unknown> = {
        role: "assistant",
        content: texts.length > 0 ? texts.join("") : null,
      };
      if (toolCalls.length > 0) assistant["tool_calls"] = toolCalls;
      messages.push(assistant);
    }
  }

  const out: Record<string, unknown> = {
    model,
    messages,
    max_completion_tokens: canonical.maxTokens,
    stream: canonical.stream,
  };
  if (canonical.temperature != null) out["temperature"] = canonical.temperature;
  if (canonical.topP != null) out["top_p"] = canonical.topP;
  if (canonical.stop != null) out["stop"] = canonical.stop;
  if (canonical.tools != null) {
    out["tools"] = canonical.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? null, parameters: t.parameters },
    }));
  }
  if (canonical.toolChoice != null) {
    out["tool_choice"] = renderOpenAIToolChoice(canonical.toolChoice);
  }
  if (canonical.parallelToolCalls === false) out["parallel_tool_calls"] = false;
  return out;
}

function renderOpenAIUserContent(parts: ContentPart[]): unknown {
  const hasImage = parts.some((p) => p.type === "image");
  if (!hasImage) {
    return parts
      .filter((p) => p.type === "text")
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
  }
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      const url =
        part.data != null ? `data:${part.mediaType ?? ""};base64,${part.data}` : (part.url ?? "");
      return { type: "image_url", image_url: { url } };
    }
    return {};
  });
}

function renderOpenAIToolChoice(choice: ToolChoice): unknown {
  switch (choice.mode) {
    case "auto":
      return "auto";
    case "required":
      return "required";
    case "none":
      return "none";
    case "force":
      return { type: "function", function: { name: choice.name ?? "" } };
  }
}

// ---------------------------------------------------------------------------
// Response.
// ---------------------------------------------------------------------------

export function openaiResponseToCanonical(response: unknown): CanonicalResponse {
  const choice0 = asArray(get(response, "choices"))[0];
  const message = get(choice0, "message");
  const out: CanonicalResponse = {};
  const content = get(message, "content");
  if (typeof content === "string") out.text = content;
  const toolCalls = asArray(get(message, "tool_calls"));
  if (toolCalls.length > 0) {
    out.toolCalls = toolCalls.map((tc) => {
      const fn = get(tc, "function");
      return {
        id: requireString(get(tc, "id")),
        name: requireString(get(fn, "name")),
        arguments: loadsArgs(get(fn, "arguments")),
      };
    });
  }
  const finish = get(choice0, "finish_reason");
  out.finishReason = normalizeFinishReason("openai", finish == null ? null : requireString(finish));
  const model = get(response, "model");
  if (typeof model === "string") out.model = model;
  return out;
}

export function canonicalToOpenAIResponse(canonical: CanonicalResponse): unknown {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: canonical.text ?? null,
    tool_calls:
      canonical.toolCalls != null && canonical.toolCalls.length > 0
        ? canonical.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }))
        : null,
  };
  return {
    choices: [
      {
        index: 0,
        message,
        finish_reason: denormalizeFinishReason("openai", canonical.finishReason ?? null),
      },
    ],
    model: canonical.model ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stream.
// ---------------------------------------------------------------------------

export function openaiChunkToDeltas(
  served: string,
  requested: string,
  chunk: unknown,
): StreamDelta[] {
  const choice = asArray(get(chunk, "choices"))[0];
  const delta = get(choice, "delta");
  if (get(delta, "tool_calls") != null) {
    raise(served, requested, "cross_provider_tool_stream");
  }
  const deltas: StreamDelta[] = [];
  const content = get(delta, "content");
  if (typeof content === "string" && content.length > 0) deltas.push({ text: content });
  const finish = get(choice, "finish_reason");
  if (finish != null) {
    const canonical = normalizeFinishReason("openai", requireString(finish));
    if (canonical !== null) deltas.push({ finishReason: canonical });
  }
  return deltas;
}

export function deltaToOpenAIChunk(delta: StreamDelta): unknown {
  if (delta.text !== undefined) {
    return { choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] };
  }
  return {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: denormalizeFinishReason("openai", delta.finishReason ?? null),
      },
    ],
  };
}
