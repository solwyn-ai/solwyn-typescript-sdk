import { describe, expect, it, vi } from "vitest";
import { noopLogger } from "../../src/logging";
import { estimateContentLength } from "../../src/privacy";
import { AnthropicAdapter, AnthropicStreamAccumulator } from "../../src/providers/anthropic";
import { BedrockAdapter } from "../../src/providers/bedrock";
import { GoogleAdapter, GoogleStreamAccumulator } from "../../src/providers/google";
import { buildCompatAdapters } from "../../src/providers/openai-compatible";
import { openaiChunkToDeltas } from "../../src/providers/translation/openai";
import { TokenDetailsSchema } from "../../src/token-details";

describe("Anthropic cumulative stream usage", () => {
  it.each([
    { aggregate: 1200, cache5m: 200, estimated: false },
    { aggregate: 1500, cache5m: 500, estimated: false },
    { aggregate: 900, cache5m: 200, estimated: true },
  ])("preserves the initial 1h split with aggregate-only deltas: $aggregate", ({
    aggregate,
    cache5m,
    estimated,
  }) => {
    const acc = new AnthropicStreamAccumulator(noopLogger);
    acc.observe({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 1200,
          cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 1000 },
          output_tokens: 1,
        },
      },
    });
    const delta = {
      type: "message_delta",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: aggregate,
        output_tokens: 50,
        output_tokens_details: null,
        server_tool_use: null,
      },
    };
    acc.observe(delta);
    acc.observe(delta);
    expect(acc.finalize()).toMatchObject({
      input_tokens: 1010 + cache5m,
      output_tokens: 50,
      cache_creation_5m_tokens: cache5m,
      cache_creation_1h_tokens: 1000,
      is_estimated: estimated,
    });
  });

  it.each([
    { cache_creation_input_tokens: -1 },
    { cache_creation: { ephemeral_5m_input_tokens: "bad", ephemeral_1h_input_tokens: 20 } },
  ])("keeps malformed cache deltas estimated: %j", (cache) => {
    const acc = new AnthropicStreamAccumulator(noopLogger);
    acc.observe({
      type: "message_start",
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 30 } },
    });
    acc.observe({
      type: "message_delta",
      usage: { input_tokens: 200, output_tokens: 5, ...cache },
    });
    expect(acc.finalize()).toMatchObject({
      input_tokens: "cache_creation" in cache ? 250 : 230,
      output_tokens: 5,
      is_estimated: true,
    });
  });

  it("keeps malformed initial cache usage estimated after a valid input update", () => {
    const acc = new AnthropicStreamAccumulator(noopLogger);
    acc.observe({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: "bad",
        },
      },
    });
    acc.observe({ type: "message_delta", usage: { input_tokens: 200, output_tokens: 5 } });
    expect(acc.finalize()).toMatchObject({
      input_tokens: 200,
      output_tokens: 5,
      is_estimated: true,
    });
  });

  it("replaces input and cache counters with the server-tool totals", () => {
    const acc = new AnthropicStreamAccumulator(noopLogger);
    acc.observe({ type: "message_start", message: { usage: { input_tokens: 100 } } });
    acc.observe({
      type: "message_delta",
      usage: { input_tokens: 2600, cache_read_input_tokens: 400, output_tokens: 300 },
    });
    expect(acc.finalize()).toMatchObject({
      input_tokens: 3000,
      cached_input_tokens: 400,
      output_tokens: 300,
      is_estimated: false,
    });
  });

  it("updates cache writes by TTL without adding cumulative counters twice", () => {
    const acc = new AnthropicStreamAccumulator(noopLogger);
    acc.observe({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
        },
      },
    });
    const delta = {
      type: "message_delta",
      usage: {
        input_tokens: 200,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 999,
        cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 60 },
        output_tokens: 10,
      },
    };
    acc.observe(delta);
    acc.observe(delta);
    expect(acc.finalize()).toMatchObject({
      input_tokens: 350,
      cached_input_tokens: 40,
      cache_creation_5m_tokens: 50,
      cache_creation_1h_tokens: 60,
    });
  });

  it("preserves start counters when a delta has only output or invalid input", () => {
    const acc = new AnthropicStreamAccumulator(noopLogger);
    acc.observe({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
        },
      },
    });
    acc.observe({ type: "message_delta", usage: { output_tokens: 5 } });
    expect(acc.finalize()).toMatchObject({ input_tokens: 150, output_tokens: 5 });
    acc.observe({
      type: "message_delta",
      usage: {
        input_tokens: -1,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: "bad",
        output_tokens: 10,
      },
    });
    expect(acc.finalize()).toMatchObject({ input_tokens: 150, output_tokens: 10 });
  });
});

