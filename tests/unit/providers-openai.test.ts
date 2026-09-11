/**
 * Exercises `OpenAIAdapter` and the shared extraction helpers. Fully offline; no fetch,
 * no `openai`
 * package.
 */

import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors";
import type { Logger } from "../../src/logging";
import {
  OpenAIResponsesStreamAccumulator,
  OpenAIStreamAccumulator,
} from "../../src/providers/accumulator";
import { OpenAIAdapter } from "../../src/providers/openai";
import type { ProviderAdapter } from "../../src/providers/protocol";
import { buildTokenDetails, zeroTokenDetails } from "../../src/token-details";
import { SERVICE_TIER_MAX_LENGTH } from "../../src/types";

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
  };
}

describe("OpenAIAdapter — protocol + identity", () => {
  it("satisfies the ProviderAdapter interface (compile-time) and reports name/dialect", () => {
    const adapter: ProviderAdapter = new OpenAIAdapter();
    expect(adapter.name).toBe("openai");
    expect(adapter.dialect).toBe("openai");
  });
});

describe("OpenAIAdapter.detectModel", () => {
  it.each(["gpt-4o", "gpt-4", "o3-mini", "o4-mini"])("matches %s", (model) => {
    expect(new OpenAIAdapter().detectModel(model)).toBe(true);
  });

  it.each(["claude-3-5-sonnet", "gemini-2.5-flash"])("rejects %s", (model) => {
    expect(new OpenAIAdapter().detectModel(model)).toBe(false);
  });
});

describe("OpenAIAdapter.detectClient", () => {
  it("detects a genuine OpenAI-shaped client (chat.completions.create present)", () => {
    const client = { chat: { completions: { create: () => undefined } } };
    expect(new OpenAIAdapter().detectClient(client)).toBe(true);
  });

  it("detects via a constructor name containing 'openai'", () => {
    class OpenAI {}
    expect(new OpenAIAdapter().detectClient(new OpenAI())).toBe(true);
  });

  it("rejects a non-OpenAI client (anthropic-shaped, messages.create only)", () => {
    const client = { messages: { create: () => undefined } };
    expect(new OpenAIAdapter().detectClient(client)).toBe(false);
  });

  it("rejects non-objects", () => {
    const adapter = new OpenAIAdapter();
    expect(adapter.detectClient(null)).toBe(false);
    expect(adapter.detectClient(undefined)).toBe(false);
    expect(adapter.detectClient("openai")).toBe(false);
  });
});

