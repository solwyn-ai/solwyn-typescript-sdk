/**
 * Exercises `BedrockAdapter` and `BedrockStreamAccumulator` behavior. Fully offline;
 * no fetch or provider I/O.
 *
 * Fixtures are PLAIN objects shaped like Converse responses / stream events, duck-typed
 * `bedrock-runtime` clients, plain AWS-import-free command classes named exactly like AWS SDK
 * v3's `ConverseCommand`, plus one installed real-command regression for Smithy middleware state.
 */

import { ConverseCommand as AwsConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors";
import type { Logger } from "../../src/logging";
import { BedrockAdapter, BedrockStreamAccumulator } from "../../src/providers/bedrock";
import {
  BEDROCK_NATIVE_COMMAND,
  type PrepareCallOptions,
  type ProviderAdapter,
} from "../../src/providers/protocol";
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

/** A `PrepareCallOptions` with the given `isStreaming`; other fields use neutral defaults. */
function callOptions(isStreaming: boolean): PrepareCallOptions {
  return {
    surface: "chat",
    isStreaming,
    crossProvider: false,
    timeout: 0,
    maxRetries: 0,
  };
}

// ---------------------------------------------------------------------------
// Protocol + identity
// ---------------------------------------------------------------------------

describe("BedrockAdapter — protocol + identity", () => {
  it("satisfies the ProviderAdapter interface (compile-time) and reports name/dialect", () => {
    const adapter: ProviderAdapter = new BedrockAdapter();
    expect(adapter.name).toBe("bedrock");
    expect(adapter.dialect).toBe("bedrock");
  });
});

// ---------------------------------------------------------------------------
// detectModel
// ---------------------------------------------------------------------------

describe("BedrockAdapter.detectModel — matches", () => {
  it.each([
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "eu.anthropic.claude-3-5-sonnet-20240620-v1:0",
    "apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "global.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "jp.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "us-gov.anthropic.claude-3-5-sonnet-20240620-v1:0",
    "meta.llama3-1-70b-instruct-v1:0",
    "mistral.mistral-large-2402-v1:0",
    "cohere.command-r-plus-v1:0",
    "ai21.jamba-1-5-large-v1:0",
    "amazon.nova-pro-v1:0",
    "amazon.titan-text-express-v1",
    "deepseek.r1-v1:0",
    "openai.gpt-oss-120b-1:0",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
    "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/us-gov.anthropic.claude-3-5-sonnet-20240620-v1:0",
  ])("matches %s", (model) => {
    expect(new BedrockAdapter().detectModel(model)).toBe(true);
  });
});

describe("BedrockAdapter.detectModel — rejects", () => {
  it.each([
    "gpt-4o",
    "claude-3-5-sonnet",
    "gemini-2.5-flash",
    "anthropic",
    "us.unknownvendor.some-model-v1:0",
    "",
  ])("rejects %s", (model) => {
    expect(new BedrockAdapter().detectModel(model)).toBe(false);
  });

  it("does not shadow a native Anthropic id (bare `claude-*` has no Bedrock prefix)", () => {
    expect(new BedrockAdapter().detectModel("claude-3-5-sonnet")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectClient
// ---------------------------------------------------------------------------

describe("BedrockAdapter.detectClient", () => {
  const adapter = new BedrockAdapter();

  it("accepts a boto3 bedrock-runtime client (structural meta shape)", () => {
    const client = {
      meta: { service_model: { service_name: "bedrock-runtime" }, region_name: "us-east-1" },
    };
    expect(adapter.detectClient(client)).toBe(true);
  });

  it("accepts an aiobotocore bedrock-runtime client (same structural shape)", () => {
    const client = {
      meta: { service_model: { service_name: "bedrock-runtime" }, region_name: "eu-central-1" },
    };
    expect(adapter.detectClient(client)).toBe(true);
  });

  it("accepts an AWS SDK v3 client via constructor name (BedrockRuntimeClient)", () => {
    class BedrockRuntimeClient {}
    expect(adapter.detectClient(new BedrockRuntimeClient())).toBe(true);
  });

  it("rejects another AWS service client (s3)", () => {
    const client = { meta: { service_model: { service_name: "s3" }, region_name: "us-east-1" } };
    expect(adapter.detectClient(client)).toBe(false);
  });

  it("rejects the Bedrock control-plane client (service_name === 'bedrock')", () => {
    const client = {
      meta: { service_model: { service_name: "bedrock" }, region_name: "us-east-1" },
    };
    expect(adapter.detectClient(client)).toBe(false);
  });

  it("rejects a non-botocore (foreign SDK) client", () => {
    const client = { chat: { completions: { create: () => undefined } } };
    expect(adapter.detectClient(client)).toBe(false);
  });

  it("rejects an object without .meta (never throws)", () => {
    expect(adapter.detectClient({})).toBe(false);
    expect(adapter.detectClient(null)).toBe(false);
    expect(adapter.detectClient(undefined)).toBe(false);
    expect(adapter.detectClient("nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractUsage
// ---------------------------------------------------------------------------

describe("BedrockAdapter.extractUsage", () => {
  const adapter = new BedrockAdapter();

  it("passes basic (non-cached) tokens straight through, cache fields zero", () => {
    const td = adapter.extractUsage({
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    expect(td.input_tokens).toBe(100);
    expect(td.output_tokens).toBe(50);
    expect(td.cached_input_tokens).toBe(0);
    expect(td.cache_creation_5m_tokens).toBe(0);
    expect(td.cache_creation_1h_tokens).toBe(0);
  });

  it("has zero cache fields when the response carries no cache keys at all", () => {
    const td = adapter.extractUsage({ usage: { inputTokens: 10, outputTokens: 5 } });
    expect(td.cached_input_tokens).toBe(0);
    expect(td.cache_creation_5m_tokens).toBe(0);
    expect(td.cache_creation_1h_tokens).toBe(0);
  });

  it("folds cache read/write additively into input_tokens; write → 5m bucket by default", () => {
    const td = adapter.extractUsage({
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 20,
      },
    });
    expect(td.input_tokens).toBe(150); // 100 + 30 + 20
    expect(td.cached_input_tokens).toBe(30);
    expect(td.cache_creation_5m_tokens).toBe(20);
    expect(td.cache_creation_1h_tokens).toBe(0);
  });

  it("splits cache-write tokens by TTL via cacheDetails", () => {
    const td = adapter.extractUsage({
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheWriteInputTokens: 25,
        cacheDetails: [
          { inputTokens: 15, ttl: "1h" },
          { inputTokens: 10, ttl: "5m" },
        ],
      },
    });
    expect(td.cache_creation_1h_tokens).toBe(15);
    expect(td.cache_creation_5m_tokens).toBe(10);
    expect(td.input_tokens).toBe(125); // 100 + 0 + 25
  });

  it("preserves the full aggregate when cacheDetails only partially itemizes", () => {
    const td = adapter.extractUsage({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteInputTokens: 20,
        cacheDetails: [{ inputTokens: 8, ttl: "1h" }],
      },
    });
    expect(td.cache_creation_1h_tokens).toBe(8);
    expect(td.cache_creation_5m_tokens).toBe(12); // remainder 20 - 8, not 0
    expect(td.input_tokens).toBe(30); // 10 + 0 + 20
  });

  it("degrades a null-valued usage field to 0 (not error/NaN/omission)", () => {
    const td = adapter.extractUsage({
      usage: { inputTokens: 42, outputTokens: 5, cacheReadInputTokens: null },
    });
    expect(td.cached_input_tokens).toBe(0);
    expect(td.input_tokens).toBe(42);
  });

  it("returns all zeros for missing usage, non-mapping response, and non-mapping usage", () => {
    const zero = new BedrockAdapter().extractUsage({}); // missing usage
    expect(zero.input_tokens).toBe(0);
    expect(zero.output_tokens).toBe(0);

    expect(adapter.extractUsage("garbage").input_tokens).toBe(0);
    expect(adapter.extractUsage(null).input_tokens).toBe(0);
    expect(adapter.extractUsage({ usage: "garbage" }).input_tokens).toBe(0);
    expect(adapter.extractUsage({ usage: "garbage" }).output_tokens).toBe(0);
  });

  it("never throws on wildly malformed input", () => {
    expect(() => adapter.extractUsage(undefined)).not.toThrow();
    expect(() => adapter.extractUsage(123)).not.toThrow();
    expect(() =>
      adapter.extractUsage({ usage: { inputTokens: "x", cacheDetails: 7 } }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// estimateMissingUsage
// ---------------------------------------------------------------------------

describe("BedrockAdapter.estimateMissingUsage", () => {
  it("always returns null (Converse always carries usage)", () => {
    const adapter = new BedrockAdapter();
    expect(adapter.estimateMissingUsage({}, { estimatedInputTokens: 500 })).toBeNull();
    expect(adapter.estimateMissingUsage({ usage: {} }, { estimatedInputTokens: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractServiceTier
// ---------------------------------------------------------------------------

describe("BedrockAdapter.extractServiceTier", () => {
  it("reads serviceTier.type", () => {
    const adapter = new BedrockAdapter();
    expect(adapter.extractServiceTier({ serviceTier: { type: "standard" } })).toBe("standard");
  });

  it("falls back to performanceConfig.latency", () => {
    const adapter = new BedrockAdapter();
    expect(adapter.extractServiceTier({ performanceConfig: { latency: "optimized" } })).toBe(
      "optimized",
    );
  });

  it("prefers serviceTier.type over performanceConfig.latency", () => {
    const adapter = new BedrockAdapter();
    const tier = adapter.extractServiceTier({
      serviceTier: { type: "standard" },
      performanceConfig: { latency: "optimized" },
    });
    expect(tier).toBe("standard");
  });

  it("returns null when absent", () => {
    expect(new BedrockAdapter().extractServiceTier({})).toBeNull();
    expect(new BedrockAdapter().extractServiceTier("garbage")).toBeNull();
  });

  it("returns null for a non-string tier value (e.g. 123), not a coerced string", () => {
    expect(new BedrockAdapter().extractServiceTier({ serviceTier: { type: 123 } })).toBeNull();
  });

  it("truncates an overlong tier to exactly SERVICE_TIER_MAX_LENGTH and warns", () => {
    const logger = fakeLogger();
    const adapter = new BedrockAdapter({ logger });
    const overlong = "x".repeat(SERVICE_TIER_MAX_LENGTH + 10);
    const tier = adapter.extractServiceTier({ serviceTier: { type: overlong } });
    expect(tier).toHaveLength(SERVICE_TIER_MAX_LENGTH);
    expect(logger.warnings.some((w) => w.includes("Bedrock service tier exceeds"))).toBe(true);
    expect(logger.warnings.some((w) => w.includes(String(SERVICE_TIER_MAX_LENGTH)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractRegion
// ---------------------------------------------------------------------------

describe("BedrockAdapter.extractRegion", () => {
  const adapter = new BedrockAdapter();

  it("reads client.meta.region_name (boto3 shape)", () => {
    expect(adapter.extractRegion({ meta: { region_name: "eu-central-1" } })).toBe("eu-central-1");
  });

  it("reads client.config.region when it is a plain string (AWS SDK v3 sync shape, D13)", () => {
    expect(adapter.extractRegion({ config: { region: "us-west-2" } })).toBe("us-west-2");
  });

  it("resolves null (never awaits) when config.region is an async provider (D13)", () => {
    // A real AWS SDK v3 client frequently resolves config.region to a `() => Promise<string>`.
    const asyncProvider = () => Promise.resolve("ap-southeast-2");
    expect(adapter.extractRegion({ config: { region: asyncProvider } })).toBeNull();
  });

  it("prefers the boto3 meta.region_name over config.region when both are present", () => {
    const client = {
      meta: { region_name: "eu-central-1" },
      config: { region: "us-west-2" },
    };
    expect(adapter.extractRegion(client)).toBe("eu-central-1");
  });

  it("returns null when .meta is missing and no config.region string is present", () => {
    expect(adapter.extractRegion({})).toBeNull();
    expect(adapter.extractRegion(null)).toBeNull();
    expect(adapter.extractRegion({ config: {} })).toBeNull();
    expect(adapter.extractRegion({ config: { region: "" } })).toBeNull();
  });

  it("returns null when region_name is non-string / empty", () => {
    expect(adapter.extractRegion({ meta: { region_name: null } })).toBeNull();
    expect(adapter.extractRegion({ meta: { region_name: 123 } })).toBeNull();
    expect(adapter.extractRegion({ meta: { region_name: "" } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// prepareStreaming
// ---------------------------------------------------------------------------

describe("BedrockAdapter.prepareStreaming", () => {
  it("returns an equal-but-distinct copy without mutating the input or adding keys", () => {
    const adapter = new BedrockAdapter();
    const kwargs = { model: "anthropic.claude-3-5-sonnet-20241022-v2:0", messages: [] };
    const out = adapter.prepareStreaming(kwargs);
    expect(out).toEqual(kwargs);
    expect(out).not.toBe(kwargs);
    expect(kwargs).toEqual({ model: "anthropic.claude-3-5-sonnet-20241022-v2:0", messages: [] });
  });
});

// ---------------------------------------------------------------------------
// prepareCall
// ---------------------------------------------------------------------------

// A plain, AWS-import-free command class named exactly like the AWS SDK v3 `ConverseCommand`.
class ConverseCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

/**
 * Build the pipeline kwargs bag the Bedrock proxy hands to `prepareCall`: the (renamed)
 * command input, plus the ORIGINAL command threaded under `BEDROCK_NATIVE_COMMAND`. The
 * adapter reads ONLY that key for dispatch — the renamed fields are for the pipeline's
 * budget/attribution/estimation upstream, not for `prepareCall`.
 */
function threadedKwargs(command: ConverseCommand): Record<string, unknown> {
  const kwargs: Record<PropertyKey, unknown> = { model: command.input["modelId"], messages: [] };
  kwargs[BEDROCK_NATIVE_COMMAND] = command;
  return kwargs as Record<string, unknown>;
}

describe("BedrockAdapter.prepareCall", () => {
  const adapter = new BedrockAdapter();

  it("dispatches client.send(command) with the ORIGINAL command passed through untouched", () => {
    const command = new ConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
    });
    const send = vi.fn((..._args: unknown[]) => "converse-result");
    const client = { send };

    const dispatch = adapter.prepareCall(client, threadedKwargs(command), callOptions(false));
    const result = dispatch();

    expect(result).toBe("converse-result");
    expect(send).toHaveBeenCalledTimes(1);
    // The exact, untouched command instance is sent — never a reconstructed sibling.
    expect(send.mock.calls[0]?.[0]).toBe(command);
    // The command's input is not mutated (modelId stays; no `model` key leaks onto it).
    expect(command.input).toEqual({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
    });
  });

  it("dispatches the same way regardless of the isStreaming flag (command type carries intent)", () => {
    const command = new ConverseCommand({ modelId: "meta.llama3-1-70b-instruct-v1:0" });
    const send = vi.fn((..._args: unknown[]) => "stream-result");
    const client = { send };

    const dispatch = adapter.prepareCall(client, threadedKwargs(command), callOptions(true));
    const result = dispatch();

    expect(result).toBe("stream-result");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(command);
  });

  it("copies the request options, injects requestTimeout, and preserves command/tail identity", () => {
    const command = new ConverseCommand({ modelId: "amazon.nova-pro-v1:0" });
    const send = vi.fn((..._args: unknown[]) => undefined);
    const client = { send };
    const opts = { signal: "abort", requestTimeout: 7 };
    const tail = Symbol("tail");

    const dispatch = adapter.prepareCall(client, threadedKwargs(command), callOptions(false));
    dispatch(opts, tail);

    expect(send.mock.calls[0]?.[0]).toBe(command);
    expect(send.mock.calls[0]?.[1]).toEqual({ signal: "abort", requestTimeout: 1 });
    expect(send.mock.calls[0]?.[1]).not.toBe(opts);
    expect(send.mock.calls[0]?.[2]).toBe(tail);
    expect(opts).toEqual({ signal: "abort", requestTimeout: 7 });
  });

  it("rejects hostile request options before send without changing command identity", () => {
    const command = new ConverseCommand({ modelId: "amazon.nova-pro-v1:0" });
    const send = vi.fn();
    const client = { send };
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile options");
        },
      },
    );
    const dispatch = adapter.prepareCall(client, threadedKwargs(command), callOptions(false));
    expect(() => dispatch(hostile)).toThrow(ConfigurationError);
    expect(send).not.toHaveBeenCalled();
  });

  it("throws ConfigurationError when no native command was threaded into the kwargs", () => {
    const send = vi.fn();
    const client = { send };
    expect(() =>
      adapter.prepareCall(client, { model: "amazon.nova-pro-v1:0" }, callOptions(false)),
    ).toThrow(ConfigurationError);
    expect(send).not.toHaveBeenCalled();
  });

  it("throws ConfigurationError when the wrapped client exposes no send()", () => {
    const command = new ConverseCommand({ modelId: "amazon.nova-pro-v1:0" });
    expect(() => adapter.prepareCall({}, threadedKwargs(command), callOptions(false))).toThrow(
      ConfigurationError,
    );
  });
});

// ---------------------------------------------------------------------------
// prepareCall model-override and default_params seam.
// ---------------------------------------------------------------------------

describe("BedrockAdapter.prepareCall — model-override / default_params seam (D14)", () => {
  const adapter = new BedrockAdapter();

  it("preserves caller middleware when sanitizing a tagged real AWS command", () => {
    const input = {
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      solwyn_tags: { customer: "acme" },
    };
    const command = new AwsConverseCommand(input);
    command.middlewareStack.add(
      function callerCustomMiddleware(next) {
        return (args) => next(args);
      },
      { name: "callerCustomMiddleware", step: "initialize" },
    );
    const send = vi.fn();
    const kwargs: Record<PropertyKey, unknown> = {
      model: input.modelId,
      messages: [],
      [BEDROCK_NATIVE_COMMAND]: command,
    };

    adapter.prepareCall({ send }, kwargs as Record<string, unknown>, callOptions(false))();

    const sent = send.mock.calls[0]?.[0] as AwsConverseCommand;
    expect(sent).not.toBe(command);
    expect(sent.input).not.toHaveProperty("solwyn_tags");
    expect(sent.middlewareStack.identify()).toContain("callerCustomMiddleware - initialize");
    expect(command.middlewareStack.identify()).toContain("callerCustomMiddleware - initialize");
    expect(command.input).toBe(input);
    expect(command.input).toHaveProperty("solwyn_tags", { customer: "acme" });
  });

  it("preserves symbol and non-enumerable own state without invoking accessors", () => {
    const command = new ConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      solwyn_tags: { customer: "acme" },
    });
    const callerState = Symbol("callerState");
    const state = { traceId: "trace-123" };
    let accessorReads = 0;
    Object.defineProperties(command, {
      callerTrace: {
        value: "trace-123",
        writable: false,
        enumerable: false,
        configurable: true,
      },
      lazyCallerState: {
        get: () => {
          accessorReads += 1;
          return state;
        },
        enumerable: false,
        configurable: true,
      },
    });
    Object.defineProperty(command, callerState, {
      value: state,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    const originalDescriptors = Object.getOwnPropertyDescriptors(command);
    const send = vi.fn();
    const kwargs: Record<PropertyKey, unknown> = {
      model: command.input["modelId"],
      messages: [],
      [BEDROCK_NATIVE_COMMAND]: command,
    };

    adapter.prepareCall({ send }, kwargs as Record<string, unknown>, callOptions(false))();

    const sent = send.mock.calls[0]?.[0] as ConverseCommand;
    expect(Object.getOwnPropertyDescriptor(sent, "callerTrace")).toEqual(
      Object.getOwnPropertyDescriptor(command, "callerTrace"),
    );
    expect(Object.getOwnPropertyDescriptor(sent, "lazyCallerState")).toEqual(
      Object.getOwnPropertyDescriptor(command, "lazyCallerState"),
    );
    expect(Object.getOwnPropertyDescriptor(sent, callerState)).toEqual(
      Object.getOwnPropertyDescriptor(command, callerState),
    );
    expect(accessorReads).toBe(0);
    expect(Object.getOwnPropertyDescriptors(command)).toEqual(originalDescriptors);
    expect(sent.input).not.toHaveProperty("solwyn_tags");
  });

  it("fails before dispatch when caller state cannot be preserved on the sibling", () => {
    class LockedStateConverseCommand {
      readonly lockedState: { customized: boolean };

      constructor(public readonly input: Record<string, unknown>) {
        this.lockedState = { customized: false };
        Object.defineProperty(this, "lockedState", {
          configurable: false,
          enumerable: false,
          writable: false,
        });
      }
    }
    const command = new LockedStateConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      solwyn_tags: { customer: "acme" },
    });
    command.lockedState.customized = true;
    const send = vi.fn();
    const kwargs: Record<PropertyKey, unknown> = {
      model: command.input["modelId"],
      messages: [],
      [BEDROCK_NATIVE_COMMAND]: command,
    };

    expect(() =>
      adapter.prepareCall({ send }, kwargs as Record<string, unknown>, callOptions(false)),
    ).toThrow(ConfigurationError);
    expect(send).not.toHaveBeenCalled();
    expect(command.lockedState).toEqual({ customized: true });
    expect(command.input).toHaveProperty("solwyn_tags", { customer: "acme" });
  });

  it("sanitizes a constructor failure while rebuilding a tagged command", () => {
    const sentinel = "SECRET_CONSTRUCTOR_SENTINEL";
    let constructions = 0;
    class InstrumentedConverseCommand {
      constructor(public readonly input: Record<string, unknown>) {
        constructions += 1;
        if (constructions > 1) {
          throw new Error(`caller constructor leaked ${sentinel}`);
        }
      }
    }
    const input = {
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      solwyn_tags: { customer: "acme" },
    };
    const command = new InstrumentedConverseCommand(input);
    const commandDescriptors = Object.getOwnPropertyDescriptors(command);
    const inputDescriptors = Object.getOwnPropertyDescriptors(input);
    const send = vi.fn();
    const kwargs: Record<PropertyKey, unknown> = {
      model: input.modelId,
      messages: [],
      [BEDROCK_NATIVE_COMMAND]: command,
    };

    let failure: unknown;
    try {
      adapter.prepareCall({ send }, kwargs as Record<string, unknown>, callOptions(false));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(failure).toMatchObject({
      field: null,
      message: "Bedrock command reconstruction could not construct a safe sibling",
    });
    expect(Object.hasOwn(failure as object, "cause")).toBe(false);
    expect(String(failure)).not.toContain(sentinel);
    expect(send).not.toHaveBeenCalled();
    expect(constructions).toBe(2);
    expect(command.input).toBe(input);
    expect(Object.getOwnPropertyDescriptors(command)).toEqual(commandDescriptors);
    expect(Object.getOwnPropertyDescriptors(input)).toEqual(inputDescriptors);
    expect(command.input).toHaveProperty("solwyn_tags", { customer: "acme" });
  });

  it("rebuilds a same-constructor sibling when the served model overrides the command's modelId", () => {
    const messages = [{ role: "user", content: [{ text: "hi" }] }];
    const command = new ConverseCommand({
      modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages,
    });
    const send = vi.fn((..._args: unknown[]) => "ok");
    const client = { send };
    // A bedrock→bedrock failover hop: the pipeline's merged `model` is the FALLBACK entry's
    // model, different from the primary command's baked-in modelId.
    const kwargs: Record<PropertyKey, unknown> = {
      model: "meta.llama3-1-70b-instruct-v1:0",
      messages,
      [BEDROCK_NATIVE_COMMAND]: command,
    };

    adapter.prepareCall(client, kwargs as Record<string, unknown>, callOptions(false))();

    const sent = send.mock.calls[0]?.[0] as ConverseCommand;
    // A NEW sibling of the same constructor — never the original instance.
    expect(sent).not.toBe(command);
    expect(sent).toBeInstanceOf(ConverseCommand);
    // The served model is forced onto modelId; the customer's other input is preserved.
    expect(sent.input).toEqual({ modelId: "meta.llama3-1-70b-instruct-v1:0", messages });
    // The customer's ORIGINAL command is never mutated.
    expect(command.input).toEqual({
      modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages,
    });
  });

  it("rebuilds to honor a non-empty entry default_params (fill-absent: command input wins)", () => {
    const command = new ConverseCommand({
      modelId: "amazon.nova-pro-v1:0",
      messages: [],
      inferenceConfig: { maxTokens: 256 }, // per-call — must WIN over the entry default
    });
    const send = vi.fn();
    const client = { send };
    // Same model (no override), but the served entry carries default_params.
    const kwargs: Record<PropertyKey, unknown> = {
      model: "amazon.nova-pro-v1:0",
      messages: [],
      [BEDROCK_NATIVE_COMMAND]: command,
    };
    const options: PrepareCallOptions = {
      ...callOptions(false),
      entryDefaultParams: {
        inferenceConfig: { maxTokens: 16 },
        additionalModelRequestFields: { reasoning: true },
      },
    };

    adapter.prepareCall(client, kwargs as Record<string, unknown>, options)();

    const sent = send.mock.calls[0]?.[0] as ConverseCommand;
    expect(sent).not.toBe(command);
    expect(sent).toBeInstanceOf(ConverseCommand);
    // The default fills the ABSENT key; the customer's own inferenceConfig wins (fill-absent).
    expect(sent.input).toEqual({
      modelId: "amazon.nova-pro-v1:0",
      messages: [],
      inferenceConfig: { maxTokens: 256 },
      additionalModelRequestFields: { reasoning: true },
    });
  });

  it("passes the ORIGINAL command through by identity when neither model nor defaults reshape", () => {
    const command = new ConverseCommand({ modelId: "amazon.nova-pro-v1:0", messages: [] });
    const send = vi.fn();
    const client = { send };
    const kwargs: Record<PropertyKey, unknown> = {
      model: "amazon.nova-pro-v1:0", // identical to the command's modelId
      messages: [],
      [BEDROCK_NATIVE_COMMAND]: command,
    };
    const options: PrepareCallOptions = { ...callOptions(false), entryDefaultParams: {} };

    adapter.prepareCall(client, kwargs as Record<string, unknown>, options)();

    // Identity passthrough — the primary-hop contract (no reshaping, middleware preserved).
    expect(send.mock.calls[0]?.[0]).toBe(command);
  });

  it("rebuilds a same-constructor sibling for a ConverseStreamCommand (streaming intent survives)", () => {
    class ConverseStreamCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    }
    const command = new ConverseStreamCommand({ modelId: "amazon.nova-pro-v1:0", messages: [] });
    const send = vi.fn();
    const client = { send };
    const kwargs: Record<PropertyKey, unknown> = {
      model: "meta.llama3-1-70b-instruct-v1:0", // override → rebuild
      messages: [],
      [BEDROCK_NATIVE_COMMAND]: command,
    };

    adapter.prepareCall(client, kwargs as Record<string, unknown>, callOptions(true))();

    const sent = send.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(ConverseStreamCommand);
    expect(sent).not.toBe(command);
  });

  it("strips a stray `stream` key from the rebuilt Converse input (streaming intent rides the command TYPE)", () => {
    // Converse carries streaming intent in the command TYPE, never an input field; a stray
    // `stream` member (a plausible leftover from OpenAI-style code, or an entry default) would be
    // rejected by the AWS SDK/service on a failover hop. The rebuild must delete it from BOTH the
    // command input and the merged entry defaults while every other field survives — deleting the
    // strip line would otherwise pass the rest of the suite, so this closes that regression gap.
    const command = new ConverseCommand({
      modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      stream: true, // stray input member
    });
    const send = vi.fn();
    const client = { send };
    const kwargs: Record<PropertyKey, unknown> = {
      model: "meta.llama3-1-70b-instruct-v1:0", // override → rebuild
      messages: [],
      [BEDROCK_NATIVE_COMMAND]: command,
    };
    const options: PrepareCallOptions = {
      ...callOptions(false),
      entryDefaultParams: { stream: true, inferenceConfig: { maxTokens: 32 } },
    };

    adapter.prepareCall(client, kwargs as Record<string, unknown>, options)();

    const sent = send.mock.calls[0]?.[0] as ConverseCommand;
    expect(sent).not.toBe(command);
    expect(sent).toBeInstanceOf(ConverseCommand);
    // The stray `stream` key is gone from the rebuilt sibling's input (from both sources).
    expect("stream" in sent.input).toBe(false);
    // Every other field survives: the served model, the customer messages, and the entry default.
    expect(sent.input["modelId"]).toBe("meta.llama3-1-70b-instruct-v1:0");
    expect(sent.input["messages"]).toEqual([]);
    expect(sent.input["inferenceConfig"]).toEqual({ maxTokens: 32 });
    // The customer's ORIGINAL command still carries its stray key untouched (never mutated).
    expect(command.input["stream"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unwrapStreamSource / wrapStreamResult
// ---------------------------------------------------------------------------

describe("BedrockAdapter.unwrapStreamSource", () => {
  it("returns the identity of the inner response['stream']", () => {
    const adapter = new BedrockAdapter();
    const inner = { [Symbol.iterator]: () => ({}) };
    const response = { stream: inner, ResponseMetadata: { HTTPStatusCode: 200 } };
    expect(adapter.unwrapStreamSource(response)).toBe(inner);
  });
});

describe("BedrockAdapter.wrapStreamResult", () => {
  const adapter = new BedrockAdapter();

  it("preserves every other top-level key on a same-dialect (mapping) served response", () => {
    const wrapper = { wrapped: true };
    const served = { stream: { old: true }, ResponseMetadata: { HTTPStatusCode: 200 } };
    const out = adapter.wrapStreamResult(wrapper, served) as Record<string, unknown>;
    expect(out["stream"]).toBe(wrapper);
    expect(out["ResponseMetadata"]).toEqual({ HTTPStatusCode: 200 });
  });

  it("builds a minimal { stream } object on a cross-provider (non-mapping) served response", () => {
    const wrapper = { wrapped: true };
    const foreignStream = "not-a-mapping";
    const out = adapter.wrapStreamResult(wrapper, foreignStream) as Record<string, unknown>;
    expect(out).toEqual({ stream: wrapper });
  });
});

// ---------------------------------------------------------------------------
// BedrockStreamAccumulator
// ---------------------------------------------------------------------------

describe("BedrockStreamAccumulator", () => {
  it("accumulates usage from the terminal metadata event; non-usage events are inert", () => {
    const acc = new BedrockStreamAccumulator(fakeLogger());
    acc.observe({ messageStart: { role: "assistant" } });
    acc.observe({ contentBlockDelta: { delta: {}, contentBlockIndex: 0 } });
    acc.observe({ messageStop: { stopReason: "end_turn" } });
    acc.observe({ metadata: { usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } } });

    const td = acc.finalize();
    expect(td.input_tokens).toBe(100);
    expect(td.output_tokens).toBe(40);
  });

  it("uses the same additive/5m formula for streamed cache fields", () => {
    const acc = new BedrockStreamAccumulator(fakeLogger());
    acc.observe({
      metadata: {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 40,
          cacheWriteInputTokens: 15,
        },
      },
    });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(155); // 100 + 40 + 15
    expect(td.cached_input_tokens).toBe(40);
    expect(td.cache_creation_5m_tokens).toBe(15);
    expect(td.cache_creation_1h_tokens).toBe(0);
  });

  it("settles at zero AND warns when it saw events but no usable metadata usage", () => {
    const logger = fakeLogger();
    const acc = new BedrockStreamAccumulator(logger);
    acc.observe({ messageStart: {} });
    acc.observe({ contentBlockDelta: {} });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(0);
    expect(td.output_tokens).toBe(0);
    expect(logger.warnings.some((w) => w.includes("metadata"))).toBe(true);
  });

  it("settles at zero WITHOUT warning on a truly untouched accumulator (no observe calls)", () => {
    const logger = fakeLogger();
    const acc = new BedrockStreamAccumulator(logger);
    const td = acc.finalize();
    expect(td.input_tokens).toBe(0);
    expect(logger.warnings).toHaveLength(0);
  });

  it("warns on a usage-less metadata event (regression: sawEvent must be set on metadata chunks)", () => {
    const logger = fakeLogger();
    const acc = new BedrockStreamAccumulator(logger);
    acc.observe({ metadata: { metrics: { latencyMs: 12 } } }); // metadata but NO usage
    const td = acc.finalize();
    expect(td.input_tokens).toBe(0);
    expect(logger.warnings.some((w) => w.includes("metadata"))).toBe(true);
  });

  it("treats a non-mapping chunk as a safe no-op (never throws, does not set sawEvent)", () => {
    const logger = fakeLogger();
    const acc = new BedrockStreamAccumulator(logger);
    expect(() => acc.observe(null)).not.toThrow();
    expect(() => acc.observe(undefined)).not.toThrow();
    expect(() => acc.observe("garbage")).not.toThrow();
    expect(() => acc.observe(42)).not.toThrow();
    const td = acc.finalize();
    expect(td.input_tokens).toBe(0);
    // No mapping chunk was ever observed → no warning (distinct from the abandoned-stream case).
    expect(logger.warnings).toHaveLength(0);
  });

  it("reads service tier from the metadata event (serviceTier.type)", () => {
    const acc = new BedrockStreamAccumulator(fakeLogger());
    acc.observe({
      metadata: { usage: { inputTokens: 1, outputTokens: 1 }, serviceTier: { type: "standard" } },
    });
    expect(acc.getServiceTier()).toBe("standard");
  });

  it("prefers serviceTier.type over performanceConfig.latency in the metadata event", () => {
    const acc = new BedrockStreamAccumulator(fakeLogger());
    acc.observe({
      metadata: {
        usage: { inputTokens: 1, outputTokens: 1 },
        serviceTier: { type: "standard" },
        performanceConfig: { latency: "optimized" },
      },
    });
    expect(acc.getServiceTier()).toBe("standard");
  });

  it("returns null service tier when no metadata event carried a tier", () => {
    const acc = new BedrockStreamAccumulator(fakeLogger());
    acc.observe({ messageStart: {} });
    acc.observe({ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } });
    expect(acc.getServiceTier()).toBeNull();
  });
});
