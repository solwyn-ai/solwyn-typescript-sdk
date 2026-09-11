/**
 * Exercises `AnthropicAdapter` and `AnthropicStreamAccumulator`. Fully offline; no fetch, no
 * `@anthropic-ai/sdk` package — fixtures are plain objects shaped like Anthropic
 * Messages API responses / stream events.
 */

import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors";
import type { Logger } from "../../src/logging";
import { AnthropicAdapter, AnthropicStreamAccumulator } from "../../src/providers/anthropic";
import type { PrepareCallOptions, ProviderAdapter } from "../../src/providers/protocol";
import { buildTokenDetails, zeroTokenDetails } from "../../src/token-details";

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

// The Anthropic adapter has a single call surface (messages.create) and ignores
// `surface`; "chat" satisfies the DispatchSurface type without a cast.
const callOptions: PrepareCallOptions = {
  surface: "chat",
  isStreaming: false,
  crossProvider: false,
  timeout: 30,
  maxRetries: 2,
};

// ---------------------------------------------------------------------------
// Protocol + identity
// ---------------------------------------------------------------------------

describe("AnthropicAdapter — protocol + identity", () => {
  it("satisfies the ProviderAdapter interface (compile-time) and reports name/dialect", () => {
    const adapter: ProviderAdapter = new AnthropicAdapter();
    expect(adapter.name).toBe("anthropic");
    expect(adapter.dialect).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// detectModel
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.detectModel", () => {
  it.each(["claude-3-5-sonnet", "claude-opus-4-6", "claude-haiku-3-5"])("matches %s", (model) => {
    expect(new AnthropicAdapter().detectModel(model)).toBe(true);
  });

  it.each(["gpt-4o", "gemini-2.5-flash"])("rejects %s", (model) => {
    expect(new AnthropicAdapter().detectModel(model)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectClient
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.detectClient", () => {
  it("detects a genuine Anthropic-shaped client (messages.create present)", () => {
    // FakeClient shaped like `anthropic.resources` — exposes messages.create.
    const client = { messages: { create: () => undefined } };
    expect(new AnthropicAdapter().detectClient(client)).toBe(true);
  });

  it("detects via a constructor name containing 'anthropic'", () => {
    class Anthropic {}
    expect(new AnthropicAdapter().detectClient(new Anthropic())).toBe(true);
  });

  it("rejects a non-Anthropic client (openai-shaped, chat.completions.create only)", () => {
    const client = { chat: { completions: { create: () => undefined } } };
    expect(new AnthropicAdapter().detectClient(client)).toBe(false);
  });

  it("rejects non-objects", () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.detectClient(null)).toBe(false);
    expect(adapter.detectClient(undefined)).toBe(false);
    expect(adapter.detectClient("anthropic")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractUsage — additive normalization
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.extractUsage — additive input normalization", () => {
  const adapter = new AnthropicAdapter();

  it("extracts plain input/output tokens with no cache fields", () => {
    const usage = adapter.extractUsage({ usage: { input_tokens: 42, output_tokens: 17 } });
    expect(usage.input_tokens).toBe(42);
    expect(usage.output_tokens).toBe(17);
  });

  it("normalizes input_tokens to the sum of base + cache_read + 5m + 1h (1000+300+150+50=1500)", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 1000,
        output_tokens: 9,
        cache_read_input_tokens: 300,
        cache_creation: {
          ephemeral_5m_input_tokens: 150,
          ephemeral_1h_input_tokens: 50,
        },
      },
    });
    expect(usage.input_tokens).toBe(1500);
    expect(usage.cached_input_tokens).toBe(300);
    expect(usage.cache_creation_5m_tokens).toBe(150);
    expect(usage.cache_creation_1h_tokens).toBe(50);
  });

  it("with no cache fields, normalized input equals base exactly", () => {
    const usage = adapter.extractUsage({ usage: { input_tokens: 777, output_tokens: 1 } });
    expect(usage.input_tokens).toBe(777);
    expect(usage.cached_input_tokens).toBe(0);
    expect(usage.cache_creation_5m_tokens).toBe(0);
    expect(usage.cache_creation_1h_tokens).toBe(0);
  });

  it("maps cache_read_input_tokens 1:1 to cached_input_tokens", () => {
    const usage = adapter.extractUsage({
      usage: { input_tokens: 100, cache_read_input_tokens: 60 },
    });
    expect(usage.cached_input_tokens).toBe(60);
    // Summed INTO input_tokens (100 + 60), not double-counted elsewhere.
    expect(usage.input_tokens).toBe(160);
  });

  it("maps cache_creation.ephemeral_5m to cache_creation_5m_tokens; 1h defaults 0 when absent", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 80 },
      },
    });
    expect(usage.cache_creation_5m_tokens).toBe(80);
    expect(usage.cache_creation_1h_tokens).toBe(0);
    expect(usage.input_tokens).toBe(280);
  });

  it("extracts both 5m and 1h cache-write buckets independently (1000+200+200+100=1500)", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 1000,
        output_tokens: 5,
        cache_read_input_tokens: 200,
        cache_creation: {
          ephemeral_5m_input_tokens: 200,
          ephemeral_1h_input_tokens: 100,
        },
      },
    });
    expect(usage.cache_creation_5m_tokens).toBe(200);
    expect(usage.cache_creation_1h_tokens).toBe(100);
    expect(usage.input_tokens).toBe(1500);
  });

  it("produces a fully-correct combined response (base + cache_read + 5m, no 1h)", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 500,
        output_tokens: 40,
        cache_read_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 100 },
      },
    });
    expect(usage.input_tokens).toBe(900); // 500 + 300 + 100
    expect(usage.output_tokens).toBe(40);
    expect(usage.cached_input_tokens).toBe(300);
    expect(usage.cache_creation_5m_tokens).toBe(100);
    expect(usage.cache_creation_1h_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractUsage — aggregate fallback vs sub-object presence
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.extractUsage — cache_creation aggregate fallback", () => {
  const adapter = new AnthropicAdapter();

  it("attributes the flat aggregate entirely to the 5m bucket when no sub-object (1000+200+300=1500, 5m=300)", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
      },
    });
    expect(usage.cache_creation_5m_tokens).toBe(300);
    expect(usage.cache_creation_1h_tokens).toBe(0);
    // Aggregate summed in exactly once.
    expect(usage.input_tokens).toBe(1500);
  });

  it("ignores the flat aggregate entirely when the sub-object is present even with zero values", () => {
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 999, // discarded — sub-object present
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
      },
    });
    expect(usage.cache_creation_5m_tokens).toBe(0);
    expect(usage.cache_creation_1h_tokens).toBe(0);
    // Base only — aggregate 999 not summed in.
    expect(usage.input_tokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// extractUsage — permanent-zero fields & graceful degradation
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.extractUsage — permanent-zero fields", () => {
  const adapter = new AnthropicAdapter();

  it("reasoning_tokens is always 0 (extended thinking folded into output — permanent blind spot)", () => {
    const usage = adapter.extractUsage({ usage: { input_tokens: 10, output_tokens: 5000 } });
    expect(usage.reasoning_tokens).toBe(0);
  });

  it("audio / prediction / tool_use fields are always 0 (OpenAI/Google-only)", () => {
    const usage = adapter.extractUsage({
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
    });
    expect(usage.audio_input_tokens).toBe(0);
    expect(usage.audio_output_tokens).toBe(0);
    expect(usage.accepted_prediction_tokens).toBe(0);
    expect(usage.rejected_prediction_tokens).toBe(0);
    expect(usage.tool_use_input_tokens).toBe(0);
  });

  it("degrades gracefully with NO cache fields at all (older/no-cache response shape)", () => {
    const usage = adapter.extractUsage({ usage: { input_tokens: 123, output_tokens: 45 } });
    expect(usage.input_tokens).toBe(123);
    expect(usage.cached_input_tokens).toBe(0);
    expect(usage.cache_creation_5m_tokens).toBe(0);
    expect(usage.cache_creation_1h_tokens).toBe(0);
  });

  it("returns a genuine TokenDetails shape (deep-equal to a defaulted instance for zeros)", () => {
    const usage = adapter.extractUsage({ usage: { input_tokens: 0, output_tokens: 0 } });
    expect(usage).toEqual(zeroTokenDetails());
  });
});