describe("OpenAIAdapter.extractUsage — Chat Completions shape", () => {
  const adapter = new OpenAIAdapter();

  it("maps prompt_tokens/completion_tokens to input_tokens/output_tokens", () => {
    const usage = adapter.extractUsage({ usage: { prompt_tokens: 12, completion_tokens: 7 } });
    expect(usage.input_tokens).toBe(12);
    expect(usage.output_tokens).toBe(7);
  });

  it("maps prompt_tokens_details.cached_tokens to cached_input_tokens", () => {
    const usage = adapter.extractUsage({
      usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } },
    });
    expect(usage.cached_input_tokens).toBe(400);
  });

  it("maps cache_write_tokens to the existing 5m bucket without changing cache reads", () => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 500,
        prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 25 },
      },
    });
    expect(usage.cached_input_tokens).toBe(400);
    expect(usage.cache_creation_5m_tokens).toBe(25);
    expect(usage.cache_creation_1h_tokens).toBe(0);
  });

  it("falls back to flat cached_tokens when prompt_tokens_details is absent", () => {
    const usage = adapter.extractUsage({
      usage: { prompt_tokens: 500, cached_tokens: 400 },
    });
    expect(usage.cached_input_tokens).toBe(400);
  });

  it.each([
    null,
    undefined,
  ])("does not use flat cached_tokens when prompt_tokens_details is present as %s", (promptDetails) => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 500,
        cached_tokens: 400,
        prompt_tokens_details: promptDetails,
      },
    });
    expect(usage.cached_input_tokens).toBe(0);
  });

  it.each([
    0,
    undefined,
    null,
  ])("prefers nested cached_tokens %s over a flat cached_tokens fallback", (cachedTokens) => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 500,
        cached_tokens: 400,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      },
    });
    expect(usage.cached_input_tokens).toBe(0);
  });

  it.each([
    false,
    "malformed",
    1,
  ])("does not use flat cached_tokens when prompt_tokens_details is present as %j", (promptDetails) => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 500,
        cached_tokens: 400,
        prompt_tokens_details: promptDetails,
      },
    });
    expect(usage.cached_input_tokens).toBe(0);
  });

  it.each([
    true,
    false,
    "400",
    {},
    -1,
    1.5,
  ])("degrades malformed flat cached_tokens %j to zero without affecting other counters", (cachedTokens) => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 500,
        completion_tokens: 25,
        cached_tokens: cachedTokens,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    });
    expect(usage.cached_input_tokens).toBe(0);
    expect(usage.input_tokens).toBe(500);
    expect(usage.output_tokens).toBe(25);
    expect(usage.reasoning_tokens).toBe(10);
  });

  it("maps prompt_tokens_details.audio_tokens to audio_input_tokens", () => {
    const usage = adapter.extractUsage({
      usage: { prompt_tokens: 500, prompt_tokens_details: { audio_tokens: 50 } },
    });
    expect(usage.audio_input_tokens).toBe(50);
  });

  it("maps completion_tokens_details.reasoning_tokens to reasoning_tokens", () => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 5,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 100 },
      },
    });
    expect(usage.reasoning_tokens).toBe(100);
  });

  it("maps completion_tokens_details.audio_tokens to audio_output_tokens", () => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 5,
        completion_tokens: 200,
        completion_tokens_details: { audio_tokens: 80 },
      },
    });
    expect(usage.audio_output_tokens).toBe(80);
  });

  it("maps accepted_prediction_tokens and rejected_prediction_tokens", () => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 5,
        completion_tokens: 200,
        completion_tokens_details: {
          accepted_prediction_tokens: 150,
          rejected_prediction_tokens: 25,
        },
      },
    });
    expect(usage.accepted_prediction_tokens).toBe(150);
    expect(usage.rejected_prediction_tokens).toBe(25);
  });

  it("degrades every detail sub-field to 0 when detail sub-objects are absent", () => {
    const usage = adapter.extractUsage({ usage: { prompt_tokens: 12, completion_tokens: 7 } });
    expect(usage.cached_input_tokens).toBe(0);
    expect(usage.reasoning_tokens).toBe(0);
    expect(usage.audio_input_tokens).toBe(0);
    expect(usage.audio_output_tokens).toBe(0);
    expect(usage.accepted_prediction_tokens).toBe(0);
    expect(usage.rejected_prediction_tokens).toBe(0);
  });

  it("degrades every detail sub-field to 0 when detail sub-objects are null", () => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_tokens_details: null,
        completion_tokens_details: null,
      },
    });
    expect(usage.input_tokens).toBe(12);
    expect(usage.output_tokens).toBe(7);
    expect(usage.cached_input_tokens).toBe(0);
    expect(usage.reasoning_tokens).toBe(0);
  });

  it("leaves cache-creation split tokens at zero when cache-write usage is absent", () => {
    const usage = adapter.extractUsage({
      usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } },
    });
    expect(usage.cache_creation_5m_tokens).toBe(0);
    expect(usage.cache_creation_1h_tokens).toBe(0);
  });

  it.each([
    null,
    -1,
    true,
    "25",
    25.5,
    {},
  ])("degrades unusable cache_write_tokens %j to zero without throwing", (cacheWriteTokens) => {
    const extract = () =>
      adapter.extractUsage({
        usage: {
          prompt_tokens: 500,
          prompt_tokens_details: { cache_write_tokens: cacheWriteTokens },
        },
      });
    expect(extract).not.toThrow();
    expect(extract().cache_creation_5m_tokens).toBe(0);
  });

  it("never populates tool_use_input_tokens", () => {
    const usage = adapter.extractUsage({ usage: { prompt_tokens: 500, completion_tokens: 10 } });
    expect(usage.tool_use_input_tokens).toBe(0);
  });

  it("returns a genuine TokenDetails shape (deep-equal to a defaulted instance for zeros)", () => {
    const usage = adapter.extractUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(usage).toEqual(zeroTokenDetails());
  });

  it("selects the Chat Completions branch even when prompt_tokens === 0 (presence, not truthiness)", () => {
    const usage = adapter.extractUsage({ usage: { prompt_tokens: 0, completion_tokens: 42 } });
    expect(usage.output_tokens).toBe(42);
  });
});

