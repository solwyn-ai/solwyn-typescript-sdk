/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * Shared content-block classification (multimodal discriminator → constant label) and
 * the tool-exchange integrity checks (parallel-same-name, orphan, dangling) that run
 * over parsed canonical messages. Pure; no I/O capability of any kind (no network
 * client, no diagnostic sink). Only constant structural labels are ever raised — a
 * caller-supplied discriminator string is NEVER interpolated into a label.
 */

import { raise } from "./guardrails";
import type { CanonicalMessage } from "./models";

/**
 * Map a non-text/non-image content-block discriminator to its fixed `multimodal.*`
 * label, or the constant `content_part.unknown` for anything outside the known map.
 * The caller-controlled `type` string is NEVER echoed into the returned label.
 */
export function multimodalLabelForType(type: string): string {
  switch (type) {
    case "document":
    case "file":
    case "input_file":
      return "multimodal.document";
    case "audio":
    case "input_audio":
      return "multimodal.audio";
    case "video":
      return "multimodal.video";
    default:
      return "content_part.unknown";
  }
}

/** Classify a Google `inlineData` MIME string by its top-level category. */
export function multimodalLabelForMime(mime: string): string {
  const top = mime.split("/")[0] ?? "";
  switch (top) {
    case "audio":
      return "multimodal.audio";
    case "video":
      return "multimodal.video";
    case "application":
    case "text":
      return "multimodal.document";
    default:
      return "multimodal.unknown";
  }
}

/**
 * Enforce tool-exchange integrity across a whole parsed request, mid-parse-safe:
 *  - two+ tool calls sharing a name in ONE turn → `parallel_same_name_tool_calls`;
 *  - a tool result whose id has no pending PRIOR tool call → `orphan_tool_result`;
 *  - a tool call with no LATER matching tool result → `dangling_tool_call`.
 */
export function validateToolExchange(messages: CanonicalMessage[], source: string): void {
  const pending = new Set<string>();

  for (const message of messages) {
    const namesThisTurn: string[] = [];
    for (const part of message.content) {
      if (part.type === "tool_use") {
        namesThisTurn.push(part.name);
        pending.add(part.id);
      } else if (part.type === "tool_result") {
        if (!pending.delete(part.toolUseId)) {
          raise(source, "*", "orphan_tool_result");
        }
      }
    }
    const dupes = namesThisTurn.length !== new Set(namesThisTurn).size;
    if (namesThisTurn.length > 1 && dupes) {
      raise(source, "*", "parallel_same_name_tool_calls");
    }
  }

  if (pending.size > 0) raise(source, "*", "dangling_tool_call");
}
