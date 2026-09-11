/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * Canonical request/response model schemas (zod 4, strict) for the cross-dialect
 * translation subset. This module is pure and holds no I/O capability of any kind:
 * no network client, no diagnostic sink, no side channel. The only values that ever
 * leave this package are structural labels (on thrown errors) and the translated
 * payloads themselves — prompt/response content never escapes any other way.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Content parts (discriminated on `type`).
// ---------------------------------------------------------------------------

export const TextPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});

export const ImagePartSchema = z.strictObject({
  type: z.literal("image"),
  mediaType: z.string().nullable().optional(),
  data: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});

export const ToolUsePartSchema = z.strictObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const ToolResultPartSchema = z.strictObject({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  content: z.string(),
});

export const ContentPartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ImagePartSchema,
  ToolUsePartSchema,
  ToolResultPartSchema,
]);

export const CanonicalMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.array(ContentPartSchema),
});

export const CanonicalToolSchema = z.strictObject({
  name: z.string(),
  description: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()),
});

export const ToolChoiceSchema = z.strictObject({
  mode: z.enum(["auto", "required", "none", "force"]),
  name: z.string().nullable().optional(),
});

export const CanonicalRequestSchema = z.strictObject({
  system: z.string().nullable().optional(),
  messages: z.array(CanonicalMessageSchema),
  maxTokens: z.number(),
  temperature: z.number().nullable().optional(),
  topP: z.number().nullable().optional(),
  stop: z.array(z.string()).nullable().optional(),
  stream: z.boolean().default(false),
  tools: z.array(CanonicalToolSchema).nullable().optional(),
  toolChoice: ToolChoiceSchema.nullable().optional(),
  parallelToolCalls: z.boolean().default(true),
});

export const CanonicalToolCallSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

export const CanonicalResponseSchema = z.strictObject({
  text: z.string().nullable().optional(),
  toolCalls: z.array(CanonicalToolCallSchema).nullable().optional(),
  finishReason: z.enum(["stop", "length", "tool_use", "content_filter"]).nullable().optional(),
  model: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Inferred TS types.
// ---------------------------------------------------------------------------

export type TextPart = z.infer<typeof TextPartSchema>;
export type ImagePart = z.infer<typeof ImagePartSchema>;
export type ToolUsePart = z.infer<typeof ToolUsePartSchema>;
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;
export type CanonicalMessage = z.infer<typeof CanonicalMessageSchema>;
export type CanonicalTool = z.infer<typeof CanonicalToolSchema>;
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;
export type CanonicalRequest = z.infer<typeof CanonicalRequestSchema>;
export type CanonicalToolCall = z.infer<typeof CanonicalToolCallSchema>;
export type CanonicalResponse = z.infer<typeof CanonicalResponseSchema>;

export type CanonicalFinishReason = "stop" | "length" | "tool_use" | "content_filter";

/**
 * Internal per-delta stream unit — exactly one of `text` / `finishReason` is set.
 * Not part of the public surface.
 */
export interface StreamDelta {
  text?: string;
  finishReason?: CanonicalFinishReason;
}