describe("OpenAIAdapter.extractUsage — Responses API shape", () => {
  const adapter = new OpenAIAdapter();

  it("maps input_tokens/output_tokens straight through", () => {
    const usage = adapter.extractUsage({ usage: { input_tokens: 30, output_tokens: 9 } });
    expect(usage.input_tokens).toBe(30);
    expect(usage.output_tokens).toBe(9);
  });

  it("maps input_tokens_details.cached_tokens to cached_input_tokens", () => {
    const usage = adapter.extractUsage({
      usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 20 } },
    });
    expect(usage.cached_input_tokens).toBe(20);
  });

  it("maps Responses cache_write_tokens to the existing 5m bucket", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 250,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 200 },
      },
    });
    expect(usage.cached_input_tokens).toBe(20);
    expect(usage.cache_creation_5m_tokens).toBe(200);
    expect(usage.cache_creation_1h_tokens).toBe(0);
  });

  it("leaves Responses cache-creation tokens at zero when cache-write usage is absent", () => {
    const usage = adapter.extractUsage({
      usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 20 } },
    });
    expect(usage.cache_creation_5m_tokens).toBe(0);
    expect(usage.cache_creation_1h_tokens).toBe(0);
  });

  it("maps output_tokens_details.reasoning_tokens to reasoning_tokens", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 5,
        output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 15 },
      },
    });
    expect(usage.reasoning_tokens).toBe(15);
  });

  it("extracts all 8 sub-fields in one combined case (full parity with Chat Completions)", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 40, audio_tokens: 5 },
        output_tokens_details: {
          reasoning_tokens: 60,
          audio_tokens: 7,
          accepted_prediction_tokens: 11,
          rejected_prediction_tokens: 3,
        },
      },
    });
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(200);
    expect(usage.cached_input_tokens).toBe(40);
    expect(usage.audio_input_tokens).toBe(5);
    expect(usage.reasoning_tokens).toBe(60);
    expect(usage.audio_output_tokens).toBe(7);
    expect(usage.accepted_prediction_tokens).toBe(11);
    expect(usage.rejected_prediction_tokens).toBe(3);
  });
});

