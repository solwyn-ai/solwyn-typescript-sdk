/**
 * Exercises `GoogleAdapter` and `GoogleStreamAccumulator`. Fully offline; no fetch, no
 * `@google/genai` package — fixtures are plain objects shaped like Gemini
 * `GenerateContentResponse` / stream chunks (camelCase `usageMetadata`, per the real
 * `@google/genai` TS SDK).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors";
import { GoogleAdapter, GoogleStreamAccumulator } from "../../src/providers/google";
import type { ProviderAdapter } from "../../src/providers/protocol";
import { buildTokenDetails } from "../../src/token-details";

afterEach(() => vi.restoreAllMocks());

describe("GoogleAdapter — protocol + identity", () => {
  it("satisfies the ProviderAdapter interface (compile-time) and reports name/dialect", () => {
    const adapter: ProviderAdapter = new GoogleAdapter();
    expect(adapter.name).toBe("google");
    expect(adapter.dialect).toBe("google");
  });
});

describe("GoogleAdapter.detectModel", () => {
  it.each([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash-lite",
  ])("matches %s", (model) => {
    expect(new GoogleAdapter().detectModel(model)).toBe(true);
  });

  it.each(["gpt-4o", "claude-3-5-sonnet"])("rejects %s", (model) => {
    expect(new GoogleAdapter().detectModel(model)).toBe(false);
  });

  it("is case-sensitive and prefix-only (rejects 'Gemini-...' and mid-string)", () => {
    const adapter = new GoogleAdapter();
    expect(adapter.detectModel("Gemini-2.5-flash")).toBe(false);
    expect(adapter.detectModel("models/gemini-2.5-flash")).toBe(false);
  });
});

describe("GoogleAdapter.detectClient", () => {
  it("detects a genuine Google-shaped client (models.generateContent + generateContentStream)", () => {
    const client = {
      models: { generateContent: () => undefined, generateContentStream: () => undefined },
    };
    expect(new GoogleAdapter().detectClient(client)).toBe(true);
  });

  it("rejects a client exposing only one of the two methods", () => {
    const adapter = new GoogleAdapter();
    expect(adapter.detectClient({ models: { generateContent: () => undefined } })).toBe(false);
    expect(adapter.detectClient({ models: { generateContentStream: () => undefined } })).toBe(
      false,
    );
  });

  it("rejects a non-Google client (openai-shaped)", () => {
    const client = { chat: { completions: { create: () => undefined } } };
    expect(new GoogleAdapter().detectClient(client)).toBe(false);
  });

  it("rejects non-objects and objects without a models surface", () => {
    const adapter = new GoogleAdapter();
    expect(adapter.detectClient(null)).toBe(false);
    expect(adapter.detectClient(undefined)).toBe(false);
    expect(adapter.detectClient("google.genai")).toBe(false);
    expect(adapter.detectClient({})).toBe(false);
  });
});

describe("GoogleAdapter.extractUsage — usageMetadata normalization", () => {
  const adapter = new GoogleAdapter();

  it("maps promptTokenCount to input_tokens verbatim", () => {
    const usage = adapter.extractUsage({ usageMetadata: { promptTokenCount: 1000 } });
    expect(usage.input_tokens).toBe(1000);
  });

  it("output_tokens equals candidatesTokenCount alone when no thinking tokens", () => {
    const usage = adapter.extractUsage({ usageMetadata: { candidatesTokenCount: 500 } });
    expect(usage.output_tokens).toBe(500);
    expect(usage.reasoning_tokens).toBe(0);
  });

  it("output_tokens = candidatesTokenCount + thoughtsTokenCount (candidates excludes thoughts)", () => {
    const usage = adapter.extractUsage({
      usageMetadata: { candidatesTokenCount: 400, thoughtsTokenCount: 200 },
    });
    expect(usage.output_tokens).toBe(600);
  });

  it("reasoning_tokens maps from thoughtsTokenCount verbatim", () => {
    const usage = adapter.extractUsage({
      usageMetadata: { candidatesTokenCount: 10, thoughtsTokenCount: 150 },
    });
    expect(usage.reasoning_tokens).toBe(150);
  });

  it("reasoning_tokens is 0 when thoughtsTokenCount is absent", () => {
    const usage = adapter.extractUsage({ usageMetadata: { candidatesTokenCount: 10 } });
    expect(usage.reasoning_tokens).toBe(0);
  });

  it("cached_input_tokens maps from cachedContentTokenCount verbatim", () => {
    const usage = adapter.extractUsage({ usageMetadata: { cachedContentTokenCount: 800 } });
    expect(usage.cached_input_tokens).toBe(800);
  });

  it("cached_input_tokens is 0 when cachedContentTokenCount is absent", () => {
    const usage = adapter.extractUsage({ usageMetadata: { promptTokenCount: 5 } });
    expect(usage.cached_input_tokens).toBe(0);
  });

  it("tool_use_input_tokens maps from toolUsePromptTokenCount verbatim", () => {
    const usage = adapter.extractUsage({ usageMetadata: { toolUsePromptTokenCount: 120 } });
    expect(usage.tool_use_input_tokens).toBe(120);
  });

  it("tool_use_input_tokens is 0 when toolUsePromptTokenCount is absent", () => {
    const usage = adapter.extractUsage({ usageMetadata: { promptTokenCount: 5 } });
    expect(usage.tool_use_input_tokens).toBe(0);
  });

  it("normalizes all five mapped fields together when all optional fields are present", () => {
    const usage = adapter.extractUsage({
      usageMetadata: {
        promptTokenCount: 2000,
        candidatesTokenCount: 400,
        thoughtsTokenCount: 200,
        cachedContentTokenCount: 500,
        toolUsePromptTokenCount: 100,
      },
    });
    expect(usage.input_tokens).toBe(2000);
    expect(usage.output_tokens).toBe(600);
    expect(usage.reasoning_tokens).toBe(200);
    expect(usage.cached_input_tokens).toBe(500);
    expect(usage.tool_use_input_tokens).toBe(100);
  });

  it("always returns a genuine TokenDetails instance (deep-equal to zeros for empty usage)", () => {
    const usage = adapter.extractUsage({ usageMetadata: {} });
    expect(usage).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("leaves audio tokens zero when modality details are absent", () => {
    const usage = adapter.extractUsage({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    });
    expect(usage.audio_input_tokens).toBe(0);
    expect(usage.audio_output_tokens).toBe(0);
  });

  it("never populates cache-creation split tokens (no Google equivalent)", () => {
    const usage = adapter.extractUsage({
      usageMetadata: { cachedContentTokenCount: 800 },
    });
    expect(usage.cache_creation_5m_tokens).toBe(0);
    expect(usage.cache_creation_1h_tokens).toBe(0);
  });

  it("never populates prediction tokens (no Google equivalent)", () => {
    const usage = adapter.extractUsage({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    });
    expect(usage.accepted_prediction_tokens).toBe(0);
    expect(usage.rejected_prediction_tokens).toBe(0);
  });

  it("marks missing output usage estimated while preserving the reported input count", () => {
    const usage = adapter.extractUsage({ usageMetadata: { promptTokenCount: 1 } });
    expect(usage.is_estimated).toBe(true);
    expect(usage.input_tokens).toBe(1);
  });

  it("maps and sums IMAGE/AUDIO modality details on both input and output sides", () => {
    const usage = adapter.extractUsage({
      usageMetadata: {
        promptTokenCount: 900,
        candidatesTokenCount: 500,
        promptTokensDetails: [
          { modality: { value: "IMAGE" }, tokenCount: 100 },
          { modality: { name: "image" }, tokenCount: 150 },
          { modality: "AUDIO", tokenCount: 80 },
        ],
        candidatesTokensDetails: [
          { modality: { value: "IMAGE" }, tokenCount: 300 },
          { modality: { name: "audio" }, tokenCount: 60 },
          { modality: { value: 123, name: "AUDIO" }, tokenCount: 20 },
          { modality: { value: "TEXT", name: "IMAGE" }, tokenCount: 999 },
        ],
      },
    });
    expect(usage.image_input_tokens).toBe(250);
    expect(usage.audio_input_tokens).toBe(80);
    expect(usage.image_output_tokens).toBe(300);
    expect(usage.audio_output_tokens).toBe(80);
    expect(usage.input_tokens).toBe(900);
    expect(usage.output_tokens).toBe(500);
  });

  it("skips garbage modality counts and ignores non-array detail containers", () => {
    const usage = adapter.extractUsage({
      usageMetadata: {
        promptTokensDetails: { modality: "IMAGE", tokenCount: 999 },
        candidatesTokensDetails: [
          { modality: "IMAGE", tokenCount: true },
          { modality: "IMAGE", tokenCount: -1 },
          { modality: "IMAGE", tokenCount: 1.5 },
          { modality: "TEXT", tokenCount: 44 },
          null,
        ],
      },
    });
    expect(usage.image_input_tokens).toBe(0);
    expect(usage.image_output_tokens).toBe(0);
    expect(usage.audio_input_tokens).toBe(0);
    expect(usage.audio_output_tokens).toBe(0);
  });

  it("never throws when a modality detail array has hostile property access", () => {
    const hostile = new Proxy([], {
      get() {
        throw new Error("unreadable");
      },
    });
    expect(() =>
      adapter.extractUsage({ usageMetadata: { promptTokensDetails: hostile } }),
    ).not.toThrow();
  });
});

describe("GoogleAdapter.extractUsage — missing usageMetadata", () => {
  const adapter = new GoogleAdapter();

  it("a response with no usageMetadata attribute returns all-zero TokenDetails", () => {
    expect(adapter.extractUsage({})).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("a response with usageMetadata === null returns all-zero TokenDetails", () => {
    expect(adapter.extractUsage({ usageMetadata: null })).toEqual(
      buildTokenDetails({ is_estimated: true }),
    );
  });

  it("a non-object response returns all-zero (never throws)", () => {
    expect(adapter.extractUsage(null)).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(adapter.extractUsage(undefined)).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(adapter.extractUsage("nonsense")).toEqual(buildTokenDetails({ is_estimated: true }));
  });
});

describe("GoogleAdapter.estimateMissingUsage / extractServiceTier / extractRegion", () => {
  const adapter = new GoogleAdapter();

  it("estimateMissingUsage always returns null (Google always reports usage)", () => {
    expect(adapter.estimateMissingUsage({}, { estimatedInputTokens: 1000 })).toBeNull();
    expect(
      adapter.estimateMissingUsage(
        { usageMetadata: { promptTokenCount: 5 } },
        { estimatedInputTokens: 0 },
      ),
    ).toBeNull();
  });

  it("extractServiceTier always returns null (Google has no service tier)", () => {
    expect(adapter.extractServiceTier({})).toBeNull();
    expect(adapter.extractServiceTier({ service_tier: "priority" })).toBeNull();
  });

  it("extractRegion always returns null (Gemini pricing is not regional)", () => {
    expect(adapter.extractRegion({})).toBeNull();
    expect(adapter.extractRegion({ region: "us-central1" })).toBeNull();
  });
});

describe("GoogleAdapter.prepareStreaming", () => {
  const adapter = new GoogleAdapter();

  it("returns a NEW shallow copy of kwargs, unchanged", () => {
    const kwargs = { model: "gemini-2.5-flash", contents: "hi" };
    const prepared = adapter.prepareStreaming(kwargs);
    expect(prepared).not.toBe(kwargs);
    expect(prepared).toEqual(kwargs);
  });

  it("does not mutate the caller's kwargs", () => {
    const kwargs = { model: "gemini-2.5-flash" };
    adapter.prepareStreaming(kwargs);
    expect(kwargs).toEqual({ model: "gemini-2.5-flash" });
  });

  it("is unchanged for crossProvider=true as well", () => {
    const kwargs = { model: "gemini-2.5-flash" };
    expect(adapter.prepareStreaming(kwargs, { crossProvider: true })).toEqual(kwargs);
  });
});

describe("GoogleAdapter.prepareCall — dispatch seams", () => {
  const adapter = new GoogleAdapter();

  function makeClient() {
    const generateContent = vi.fn((..._args: unknown[]) => "content");
    const generateContentStream = vi.fn((..._args: unknown[]) => "stream");
    return {
      client: { models: { generateContent, generateContentStream } },
      generateContent,
      generateContentStream,
    };
  }

  const baseOptions = {
    surface: "chat" as const,
    isStreaming: false,
    crossProvider: false,
    timeout: 12.5,
    maxRetries: 2,
  };

  it("strips the stream key and injects the HTTP bound (seconds->ms, attempts=1)", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { client, generateContent } = makeClient();
    const kwargs: Record<string, unknown> = {
      model: "gemini-2.5-flash",
      contents: "hi",
      stream: true,
    };
    const original = { ...kwargs };
    adapter.prepareCall(client, kwargs, baseOptions)();

    const passed = generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
    const config = passed["config"] as Record<string, unknown>;
    const httpOptions = config["httpOptions"] as Record<string, unknown>;
    const retryOptions = httpOptions["retryOptions"] as Record<string, unknown>;

    expect(httpOptions["timeout"]).toBe(12_500);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 12_500);
    expect(config["abortSignal"]).toBeInstanceOf(AbortSignal);
    expect(retryOptions["attempts"]).toBe(1);
    expect(passed["stream"]).toBeUndefined();
    // Input kwargs left byte-for-byte unmutated.
    expect(kwargs).toEqual(original);
  });

  it("is_streaming=true dispatches through models.generateContentStream", () => {
    const { client, generateContent, generateContentStream } = makeClient();
    const result = adapter.prepareCall(
      client,
      { model: "gemini-2.5-flash", stream: true },
      { ...baseOptions, isStreaming: true },
    )();
    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(generateContentStream.mock.instances[0]).toBe(client.models);
    expect(generateContent).not.toHaveBeenCalled();
    expect(result).toBe("stream");
    const passed = generateContentStream.mock.calls[0]?.[0] as Record<string, unknown>;
    const config = passed["config"] as Record<string, unknown>;
    const httpOptions = config["httpOptions"] as Record<string, unknown>;
    expect(httpOptions["timeout"]).toBe(12_500);
    expect((httpOptions["retryOptions"] as Record<string, unknown>)["attempts"]).toBe(1);
  });

  it("is_streaming=false dispatches through models.generateContent bound to models", () => {
    const { client, generateContent, generateContentStream } = makeClient();
    const result = adapter.prepareCall(client, { model: "gemini-2.5-flash" }, baseOptions)();
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.instances[0]).toBe(client.models);
    expect(generateContentStream).not.toHaveBeenCalled();
    expect(result).toBe("content");
  });

  it("preserves caller-supplied config and httpOptions keys alongside the injected timeout", () => {
    const { client, generateContent } = makeClient();
    const kwargs = {
      model: "gemini-2.5-flash",
      config: { temperature: 0.2, httpOptions: { headers: { "x-a": "1" } } },
    };
    adapter.prepareCall(client, kwargs, { ...baseOptions, timeout: 10.0, maxRetries: 0 })();

    const passed = generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
    const config = passed["config"] as Record<string, unknown>;
    const httpOptions = config["httpOptions"] as Record<string, unknown>;
    expect(config["temperature"]).toBe(0.2);
    expect(httpOptions["headers"]).toEqual({ "x-a": "1" });
    expect(httpOptions["timeout"]).toBe(10_000);
    expect((httpOptions["retryOptions"] as Record<string, unknown>)["attempts"]).toBe(1);
    // Deep immutability: caller's nested config objects untouched.
    expect(kwargs.config).toEqual({ temperature: 0.2, httpOptions: { headers: { "x-a": "1" } } });
  });

  it("floors timeout at 1ms and attempts at 1 for zero/negative bounds", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { client, generateContent } = makeClient();
    adapter.prepareCall(
      client,
      { model: "gemini-2.5-flash" },
      {
        ...baseOptions,
        timeout: 0,
        maxRetries: -5,
      },
    )();
    const passed = generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
    const httpOptions = (passed["config"] as Record<string, unknown>)["httpOptions"] as Record<
      string,
      unknown
    >;
    expect(httpOptions["timeout"]).toBe(1);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 1);
    expect((httpOptions["retryOptions"] as Record<string, unknown>)["attempts"]).toBe(1);
  });

  it("saturates an oversized provider timeout at the portable timer maximum", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { client, generateContent } = makeClient();
    adapter.prepareCall(
      client,
      { model: "gemini-2.5-flash" },
      {
        ...baseOptions,
        timeout: Number.MAX_VALUE,
      },
    )();

    const passed = generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
    const httpOptions = (passed["config"] as Record<string, unknown>)["httpOptions"] as Record<
      string,
      unknown
    >;
    expect(httpOptions["timeout"]).toBe(2_147_483_647);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
  });

  it("forwards the caller's trailing passthrough args verbatim after the kwargs bag", () => {
    const { client, generateContent } = makeClient();
    const requestOptions = { abortSignal: "signal" };
    adapter.prepareCall(client, { model: "gemini-2.5-flash" }, baseOptions)(requestOptions);
    expect(generateContent.mock.calls[0]?.[1]).toBe(requestOptions);
  });

  it("throws ConfigurationError when the target method is absent", () => {
    const dispatch = () =>
      adapter.prepareCall({ models: {} }, { model: "gemini-2.5-flash" }, baseOptions);
    expect(dispatch).toThrow(ConfigurationError);
  });

  it("applies the same copied nested bound to Google media dispatch", () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const embedContent = vi.fn((..._args: unknown[]) => "embedded");
    const client = { models: { embedContent } };
    const config = { temperature: 0.2, httpOptions: { headers: { x: "1" } } };
    const kwargs = { model: "text-embedding-004", config };
    const prepared = adapter.prepareMediaCall("embeddings", client, kwargs, {
      timeout: 42,
      maxRetries: 7,
    });
    prepared.method(prepared.kwargs);

    const passed = embedContent.mock.calls[0]?.[0] as Record<string, unknown>;
    const passedConfig = passed["config"] as Record<string, unknown>;
    const httpOptions = passedConfig["httpOptions"] as Record<string, unknown>;
    expect(httpOptions["timeout"]).toBe(42_000);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 42_000);
    expect((httpOptions["retryOptions"] as Record<string, unknown>)["attempts"]).toBe(1);
    expect(httpOptions["headers"]).toEqual({ x: "1" });
    expect(passedConfig).not.toBe(config);
    expect(config).toEqual({ temperature: 0.2, httpOptions: { headers: { x: "1" } } });
  });
});

describe("GoogleAdapter stream-shape seams", () => {
  const adapter = new GoogleAdapter();

  it("unwrapStreamSource is strict identity", () => {
    const source = { some: "stream" };
    expect(adapter.unwrapStreamSource(source)).toBe(source);
  });

  it("wrapStreamResult is strict identity (returns the wrapper, ignores servedResponse)", () => {
    const wrapper = { wrapped: true };
    const served = { served: true };
    expect(adapter.wrapStreamResult(wrapper, served)).toBe(wrapper);
  });
});

describe("GoogleAdapter.createStreamAccumulator", () => {
  const adapter = new GoogleAdapter();

  it("returns a fresh GoogleStreamAccumulator; empty finalize is all-zero, tier null", () => {
    const acc = adapter.createStreamAccumulator();
    expect(acc).toBeInstanceOf(GoogleStreamAccumulator);
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(acc.getServiceTier()).toBeNull();
  });

  it("returns a distinct instance each call (never shared across streams)", () => {
    expect(adapter.createStreamAccumulator()).not.toBe(adapter.createStreamAccumulator());
  });

  it("ignores estimatedInputTokens entirely", () => {
    const acc = adapter.createStreamAccumulator({ estimatedInputTokens: 9999 });
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
  });
});

describe("GoogleStreamAccumulator", () => {
  it("finalize is all-zero and getServiceTier is null before any chunk", () => {
    const acc = new GoogleStreamAccumulator();
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(acc.getServiceTier()).toBeNull();
  });

  it("finalize returns all-zero when only usage-less chunks are observed", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({ candidates: [{ index: 0 }] });
    acc.observe({ text: "partial" });
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("settles usage from the last usageMetadata-bearing chunk (candidates + thoughts summed)", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({ text: "a" });
    acc.observe({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 10 },
    });
    const details = acc.finalize();
    expect(details.input_tokens).toBe(100);
    expect(details.output_tokens).toBe(50);
    expect(details.reasoning_tokens).toBe(10);
  });

  it("last non-null usageMetadata wins; a later usage-less chunk does not clear it", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    acc.observe({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200 } });
    acc.observe({ text: "trailing-no-usage" });
    const details = acc.finalize();
    expect(details.input_tokens).toBe(100);
    expect(details.output_tokens).toBe(200);
  });

  it("a chunk whose usageMetadata is explicitly null does not clear a stored value", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } });
    acc.observe({ usageMetadata: null });
    const details = acc.finalize();
    expect(details.input_tokens).toBe(7);
    expect(details.output_tokens).toBe(3);
  });

  it("extracts cached and tool-use tokens from the retained usageMetadata", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({
      usageMetadata: {
        promptTokenCount: 500,
        candidatesTokenCount: 300,
        cachedContentTokenCount: 400,
        toolUsePromptTokenCount: 60,
      },
    });
    const details = acc.finalize();
    expect(details.cached_input_tokens).toBe(400);
    expect(details.tool_use_input_tokens).toBe(60);
  });

  it("settles summed IMAGE/AUDIO detail buckets from the terminal usage metadata", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        promptTokensDetails: [
          { modality: { value: "IMAGE" }, tokenCount: 100 },
          { modality: { name: "IMAGE" }, tokenCount: 150 },
          { modality: "AUDIO", tokenCount: 30 },
        ],
        candidatesTokensDetails: [
          { modality: { value: "IMAGE" }, tokenCount: 40 },
          { modality: { name: "AUDIO" }, tokenCount: 50 },
        ],
      },
    });
    const details = acc.finalize();
    expect(details.image_input_tokens).toBe(250);
    expect(details.audio_input_tokens).toBe(30);
    expect(details.image_output_tokens).toBe(40);
    expect(details.audio_output_tokens).toBe(50);
    expect(details.input_tokens).toBe(10);
    expect(details.output_tokens).toBe(20);
  });

  it("getServiceTier always returns null", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({ usageMetadata: { promptTokenCount: 1 } });
    expect(acc.getServiceTier()).toBeNull();
  });
});
