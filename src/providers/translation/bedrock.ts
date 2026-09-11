/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * Bedrock (Converse) dialect: request parse/render, response reshape, and per-chunk
 * stream translation. Content blocks are single-key unions (no `type` discriminator),
 * images are raw bytes on the wire. Pure; no I/O capability of any kind (no network
 * client, no diagnostic sink). Structural labels only ever escape on error.
 */

import {
  asArray,
  base64ToBytes,
  bytesToBase64,
  coerceToText,
  denormalizeFinishReason,
  get,
  normalizeFinishReason,
  parseStop,
  parseTemperature,
  parseTopP,
  requireObject,
  requireString,
} from "./common";
import { multimodalLabelForType, validateToolExchange } from "./content";
import {
  checkForbiddenCounts,
  RECOGNIZED_BEDROCK_INFERENCE_CONFIG,
  RECOGNIZED_BEDROCK_TOP_LEVEL,
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

function coerceBedrockToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      const text = get(block, "text");
      if (typeof text === "string") out += text;
      else if (get(block, "json") !== undefined) out += JSON.stringify(get(block, "json"));
    }
    return out;
  }
  return coerceToText(content);
}

function parseBedrockImage(image: unknown): ContentPart {
  const source = get(image, "source");
  if (get(source, "s3Location") != null) raise("bedrock", "*", "image.opaque_handle");
  const format = requireString(get(image, "format"));
  const bytes = get(source, "bytes");
  const data =
    bytes instanceof Uint8Array ? bytesToBase64(bytes) : bytesToBase64(requireString(bytes));
  return { type: "image", mediaType: `image/${format}`, data };
}

function parseBedrockBlocks(content: unknown, source: string): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of asArray(content)) {
    if (get(block, "cachePoint") != null) raise(source, "*", "cache_control");
    if (get(block, "guardContent") != null) raise(source, "*", "bedrock.guard_content");
    if (get(block, "reasoningContent") != null) raise(source, "*", "reasoning");
    if (get(block, "text") !== undefined) {
      parts.push({ type: "text", text: requireString(get(block, "text")) });
    } else if (get(block, "image") != null) {
      parts.push(parseBedrockImage(get(block, "image")));
    } else if (get(block, "toolUse") != null) {
      const use = get(block, "toolUse");
      parts.push({
        type: "tool_use",
        id: requireString(get(use, "toolUseId")),
        name: requireString(get(use, "name")),
        input: requireObject(get(use, "input")),
      });
    } else if (get(block, "toolResult") != null) {
      const result = get(block, "toolResult");
      parts.push({
        type: "tool_result",
        toolUseId: requireString(get(result, "toolUseId")),
        content: coerceBedrockToolResult(get(result, "content")),
      });
    } else {
      const key = Object.keys(block as Record<string, unknown>)[0] ?? "";
      raise(source, "*", multimodalLabelForType(key));
    }
  }
  return parts;
}

function parseBedrockSystem(system: unknown): string | null {
  if (system == null) return null;
  const texts: string[] = [];
  for (const block of asArray(system)) {
    if (get(block, "cachePoint") != null) raise("bedrock", "*", "cache_control");
    if (get(block, "guardContent") != null) raise("bedrock", "*", "bedrock.guard_content");
    if (get(block, "reasoningContent") != null) raise("bedrock", "*", "reasoning");
    if (get(block, "text") !== undefined) {
      const text = get(block, "text");
      texts.push(typeof text === "string" ? text : "");
    } else {
      // Any non-text system block (image, etc.) has no cross-provider equivalent —
      // RAISE its structural content label per Python `_bedrock_system` (never skip).
      const key = Object.keys(block as Record<string, unknown>)[0] ?? "";
      raise("bedrock", "*", multimodalLabelForType(key));
    }
  }
  // Bedrock joins system text blocks with a single "\n" (Python `_bedrock_system`).
  return texts.length > 0 ? texts.join("\n") : null;
}