describe("OpenAIAdapter.extractUsage — missing/garbage usage", () => {
  const adapter = new OpenAIAdapter();

  it("usage === null returns a fresh all-zero TokenDetails", () => {
    expect(adapter.extractUsage({ usage: null })).toEqual(
      buildTokenDetails({ is_estimated: true }),
    );
  });

  it("no usage property at all returns all-zero", () => {
    expect(adapter.extractUsage({})).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("a non-object response returns all-zero (never throws)", () => {
    expect(adapter.extractUsage(null)).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(adapter.extractUsage("nonsense")).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(adapter.extractUsage(undefined)).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("a usage object with neither prompt_tokens nor input_tokens returns all-zero", () => {
    expect(adapter.extractUsage({ usage: { total_tokens: 99 } })).toEqual(
      buildTokenDetails({ is_estimated: true }),
    );
  });

  it("negative Chat Completions totals degrade the whole record to defaults", () => {
    expect(adapter.extractUsage({ usage: { prompt_tokens: -1, completion_tokens: -5 } })).toEqual(
      buildTokenDetails({ is_estimated: true }),
    );
  });

  it("negative Responses API totals degrade the whole record to defaults", () => {
    expect(adapter.extractUsage({ usage: { input_tokens: -1, output_tokens: -5 } })).toEqual(
      buildTokenDetails({ is_estimated: true }),
    );
  });

  it("string and boolean values both degrade to 0 (guards against value || 0 coercion)", () => {
    const usage = adapter.extractUsage({
      usage: { prompt_tokens: "abc", completion_tokens: true },
    });
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("float values degrade to 0 (only clean integers pass)", () => {
    const usage = adapter.extractUsage({
      usage: { prompt_tokens: 500.5, completion_tokens: 10 },
    });
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(10);
  });

  it("a negative detail field degrades ONLY that field; valid totals survive", () => {
    const usage = adapter.extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: -3 },
      },
    });
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usage.cached_input_tokens).toBe(0);
  });
});

describe("OpenAIAdapter.extractServiceTier", () => {
  const adapter = new OpenAIAdapter();

  it.each(["priority", "flex", "batch", "default"])("returns %s unchanged", (tier) => {
    expect(adapter.extractServiceTier({ service_tier: tier })).toBe(tier);
  });

  it("returns null when service_tier is absent", () => {
    expect(adapter.extractServiceTier({})).toBeNull();
  });

  it("returns null when service_tier is null", () => {
    expect(adapter.extractServiceTier({ service_tier: null })).toBeNull();
  });

  it("returns null when service_tier is a non-string (number)", () => {
    expect(adapter.extractServiceTier({ service_tier: 42 })).toBeNull();
  });

  it("truncates an over-long tier to exactly SERVICE_TIER_MAX_LENGTH and warns via the logger", () => {
    const logger = fakeLogger();
    const localAdapter = new OpenAIAdapter({ logger });
    const overlong = "x".repeat(SERVICE_TIER_MAX_LENGTH + 20);
    const result = localAdapter.extractServiceTier({ service_tier: overlong });
    expect(result).toBe("x".repeat(SERVICE_TIER_MAX_LENGTH));
    expect(result).toHaveLength(SERVICE_TIER_MAX_LENGTH);
    expect(logger.warnings).toHaveLength(1);
  });
});

describe("OpenAIAdapter.estimateMissingUsage / extractRegion", () => {
  const adapter = new OpenAIAdapter();

  it("estimateMissingUsage always returns null (OpenAI always reports usage)", () => {
    expect(adapter.estimateMissingUsage({}, { estimatedInputTokens: 1000 })).toBeNull();
    expect(adapter.estimateMissingUsage({ usage: null }, { estimatedInputTokens: 0 })).toBeNull();
  });

  it("extractRegion always returns null (OpenAI pricing is not regional)", () => {
    expect(adapter.extractRegion({})).toBeNull();
    expect(adapter.extractRegion({ region: "us-east-1" })).toBeNull();
  });
});

describe("OpenAIAdapter.prepareStreaming", () => {
  const adapter = new OpenAIAdapter();

  it("returns a NEW object with stream_options.include_usage = true", () => {
    const kwargs = { model: "gpt-4o" };
    const prepared = adapter.prepareStreaming(kwargs);
    expect(prepared).not.toBe(kwargs);
    expect(prepared["stream_options"]).toEqual({ include_usage: true });
  });

  it("does not mutate the caller's kwargs or its original stream_options", () => {
    const originalStreamOptions = { foo: "bar" };
    const kwargs = { model: "gpt-4o", stream_options: originalStreamOptions };
    const prepared = adapter.prepareStreaming(kwargs);
    // Input untouched.
    expect(kwargs.stream_options).toBe(originalStreamOptions);
    expect(originalStreamOptions).toEqual({ foo: "bar" });
    // Copy has the merged options on a fresh object.
    expect(prepared["stream_options"]).not.toBe(originalStreamOptions);
    expect(prepared["stream_options"]).toEqual({ foo: "bar", include_usage: true });
  });

  it("returns an object even for empty kwargs (never undefined)", () => {
    const prepared = adapter.prepareStreaming({});
    expect(prepared).toBeTypeOf("object");
    expect(prepared["stream_options"]).toEqual({ include_usage: true });
  });

  it("ignores the crossProvider flag (always injects include_usage)", () => {
    const prepared = adapter.prepareStreaming({ model: "gpt-4o" }, { crossProvider: true });
    expect(prepared["stream_options"]).toEqual({ include_usage: true });
  });
});

describe("OpenAIAdapter.prepareCall — chat surface", () => {
  const adapter = new OpenAIAdapter();

  function makeClient() {
    const create = vi.fn((..._args: unknown[]) => "dispatched");
    return { client: { chat: { completions: { create } } }, create };
  }

  const chatOptions = {
    surface: "chat" as const,
    isStreaming: false,
    crossProvider: false,
    timeout: 30,
    maxRetries: 2,
  };

  it("dispatches through chat.completions.create bound to its receiver", () => {
    const { client, create } = makeClient();
    const dispatch = adapter.prepareCall(client, { model: "gpt-4o" }, chatOptions);
    const result = dispatch();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.instances[0]).toBe(client.chat.completions);
    expect(result).toBe("dispatched");
  });

  it("invokes create with a kwargs copy value-equal to the input but not the same reference", () => {
    const { client, create } = makeClient();
    const kwargs = { model: "gpt-4o", temperature: 0.5 };
    adapter.prepareCall(client, kwargs, chatOptions)();
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed).not.toBe(kwargs);
    expect(passed).toEqual(kwargs);
    expect(passed["stream"]).toBeUndefined();
  });

  it("copies and overrides request options while preserving caller state and later arguments", () => {
    const { client, create } = makeClient();
    const requestOptions = { signal: "abort-signal", timeout: 7, maxRetries: 9 };
    const tail = { tail: true };
    adapter.prepareCall(client, { model: "gpt-4o" }, chatOptions)(requestOptions, tail);
    expect(create.mock.calls[0]?.[1]).not.toBe(requestOptions);
    expect(create.mock.calls[0]?.[1]).toEqual({
      signal: "abort-signal",
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(create.mock.calls[0]?.[2]).toBe(tail);
    expect(requestOptions).toEqual({ signal: "abort-signal", timeout: 7, maxRetries: 9 });
  });

  it("saturates an oversized provider timeout at the portable timer maximum", () => {
    const { client, create } = makeClient();
    adapter.prepareCall(
      client,
      { model: "gpt-4o" },
      {
        ...chatOptions,
        timeout: Number.MAX_VALUE,
      },
    )();

    expect(create.mock.calls[0]?.[1]).toEqual({
      timeout: 2_147_483_647,
      maxRetries: 0,
    });
  });

  it.each([
    null,
    [],
    1,
    "options",
    () => undefined,
  ])("rejects an invalid request-options slot (%s) before provider dispatch", (invalid) => {
    const { client, create } = makeClient();
    const dispatch = adapter.prepareCall(client, { model: "gpt-4o" }, chatOptions);
    expect(() => dispatch(invalid)).toThrow(ConfigurationError);
    expect(create).not.toHaveBeenCalled();
  });

  it("wraps request-options enumeration failures as ConfigurationError before dispatch", () => {
    const { client, create } = makeClient();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile options");
        },
      },
    );
    const dispatch = adapter.prepareCall(client, { model: "gpt-4o" }, chatOptions);
    expect(() => dispatch(hostile)).toThrow(ConfigurationError);
    expect(create).not.toHaveBeenCalled();
  });

  it("wraps revoked request-options proxies as ConfigurationError before dispatch", () => {
    const { client, create } = makeClient();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const dispatch = adapter.prepareCall(client, { model: "gpt-4o" }, chatOptions);

    expect(() => dispatch(revoked.proxy)).toThrow(ConfigurationError);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps hostile enumeration total when a trap throws an unreadable value", () => {
    const { client, create } = makeClient();
    const unreadable = Proxy.revocable({}, {});
    unreadable.revoke();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw unreadable.proxy;
        },
      },
    );
    const dispatch = adapter.prepareCall(client, { model: "gpt-4o" }, chatOptions);

    expect(() => dispatch(hostile)).toThrow(ConfigurationError);
    expect(create).not.toHaveBeenCalled();
  });

  it("injects stream_options.include_usage and stream:true when streaming, without mutating input", () => {
    const { client, create } = makeClient();
    const kwargs: Record<string, unknown> = { model: "gpt-4o" };
    adapter.prepareCall(client, kwargs, { ...chatOptions, isStreaming: true })();
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed["stream"]).toBe(true);
    expect(passed["stream_options"]).toEqual({ include_usage: true });
    expect(kwargs["stream"]).toBeUndefined();
    expect(kwargs["stream_options"]).toBeUndefined();
  });

  it("throws ConfigurationError when chat.completions.create is absent", () => {
    const dispatch = () =>
      adapter.prepareCall({ chat: { completions: {} } }, { model: "gpt-4o" }, chatOptions);
    expect(dispatch).toThrow(ConfigurationError);
  });
});

