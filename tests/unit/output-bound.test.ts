import { describe, expect, it } from "vitest";
import { resolveAiSdkOutputBound, resolveEffectiveOutputBound } from "../../src/output-bound";

const DEFAULT_BOUND = 4096;

function hop(
  provider: string,
  dialect: "openai" | "anthropic" | "google" | "bedrock",
  model: string,
  defaultParams: unknown = {},
) {
  return { provider, dialect, model, defaultParams } as const;
}

describe("effective output bound", () => {
  it("normalizes OpenAI aliases per layer before applying caller precedence", () => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "openai",
        sourceDialect: "openai",
        sourceModel: "gpt-5.5",
        globalDefaults: { max_completion_tokens: 100 },
        callParams: { max_tokens: 700 },
        hops: [hop("openai", "openai", "gpt-5.5", { max_completion_tokens: 300 })],
        defaultBound: DEFAULT_BOUND,
      }),
    ).toBe(700);
  });

  it("normalizes the modern alias back to max_tokens for legacy and compat targets", () => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "groq",
        sourceDialect: "openai",
        sourceModel: "llama-3.3-70b",
        globalDefaults: { max_tokens: 100 },
        callParams: { max_completion_tokens: 650 },
        hops: [hop("groq", "openai", "llama-3.3-70b", { max_tokens: 300 })],
        defaultBound: DEFAULT_BOUND,
      }),
    ).toBe(650);
  });

  it("takes the largest effective contribution across configured same-dialect hops", () => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "openai",
        sourceDialect: "openai",
        sourceModel: "gpt-5.5",
        globalDefaults: {},
        callParams: {},
        hops: [
          hop("openai", "openai", "gpt-5.5", { max_tokens: 250 }),
          hop("openrouter", "openai", "meta/llama", { max_completion_tokens: 900 }),
        ],
        defaultBound: 128,
      }),
    ).toBe(900);
  });

  it("reads cross-dialect hops in the source dialect and ignores target-native defaults", () => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "google",
        sourceDialect: "google",
        sourceModel: "gemini-2.5-pro",
        globalDefaults: { config: { maxOutputTokens: 320 } },
        callParams: {},
        hops: [
          hop("google", "google", "gemini-2.5-pro"),
          hop("anthropic", "anthropic", "claude-opus-4", { max_tokens: 1_200 }),
        ],
        defaultBound: 64,
      }),
    ).toBe(320);
  });

  it("reads native Google config and ignores unsupported Python cap aliases", () => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "google",
        sourceDialect: "google",
        sourceModel: "gemini-2.5-pro",
        globalDefaults: { max_output_tokens: 100 },
        callParams: { config: { maxOutputTokens: 720 }, max_output_tokens: 900 },
        hops: [hop("google", "google", "gemini-2.5-pro")],
        defaultBound: DEFAULT_BOUND,
      }),
    ).toBe(720);
  });

  it("reads Bedrock inferenceConfig.maxTokens", () => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "bedrock",
        sourceDialect: "bedrock",
        sourceModel: "anthropic.claude-3",
        globalDefaults: {},
        callParams: { inferenceConfig: { maxTokens: 845 } },
        hops: [hop("bedrock", "bedrock", "anthropic.claude-3")],
        defaultBound: DEFAULT_BOUND,
      }),
    ).toBe(845);
  });

  it.each([
    ["google", "config", { maxOutputTokens: 128 }],
    ["bedrock", "inferenceConfig", { maxTokens: 128 }],
  ] as const)("projects replacement of the whole native %s config object", (dialect, key, cap) => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: dialect,
        sourceDialect: dialect,
        sourceModel: "model",
        globalDefaults: { [key]: cap },
        callParams: { [key]: {} },
        hops: [hop(dialect, dialect, "model")],
        defaultBound: DEFAULT_BOUND,
      }),
    ).toBe(DEFAULT_BOUND);
  });

  it("does not reserve an ignored Python-shaped Google cap", () => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "google",
        sourceDialect: "google",
        sourceModel: "gemini-2.5-flash",
        globalDefaults: {},
        callParams: { config: { max_output_tokens: 128 }, max_output_tokens: 128 },
        hops: [hop("google", "google", "gemini-2.5-flash")],
        defaultBound: DEFAULT_BOUND,
      }),
    ).toBe(DEFAULT_BOUND);
  });

  it.each([
    null,
    true,
    "321",
    1.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    0,
    -1,
  ])("uses the configured default for an unusable cap %j", (value) => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "anthropic",
        sourceDialect: "anthropic",
        sourceModel: "claude-opus-4",
        globalDefaults: {},
        callParams: { max_tokens: value },
        hops: [hop("anthropic", "anthropic", "claude-opus-4")],
        defaultBound: 777,
      }),
    ).toBe(777);
  });

  it("does not mutate frozen caller/default objects", () => {
    const globalDefaults = Object.freeze({ max_tokens: 100 });
    const entryDefaults = Object.freeze({ max_completion_tokens: 200 });
    const callParams = Object.freeze({ max_tokens: 300 });

    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "openai",
        sourceDialect: "openai",
        sourceModel: "gpt-5.5",
        globalDefaults,
        callParams,
        hops: [hop("openai", "openai", "gpt-5.5", entryDefaults)],
        defaultBound: DEFAULT_BOUND,
      }),
    ).toBe(300);
    expect(globalDefaults).toEqual({ max_tokens: 100 });
    expect(entryDefaults).toEqual({ max_completion_tokens: 200 });
    expect(callParams).toEqual({ max_tokens: 300 });
  });

  it("never touches unrelated getters while resolving caps", () => {
    const params = { max_tokens: 611 };
    Object.defineProperty(params, "messages", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_CONTENT");
      },
    });

    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "anthropic",
        sourceDialect: "anthropic",
        sourceModel: "claude-opus-4",
        globalDefaults: {},
        callParams: params,
        hops: [hop("anthropic", "anthropic", "claude-opus-4")],
        defaultBound: DEFAULT_BOUND,
      }),
    ).toBe(611);
  });

  it.each([
    [
      "throwing cap getter",
      () => {
        const params = {};
        Object.defineProperty(params, "max_tokens", {
          get() {
            throw new Error("PRIVATE_CAP");
          },
        });
        return params;
      },
    ],
    [
      "revoked mapping",
      () => {
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        return revocable.proxy;
      },
    ],
    ["malformed Google config", () => ({ config: 17 })],
  ])("degrades a hop with a %s to the configured default", (_label, makeParams) => {
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: _label.includes("Google") ? "google" : "anthropic",
        sourceDialect: _label.includes("Google") ? "google" : "anthropic",
        sourceModel: "model",
        globalDefaults: {},
        callParams: makeParams(),
        hops: [
          hop(
            _label.includes("Google") ? "google" : "anthropic",
            _label.includes("Google") ? "google" : "anthropic",
            "model",
          ),
        ],
        defaultBound: 733,
      }),
    ).toBe(733);
  });

  it("uses only the effective primary Responses max_output_tokens mapping", () => {
    const fallbackDefaults = {};
    Object.defineProperty(fallbackDefaults, "max_output_tokens", {
      get() {
        throw new Error("FALLBACK_MUST_NOT_BE_READ");
      },
    });

    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "openai",
        sourceDialect: "openai",
        sourceModel: "gpt-5.5",
        globalDefaults: { max_tokens: 900 },
        callParams: { max_output_tokens: 512, max_completion_tokens: 1_200 },
        hops: [
          hop("openai", "openai", "gpt-5.5"),
          hop("openrouter", "openai", "fallback", fallbackDefaults),
        ],
        defaultBound: 777,
        responses: true,
      }),
    ).toBe(512);
    expect(
      resolveEffectiveOutputBound({
        sourceProvider: "openai",
        sourceDialect: "openai",
        sourceModel: "gpt-5.5",
        globalDefaults: {},
        callParams: { max_completion_tokens: 1_200 },
        hops: [],
        defaultBound: 777,
        responses: true,
      }),
    ).toBe(777);
  });
});

describe("AI SDK output bound", () => {
  it.each([
    [512, 512],
    [undefined, 777],
    [true, 777],
    [0, 777],
    [1.5, 777],
    [Number.MAX_SAFE_INTEGER + 1, 777],
  ])("maps maxOutputTokens=%j to %i", (maxOutputTokens, expected) => {
    expect(resolveAiSdkOutputBound({ maxOutputTokens }, 777)).toBe(expected);
  });
});