export function bedrockToCanonical(kwargs: Record<string, unknown>): CanonicalRequest {
  checkForbiddenCounts(kwargs, "bedrock");
  if (get(kwargs, "guardrailConfig") != null) {
    raise("bedrock", "*", "bedrock.guardrail_config");
  }
  scanScope(kwargs, RECOGNIZED_BEDROCK_TOP_LEVEL, "bedrock");

  const inference = get(kwargs, "inferenceConfig");
  const inf = inference != null ? requireObject(inference) : {};
  if (inference != null) scanScope(inf, RECOGNIZED_BEDROCK_INFERENCE_CONFIG, "bedrock");

  const maxTokens = inf["maxTokens"];
  if (maxTokens == null) raise("bedrock", "*", "missing_max_tokens");

  const messages: CanonicalMessage[] = [];
  for (const message of asArray(get(kwargs, "messages"))) {
    const role = get(message, "role");
    if (role !== "user" && role !== "assistant") {
      raise("bedrock", "*", "unknown_message_role");
    }
    messages.push({ role, content: parseBedrockBlocks(get(message, "content"), "bedrock") });
  }

  validateToolExchange(messages, "bedrock");

  const canonical: CanonicalRequest = {
    messages,
    maxTokens: maxTokens as number,
    stream: get(kwargs, "stream") === true,
    parallelToolCalls: true,
  };
  const system = parseBedrockSystem(get(kwargs, "system"));
  if (system !== null) canonical.system = system;
  const temperature = parseTemperature(inf["temperature"], "bedrock");
  if (temperature !== null) canonical.temperature = temperature;
  const topP = parseTopP(inf["topP"]);
  if (topP !== null) canonical.topP = topP;
  const stop = parseStop(inf["stopSequences"], "bedrock");
  if (stop !== null) canonical.stop = stop;

  const toolConfig = get(kwargs, "toolConfig");
  const tools = parseBedrockTools(get(toolConfig, "tools"));
  if (tools !== null) canonical.tools = tools;
  const toolChoice = parseBedrockToolChoice(get(toolConfig, "toolChoice"));
  if (toolChoice !== null) canonical.toolChoice = toolChoice;

  return canonical;
}

function parseBedrockTools(value: unknown): CanonicalTool[] | null {
  if (value == null) return null;
  const tools: CanonicalTool[] = [];
  for (const tool of asArray(value)) {
    if (get(tool, "cachePoint") != null) raise("bedrock", "*", "cache_control");
    const spec = get(tool, "toolSpec");
    if (spec == null) raise("bedrock", "*", "bedrock.unsupported_tool");
    const canonicalTool: CanonicalTool = {
      name: requireString(get(spec, "name")),
      parameters: requireObject(get(get(spec, "inputSchema"), "json") ?? {}),
    };
    const description = get(spec, "description");
    if (typeof description === "string") canonicalTool.description = description;
    tools.push(canonicalTool);
  }
  return tools;
}

function parseBedrockToolChoice(value: unknown): ToolChoice | null {
  if (value == null) return null;
  if (get(value, "auto") != null) return { mode: "auto" };
  if (get(value, "any") != null) return { mode: "required" };
  if (get(value, "tool") != null) {
    return { mode: "force", name: requireString(get(get(value, "tool"), "name")) };
  }
  raise("bedrock", "*", "tool_choice.unknown");
}

export function canonicalToBedrock(
  canonical: CanonicalRequest,
  model: string,
): Record<string, unknown> {
  if (canonical.parallelToolCalls === false) raise("*", "bedrock", "parallel_tool_calls");

  const messages: unknown[] = [];
  for (const message of canonical.messages) {
    const blocks = renderBedrockBlocks(message.content);
    if (blocks.length === 0) continue; // drop empty turns (behavior 25)
    messages.push({ role: message.role, content: blocks });
  }

  const inferenceConfig: Record<string, unknown> = { maxTokens: canonical.maxTokens };
  if (canonical.temperature != null) inferenceConfig["temperature"] = canonical.temperature;
  if (canonical.topP != null) inferenceConfig["topP"] = canonical.topP;
  if (canonical.stop != null) inferenceConfig["stopSequences"] = canonical.stop;

  const out: Record<string, unknown> = { model, messages, inferenceConfig };
  if (canonical.system != null) out["system"] = [{ text: canonical.system }];

  if (canonical.tools != null) {
    const toolConfig: Record<string, unknown> = {
      tools: canonical.tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description ?? null,
          inputSchema: { json: t.parameters },
        },
      })),
    };
    if (canonical.toolChoice != null) {
      toolConfig["toolChoice"] = renderBedrockToolChoice(canonical.toolChoice);
    }
    out["toolConfig"] = toolConfig;
  } else if (canonical.toolChoice != null) {
    out["toolConfig"] = { toolChoice: renderBedrockToolChoice(canonical.toolChoice) };
  }

  return out;
}