describe("OpenAIAdapter.prepareCall — responses surface", () => {
  const adapter = new OpenAIAdapter();

  const responsesOptions = {
    surface: "responses" as const,
    isStreaming: false,
    crossProvider: false,
    timeout: 0,
    maxRetries: 0,
  };

  function makeClient() {
    const create = vi.fn((..._args: unknown[]) => "responses-dispatched");
    return { client: { responses: { create } }, create };
  }

  it("dispatches through responses.create bound to its receiver", () => {
    const { client, create } = makeClient();
    const result = adapter.prepareCall(
      client,
      { model: "gpt-4o", input: "hi" },
      responsesOptions,
    )();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.instances[0]).toBe(client.responses);
    expect(result).toBe("responses-dispatched");
  });

  it("dispatches responses.parse through the parse leaf with a defensive copy and receiver", () => {
    const parse = vi.fn((..._args: unknown[]) => "parsed");
    const responses = { create: vi.fn(), parse };
    const kwargs = { model: "gpt-4o", input: "hi" };
    const result = adapter.prepareCall({ responses }, kwargs, {
      ...responsesOptions,
      responsesLeaf: "parse",
    })({ headers: { x: "1" } });

    expect(result).toBe("parsed");
    expect(parse.mock.instances[0]).toBe(responses);
    expect(parse.mock.calls[0]?.[0]).toEqual(kwargs);
    expect(parse.mock.calls[0]?.[0]).not.toBe(kwargs);
    expect(parse.mock.calls[0]?.[1]).toEqual({
      headers: { x: "1" },
      timeout: 1,
      maxRetries: 0,
    });
    expect(responses.create).not.toHaveBeenCalled();
  });

  it("applies the same timeout carrier to OpenAI media dispatch", () => {
    const create = vi.fn((..._args: unknown[]) => "embedded");
    const client = { embeddings: { create } };
    const kwargs = { model: "text-embedding-3-small", input: "opaque" };
    const prepared = adapter.prepareMediaCall("embeddings", client, kwargs, {
      timeout: 42,
      maxRetries: 0,
    });
    const requestOptions = { signal: "abort", timeout: 3, maxRetries: 4 };
    const tail = Symbol("tail");
    const result = prepared.method(prepared.kwargs, requestOptions, tail);

    expect(result).toBe("embedded");
    expect(create.mock.calls[0]?.[0]).toEqual(kwargs);
    expect(create.mock.calls[0]?.[1]).toEqual({
      signal: "abort",
      timeout: 42_000,
      maxRetries: 0,
    });
    expect(create.mock.calls[0]?.[2]).toBe(tail);
    expect(requestOptions).toEqual({ signal: "abort", timeout: 3, maxRetries: 4 });
  });

  it("fails loud on an unsupported internal Responses leaf before client attribute access", () => {
    let responsesAccesses = 0;
    const client = Object.defineProperty({}, "responses", {
      get() {
        responsesAccesses += 1;
        throw new Error("must not touch client");
      },
    });

    const call = () =>
      adapter.prepareCall(
        client,
        { model: "gpt-4o" },
        {
          ...responsesOptions,
          responsesLeaf: "retrieve" as "create",
        },
      );

    expect(call).toThrow(ConfigurationError);
    expect(call).toThrow(/unsupported OpenAI Responses leaf: retrieve/);
    expect(responsesAccesses).toBe(0);
  });

  it("sets stream:true (and never stream_options) when streaming, without mutating input", () => {
    const { client, create } = makeClient();
    const kwargs: Record<string, unknown> = { model: "gpt-4o", input: "hi" };
    adapter.prepareCall(client, kwargs, { ...responsesOptions, isStreaming: true })();
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed["stream"]).toBe(true);
    // The Responses API settles usage from the terminal event, NOT stream_options.
    expect(passed["stream_options"]).toBeUndefined();
    expect(kwargs["stream"]).toBeUndefined();
  });

  it("throws ConfigurationError when responses.create is absent", () => {
    const dispatch = () => adapter.prepareCall({}, { model: "gpt-4o" }, responsesOptions);
    expect(dispatch).toThrow(ConfigurationError);
  });
});

