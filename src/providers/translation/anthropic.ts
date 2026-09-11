/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * Anthropic (Messages) dialect: request parse/render, response reshape, and per-chunk
 * stream translation. Pure; no I/O capability of any kind (no network client, no
 * diagnostic sink). Structural labels only ever escape on error.
 */

import {
  asArray,
  coerceToText,
  denormalizeFinishReason,
  get,
  normalizeFinishReason,
  parseImageUrl,
  parseStop,
  parseTemperature,
  parseTopP,
  requireObject,
  requireString,
} from "./common";
import { multimodalLabelForType, validateToolExchange } from "./content";
import {
  checkForbiddenCounts,
  RECOGNIZED_ANTHROPIC_TOP_LEVEL,
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

const ANTHROPIC_PROPRIETARY_PREFIXES = [
  "computer",
  "bash",
  "text_editor",
  "web_search",
  "code_execution",
];

function parseAnthropicImage(source: unknown): ContentPart {
  const type = get(source, "type");
  if (type === "base64") {
    return {
      type: "image",
      mediaType: requireString(get(source, "media_type")),
      data: requireString(get(source, "data")),
    };
  }
  if (type === "url") {
    return { type: "image", ...parseImageUrl(get(source, "url"), "anthropic") };
  }
  raise("anthropic", "*", "image.opaque_handle");
}

function parseAnthropicBlocks(content: unknown): ContentPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const parts: ContentPart[] = [];
  for (const block of asArray(content)) {
    if (get(block, "cache_control") != null) raise("anthropic", "*", "cache_control");
    const type = get(block, "type");
    if (type === "text") {
      parts.push({ type: "text", text: requireString(get(block, "text")) });
    } else if (type === "image") {
      parts.push(parseAnthropicImage(get(block, "source")));
    } else if (type === "tool_use") {
      parts.push({
        type: "tool_use",
        id: requireString(get(block, "id")),
        name: requireString(get(block, "name")),
        input: requireObject(get(block, "input")),
      });
    } else if (type === "tool_result") {
      parts.push({
        type: "tool_result",
        toolUseId: requireString(get(block, "tool_use_id")),
        content: coerceToText(get(block, "content")),
      });
    } else {
      raise("anthropic", "*", multimodalLabelForType(requireString(type)));
    }
  }
  return parts;
}

export function anthropicToCanonical(kwargs: Record<string, unknown>): CanonicalRequest {
  if (get(kwargs, "mcp_servers") != null) raise("anthropic", "*", "anthropic.mcp_servers");
  checkForbiddenCounts(kwargs, "anthropic");
  scanScope(kwargs, RECOGNIZED_ANTHROPIC_TOP_LEVEL, "anthropic");

  const maxTokens = get(kwargs, "max_tokens");
  if (maxTokens == null) raise("anthropic", "*", "missing_max_tokens");

  const messages: CanonicalMessage[] = [];
  for (const message of asArray(get(kwargs, "messages"))) {
    const role = get(message, "role");
    if (role !== "user" && role !== "assistant") {
      raise("anthropic", "*", "unknown_message_role");
    }
    messages.push({ role, content: parseAnthropicBlocks(get(message, "content")) });
  }

  validateToolExchange(messages, "anthropic");

  const canonical: CanonicalRequest = {
    messages,
    maxTokens: maxTokens as number,
    stream: get(kwargs, "stream") === true,
    parallelToolCalls: get(kwargs, "parallel_tool_calls") !== false,
  };

  const system = get(kwargs, "system");
  if (typeof system === "string") canonical.system = system;
  else if (system != null) raise("anthropic", "*", "system_block_list");

  const temperature = parseTemperature(get(kwargs, "temperature"), "anthropic");
  if (temperature !== null) canonical.temperature = temperature;
  const topP = parseTopP(get(kwargs, "top_p"));
  if (topP !== null) canonical.topP = topP;
  const stop = parseStop(get(kwargs, "stop_sequences") ?? get(kwargs, "stop"), "anthropic");
  if (stop !== null) canonical.stop = stop;

  const tools = parseAnthropicTools(get(kwargs, "tools"));
  if (tools !== null) canonical.tools = tools;
  const toolChoice = parseAnthropicToolChoice(get(kwargs, "tool_choice"));
  if (toolChoice !== null) canonical.toolChoice = toolChoice;

  return canonical;
}

function parseAnthropicTools(value: unknown): CanonicalTool[] | null {
  if (value == null) return null;
  const tools: CanonicalTool[] = [];
  for (const tool of asArray(value)) {
    if (get(tool, "cache_control") != null) raise("anthropic", "*", "cache_control");
    const type = get(tool, "type");
    if (type != null && type !== "custom") {
      const t = requireString(type);
      const prefix = ANTHROPIC_PROPRIETARY_PREFIXES.find((p) => t.startsWith(p));
      raise(
        "anthropic",
        "*",
        prefix != null ? `anthropic.${prefix}` : "anthropic.unsupported_tool",
      );
    }
    const canonicalTool: CanonicalTool = {
      name: requireString(get(tool, "name")),
      parameters: requireObject(get(tool, "input_schema") ?? {}),
    };
    const description = get(tool, "description");
    if (typeof description === "string") canonicalTool.description = description;
    tools.push(canonicalTool);
  }
  return tools;
}

