/**
 * PRIVACY-CRITICAL — translation package (content-privileged) public surface.
 *
 * Re-exports exactly the cross-dialect translation entry points and the canonical
 * model types/schemas. This whole package is one of the three content-privileged
 * locations in the SDK; it holds no I/O capability of any kind (no network client, no
 * diagnostic sink) and only ever emits structural labels or translated payloads.
 */

export {
  type FromCanonicalOptions,
  failCrossProviderToolStream,
  fromCanonical,
  normalizeFinishReason,
  normalizeResponse,
  toCanonical,
  translateStreamChunk,
} from "./api";
export { PROVIDERS, type ProviderName } from "./guardrails";
export {
  type CanonicalFinishReason,
  type CanonicalMessage,
  CanonicalMessageSchema,
  type CanonicalRequest,
  CanonicalRequestSchema,
  type CanonicalResponse,
  CanonicalResponseSchema,
  type CanonicalTool,
  CanonicalToolSchema,
  type ContentPart,
  ContentPartSchema,
  type ToolChoice,
  ToolChoiceSchema,
} from "./models";