describe("OpenAIAdapter stream-shape seams", () => {
  const adapter = new OpenAIAdapter();

  it("unwrapStreamSource is strict identity", () => {
    const source = { some: "stream" };
    expect(adapter.unwrapStreamSource(source)).toBe(source);
  });

  it("wrapStreamResult is strict identity (returns the wrapper reference)", () => {
    const wrapper = { wrapped: true };
    const served = { served: true };
    expect(adapter.wrapStreamResult(wrapper, served)).toBe(wrapper);
  });
});

describe("OpenAIAdapter.createStreamAccumulator", () => {
  const adapter = new OpenAIAdapter();

  it("returns a fresh StreamUsageAccumulator; empty finalize is all-zero, tier null", () => {
    const acc = adapter.createStreamAccumulator();
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(acc.getServiceTier()).toBeNull();
  });

  it("returns a distinct instance each call", () => {
    expect(adapter.createStreamAccumulator()).not.toBe(adapter.createStreamAccumulator());
  });

  it("returns a Chat-Completions accumulator for the chat surface (default)", () => {
    expect(adapter.createStreamAccumulator({ surface: "chat" })).toBeInstanceOf(
      OpenAIStreamAccumulator,
    );
    // Absent surface defaults to chat.
    expect(adapter.createStreamAccumulator()).toBeInstanceOf(OpenAIStreamAccumulator);
  });

  it("returns a Responses-API accumulator for the responses surface", () => {
    expect(adapter.createStreamAccumulator({ surface: "responses" })).toBeInstanceOf(
      OpenAIResponsesStreamAccumulator,
    );
  });
});