describe("Anthropic usage details", () => {
  it.each([
    ["standard", "standard"],
    ["priority", "priority"],
    ["batch", null],
    ["unknown", null],
    ["x".repeat(50), null],
  ])("filters unsupported service tiers from buffered and streamed usage: %s", (tier, expected) => {
    const adapter = new AnthropicAdapter({ logger: noopLogger });
    const response = { usage: { input_tokens: 10, output_tokens: 20, service_tier: tier } };
    expect(adapter.extractServiceTier(response)).toBe(expected);
    const acc = adapter.createStreamAccumulator();
    acc.observe({ type: "message_start", message: response });
    expect(acc.getServiceTier()).toBe(expected);
    acc.observe({ type: "message_delta", usage: { output_tokens: 20, service_tier: tier } });
    expect(acc.getServiceTier()).toBe(expected);
  });

  it("reports service tier and thinking as a subset of output", () => {
    const adapter = new AnthropicAdapter({ logger: noopLogger });
    const response = {
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        output_tokens_details: { thinking_tokens: 80 },
        service_tier: "priority",
      },
    };
    expect(adapter.extractServiceTier(response)).toBe("priority");
    expect(TokenDetailsSchema.parse(adapter.extractUsage(response))).toMatchObject({
      output_tokens: 100,
      reasoning_tokens: 80,
      is_estimated: false,
    });
    const acc = adapter.createStreamAccumulator();
    acc.observe({ type: "message_start", message: response });
    acc.observe({
      type: "message_delta",
      usage: { output_tokens: 120, output_tokens_details: { thinking_tokens: 90 } },
    });
    expect(acc.finalize()).toMatchObject({ output_tokens: 120, reasoning_tokens: 90 });
    expect(acc.getServiceTier()).toBe("priority");
  });
});

describe("Google request estimates", () => {
  it.each([
    [[{ role: "user", parts: [{ text: "abcd" }, { inlineData: { data: "ignored" } }] }], 4],
    [{ role: "user", parts: [{ text: "abcd" }] }, 4],
    [["ab", { text: "cde" }, { parts: [{ text: "fghi" }] }], 9],
  ])("counts Content and Part unions: %j", (contents, expected) => {
    expect(estimateContentLength({ contents })).toBe(expected);
  });

  it.each([
    "abcd",
    { parts: [{ text: "abcd" }] },
    [{ text: "ab" }, { text: "cd" }],
  ])("includes systemInstruction: %j", (systemInstruction) => {
    expect(
      estimateContentLength({
        contents: { parts: [{ text: "x".repeat(20_000) }] },
        config: { systemInstruction },
      }),
    ).toBe(20_004);
  });
});

describe("Google omitted zero output counters", () => {
  it.each([
    { promptTokenCount: 100 },
    { promptTokenCount: 100, thoughtsTokenCount: 20 },
  ])("trusts omitted candidates only for buffered or finished responses: %j", (usageMetadata) => {
    const adapter = new GoogleAdapter();
    const expected = {
      input_tokens: 100,
      output_tokens: usageMetadata.thoughtsTokenCount ?? 0,
      is_estimated: false,
    };
    expect(adapter.extractUsage({ usageMetadata })).toMatchObject(expected);
    const acc = new GoogleStreamAccumulator();
    acc.observe({ usageMetadata });
    expect(acc.finalize()).toMatchObject({ ...expected, is_estimated: true });
    acc.observe({ candidates: [{ finishReason: "STOP" }] });
    expect(acc.finalize()).toMatchObject(expected);
  });

  it("trusts explicit streamed zero output without a finish reason", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0 } });
    expect(acc.finalize()).toMatchObject({
      input_tokens: 100,
      output_tokens: 0,
      is_estimated: false,
    });
  });

  it("keeps an unspecified stream finish reason estimated", () => {
    const acc = new GoogleStreamAccumulator();
    acc.observe({
      usageMetadata: { promptTokenCount: 100 },
      candidates: [{ finishReason: "FINISH_REASON_UNSPECIFIED" }],
    });
    expect(acc.finalize().is_estimated).toBe(true);
  });
  it("still marks absent and malformed usage as estimated", () => {
    const adapter = new GoogleAdapter();
    expect(adapter.extractUsage({ usageMetadata: {} }).is_estimated).toBe(true);
    expect(
      adapter.extractUsage({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: -1,
        },
      }).is_estimated,
    ).toBe(true);
  });
});

describe("stream compatibility", () => {
  it.each([
    {
      controller: {},
      iterator: {},
      [Symbol.asyncIterator]() {
        return this;
      },
    },
    {
      next() {},
      return() {},
      [Symbol.asyncIterator]() {
        return this;
      },
    },
  ])("does not expose foreign stream helpers in Bedrock results", (foreign) => {
    const stream = {};
    const result = new BedrockAdapter().wrapStreamResult(stream, foreign);
    expect(Reflect.ownKeys(result as object)).toEqual(["stream"]);
    expect(result).toEqual({ stream });
  });

  it("bounds a compatible tier at settlement and warns once", () => {
    const warn = vi.fn();
    const adapter = buildCompatAdapters({ logger: { ...noopLogger, warn } })[0];
    if (!adapter) throw new Error("missing compatible adapter");
    const acc = adapter.createStreamAccumulator();
    for (let i = 0; i < 50; i++) acc.observe({ service_tier: "x".repeat(50) });
    expect(warn).not.toHaveBeenCalled();
    expect(acc.getServiceTier()).toBe("x".repeat(32));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts empty streamed tool-call arrays but rejects actual tool calls", () => {
    expect(
      openaiChunkToDeltas("openai", "anthropic", {
        choices: [
          {
            delta: { content: "synthetic", tool_calls: [] },
            finish_reason: "stop",
          },
        ],
      }),
    ).toEqual([{ text: "synthetic" }, { finishReason: "stop" }]);
    expect(() =>
      openaiChunkToDeltas("openai", "anthropic", {
        choices: [
          {
            delta: { tool_calls: [{ index: 0 }] },
          },
        ],
      }),
    ).toThrow();
  });
});
