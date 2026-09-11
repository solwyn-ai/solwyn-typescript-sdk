/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * The four public dispatchers (`toCanonical`, `fromCanonical`, `normalizeResponse`,
 * `translateStreamChunk`) plus the finish-reason lookup and the pre-dispatch
 * tool-stream guard. Every entry point wraps its dialect logic in `guard` so a
 * malformed content value converts to a value-free structural error. Pure; no I/O
 * capability of any kind (no network client, no diagnostic sink).
 */

import {
  anthropicChunkToDeltas,
  anthropicResponseToCanonical,
  anthropicToCanonical,
  canonicalToAnthropic,
  canonicalToAnthropicResponse,
  deltaToAnthropicChunk,
} from "./anthropic";
import {
  bedrockChunkToDeltas,
  bedrockResponseToCanonical,
  bedrockToCanonical,
  canonicalToBedrock,
  canonicalToBedrockResponse,
  deltaToBedrockChunk,
} from "./bedrock";
import { normalizeFinishReason } from "./common";
import {
  canonicalToGoogle,
  canonicalToGoogleResponse,
  deltaToGoogleChunk,
  googleChunkToDeltas,
  googleResponseToCanonical,
  googleToCanonical,
} from "./google";
import { guard, type ProviderName, raise, validateProvider } from "./guardrails";
import type { CanonicalRequest, CanonicalResponse, StreamDelta } from "./models";
import {
  canonicalToOpenAI,
  canonicalToOpenAIResponse,
  deltaToOpenAIChunk,
  openaiChunkToDeltas,
  openaiResponseToCanonical,
  openaiToCanonical,
} from "./openai";

export { normalizeFinishReason };

/** Options threaded into `fromCanonical`. */
export interface FromCanonicalOptions {
  /**
   * Constructor that builds a native Converse command from the rendered request dict.
   * REQUIRED when `provider === "bedrock"`: without an AWS import the translation
   * package cannot construct a Converse command, so a cross-dialect hop INTO bedrock
   * with no reachable command constructor fails loudly (D14). Ignored for other
   * providers.
   */
  bedrockCommandConstructor?: (input: Record<string, unknown>) => unknown;
}

export function toCanonical(provider: string, kwargs: Record<string, unknown>): CanonicalRequest {
  validateProvider(provider);
  return guard(provider, "*", "malformed_request", () => {
    switch (provider as ProviderName) {
      case "openai":
        return openaiToCanonical(kwargs);
      case "anthropic":
        return anthropicToCanonical(kwargs);
      case "google":
        return googleToCanonical(kwargs);
      case "bedrock":
        return bedrockToCanonical(kwargs);
    }
  });
}

export function fromCanonical(
  provider: string,
  canonical: CanonicalRequest,
  model: string,
  options: FromCanonicalOptions = {},
): unknown {
  validateProvider(provider);
  return guard("*", provider, "malformed_request", () => {
    switch (provider as ProviderName) {
      case "openai":
        return canonicalToOpenAI(canonical, model);
      case "anthropic":
        return canonicalToAnthropic(canonical, model);
      case "google":
        return canonicalToGoogle(canonical, model);
      case "bedrock": {
        const dict = canonicalToBedrock(canonical, model);
        if (options.bedrockCommandConstructor === undefined) {
          // D14: no reachable Converse command constructor on a cross-dialect hop.
          raise("*", "bedrock", "bedrock.no_converse_command");
        }
        return options.bedrockCommandConstructor(dict);
      }
    }
  });
}

function responseToCanonical(served: ProviderName, response: unknown): CanonicalResponse {
  switch (served) {
    case "openai":
      return openaiResponseToCanonical(response);
    case "anthropic":
      return anthropicResponseToCanonical(response);
    case "google":
      return googleResponseToCanonical(response);
    case "bedrock":
      return bedrockResponseToCanonical(response);
  }
}

function canonicalToResponse(requested: ProviderName, canonical: CanonicalResponse): unknown {
  switch (requested) {
    case "openai":
      return canonicalToOpenAIResponse(canonical);
    case "anthropic":
      return canonicalToAnthropicResponse(canonical);
    case "google":
      return canonicalToGoogleResponse(canonical);
    case "bedrock":
      return canonicalToBedrockResponse(canonical);
  }
}

export function normalizeResponse(args: {
  served: string;
  requested: string;
  response: unknown;
}): unknown {
  const { served, requested, response } = args;
  validateProvider(served);
  validateProvider(requested);
  if (served === requested) return response; // identity — exact same reference
  return guard(served, requested, "malformed_request", () => {
    const canonical = responseToCanonical(served as ProviderName, response);
    return canonicalToResponse(requested as ProviderName, canonical);
  });
}

function chunkToDeltas(
  served: ProviderName,
  requested: ProviderName,
  chunk: unknown,
): StreamDelta[] {
  switch (served) {
    case "openai":
      return openaiChunkToDeltas(served, requested, chunk);
    case "anthropic":
      return anthropicChunkToDeltas(served, requested, chunk);
    case "google":
      return googleChunkToDeltas(served, requested, chunk);
    case "bedrock":
      return bedrockChunkToDeltas(served, requested, chunk);
  }
}

function deltaToChunk(requested: ProviderName, delta: StreamDelta): unknown {
  switch (requested) {
    case "openai":
      return deltaToOpenAIChunk(delta);
    case "anthropic":
      return deltaToAnthropicChunk(delta);
    case "google":
      return deltaToGoogleChunk(delta);
    case "bedrock":
      return deltaToBedrockChunk(delta);
  }
}

export function translateStreamChunk(args: {
  served: string;
  requested: string;
  chunk: unknown;
}): unknown[] {
  const { served, requested, chunk } = args;
  validateProvider(served);
  validateProvider(requested);
  return guard(served, requested, "malformed_request", () => {
    const deltas = chunkToDeltas(served as ProviderName, requested as ProviderName, chunk);
    return deltas.map((delta) => deltaToChunk(requested as ProviderName, delta));
  });
}

/**
 * Pre-dispatch guard: abort a cross-provider streaming hop that is KNOWN to carry tool
 * declarations before any foreign stream is opened. Always throws.
 */
export function failCrossProviderToolStream(args: { source: string; target: string }): never {
  raise(args.source, args.target, "cross_provider_tool_stream");
}