describe("OpenAIStreamAccumulator", () => {
  it("finalize is all-zero and getServiceTier is null before any chunk", () => {
    const acc = new OpenAIStreamAccumulator();
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(acc.getServiceTier()).toBeNull();
  });

  it("finalize returns all-zero when only usage-less chunks are observed", () => {
    const acc = new OpenAIStreamAccumulator();
    acc.observe({ choices: [{ index: 0 }] });
    acc.observe({ id: "chunk-2" });
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("settles usage from the terminal usage-bearing chunk", () => {
    const acc = new OpenAIStreamAccumulator();
    acc.observe({ id: "c1" });
    acc.observe({ id: "c2", usage: { prompt_tokens: 11, completion_tokens: 22 } });
    const details = acc.finalize();
    expect(details.input_tokens).toBe(11);
    expect(details.output_tokens).toBe(22);
  });

  it("last usage-bearing chunk wins; a later usage-less chunk does not clear it", () => {
    const acc = new OpenAIStreamAccumulator();
    acc.observe({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    acc.observe({ usage: { prompt_tokens: 100, completion_tokens: 200 } });
    acc.observe({ id: "trailing-no-usage" });
    const details = acc.finalize();
    expect(details.input_tokens).toBe(100);
    expect(details.output_tokens).toBe(200);
  });

  it("extracts cache-read, cache-write, and reasoning tokens from the terminal chunk", () => {
    const acc = new OpenAIStreamAccumulator();
    acc.observe({
      usage: {
        prompt_tokens: 500,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 120 },
      },
    });
    const details = acc.finalize();
    expect(details.cached_input_tokens).toBe(400);
    expect(details.cache_creation_5m_tokens).toBe(30);
    expect(details.reasoning_tokens).toBe(120);
  });

  it("getServiceTier reads the tier from the stored terminal chunk", () => {
    const acc = new OpenAIStreamAccumulator();
    acc.observe({ usage: { prompt_tokens: 1, completion_tokens: 1 }, service_tier: "priority" });
    expect(acc.getServiceTier()).toBe("priority");
  });

  it("skips a chunk whose usage is explicitly null", () => {
    const acc = new OpenAIStreamAccumulator();
    acc.observe({ usage: null });
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
  });
});

describe("OpenAIResponsesStreamAccumulator", () => {
  it("finalize is all-zero and getServiceTier is null before any event", () => {
    const acc = new OpenAIResponsesStreamAccumulator();
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(acc.getServiceTier()).toBeNull();
  });

  it("ignores semantic events that carry no response.usage", () => {
    const acc = new OpenAIResponsesStreamAccumulator();
    acc.observe({ type: "response.created", response: { id: "resp_1", usage: null } });
    acc.observe({ type: "response.output_text.delta", delta: "hello" });
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(acc.getServiceTier()).toBeNull();
  });

  it("settles usage from the terminal response.completed event (Responses-API usage shape)", () => {
    const acc = new OpenAIResponsesStreamAccumulator();
    acc.observe({ type: "response.created", response: { usage: null } });
    acc.observe({ type: "response.in_progress", response: { usage: null } });
    acc.observe({
      type: "response.completed",
      response: {
        service_tier: "default",
        usage: {
          input_tokens: 30,
          output_tokens: 9,
          input_tokens_details: { cached_tokens: 12, cache_write_tokens: 75 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    });
    const details = acc.finalize();
    expect(details.input_tokens).toBe(30);
    expect(details.output_tokens).toBe(9);
    expect(details.cached_input_tokens).toBe(12);
    expect(details.cache_creation_5m_tokens).toBe(75);
    expect(details.reasoning_tokens).toBe(4);
    expect(acc.getServiceTier()).toBe("default");
  });

  it("last usage-bearing event wins; a trailing usage-less event does not clear it", () => {
    const acc = new OpenAIResponsesStreamAccumulator();
    acc.observe({ response: { usage: { input_tokens: 1, output_tokens: 1 } } });
    acc.observe({ response: { usage: { input_tokens: 100, output_tokens: 200 } } });
    acc.observe({ type: "response.output_text.done", response: { usage: null } });
    const details = acc.finalize();
    expect(details.input_tokens).toBe(100);
    expect(details.output_tokens).toBe(200);
  });

  it("does not confuse a top-level chat-shaped usage for a Responses event (needs response.usage)", () => {
    const acc = new OpenAIResponsesStreamAccumulator();
    // A chat-shaped chunk (top-level usage, no nested response) is not a Responses event.
    acc.observe({ usage: { prompt_tokens: 5, completion_tokens: 7 } });
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
  });
});