// ---------------------------------------------------------------------------
// extractUsage — missing usage / never-throws
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.extractUsage — missing usage never throws", () => {
  const adapter = new AnthropicAdapter();

  it("returns all-zero TokenDetails when response.usage is null", () => {
    expect(adapter.extractUsage({ usage: null })).toEqual(
      buildTokenDetails({ is_estimated: true }),
    );
  });

  it("returns all-zero TokenDetails when response has no usage attribute", () => {
    expect(adapter.extractUsage({ id: "msg_1" })).toEqual(
      buildTokenDetails({ is_estimated: true }),
    );
  });

  it("returns all-zero TokenDetails for null/undefined/non-object responses (never throws)", () => {
    expect(adapter.extractUsage(null)).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(adapter.extractUsage(undefined)).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(adapter.extractUsage("garbage")).toEqual(buildTokenDetails({ is_estimated: true }));
  });

  it("tolerates a non-object cache_creation without throwing (aggregate still suppressed by presence)", () => {
    // cache_creation present (not null) but not an object -> ephemeral fields read as 0,
    // and the aggregate fallback is still suppressed by presence.
    const usage = adapter.extractUsage({
      usage: {
        input_tokens: 50,
        cache_creation: 7,
        cache_creation_input_tokens: 999,
      },
    });
    expect(usage.cache_creation_5m_tokens).toBe(0);
    expect(usage.cache_creation_1h_tokens).toBe(0);
    expect(usage.input_tokens).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Always-null seams
// ---------------------------------------------------------------------------

describe("AnthropicAdapter — always-null seams", () => {
  const adapter = new AnthropicAdapter();

  it("estimateMissingUsage always returns null (Anthropic always reports usage)", () => {
    expect(adapter.estimateMissingUsage({ usage: null }, { estimatedInputTokens: 100 })).toBe(null);
    expect(adapter.estimateMissingUsage({}, { estimatedInputTokens: 0 })).toBe(null);
  });

  it("extractServiceTier always returns null regardless of response shape", () => {
    expect(adapter.extractServiceTier({})).toBe(null);
    expect(adapter.extractServiceTier({ service_tier: "priority" })).toBe(null);
    expect(adapter.extractServiceTier(null)).toBe(null);
  });

  it("extractRegion always returns null (Anthropic pricing is not regional)", () => {
    expect(adapter.extractRegion({ region: "us-east-1" })).toBe(null);
    expect(adapter.extractRegion(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// prepareStreaming
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.prepareStreaming", () => {
  const adapter = new AnthropicAdapter();

  it("returns a value-equal but reference-distinct copy of the input kwargs (no-op transform)", () => {
    const kwargs = { model: "claude-opus-4-6", max_tokens: 1024 };
    const prepared = adapter.prepareStreaming(kwargs);
    expect(prepared).toEqual(kwargs);
    expect(prepared).not.toBe(kwargs);
  });

  it("adds/removes/mutates no keys and ignores crossProvider", () => {
    const kwargs = { model: "claude-opus-4-6", messages: [] };
    const prepared = adapter.prepareStreaming(kwargs, { crossProvider: true });
    expect(Object.keys(prepared)).toEqual(Object.keys(kwargs));
    expect(prepared).toEqual(kwargs);
  });
});

// ---------------------------------------------------------------------------
// createStreamAccumulator
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.createStreamAccumulator", () => {
  const adapter = new AnthropicAdapter();

  it("returns a fresh AnthropicStreamAccumulator instance", () => {
    expect(adapter.createStreamAccumulator()).toBeInstanceOf(AnthropicStreamAccumulator);
  });

  it("returns a distinct instance per call (never shared across streams)", () => {
    expect(adapter.createStreamAccumulator()).not.toBe(adapter.createStreamAccumulator());
  });

  it("accepts (and ignores) an estimatedInputTokens override", () => {
    expect(adapter.createStreamAccumulator({ estimatedInputTokens: 999 })).toBeInstanceOf(
      AnthropicStreamAccumulator,
    );
  });
});

// ---------------------------------------------------------------------------
// prepareCall
// ---------------------------------------------------------------------------

describe("AnthropicAdapter.prepareCall", () => {
  const adapter = new AnthropicAdapter();

  function makeClient() {
    const create = vi.fn((..._args: unknown[]) => "dispatched");
    return { client: { messages: { create } }, create };
  }

  it("dispatches through messages.create bound to its receiver", () => {
    const { client, create } = makeClient();
    const dispatch = adapter.prepareCall(client, { model: "claude-opus-4-6" }, callOptions);
    const result = dispatch();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.instances[0]).toBe(client.messages);
    expect(result).toBe("dispatched");
  });

  it("invokes create with a kwargs copy value-equal to the input but not the same reference", () => {
    const { client, create } = makeClient();
    const kwargs = { model: "claude-opus-4-6", max_tokens: 512 };
    adapter.prepareCall(client, kwargs, callOptions)();
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed).not.toBe(kwargs);
    expect(passed).toEqual(kwargs);
    expect(passed["stream"]).toBeUndefined();
  });

  it("copies and overrides request options while preserving unrelated values and tail identity", () => {
    const { client, create } = makeClient();
    const requestOptions = { signal: "abort-signal", timeout: 7, maxRetries: 9 };
    const tail = Symbol("tail");
    adapter.prepareCall(client, { model: "claude-opus-4-6" }, callOptions)(requestOptions, tail);
    expect(create.mock.calls[0]?.[1]).toEqual({
      signal: "abort-signal",
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(create.mock.calls[0]?.[1]).not.toBe(requestOptions);
    expect(create.mock.calls[0]?.[2]).toBe(tail);
    expect(requestOptions).toEqual({ signal: "abort-signal", timeout: 7, maxRetries: 9 });
  });

  it("sets stream:true on the returned copy only when streaming, without mutating input", () => {
    const { client, create } = makeClient();
    const kwargs: Record<string, unknown> = { model: "claude-opus-4-6" };
    adapter.prepareCall(client, kwargs, { ...callOptions, isStreaming: true })();
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed["stream"]).toBe(true);
    expect(kwargs["stream"]).toBeUndefined();
  });

  it("throws ConfigurationError when messages.create is absent", () => {
    const dispatch = () => adapter.prepareCall({ messages: {} }, { model: "x" }, callOptions);
    expect(dispatch).toThrow(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// Stream-shape seams (identity)
// ---------------------------------------------------------------------------

describe("AnthropicAdapter stream-shape seams", () => {
  const adapter = new AnthropicAdapter();

  it("unwrapStreamSource is strict identity for arbitrary opaque objects", () => {
    const source = { some: "stream" };
    expect(adapter.unwrapStreamSource(source)).toBe(source);
  });

  it("wrapStreamResult is strict identity (returns the wrapper reference) for arbitrary inputs", () => {
    const wrapper = { wrapped: true };
    const served = { served: true };
    expect(adapter.wrapStreamResult(wrapper, served)).toBe(wrapper);
  });
});

// ---------------------------------------------------------------------------
// AnthropicStreamAccumulator
// ---------------------------------------------------------------------------

describe("AnthropicStreamAccumulator", () => {
  it("extracts input from message_start and output from message_delta; ignores content_block_delta & message_stop", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.observe({ type: "message_start", message: { usage: { input_tokens: 150 } } });
    // content_block_delta carries only text -> a total no-op for token counting.
    acc.observe({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } });
    acc.observe({ type: "message_delta", usage: { output_tokens: 83 } });
    acc.observe({ type: "message_stop" });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(150);
    expect(td.output_tokens).toBe(83);
    expect(td.cached_input_tokens).toBe(0);
  });

  it("extracts cache fields with the same additive rule (800+300+100=1200)", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.observe({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 800,
          cache_read_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 100 },
        },
      },
    });
    acc.observe({ type: "message_delta", usage: { output_tokens: 20 } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(1200);
    expect(td.cached_input_tokens).toBe(300);
    expect(td.cache_creation_5m_tokens).toBe(100);
    expect(td.cache_creation_1h_tokens).toBe(0);
  });

  it("normalizes input with both 5m and 1h nonzero (1000+200+300+150=1650, output=500)", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.observe({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 200,
          cache_creation: {
            ephemeral_5m_input_tokens: 300,
            ephemeral_1h_input_tokens: 150,
          },
        },
      },
    });
    acc.observe({ type: "message_delta", usage: { output_tokens: 500 } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(1650);
    expect(td.output_tokens).toBe(500);
    expect(td.cache_creation_5m_tokens).toBe(300);
    expect(td.cache_creation_1h_tokens).toBe(150);
  });

  it("a cache_creation sub-object with zero values suppresses a nonzero flat aggregate (input=100)", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.observe({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 999,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
    });
    acc.observe({ type: "message_delta", usage: { output_tokens: 1 } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(100);
    expect(td.cache_creation_5m_tokens).toBe(0);
  });

  it("an aggregate-only message_start attributes the whole aggregate to the 5m bucket (1000+200+300=1500)", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.observe({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 300,
        },
      },
    });
    acc.observe({ type: "message_delta", usage: { output_tokens: 2 } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(1500);
    expect(td.cache_creation_5m_tokens).toBe(300);
    expect(td.cache_creation_1h_tokens).toBe(0);
  });

  it("logs a 'without message_start' warning when output was seen but no message_start", () => {
    const logger = fakeLogger();
    const acc = new AnthropicStreamAccumulator(logger);
    acc.observe({ type: "message_delta", usage: { output_tokens: 83 } });
    const td = acc.finalize();
    // Partial data returned, not zeroed, not raised.
    expect(td.input_tokens).toBe(0);
    expect(td.output_tokens).toBe(83);
    expect(logger.warnings.some((w) => w.includes("without message_start"))).toBe(true);
    // The mirror warning must NOT fire (inputTotal is 0).
    expect(logger.warnings.some((w) => w.includes("without message_delta"))).toBe(false);
  });

  it("logs a 'without message_delta' warning when input was seen but no message_delta", () => {
    const logger = fakeLogger();
    const acc = new AnthropicStreamAccumulator(logger);
    acc.observe({ type: "message_start", message: { usage: { input_tokens: 150 } } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(150);
    expect(td.output_tokens).toBe(0);
    expect(logger.warnings.some((w) => w.includes("without message_delta"))).toBe(true);
    expect(logger.warnings.some((w) => w.includes("without message_start"))).toBe(false);
  });

  it("returns all-zero TokenDetails and logs no warnings on an empty stream (zero observe calls)", () => {
    const logger = fakeLogger();
    const acc = new AnthropicStreamAccumulator(logger);
    expect(acc.finalize()).toEqual(buildTokenDetails({ is_estimated: true }));
    expect(logger.warnings).toEqual([]);
  });

  it("tolerates a minimal message_start usage (only input_tokens) — cache fields default to 0", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.observe({ type: "message_start", message: { usage: { input_tokens: 64 } } });
    acc.observe({ type: "message_delta", usage: { output_tokens: 8 } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(64);
    expect(td.cached_input_tokens).toBe(0);
    expect(td.cache_creation_5m_tokens).toBe(0);
    expect(td.cache_creation_1h_tokens).toBe(0);
  });

  it("tolerates a message_start with no usage block (fields stay at zero, no throw)", () => {
    const acc = new AnthropicStreamAccumulator();
    acc.observe({ type: "message_start", message: {} });
    acc.observe({ type: "message_delta", usage: { output_tokens: 5 } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(0);
    expect(td.output_tokens).toBe(5);
  });

  it("getServiceTier always returns null", () => {
    expect(new AnthropicStreamAccumulator().getServiceTier()).toBe(null);
  });
});