function renderBedrockBlocks(parts: ContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length > 0) blocks.push({ text: part.text });
    } else if (part.type === "image") {
      blocks.push(renderBedrockImage(part));
    } else if (part.type === "tool_use") {
      blocks.push({ toolUse: { toolUseId: part.id, name: part.name, input: part.input } });
    } else if (part.type === "tool_result") {
      blocks.push({
        toolResult: { toolUseId: part.toolUseId, content: [{ text: part.content }] },
      });
    }
  }
  return blocks;
}

function renderBedrockImage(part: ContentPart & { type: "image" }): unknown {
  if (part.data == null) raise("*", "bedrock", "image.url_unsupported");
  const format = (part.mediaType ?? "").split("/")[1] ?? "";
  return { image: { format, source: { bytes: base64ToBytes(part.data) } } };
}

function renderBedrockToolChoice(choice: ToolChoice): unknown {
  switch (choice.mode) {
    case "auto":
      return { auto: {} };
    case "required":
      return { any: {} };
    case "force":
      return { tool: { name: choice.name ?? "" } };
    case "none":
      raise("*", "bedrock", "tool_choice.none");
  }
}

// ---------------------------------------------------------------------------
// Response.
// ---------------------------------------------------------------------------

export function bedrockResponseToCanonical(response: unknown): CanonicalResponse {
  const message = get(get(get(response, "output"), "message"), "content");
  const out: CanonicalResponse = {};
  const texts: string[] = [];
  const toolCalls: CanonicalResponse["toolCalls"] = [];
  for (const block of asArray(message)) {
    if (get(block, "text") !== undefined) {
      texts.push(requireString(get(block, "text")));
    } else if (get(block, "toolUse") != null) {
      const use = get(block, "toolUse");
      toolCalls.push({
        id: requireString(get(use, "toolUseId")),
        name: requireString(get(use, "name")),
        arguments: requireObject(get(use, "input")),
      });
    }
  }
  if (texts.length > 0) out.text = texts.join("");
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  const stopReason = get(response, "stopReason");
  out.finishReason = normalizeFinishReason(
    "bedrock",
    stopReason == null ? null : requireString(stopReason),
  );
  return out;
}

export function canonicalToBedrockResponse(canonical: CanonicalResponse): unknown {
  const content: unknown[] = [];
  if (canonical.text != null) content.push({ text: canonical.text });
  for (const tc of canonical.toolCalls ?? []) {
    content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.arguments } });
  }
  return {
    output: { message: { role: "assistant", content } },
    stopReason: denormalizeFinishReason("bedrock", canonical.finishReason ?? null),
  };
}

// ---------------------------------------------------------------------------
// Stream.
// ---------------------------------------------------------------------------

export function bedrockChunkToDeltas(
  served: string,
  requested: string,
  chunk: unknown,
): StreamDelta[] {
  if (get(chunk, "messageStart") != null) return [];
  if (get(chunk, "contentBlockStop") != null) return [];
  if (get(chunk, "metadata") != null) return [];
  if (get(chunk, "contentBlockStart") != null) {
    if (get(get(chunk, "contentBlockStart"), "start") != null) {
      raise(served, requested, "cross_provider_tool_stream");
    }
    return [];
  }
  if (get(chunk, "contentBlockDelta") != null) {
    const delta = get(get(chunk, "contentBlockDelta"), "delta");
    if (get(delta, "text") !== undefined) return [{ text: requireString(get(delta, "text")) }];
    if (get(delta, "toolUse") != null) {
      raise(served, requested, "cross_provider_tool_stream");
    }
    raise(served, requested, "cross_provider_multimodal_stream");
  }
  if (get(chunk, "messageStop") != null) {
    const stopReason = get(get(chunk, "messageStop"), "stopReason");
    if (stopReason == null) return [];
    const canonical = normalizeFinishReason("bedrock", requireString(stopReason));
    return canonical !== null ? [{ finishReason: canonical }] : [];
  }
  return [];
}

export function deltaToBedrockChunk(delta: StreamDelta): unknown {
  if (delta.text !== undefined) {
    return { contentBlockDelta: { delta: { text: delta.text }, contentBlockIndex: 0 } };
  }
  return {
    messageStop: { stopReason: denormalizeFinishReason("bedrock", delta.finishReason ?? null) },
  };
}