function parseAnthropicToolChoice(value: unknown): ToolChoice | null {
  if (value == null) return null;
  const type = get(value, "type");
  if (type === "auto") return { mode: "auto" };
  if (type === "any") return { mode: "required" };
  if (type === "none") return { mode: "none" };
  if (type === "tool") return { mode: "force", name: requireString(get(value, "name")) };
  raise("anthropic", "*", "tool_choice.unknown");
}

export function canonicalToAnthropic(
  canonical: CanonicalRequest,
  model: string,
): Record<string, unknown> {
  const messages: unknown[] = [];
  for (const message of canonical.messages) {
    const blocks = renderAnthropicBlocks(message.content);
    if (blocks.length === 0) continue; // drop empty turns (behavior 25)
    messages.push({ role: message.role, content: blocks });
  }

  const out: Record<string, unknown> = {
    model,
    messages,
    max_tokens: canonical.maxTokens,
    stream: canonical.stream,
  };
  if (canonical.system != null) out["system"] = canonical.system;
  if (canonical.temperature != null) out["temperature"] = canonical.temperature;
  if (canonical.topP != null) out["top_p"] = canonical.topP;
  if (canonical.stop != null) out["stop_sequences"] = canonical.stop;
  if (canonical.tools != null) {
    out["tools"] = canonical.tools.map((t) => ({
      name: t.name,
      description: t.description ?? null,
      input_schema: t.parameters,
    }));
  }

  let toolChoice =
    canonical.toolChoice != null ? renderAnthropicToolChoice(canonical.toolChoice) : undefined;
  if (canonical.parallelToolCalls === false && toolChoice?.["type"] !== "none") {
    toolChoice = { ...(toolChoice ?? { type: "auto" }), disable_parallel_tool_use: true };
  }
  if (toolChoice !== undefined) out["tool_choice"] = toolChoice;

  return out;
}

function renderAnthropicBlocks(parts: ContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      blocks.push({ type: "image", source: renderAnthropicImageSource(part) });
    } else if (part.type === "tool_use") {
      blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
    } else if (part.type === "tool_result") {
      blocks.push({ type: "tool_result", tool_use_id: part.toolUseId, content: part.content });
    }
  }
  return blocks;
}

function renderAnthropicImageSource(part: ContentPart & { type: "image" }): unknown {
  if (part.data != null) {
    return { type: "base64", media_type: part.mediaType ?? "", data: part.data };
  }
  return { type: "url", url: part.url ?? "" };
}

function renderAnthropicToolChoice(choice: ToolChoice): Record<string, unknown> {
  switch (choice.mode) {
    case "auto":
      return { type: "auto" };
    case "required":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "force":
      return { type: "tool", name: choice.name ?? "" };
  }
}

// ---------------------------------------------------------------------------
// Response.
// ---------------------------------------------------------------------------

export function anthropicResponseToCanonical(response: unknown): CanonicalResponse {
  const out: CanonicalResponse = {};
  const texts: string[] = [];
  const toolCalls: CanonicalResponse["toolCalls"] = [];
  for (const block of asArray(get(response, "content"))) {
    const type = get(block, "type");
    if (type === "text") {
      texts.push(requireString(get(block, "text")));
    } else if (type === "tool_use") {
      toolCalls.push({
        id: requireString(get(block, "id")),
        name: requireString(get(block, "name")),
        arguments: requireObject(get(block, "input")),
      });
    }
  }
  if (texts.length > 0) out.text = texts.join("");
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  const stopReason = get(response, "stop_reason");
  out.finishReason = normalizeFinishReason(
    "anthropic",
    stopReason == null ? null : requireString(stopReason),
  );
  const model = get(response, "model");
  if (typeof model === "string") out.model = model;
  return out;
}

export function canonicalToAnthropicResponse(canonical: CanonicalResponse): unknown {
  const content: unknown[] = [];
  if (canonical.text != null) content.push({ type: "text", text: canonical.text });
  for (const tc of canonical.toolCalls ?? []) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
  }
  return {
    role: "assistant",
    content,
    stop_reason: denormalizeFinishReason("anthropic", canonical.finishReason ?? null),
    model: canonical.model ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stream.
// ---------------------------------------------------------------------------

export function anthropicChunkToDeltas(
  served: string,
  requested: string,
  chunk: unknown,
): StreamDelta[] {
  const type = get(chunk, "type");
  if (type === "message_start" || type === "content_block_stop" || type === "message_stop") {
    return [];
  }
  if (type === "content_block_start") {
    const blockType = get(get(chunk, "content_block"), "type");
    if (blockType == null || blockType === "text") return [];
    raise(served, requested, "cross_provider_tool_stream");
  }
  if (type === "content_block_delta") {
    const delta = get(chunk, "delta");
    const deltaType = get(delta, "type");
    if (deltaType === "text_delta") return [{ text: requireString(get(delta, "text")) }];
    if (deltaType === "input_json_delta") {
      raise(served, requested, "cross_provider_tool_stream");
    }
    return [];
  }
  if (type === "message_delta") {
    const stopReason = get(get(chunk, "delta"), "stop_reason");
    if (stopReason == null) return [];
    const canonical = normalizeFinishReason("anthropic", requireString(stopReason));
    return canonical !== null ? [{ finishReason: canonical }] : [];
  }
  return [];
}

export function deltaToAnthropicChunk(delta: StreamDelta): unknown {
  if (delta.text !== undefined) {
    return {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta.text },
    };
  }
  return {
    type: "message_delta",
    delta: { stop_reason: denormalizeFinishReason("anthropic", delta.finishReason ?? null) },
  };
}
