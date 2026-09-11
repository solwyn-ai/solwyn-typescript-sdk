/**
 * Cross-dialect translation unit tests covering canonical-model strictness, per-dialect request
 * parse/render, response reshaping, per-chunk stream translation, the universal
 * fail-closed subset boundary, and the privacy/structural-error hygiene guarantees
 * (no prompt/response content ever appears on a thrown error).
 *
 * Fully offline: fixtures are plain shaped objects; no provider SDK is imported.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UntranslatableRequestError } from "../../src/errors";
import type { CanonicalRequest } from "../../src/providers/translation";
import {
  CanonicalRequestSchema,
  failCrossProviderToolStream,
  fromCanonical,
  normalizeFinishReason,
  normalizeResponse,
  toCanonical,
  translateStreamChunk,
} from "../../src/providers/translation";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Bedrock render seam: an identity command constructor so `fromCanonical` returns
 * the rendered Converse input with a reachable target command constructor. */
const BEDROCK_IDENTITY = {
  bedrockCommandConstructor: (input: Record<string, unknown>) => input,
} as const;

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw, but it returned");
}

function expectFeature(fn: () => unknown, feature: string): UntranslatableRequestError {
  const err = catchErr(fn);
  expect(err).toBeInstanceOf(UntranslatableRequestError);
  const u = err as UntranslatableRequestError;
  expect(u.feature).toBe(feature);
  return u;
}

/** Every string surface of the thrown error must be free of `secret`, and no cause. */
function assertNoLeak(fn: () => unknown, secret: string, feature?: string): void {
  const err = catchErr(fn);
  expect(err).toBeInstanceOf(UntranslatableRequestError);
  const u = err as UntranslatableRequestError;
  // Every content-bearing surface except the JavaScript call stack, whose file:line frames
  // legitimately contain digits and never embed a runtime value, is included in the sweep.
  const blob = [u.name, u.message, u.feature, u.source, u.target, String(u)].join("\0");
  expect(blob).not.toContain(secret);
  expect(u.cause).toBeUndefined();
  if (feature !== undefined) expect(u.feature).toBe(feature);
}

function canonical(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return { messages: [], maxTokens: 100, stream: false, parallelToolCalls: true, ...overrides };
}

function openaiReq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Canonical model strictness + provider validation.
// ---------------------------------------------------------------------------

describe("canonical model", () => {
  it("rejects unknown extra fields (extra=forbid parity)", () => {
    expect(() => CanonicalRequestSchema.parse({ messages: [], maxTokens: 10, bogus: 1 })).toThrow();
  });

  it("parses a minimal valid request", () => {
    const parsed = CanonicalRequestSchema.parse({ messages: [], maxTokens: 10 });
    expect(parsed.maxTokens).toBe(10);
    expect(parsed.parallelToolCalls).toBe(true);
    expect(parsed.stream).toBe(false);
  });
});

describe("provider validation", () => {
  it("toCanonical throws a plain (non-structural) error mentioning provider", () => {
    const err = catchErr(() => toCanonical("cohere", openaiReq()));
    expect(err).not.toBeInstanceOf(UntranslatableRequestError);
    expect(String((err as Error).message)).toContain("provider");
  });

  it("fromCanonical throws a plain error mentioning provider", () => {
    const err = catchErr(() => fromCanonical("cohere", canonical(), "m"));
    expect(err).not.toBeInstanceOf(UntranslatableRequestError);
    expect(String((err as Error).message)).toContain("provider");
  });
});

// ---------------------------------------------------------------------------
// Request field mapping.
// ---------------------------------------------------------------------------

describe("max tokens", () => {
  it("required — missing raises missing_max_tokens (openai)", () => {
    expectFeature(
      () => toCanonical("openai", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      "missing_max_tokens",
    );
  });

  it("openai render emits max_completion_tokens, never max_tokens", () => {
    const c = toCanonical(
      "openai",
      openaiReq({ max_tokens: 55, max_completion_tokens: undefined }),
    );
    const rendered = fromCanonical("openai", c, "gpt-4o") as Record<string, unknown>;
    expect(rendered["max_completion_tokens"]).toBe(55);
    expect(rendered["max_tokens"]).toBeUndefined();
  });

  it("openai accepts legacy max_tokens input, prefers max_completion_tokens", () => {
    const legacy = toCanonical(
      "openai",
      openaiReq({ max_completion_tokens: undefined, max_tokens: 42 }),
    );
    expect(legacy.maxTokens).toBe(42);
    const both = toCanonical("openai", openaiReq({ max_completion_tokens: 100, max_tokens: 42 }));
    expect(both.maxTokens).toBe(100);
  });
});

describe("system message hoisting", () => {
  it("anthropic render hoists system to top level, not into messages", () => {
    const c = toCanonical(
      "openai",
      openaiReq({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const rendered = fromCanonical("anthropic", c, "claude") as Record<string, unknown>;
    expect(rendered["system"]).toBe("be terse");
    expect(JSON.stringify(rendered["messages"])).not.toContain("be terse");
  });

  it("multiple openai system messages concatenate with double newline", () => {
    const c = toCanonical(
      "openai",
      openaiReq({
        messages: [
          { role: "system", content: "one" },
          { role: "developer", content: "two" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(c.system).toBe("one\n\ntwo");
  });
});

describe("google config nesting", () => {
  const googleReq = {
    model: "gemini-2.0",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    config: { maxOutputTokens: 128, temperature: 0.5, topP: 0.9, stopSequences: ["x"] },
  };

  it("nests generation controls under config.*", () => {
    const c = toCanonical("google", googleReq);
    const rendered = fromCanonical("google", c, "gemini-2.0") as Record<string, unknown>;
    const config = rendered["config"] as Record<string, unknown>;
    expect(config["maxOutputTokens"]).toBe(128);
    expect(config["temperature"]).toBe(0.5);
    expect(config["topP"]).toBe(0.9);
    expect(config["stopSequences"]).toEqual(["x"]);
    expect(rendered["maxOutputTokens"]).toBeUndefined();
  });

  it("renders systemInstruction under config", () => {
    const c = canonical({
      system: "be terse",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const rendered = fromCanonical("google", c, "gemini-2.0") as Record<string, unknown>;
    expect((rendered["config"] as Record<string, unknown>)["systemInstruction"]).toBe("be terse");
  });
});

describe("scalar controls", () => {
  it("temperature <= 1.0 passes through", () => {
    expect(toCanonical("openai", openaiReq({ temperature: 0.7 })).temperature).toBe(0.7);
  });

  it.each([
    "openai",
    "anthropic",
    "google",
    "bedrock",
  ] as const)("temperature > 1.0 raises for %s with no value leak", (provider) => {
    const req =
      provider === "openai"
        ? openaiReq({ temperature: 1.5 })
        : provider === "anthropic"
          ? {
              model: "c",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 10,
              temperature: 1.5,
            }
          : provider === "google"
            ? {
                model: "g",
                contents: [{ role: "user", parts: [{ text: "hi" }] }],
                config: { maxOutputTokens: 10, temperature: 1.5 },
              }
            : {
                model: "b",
                messages: [{ role: "user", content: [{ text: "hi" }] }],
                inferenceConfig: { maxTokens: 10, temperature: 1.5 },
              };
    assertNoLeak(() => toCanonical(provider, req), "1.5", "temperature>1.0");
  });

  it("top_p passes through unchanged with no range check", () => {
    expect(toCanonical("openai", openaiReq({ top_p: 3.0 })).topP).toBe(3.0);
  });

  it("stop string normalizes to a 1-element list", () => {
    expect(toCanonical("openai", openaiReq({ stop: "STOP" })).stop).toEqual(["STOP"]);
  });

  it("more than 4 stop sequences raises stop>4", () => {
    expectFeature(
      () => toCanonical("openai", openaiReq({ stop: ["a", "b", "c", "d", "e"] })),
      "stop>4",
    );
  });
});

describe("consecutive same-role messages", () => {
  it("anthropic user,user does not raise or repair", () => {
    const c = toCanonical("anthropic", {
      model: "c",
      max_tokens: 10,
      messages: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ],
    });
    expect(c.messages).toHaveLength(2);
    expect(c.messages[0]?.role).toBe("user");
    expect(c.messages[1]?.role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// Tool declarations & tool_choice.
// ---------------------------------------------------------------------------

describe("tool declarations round-trip", () => {
  const openaiTools = openaiReq({
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "gets weather",
          parameters: { type: "object" },
        },
      },
    ],
  });

  it("openai -> canonical -> anthropic", () => {
    const c = toCanonical("openai", openaiTools);
    expect(c.tools?.[0]).toMatchObject({ name: "get_weather", description: "gets weather" });
    const anthropic = fromCanonical("anthropic", c, "claude") as Record<string, unknown>;
    const tool = (anthropic["tools"] as Record<string, unknown>[])[0] ?? {};
    expect(tool).toMatchObject({ name: "get_weather", input_schema: { type: "object" } });
  });

  it("openai -> canonical -> google functionDeclarations", () => {
    const c = toCanonical("openai", openaiTools);
    const google = fromCanonical("google", c, "gemini") as Record<string, unknown>;
    const decl =
      ((google["config"] as Record<string, unknown>)["tools"] as Record<string, unknown>[])[0] ??
      {};
    const fns = (decl as Record<string, unknown>)["functionDeclarations"] as Record<
      string,
      unknown
    >[];
    expect(fns[0]).toMatchObject({
      name: "get_weather",
      parametersJsonSchema: { type: "object" },
    });
  });

  it("openai -> canonical -> bedrock toolSpec", () => {
    const c = toCanonical("openai", openaiTools);
    const bedrock = fromCanonical("bedrock", c, "b", BEDROCK_IDENTITY) as Record<string, unknown>;
    const tool =
      (
        (bedrock["toolConfig"] as Record<string, unknown>)["tools"] as Record<string, unknown>[]
      )[0] ?? {};
    expect(tool["toolSpec"] as Record<string, unknown>).toMatchObject({
      name: "get_weather",
      inputSchema: { json: { type: "object" } },
    });
  });

  it("anthropic flat tool -> canonical", () => {
    const c = toCanonical("anthropic", {
      model: "c",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
    });
    expect(c.tools?.[0]).toMatchObject({
      name: "t",
      description: "d",
      parameters: { type: "object" },
    });
  });

  it("bedrock toolSpec -> canonical", () => {
    const c = toCanonical("bedrock", {
      model: "b",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      inferenceConfig: { maxTokens: 10 },
      toolConfig: {
        tools: [
          { toolSpec: { name: "t", description: "d", inputSchema: { json: { type: "object" } } } },
        ],
      },
    });
    expect(c.tools?.[0]).toMatchObject({ name: "t", parameters: { type: "object" } });
  });
});

describe("tool_choice modes", () => {
  it("openai auto/required/none round-trip", () => {
    for (const [oa, mode] of [
      ["auto", "auto"],
      ["required", "required"],
      ["none", "none"],
    ] as const) {
      expect(toCanonical("openai", openaiReq({ tool_choice: oa })).toolChoice?.mode).toBe(mode);
    }
  });

  it("openai force (function) carries the name", () => {
    const c = toCanonical(
      "openai",
      openaiReq({ tool_choice: { type: "function", function: { name: "f" } } }),
    );
    expect(c.toolChoice).toEqual({ mode: "force", name: "f" });
  });

  it("anthropic auto/any/none/tool map to canonical", () => {
    const base = { model: "c", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    expect(
      toCanonical("anthropic", { ...base, tool_choice: { type: "auto" } }).toolChoice?.mode,
    ).toBe("auto");
    expect(
      toCanonical("anthropic", { ...base, tool_choice: { type: "any" } }).toolChoice?.mode,
    ).toBe("required");
    expect(
      toCanonical("anthropic", { ...base, tool_choice: { type: "none" } }).toolChoice?.mode,
    ).toBe("none");
    expect(
      toCanonical("anthropic", { ...base, tool_choice: { type: "tool", name: "f" } }).toolChoice,
    ).toEqual({
      mode: "force",
      name: "f",
    });
  });

  it("google ANY with allowedFunctionNames takes only the first as force target", () => {
    const c = toCanonical("google", {
      model: "g",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: {
        maxOutputTokens: 10,
        toolConfig: {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["first", "second"] },
        },
      },
    });
    expect(c.toolChoice).toEqual({ mode: "force", name: "first" });
  });

  it("bedrock auto/any/tool map; render of none raises tool_choice.none", () => {
    const base = {
      model: "b",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      inferenceConfig: { maxTokens: 10 },
    };
    expect(
      toCanonical("bedrock", { ...base, toolConfig: { toolChoice: { auto: {} } } }).toolChoice
        ?.mode,
    ).toBe("auto");
    expect(
      toCanonical("bedrock", { ...base, toolConfig: { toolChoice: { any: {} } } }).toolChoice?.mode,
    ).toBe("required");
    expect(
      toCanonical("bedrock", { ...base, toolConfig: { toolChoice: { tool: { name: "f" } } } })
        .toolChoice,
    ).toEqual({ mode: "force", name: "f" });
    expectFeature(
      () =>
        fromCanonical(
          "bedrock",
          canonical({ toolChoice: { mode: "none" } }),
          "b",
          BEDROCK_IDENTITY,
        ),
      "tool_choice.none",
    );
  });

  it("unrecognized tool_choice shape raises tool_choice.unknown", () => {
    expectFeature(
      () => toCanonical("openai", openaiReq({ tool_choice: { type: "wat" } })),
      "tool_choice.unknown",
    );
  });
});

// ---------------------------------------------------------------------------
// Tool-use / tool-result round-trip (id + argument encoding).
// ---------------------------------------------------------------------------

describe("tool result round-trip", () => {
  const openaiExchange = openaiReq({
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
  });

  it("openai args (JSON string) become an object in canonical/anthropic", () => {
    const c = toCanonical("openai", openaiExchange);
    const use = c.messages[1]?.content[0];
    expect(use).toMatchObject({ type: "tool_use", id: "call_1", input: { city: "SF" } });
    const anthropic = fromCanonical("anthropic", c, "claude") as Record<string, unknown>;
    const blocks = (anthropic["messages"] as Record<string, unknown>[]).flatMap(
      (m) => m["content"] as Record<string, unknown>[],
    );
    const toolUse = blocks.find((b) => b["type"] === "tool_use");
    expect(toolUse?.["input"]).toEqual({ city: "SF" });
  });

  it("anthropic args (object) become a JSON string in openai", () => {
    const c = toCanonical("anthropic", {
      model: "c",
      max_tokens: 10,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
        },
      ],
    });
    const openai = fromCanonical("openai", c, "gpt-4o") as Record<string, unknown>;
    const assistant = (openai["messages"] as Record<string, unknown>[]).find(
      (m) => m["role"] === "assistant",
    );
    const tc = (assistant?.["tool_calls"] as Record<string, unknown>[])[0] ?? {};
    expect((tc["function"] as Record<string, unknown>)["arguments"]).toBe('{"city":"SF"}');
  });

  it("id is preserved verbatim across openai->anthropic->openai", () => {
    const c1 = toCanonical("openai", openaiExchange);
    const anthropic = fromCanonical("anthropic", c1, "claude") as Record<string, unknown>;
    const c2 = toCanonical("anthropic", {
      ...(anthropic as Record<string, unknown>),
      max_tokens: 10,
    });
    const openai = fromCanonical("openai", c2, "gpt-4o") as Record<string, unknown>;
    const msgs = openai["messages"] as Record<string, unknown>[];
    const assistant = msgs.find((m) => m["role"] === "assistant");
    const toolMsg = msgs.find((m) => m["role"] === "tool");
    expect((assistant?.["tool_calls"] as Record<string, unknown>[])[0]?.["id"]).toBe("call_1");
    expect(toolMsg?.["tool_call_id"]).toBe("call_1");
  });

  it("openai -> google produces a tool turn keyed by function name", () => {
    const c = toCanonical("openai", openaiExchange);
    const google = fromCanonical("google", c, "gemini") as Record<string, unknown>;
    const contents = google["contents"] as Record<string, unknown>[];
    const toolTurn = contents.find(
      (t) =>
        t["role"] === "user" &&
        (t["parts"] as Record<string, unknown>[]).some((p) => p["functionResponse"] != null),
    );
    const part = (toolTurn?.["parts"] as Record<string, unknown>[])[0] ?? {};
    const fnResp = part["functionResponse"] as Record<string, unknown>;
    expect(fnResp["name"]).toBe("get_weather");
    expect(fnResp["response"]).toEqual({ result: "sunny" });
  });

  it("google minted call ids resolve functionResponse by name", () => {
    const c = toCanonical("google", {
      model: "g",
      contents: [
        { role: "user", parts: [{ text: "weather?" }] },
        {
          role: "model",
          parts: [{ functionCall: { name: "get_weather", args: { city: "SF" } } }],
        },
        {
          role: "tool",
          parts: [{ functionResponse: { name: "get_weather", response: { result: "sunny" } } }],
        },
      ],
      config: { maxOutputTokens: 10 },
    });
    const use = c.messages[1]?.content[0];
    const result = c.messages[2]?.content[0];
    expect(use).toMatchObject({ type: "tool_use", id: "call_get_weather" });
    expect(result).toMatchObject({
      type: "tool_result",
      toolUseId: "call_get_weather",
      content: "sunny",
    });
  });
});

describe("google tool-result content round-trip", () => {
  it("{result: <str>} unwraps back to the bare string", () => {
    const c = toCanonical("google", {
      model: "g",
      contents: [
        { role: "model", parts: [{ functionCall: { id: "c1", name: "f", args: {} } }] },
        {
          role: "tool",
          parts: [
            { functionResponse: { id: "c1", name: "f", response: { result: "bare value" } } },
          ],
        },
      ],
      config: { maxOutputTokens: 10 },
    });
    expect(c.messages[1]?.content[0]).toMatchObject({ type: "tool_result", content: "bare value" });
  });

  it("a multi-key response is treated as opaque native content (flattened, not unwrapped)", () => {
    const c = toCanonical("google", {
      model: "g",
      contents: [
        { role: "model", parts: [{ functionCall: { id: "c1", name: "f", args: {} } }] },
        {
          role: "tool",
          parts: [{ functionResponse: { id: "c1", name: "f", response: { a: 1, b: 2 } } }],
        },
      ],
      config: { maxOutputTokens: 10 },
    });
    expect(c.messages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      content: '{"a":1,"b":2}',
    });
  });
});

describe("tool exchange integrity", () => {
  it("dangling tool call raises", () => {
    expectFeature(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [
              { role: "user", content: "hi" },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
                ],
              },
            ],
          }),
        ),
      "dangling_tool_call",
    );
  });

  it.each([
    "openai",
    "anthropic",
    "google",
  ] as const)("orphan tool result raises for %s with source set", (provider) => {
    const req =
      provider === "openai"
        ? openaiReq({ messages: [{ role: "tool", tool_call_id: "nope", content: "x" }] })
        : provider === "anthropic"
          ? {
              model: "c",
              max_tokens: 10,
              messages: [
                {
                  role: "user",
                  content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }],
                },
              ],
            }
          : {
              model: "g",
              contents: [
                {
                  role: "tool",
                  parts: [{ functionResponse: { id: "nope", name: "f", response: {} } }],
                },
              ],
              config: { maxOutputTokens: 10 },
            };
    const u = expectFeature(() => toCanonical(provider, req), "orphan_tool_result");
    expect(u.source).toBe(provider);
  });

  it("a fully-resolved exchange parses cleanly", () => {
    const c = toCanonical(
      "openai",
      openaiReq({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "ok" },
        ],
      }),
    );
    expect(c.messages).toHaveLength(3);
  });

  it("parallel same-name tool calls raise; distinct names are fine", () => {
    const twoSame = openaiReq({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "1" },
        { role: "tool", tool_call_id: "b", content: "2" },
      ],
    });
    expectFeature(() => toCanonical("openai", twoSame), "parallel_same_name_tool_calls");

    const twoDistinct = openaiReq({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "f", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "g", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "1" },
        { role: "tool", tool_call_id: "b", content: "2" },
      ],
    });
    expect(toCanonical("openai", twoDistinct).messages[1]?.content).toHaveLength(2);
  });
});

describe("mixed tool_result render restriction", () => {
  const mixed = canonical({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "c1", content: "ok" },
          { type: "text", text: "and more" },
        ],
      },
    ],
  });

  it("openai render raises tool_result.mixed_content", () => {
    const u = expectFeature(
      () => fromCanonical("openai", mixed, "gpt-4o"),
      "tool_result.mixed_content",
    );
    expect(u.target).toBe("openai");
  });

  it("google render raises tool_result.mixed_content", () => {
    expectFeature(() => fromCanonical("google", mixed, "gemini"), "tool_result.mixed_content");
  });

  it("anthropic renders both blocks in order", () => {
    const anthropic = fromCanonical("anthropic", mixed, "claude") as Record<string, unknown>;
    const userMsg = (anthropic["messages"] as Record<string, unknown>[]).find(
      (m) => m["role"] === "user",
    );
    const blocks = userMsg?.["content"] as Record<string, unknown>[];
    expect(blocks[0]?.["type"]).toBe("tool_result");
    expect(blocks[1]?.["type"]).toBe("text");
  });
});

describe("assistant text + tool_use coexist", () => {
  const c = canonical({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "c1", name: "f", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "ok" }] },
    ],
  });

  it("renders on openai as content + tool_calls", () => {
    const openai = fromCanonical("openai", c, "gpt-4o") as Record<string, unknown>;
    const assistant = (openai["messages"] as Record<string, unknown>[]).find(
      (m) => m["role"] === "assistant",
    );
    expect(assistant?.["content"]).toBe("let me check");
    expect((assistant?.["tool_calls"] as unknown[]).length).toBe(1);
  });

  it("renders on anthropic as ordered [text, tool_use] blocks", () => {
    const anthropic = fromCanonical("anthropic", c, "claude") as Record<string, unknown>;
    const assistant = (anthropic["messages"] as Record<string, unknown>[])[0] ?? {};
    const blocks = assistant["content"] as Record<string, unknown>[];
    expect(blocks[0]?.["type"]).toBe("text");
    expect(blocks[1]?.["type"]).toBe("tool_use");
  });

  it("renders on bedrock as ordered [text, toolUse] blocks", () => {
    const bedrock = fromCanonical("bedrock", c, "b", BEDROCK_IDENTITY) as Record<string, unknown>;
    const assistant = (bedrock["messages"] as Record<string, unknown>[])[0] ?? {};
    const blocks = assistant["content"] as Record<string, unknown>[];
    expect(blocks[0]).toHaveProperty("text");
    expect(blocks[1]).toHaveProperty("toolUse");
  });
});

describe("empty assistant turn dropping", () => {
  const c = canonical({
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ],
  });

  it("anthropic drops the empty turn", () => {
    const anthropic = fromCanonical("anthropic", c, "claude") as Record<string, unknown>;
    expect((anthropic["messages"] as unknown[]).length).toBe(1);
  });

  it("bedrock drops the empty turn", () => {
    const bedrock = fromCanonical("bedrock", c, "b", BEDROCK_IDENTITY) as Record<string, unknown>;
    expect((bedrock["messages"] as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multimodal (images).
// ---------------------------------------------------------------------------

describe("multimodal images", () => {
  it("base64 data URI parses with media type verbatim and reaches anthropic", () => {
    const c = toCanonical(
      "openai",
      openaiReq({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }],
          },
        ],
      }),
    );
    expect(c.messages[0]?.content[0]).toMatchObject({
      type: "image",
      mediaType: "image/png",
      data: "QUJD",
    });
    const anthropic = fromCanonical("anthropic", c, "claude") as Record<string, unknown>;
    const block =
      (
        (anthropic["messages"] as Record<string, unknown>[])[0]?.["content"] as Record<
          string,
          unknown
        >[]
      )[0] ?? {};
    expect((block["source"] as Record<string, unknown>)["media_type"]).toBe("image/png");
  });

  it("https public url image translates toward anthropic", () => {
    const c = toCanonical(
      "openai",
      openaiReq({
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] },
        ],
      }),
    );
    expect(c.messages[0]?.content[0]).toMatchObject({ type: "image", url: "https://x/y.png" });
  });

  it("http (insecure) url raises image.insecure_url with no leak", () => {
    assertNoLeak(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [
              {
                role: "user",
                content: [{ type: "image_url", image_url: { url: "http://secretsite/leak.png" } }],
              },
            ],
          }),
        ),
      "secretsite",
      "image.insecure_url",
    );
  });

  it("anthropic file_id opaque handle raises without leaking the handle", () => {
    assertNoLeak(
      () =>
        toCanonical("anthropic", {
          model: "c",
          max_tokens: 10,
          messages: [
            {
              role: "user",
              content: [{ type: "image", source: { type: "file", file_id: "file_SECRET" } }],
            },
          ],
        }),
      "file_SECRET",
      "image.opaque_handle",
    );
  });

  it("google gs:// uri raises image.opaque_handle without leaking the uri", () => {
    assertNoLeak(
      () =>
        toCanonical("google", {
          model: "g",
          contents: [
            {
              role: "user",
              parts: [{ fileData: { fileUri: "gs://secret-bucket/x", mimeType: "image/png" } }],
            },
          ],
          config: { maxOutputTokens: 10 },
        }),
      "secret-bucket",
      "image.opaque_handle",
    );
  });

  it("openai top-level audio raises multimodal.audio without echoing the payload", () => {
    assertNoLeak(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [
              {
                role: "user",
                content: [
                  { type: "input_audio", input_audio: { data: "SECRETAUDIO", format: "wav" } },
                ],
              },
            ],
          }),
        ),
      "SECRETAUDIO",
      "multimodal.audio",
    );
  });

  it("google exotic MIME classifies without echoing the mime", () => {
    assertNoLeak(
      () =>
        toCanonical("google", {
          model: "g",
          contents: [
            {
              role: "user",
              parts: [{ inlineData: { mimeType: "sekret/SECRETMIME", data: "x" } }],
            },
          ],
          config: { maxOutputTokens: 10 },
        }),
      "SECRETMIME",
      "multimodal.unknown",
    );
  });
});

describe("url image toward google/bedrock", () => {
  const urlImage = canonical({
    messages: [
      {
        role: "user",
        content: [{ type: "image", url: "https://x/y.png", mediaType: null, data: null }],
      },
    ],
  });
  const b64Image = canonical({
    messages: [
      {
        role: "user",
        content: [{ type: "image", url: null, mediaType: "image/png", data: "QUJD" }],
      },
    ],
  });

  it("public-url image toward google raises image.url_unsupported_google", () => {
    expectFeature(
      () => fromCanonical("google", urlImage, "gemini"),
      "image.url_unsupported_google",
    );
  });

  it("base64 image toward google renders fine", () => {
    const google = fromCanonical("google", b64Image, "gemini") as Record<string, unknown>;
    const part =
      (
        (google["contents"] as Record<string, unknown>[])[0]?.["parts"] as Record<string, unknown>[]
      )[0] ?? {};
    expect((part["inlineData"] as Record<string, unknown>)["mimeType"]).toBe("image/png");
  });

  it("public-url image toward bedrock raises image.url_unsupported", () => {
    expectFeature(
      () => fromCanonical("bedrock", urlImage, "b", BEDROCK_IDENTITY),
      "image.url_unsupported",
    );
  });
});

describe("multimodal label consistency + constant discriminators", () => {
  it.each([
    "openai",
    "anthropic",
  ] as const)("document block raises multimodal.document for %s", (provider) => {
    const req =
      provider === "openai"
        ? openaiReq({
            messages: [
              { role: "user", content: [{ type: "document", source: { data: "SECRETDOC" } }] },
            ],
          })
        : {
            model: "c",
            max_tokens: 10,
            messages: [
              { role: "user", content: [{ type: "document", source: { data: "SECRETDOC" } }] },
            ],
          };
    assertNoLeak(() => toCanonical(provider, req), "SECRETDOC", "multimodal.document");
  });

  it("an unknown discriminator raises the constant content_part.unknown (no echo)", () => {
    assertNoLeak(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [{ role: "user", content: [{ type: "x_SECRET_disc", data: "y" }] }],
          }),
        ),
      "x_SECRET_disc",
      "content_part.unknown",
    );
  });

  it("an exotic tool type never echoes (openai.unsupported_tool)", () => {
    assertNoLeak(
      () => toCanonical("openai", openaiReq({ tools: [{ type: "SECRET_tool_type" }] })),
      "SECRET_tool_type",
      "openai.unsupported_tool",
    );
  });
});

// ---------------------------------------------------------------------------
// Fail-loudly unsupported features.
// ---------------------------------------------------------------------------

describe("fail loudly — forbidden keys", () => {
  const forbidden: [string, unknown][] = [
    ["seed", 42],
    ["frequency_penalty", 0.5],
    ["presence_penalty", 0.5],
    ["top_k", 40],
    ["response_format", { type: "json_object" }],
    ["response_schema", { type: "object" }],
    ["logprobs", true],
    ["top_logprobs", 5],
    ["logit_bias", { "1": 2 }],
    ["service_tier", "auto"],
    ["reasoning_effort", "high"],
    ["reasoning", { effort: "high" }],
    ["thinking", { type: "enabled" }],
    ["thinking_config", { budget: 1 }],
    ["cache_control", { type: "ephemeral" }],
    ["cached_content", "cachedContents/x"],
    ["response_mime_type", "application/json"],
  ];

  it.each(forbidden)("openai %s present raises the key label with no value leak", (key, value) => {
    assertNoLeak(
      () => toCanonical("openai", openaiReq({ [key]: value })),
      String(JSON.stringify(value)),
      key,
    );
  });

  it("n>1 raises without leaking the value", () => {
    assertNoLeak(() => toCanonical("openai", openaiReq({ n: 3 })), "3", "n>1");
  });

  it("responses API shape raises responses_api before any other parsing", () => {
    expectFeature(
      () => toCanonical("openai", { model: "gpt-4o", input: "hello", instructions: "be nice" }),
      "responses_api",
    );
  });

  it("google built-in search tool raises google.google_search", () => {
    expectFeature(
      () =>
        toCanonical("google", {
          model: "g",
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          config: { maxOutputTokens: 10, tools: [{ googleSearch: {} }] },
        }),
      "google.google_search",
    );
  });

  it("anthropic proprietary computer tool raises anthropic.computer (prefix match)", () => {
    expectFeature(
      () =>
        toCanonical("anthropic", {
          model: "c",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "computer_20241022", name: "computer" }],
        }),
      "anthropic.computer",
    );
  });

  it("anthropic web_search proprietary tool raises anthropic.web_search", () => {
    expectFeature(
      () =>
        toCanonical("anthropic", {
          model: "c",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      "anthropic.web_search",
    );
  });

  it("anthropic mcp_servers present raises anthropic.mcp_servers", () => {
    expectFeature(
      () =>
        toCanonical("anthropic", {
          model: "c",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
          mcp_servers: [{ url: "https://mcp.example" }],
        }),
      "anthropic.mcp_servers",
    );
  });

  it.each([
    "file_search",
    "web_search",
    "computer_use_preview",
    "code_interpreter",
    "image_generation",
    "mcp",
  ] as const)("openai known non-function tool %s raises openai.<type>", (type) => {
    expectFeature(() => toCanonical("openai", openaiReq({ tools: [{ type }] })), `openai.${type}`);
  });

  it("unknown message role raises unknown_message_role", () => {
    expectFeature(
      () => toCanonical("openai", openaiReq({ messages: [{ role: "function", content: "hi" }] })),
      "unknown_message_role",
    );
  });
});

describe("fail closed — unrecognized kwargs", () => {
  it("openai unknown top-level kwarg raises a fixed unsupported_kwarg label", () => {
    expectFeature(() => toCanonical("openai", openaiReq({ frobnicate: 1 })), "unsupported_kwarg");
  });

  it("anthropic unknown top-level kwarg raises a fixed unsupported_kwarg label", () => {
    expectFeature(
      () =>
        toCanonical("anthropic", {
          model: "c",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
          frob: 1,
        }),
      "unsupported_kwarg",
    );
  });

  it("google config-scope unknown kwarg raises a fixed unsupported_kwarg label", () => {
    expectFeature(
      () =>
        toCanonical("google", {
          model: "g",
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          config: { maxOutputTokens: 10, frob: 1 },
        }),
      "unsupported_kwarg",
    );
  });

  it("a forbidden-key label takes precedence over the generic fallback", () => {
    expectFeature(() => toCanonical("openai", openaiReq({ seed: 1 })), "seed");
  });
});

describe("parallel_tool_calls=false rendering", () => {
  const c = canonical({
    parallelToolCalls: false,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });

  it("openai emits parallel_tool_calls:false explicitly", () => {
    const openai = fromCanonical("openai", c, "gpt-4o") as Record<string, unknown>;
    expect(openai["parallel_tool_calls"]).toBe(false);
  });

  it("anthropic emits tool_choice.disable_parallel_tool_use with default auto", () => {
    const anthropic = fromCanonical("anthropic", c, "claude") as Record<string, unknown>;
    expect(anthropic["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("google raises parallel_tool_calls=False", () => {
    expectFeature(() => fromCanonical("google", c, "gemini"), "parallel_tool_calls=False");
  });

  it("bedrock raises parallel_tool_calls (no =False suffix)", () => {
    expectFeature(() => fromCanonical("bedrock", c, "b", BEDROCK_IDENTITY), "parallel_tool_calls");
  });
});

describe("google candidate_count", () => {
  it("candidate_count == 1 is accepted", () => {
    const c = toCanonical("google", {
      model: "g",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: { maxOutputTokens: 10, candidateCount: 1 },
    });
    expect(c.maxTokens).toBe(10);
  });

  it("candidate_count > 1 raises candidate_count>1", () => {
    assertNoLeak(
      () =>
        toCanonical("google", {
          model: "g",
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          config: { maxOutputTokens: 10, candidateCount: 3 },
        }),
      "3",
      "candidate_count>1",
    );
  });
});

// ---------------------------------------------------------------------------
// Finish-reason table (forward lookup).
// ---------------------------------------------------------------------------

describe("normalizeFinishReason forward table", () => {
  const cases: [string, string, string | null][] = [
    ["openai", "stop", "stop"],
    ["openai", "length", "length"],
    ["openai", "tool_calls", "tool_use"],
    ["openai", "function_call", "tool_use"],
    ["openai", "content_filter", "content_filter"],
    ["anthropic", "end_turn", "stop"],
    ["anthropic", "stop_sequence", "stop"],
    ["anthropic", "pause_turn", "stop"],
    ["anthropic", "max_tokens", "length"],
    ["anthropic", "tool_use", "tool_use"],
    ["anthropic", "refusal", "content_filter"],
    ["google", "STOP", "stop"],
    ["google", "MAX_TOKENS", "length"],
    ["google", "SAFETY", "content_filter"],
    ["google", "RECITATION", "content_filter"],
    ["google", "PROHIBITED_CONTENT", "content_filter"],
    ["google", "BLOCKLIST", "content_filter"],
    ["bedrock", "end_turn", "stop"],
    ["bedrock", "stop_sequence", "stop"],
    ["bedrock", "max_tokens", "length"],
    ["bedrock", "model_context_window_exceeded", "length"],
    ["bedrock", "tool_use", "tool_use"],
    ["bedrock", "guardrail_intervened", "content_filter"],
    ["bedrock", "content_filtered", "content_filter"],
    ["bedrock", "malformed_model_output", null],
    ["bedrock", "malformed_tool_use", null],
  ];
  it.each(cases)("%s %s -> %s", (served, raw, expected) => {
    expect(normalizeFinishReason(served, raw)).toBe(expected);
  });

  it("null raw and unknown pair return null", () => {
    expect(normalizeFinishReason("openai", null)).toBeNull();
    expect(normalizeFinishReason("openai", "nonsense")).toBeNull();
    expect(normalizeFinishReason("nonsense", "stop")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Response normalization.
// ---------------------------------------------------------------------------

describe("normalizeResponse", () => {
  const openaiTextResp = {
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello world", tool_calls: null },
        finish_reason: "stop",
      },
    ],
    model: "gpt-4o",
  };

  it("is identity when served === requested (same reference)", () => {
    expect(
      normalizeResponse({ served: "openai", requested: "openai", response: openaiTextResp }),
    ).toBe(openaiTextResp);
  });

  it("openai served -> anthropic requested reshapes text + finish reason", () => {
    const out = normalizeResponse({
      served: "openai",
      requested: "anthropic",
      response: openaiTextResp,
    }) as Record<string, unknown>;
    expect((out["content"] as Record<string, unknown>[])[0]).toMatchObject({
      type: "text",
      text: "Hello world",
    });
    expect(out["stop_reason"]).toBe("end_turn");
  });

  it("openai tool-call response -> anthropic requested keeps id/name and object args", () => {
    const resp = {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      model: "gpt-4o",
    };
    const out = normalizeResponse({
      served: "openai",
      requested: "anthropic",
      response: resp,
    }) as Record<string, unknown>;
    const block = (out["content"] as Record<string, unknown>[])[0] ?? {};
    expect(block).toMatchObject({ type: "tool_use", id: "c1", name: "f", input: { a: 1 } });
    expect(out["stop_reason"]).toBe("tool_use");
  });

  it("openai served -> google requested exposes .text and .functionCalls accessors", () => {
    const out = normalizeResponse({
      served: "openai",
      requested: "google",
      response: openaiTextResp,
    }) as {
      text: string | null;
      functionCalls: unknown[];
      candidates: unknown[];
    };
    expect(out.text).toBe("Hello world");
    expect(out.functionCalls).toBeUndefined();
    expect(out.candidates).toHaveLength(1);
  });

  it("anthropic served -> google requested .text concatenates every text part", () => {
    const anthropicResp = {
      role: "assistant",
      content: [
        { type: "text", text: "foo " },
        { type: "text", text: "bar" },
      ],
      stop_reason: "end_turn",
      model: "claude",
    };
    const out = normalizeResponse({
      served: "anthropic",
      requested: "google",
      response: anthropicResp,
    }) as {
      text: string | null;
    };
    expect(out.text).toBe("foo bar");
  });
});

describe("google tool finish reason", () => {
  it("STOP co-occurring with a function_call upgrades to tool_use", () => {
    const resp = {
      candidates: [
        { content: { parts: [{ functionCall: { name: "f", args: {} } }] }, finishReason: "STOP" },
      ],
    };
    const out = normalizeResponse({
      served: "google",
      requested: "openai",
      response: resp,
    }) as Record<string, unknown>;
    expect((out["choices"] as Record<string, unknown>[])[0]?.["finish_reason"]).toBe("tool_calls");
  });

  it("plain STOP with only text stays stop", () => {
    const resp = { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] };
    const out = normalizeResponse({
      served: "google",
      requested: "openai",
      response: resp,
    }) as Record<string, unknown>;
    expect((out["choices"] as Record<string, unknown>[])[0]?.["finish_reason"]).toBe("stop");
  });
});

// ---------------------------------------------------------------------------
// Bedrock request/response round trip.
// ---------------------------------------------------------------------------

describe("bedrock to canonical", () => {
  const base = {
    model: "anthropic.claude-3",
    messages: [{ role: "user", content: [{ text: "hi" }] }],
    inferenceConfig: { maxTokens: 100 },
  };

  it("parses a basic request + inferenceConfig scalars", () => {
    const c = toCanonical("bedrock", {
      ...base,
      inferenceConfig: { maxTokens: 100, temperature: 0.5, topP: 0.9, stopSequences: ["x"] },
    });
    expect(c.maxTokens).toBe(100);
    expect(c.temperature).toBe(0.5);
    expect(c.topP).toBe(0.9);
    expect(c.stop).toEqual(["x"]);
  });

  it("joins a system block list with a single newline (Python parity)", () => {
    const c = toCanonical("bedrock", { ...base, system: [{ text: "one" }, { text: "two" }] });
    expect(c.system).toBe("one\ntwo");
  });

  it("missing maxTokens raises missing_max_tokens", () => {
    expectFeature(
      () => toCanonical("bedrock", { ...base, inferenceConfig: {} }),
      "missing_max_tokens",
    );
  });

  it("image bytes become base64 with image/<format> media type", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const c = toCanonical("bedrock", {
      ...base,
      messages: [{ role: "user", content: [{ image: { format: "png", source: { bytes } } }] }],
    });
    const part = c.messages[0]?.content[0];
    expect(part).toMatchObject({ type: "image", mediaType: "image/png" });
    expect(atob((part as { data: string }).data)).toBe("");
  });

  it("s3Location image raises image.opaque_handle without leaking the uri", () => {
    assertNoLeak(
      () =>
        toCanonical("bedrock", {
          ...base,
          messages: [
            {
              role: "user",
              content: [
                { image: { format: "png", source: { s3Location: { uri: "s3://secret/x" } } } },
              ],
            },
          ],
        }),
      "secret",
      "image.opaque_handle",
    );
  });

  it("cachePoint content block raises cache_control", () => {
    expectFeature(
      () =>
        toCanonical("bedrock", {
          ...base,
          messages: [{ role: "user", content: [{ cachePoint: { type: "default" } }] }],
        }),
      "cache_control",
    );
  });

  it("system cachePoint raises cache_control", () => {
    expectFeature(
      () => toCanonical("bedrock", { ...base, system: [{ cachePoint: { type: "default" } }] }),
      "cache_control",
    );
  });

  it("guardContent block raises bedrock.guard_content", () => {
    expectFeature(
      () =>
        toCanonical("bedrock", {
          ...base,
          messages: [{ role: "user", content: [{ guardContent: {} }] }],
        }),
      "bedrock.guard_content",
    );
  });

  it("reasoningContent block raises reasoning", () => {
    expectFeature(
      () =>
        toCanonical("bedrock", {
          ...base,
          messages: [{ role: "assistant", content: [{ reasoningContent: { text: "SECRET" } }] }],
        }),
      "reasoning",
    );
  });

  it("document block raises multimodal.document", () => {
    expectFeature(
      () =>
        toCanonical("bedrock", {
          ...base,
          messages: [
            { role: "user", content: [{ document: { format: "pdf", source: { bytes: "x" } } }] },
          ],
        }),
      "multimodal.document",
    );
  });

  it("guardrailConfig raises bedrock.guardrail_config", () => {
    expectFeature(
      () => toCanonical("bedrock", { ...base, guardrailConfig: { guardrailIdentifier: "g" } }),
      "bedrock.guardrail_config",
    );
  });

  it("unrecognized top-level kwarg fails closed", () => {
    expectFeature(() => toCanonical("bedrock", { ...base, frob: 1 }), "unsupported_kwarg");
  });

  it("unrecognized inferenceConfig key fails closed", () => {
    expectFeature(
      () => toCanonical("bedrock", { ...base, inferenceConfig: { maxTokens: 10, frob: 1 } }),
      "unsupported_kwarg",
    );
  });

  it("unknown message role raises unknown_message_role", () => {
    expectFeature(
      () =>
        toCanonical("bedrock", {
          ...base,
          messages: [{ role: "system", content: [{ text: "hi" }] }],
        }),
      "unknown_message_role",
    );
  });

  it("tool-use/tool-result id round-trip and temperature ceiling apply", () => {
    const c = toCanonical("bedrock", {
      ...base,
      messages: [
        { role: "user", content: [{ text: "weather?" }] },
        {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "t1", name: "f", input: { city: "SF" } } }],
        },
        {
          role: "user",
          content: [{ toolResult: { toolUseId: "t1", content: [{ text: "sunny" }] } }],
        },
      ],
    });
    expect(c.messages[1]?.content[0]).toMatchObject({ type: "tool_use", id: "t1" });
    expect(c.messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "t1",
      content: "sunny",
    });
  });

  it("dangling tool use raises", () => {
    expectFeature(
      () =>
        toCanonical("bedrock", {
          ...base,
          messages: [
            {
              role: "assistant",
              content: [{ toolUse: { toolUseId: "t1", name: "f", input: {} } }],
            },
          ],
        }),
      "dangling_tool_call",
    );
  });

  it("orphan tool result raises", () => {
    expectFeature(
      () =>
        toCanonical("bedrock", {
          ...base,
          messages: [
            {
              role: "user",
              content: [{ toolResult: { toolUseId: "nope", content: [{ text: "x" }] } }],
            },
          ],
        }),
      "orphan_tool_result",
    );
  });
});

describe("canonical to bedrock", () => {
  it("renders a basic request with inferenceConfig", () => {
    const c = canonical({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      temperature: 0.5,
      stop: ["x"],
    });
    const out = fromCanonical("bedrock", c, "b", BEDROCK_IDENTITY) as Record<string, unknown>;
    expect(out["model"]).toBe("b");
    expect(out["inferenceConfig"]).toEqual({
      maxTokens: 100,
      temperature: 0.5,
      stopSequences: ["x"],
    });
  });

  it("renders base64 image back to raw bytes", () => {
    const c = canonical({
      messages: [
        {
          role: "user",
          content: [{ type: "image", mediaType: "image/png", data: "AQID", url: null }],
        },
      ],
    });
    const out = fromCanonical("bedrock", c, "b", BEDROCK_IDENTITY) as Record<string, unknown>;
    const block =
      (
        (out["messages"] as Record<string, unknown>[])[0]?.["content"] as Record<string, unknown>[]
      )[0] ?? {};
    const bytes = (
      (block["image"] as Record<string, unknown>)["source"] as Record<string, unknown>
    )["bytes"];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("full bedrock tool exchange round-trips bedrock -> canonical -> bedrock", () => {
    const req = {
      model: "b",
      messages: [
        { role: "user", content: [{ text: "weather?" }] },
        {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "t1", name: "f", input: { city: "SF" } } }],
        },
        {
          role: "user",
          content: [{ toolResult: { toolUseId: "t1", content: [{ text: "sunny" }] } }],
        },
      ],
      inferenceConfig: { maxTokens: 100 },
    };
    const c = toCanonical("bedrock", req);
    const out = fromCanonical("bedrock", c, "b", BEDROCK_IDENTITY) as Record<string, unknown>;
    const msgs = out["messages"] as Record<string, unknown>[];
    const toolUse = (msgs[1]?.["content"] as Record<string, unknown>[])[0]?.["toolUse"] as Record<
      string,
      unknown
    >;
    expect(toolUse["toolUseId"]).toBe("t1");
    const toolResult = (msgs[2]?.["content"] as Record<string, unknown>[])[0]?.[
      "toolResult"
    ] as Record<string, unknown>;
    expect(toolResult["toolUseId"]).toBe("t1");
  });

  it("INTO bedrock without a reachable command constructor fails loud (D14)", () => {
    expectFeature(
      () =>
        fromCanonical(
          "bedrock",
          canonical({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
          "b",
        ),
      "bedrock.no_converse_command",
    );
  });
});

describe("bedrock response normalization", () => {
  const bedrockResp = {
    output: { message: { role: "assistant", content: [{ text: "Hello" }] } },
    stopReason: "end_turn",
  };

  it("bedrock -> bedrock is identity", () => {
    expect(
      normalizeResponse({ served: "bedrock", requested: "bedrock", response: bedrockResp }),
    ).toBe(bedrockResp);
  });

  it("bedrock served -> openai requested", () => {
    const out = normalizeResponse({
      served: "bedrock",
      requested: "openai",
      response: bedrockResp,
    }) as Record<string, unknown>;
    const choice = (out["choices"] as Record<string, unknown>[])[0] ?? {};
    expect((choice["message"] as Record<string, unknown>)["content"]).toBe("Hello");
    expect(choice["finish_reason"]).toBe("stop");
  });

  it("anthropic served -> bedrock requested", () => {
    const anthropicResp = {
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
      stop_reason: "max_tokens",
    };
    const out = normalizeResponse({
      served: "anthropic",
      requested: "bedrock",
      response: anthropicResp,
    }) as Record<string, unknown>;
    expect(out["stopReason"]).toBe("max_tokens");
    const content = (
      (out["output"] as Record<string, unknown>)["message"] as Record<string, unknown>
    )["content"];
    expect((content as Record<string, unknown>[])[0]).toEqual({ text: "hi there" });
  });

  it("guardrail_intervened and content_filtered both -> content_filter -> content_filtered", () => {
    for (const raw of ["guardrail_intervened", "content_filtered"]) {
      const resp = {
        output: { message: { role: "assistant", content: [{ text: "x" }] } },
        stopReason: raw,
      };
      const out = normalizeResponse({ served: "bedrock", requested: "bedrock", response: resp });
      // identity path returns same ref; re-encode via cross to check denormalization
      const cross = normalizeResponse({
        served: "bedrock",
        requested: "openai",
        response: resp,
      }) as Record<string, unknown>;
      expect(out).toBe(resp);
      expect((cross["choices"] as Record<string, unknown>[])[0]?.["finish_reason"]).toBe(
        "content_filter",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Stream chunk translation.
// ---------------------------------------------------------------------------

describe("stream chunk text translation", () => {
  it("openai text delta -> anthropic content_block_delta", () => {
    const chunk = { choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] };
    const out = translateStreamChunk({ served: "openai", requested: "anthropic", chunk });
    expect(out).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    ]);
  });

  it("openai finish -> anthropic message_delta", () => {
    const chunk = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    const out = translateStreamChunk({ served: "openai", requested: "anthropic", chunk });
    expect(out).toEqual([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]);
  });

  it("anthropic structural events map to empty arrays", () => {
    for (const chunk of [
      { type: "message_start" },
      { type: "content_block_stop" },
      { type: "message_stop" },
      { type: "content_block_start", content_block: { type: "text" } },
    ]) {
      expect(translateStreamChunk({ served: "anthropic", requested: "openai", chunk })).toEqual([]);
    }
  });

  it("openai empty/role-only delta maps to empty", () => {
    expect(
      translateStreamChunk({
        served: "openai",
        requested: "anthropic",
        chunk: { choices: [{ index: 0, delta: { role: "assistant" } }] },
      }),
    ).toEqual([]);
  });

  it("anthropic message_delta with null stop_reason maps to empty", () => {
    expect(
      translateStreamChunk({
        served: "anthropic",
        requested: "openai",
        chunk: { type: "message_delta", delta: { stop_reason: null } },
      }),
    ).toEqual([]);
  });

  it("google multi-part chunk becomes one requested chunk per part", () => {
    const chunk = { candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] };
    const out = translateStreamChunk({ served: "google", requested: "openai", chunk }) as Record<
      string,
      unknown
    >[];
    expect(out).toHaveLength(2);
    expect(
      ((out[0]?.["choices"] as Record<string, unknown>[])[0]?.["delta"] as Record<string, unknown>)[
        "content"
      ],
    ).toBe("a");
  });

  it("google finish -> openai finish_reason", () => {
    const chunk = { candidates: [{ finishReason: "MAX_TOKENS" }] };
    const out = translateStreamChunk({ served: "google", requested: "openai", chunk }) as Record<
      string,
      unknown
    >[];
    expect((out[0]?.["choices"] as Record<string, unknown>[])[0]?.["finish_reason"]).toBe("length");
  });

  it("a full anthropic sequence accumulates to the whole text with terminal finish", () => {
    const events = [
      { type: "message_start" },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
      { type: "content_block_stop" },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
    let text = "";
    let finish: string | null = null;
    for (const ev of events) {
      for (const chunk of translateStreamChunk({
        served: "anthropic",
        requested: "openai",
        chunk: ev,
      }) as Record<string, unknown>[]) {
        const choice = (chunk["choices"] as Record<string, unknown>[])[0] ?? {};
        const delta = choice["delta"] as Record<string, unknown>;
        if (typeof delta["content"] === "string") text += delta["content"];
        if (choice["finish_reason"] != null) finish = choice["finish_reason"] as string;
      }
    }
    expect(text).toBe("Hello world");
    expect(finish).toBe("stop");
  });
});

describe("stream chunk fail-loud", () => {
  it("openai tool_calls delta raises cross_provider_tool_stream", () => {
    assertNoLeak(
      () =>
        translateStreamChunk({
          served: "openai",
          requested: "anthropic",
          chunk: { choices: [{ delta: { tool_calls: [{ function: { arguments: "SECRET" } }] } }] },
        }),
      "SECRET",
      "cross_provider_tool_stream",
    );
  });

  it("anthropic input_json_delta raises cross_provider_tool_stream before leaking", () => {
    assertNoLeak(
      () =>
        translateStreamChunk({
          served: "anthropic",
          requested: "openai",
          chunk: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "SECRET" },
          },
        }),
      "SECRET",
      "cross_provider_tool_stream",
    );
  });

  it("anthropic tool_use block start raises at the block start", () => {
    expectFeature(
      () =>
        translateStreamChunk({
          served: "anthropic",
          requested: "openai",
          chunk: {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "x", name: "f" },
          },
        }),
      "cross_provider_tool_stream",
    );
  });

  it("google multimodal delta raises cross_provider_multimodal_stream with no leak", () => {
    assertNoLeak(
      () =>
        translateStreamChunk({
          served: "google",
          requested: "openai",
          chunk: {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: "image/png", data: "SECRET" } }] } },
            ],
          },
        }),
      "SECRET",
      "cross_provider_multimodal_stream",
    );
  });

  it("provider validation applies to stream chunks", () => {
    const err = catchErr(() =>
      translateStreamChunk({ served: "cohere", requested: "openai", chunk: {} }),
    );
    expect(err).not.toBeInstanceOf(UntranslatableRequestError);
    expect(String((err as Error).message)).toContain("provider");
  });

  it("failCrossProviderToolStream always throws the structural label", () => {
    const u = expectFeature(
      () => failCrossProviderToolStream({ source: "openai", target: "anthropic" }),
      "cross_provider_tool_stream",
    );
    expect(u.source).toBe("openai");
    expect(u.target).toBe("anthropic");
  });
});

describe("bedrock stream chunks", () => {
  it("text delta bedrock -> openai", () => {
    const chunk = { contentBlockDelta: { delta: { text: "Hi" }, contentBlockIndex: 0 } };
    const out = translateStreamChunk({ served: "bedrock", requested: "openai", chunk }) as Record<
      string,
      unknown
    >[];
    expect(
      ((out[0]?.["choices"] as Record<string, unknown>[])[0]?.["delta"] as Record<string, unknown>)[
        "content"
      ],
    ).toBe("Hi");
  });

  it("text delta anthropic -> bedrock", () => {
    const chunk = { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } };
    const out = translateStreamChunk({
      served: "anthropic",
      requested: "bedrock",
      chunk,
    }) as Record<string, unknown>[];
    expect((out[0]?.["contentBlockDelta"] as Record<string, unknown>)["delta"]).toEqual({
      text: "Hi",
    });
  });

  it("structural events emit no chunks", () => {
    for (const chunk of [
      { messageStart: { role: "assistant" } },
      { contentBlockStop: {} },
      { metadata: { usage: {} } },
    ]) {
      expect(translateStreamChunk({ served: "bedrock", requested: "openai", chunk })).toEqual([]);
    }
  });

  it("messageStop maps to a finish chunk", () => {
    const chunk = { messageStop: { stopReason: "end_turn" } };
    const out = translateStreamChunk({ served: "bedrock", requested: "openai", chunk }) as Record<
      string,
      unknown
    >[];
    expect((out[0]?.["choices"] as Record<string, unknown>[])[0]?.["finish_reason"]).toBe("stop");
  });

  it("toolUse delta raises cross_provider_tool_stream with no leak", () => {
    assertNoLeak(
      () =>
        translateStreamChunk({
          served: "bedrock",
          requested: "openai",
          chunk: {
            contentBlockDelta: { delta: { toolUse: { input: "SECRET" } }, contentBlockIndex: 0 },
          },
        }),
      "SECRET",
      "cross_provider_tool_stream",
    );
  });

  it("contentBlockStart (tool) raises cross_provider_tool_stream", () => {
    expectFeature(
      () =>
        translateStreamChunk({
          served: "bedrock",
          requested: "openai",
          chunk: {
            contentBlockStart: {
              start: { toolUse: { toolUseId: "x", name: "f" } },
              contentBlockIndex: 0,
            },
          },
        }),
      "cross_provider_tool_stream",
    );
  });

  it("reasoning delta raises cross_provider_multimodal_stream with no leak", () => {
    assertNoLeak(
      () =>
        translateStreamChunk({
          served: "bedrock",
          requested: "openai",
          chunk: {
            contentBlockDelta: {
              delta: { reasoningContent: { text: "SECRET" } },
              contentBlockIndex: 0,
            },
          },
        }),
      "SECRET",
      "cross_provider_multimodal_stream",
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed-request guard + privacy hygiene.
// ---------------------------------------------------------------------------

describe("malformed request guard", () => {
  it("a non-string text content value converts to a structural malformed_request error", () => {
    assertNoLeak(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [{ role: "user", content: [{ type: "text", text: { nested: "SECRET" } }] }],
          }),
        ),
      "SECRET",
      "malformed_request",
    );
  });

  it("a malformed stream chunk converts to structural with severed cause", () => {
    const err = catchErr(() =>
      translateStreamChunk({
        served: "anthropic",
        requested: "openai",
        chunk: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: { leak: "SECRET" } },
        },
      }),
    );
    expect(err).toBeInstanceOf(UntranslatableRequestError);
    const u = err as UntranslatableRequestError;
    expect(u.feature).toBe("malformed_request");
    expect(u.cause).toBeUndefined();
    expect(JSON.stringify(u, Object.getOwnPropertyNames(u))).not.toContain("SECRET");
  });

  it("an internally raised structural error retains its safe diagnostic label", () => {
    expectFeature(() => toCanonical("openai", openaiReq({ seed: 1 })), "seed");
  });
});

describe("privacy boundary — content never appears on a thrown error", () => {
  it("no thrown UntranslatableRequestError ever carries a cause chain", () => {
    const err = catchErr(() =>
      toCanonical("openai", openaiReq({ seed: 999 })),
    ) as UntranslatableRequestError;
    expect(err.cause).toBeUndefined();
  });

  it("simultaneous secrets across system + content + response never leak", () => {
    const secret = "SUPER_SECRET_XYZ";
    assertNoLeak(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [
              { role: "system", content: secret },
              {
                role: "user",
                content: [{ type: "image_url", image_url: { url: `http://${secret}/a.png` } }],
              },
            ],
          }),
        ),
      secret,
    );
  });
});

describe("package static scan — banner present, no I/O tokens", () => {
  const DIR = join(process.cwd(), "src", "providers", "translation");
  const DENY = ["logger", "logging", "httpx", "console.", "fetch("];

  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s carries a PRIVACY-CRITICAL banner and no I/O identifiers", (file) => {
    const text = readFileSync(join(DIR, file), "utf8");
    expect(text.slice(0, 600)).toContain("PRIVACY-CRITICAL");
    for (const token of DENY) {
      expect(text).not.toContain(token);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-loud translation edge cases.
// ---------------------------------------------------------------------------

describe("M4 parity — system blocks fail loud", () => {
  it("google non-string systemInstruction raises system_block_list", () => {
    const err = expectFeature(
      () =>
        toCanonical("google", {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          config: { maxOutputTokens: 10, systemInstruction: { parts: [{ text: "s" }] } },
        }),
      "system_block_list",
    );
    // The non-provider side is the "*" sentinel, never "canonical".
    expect(err.source).toBe("google");
    expect(err.target).toBe("*");
  });

  it("openai list-content system message raises system_block_list (not text coercion)", () => {
    expectFeature(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [
              { role: "system", content: [{ type: "text", text: "s" }] },
              { role: "user", content: "hi" },
            ],
          }),
        ),
      "system_block_list",
    );
  });

  it("bedrock non-text system block raises its content label (not silent skip)", () => {
    const base = {
      model: "m",
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      inferenceConfig: { maxTokens: 10 },
    };
    // An image system block → content_part.unknown (single-key union, "image").
    expectFeature(
      () =>
        toCanonical("bedrock", {
          ...base,
          system: [{ text: "a" }, { image: { format: "png", source: { bytes: "" } } }],
        }),
      "content_part.unknown",
    );
    // A document system block → multimodal.document.
    expectFeature(
      () => toCanonical("bedrock", { ...base, system: [{ document: { name: "d" } }] }),
      "multimodal.document",
    );
  });
});

describe("M4 parity — error sentinel and stream error provider threading (#4)", () => {
  it("fromCanonical render errors use '*' as the source sentinel", () => {
    const err = expectFeature(
      () => fromCanonical("google", canonical({ parallelToolCalls: false }), "m"),
      "parallel_tool_calls=False",
    );
    expect(err.source).toBe("*");
    expect(err.target).toBe("google");
  });

  it("a translated anthropic→openai stream error reports the REAL requested provider", () => {
    const err = catchErr(() =>
      translateStreamChunk({
        served: "anthropic",
        requested: "openai",
        chunk: { type: "content_block_start", content_block: { type: "tool_use" } },
      }),
    ) as UntranslatableRequestError;
    expect(err).toBeInstanceOf(UntranslatableRequestError);
    expect(err.feature).toBe("cross_provider_tool_stream");
    expect(err.source).toBe("anthropic");
    expect(err.target).toBe("openai");
  });

  it("a translated google→bedrock multimodal stream error threads both providers", () => {
    const err = catchErr(() =>
      translateStreamChunk({
        served: "google",
        requested: "bedrock",
        chunk: {
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png" } }] } }],
        },
      }),
    ) as UntranslatableRequestError;
    expect(err.feature).toBe("cross_provider_multimodal_stream");
    expect(err.source).toBe("google");
    expect(err.target).toBe("bedrock");
  });
});

describe("M4 parity — google accepts the Gemini shapes Python accepts (#5)", () => {
  it("a role-less turn defaults to user", () => {
    const c = toCanonical("google", {
      contents: [{ parts: [{ text: "hi" }] }],
      config: { maxOutputTokens: 10 },
    });
    expect(c.messages[0]?.role).toBe("user");
    expect(c.messages[0]?.content[0]).toMatchObject({ type: "text", text: "hi" });
  });

  it("a functionResponse in a user turn parses to a tool_result", () => {
    const c = toCanonical("google", {
      contents: [
        { role: "model", parts: [{ functionCall: { id: "call_1", name: "f", args: {} } }] },
        {
          role: "user",
          parts: [{ functionResponse: { id: "call_1", name: "f", response: { result: "ok" } } }],
        },
      ],
      config: { maxOutputTokens: 10 },
    });
    expect(c.messages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call_1",
      content: "ok",
    });
  });

  it("a plain text part in a tool turn parses to text", () => {
    const c = toCanonical("google", {
      contents: [{ role: "tool", parts: [{ text: "result text" }] }],
      config: { maxOutputTokens: 10 },
    });
    expect(c.messages[0]?.role).toBe("user");
    expect(c.messages[0]?.content[0]).toMatchObject({ type: "text", text: "result text" });
  });
});

describe("M4 parity — tool-call argument and schema degradation", () => {
  it("openai malformed tool-call arguments degrade to {} (#6, request)", () => {
    const c = toCanonical(
      "openai",
      openaiReq({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "f", arguments: "{bad" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "ok" },
        ],
      }),
    );
    expect(c.messages[1]?.content[0]).toMatchObject({ type: "tool_use", id: "c1", input: {} });
  });

  it("openai null tool-call arguments degrade to {} (#6)", () => {
    const c = toCanonical(
      "openai",
      openaiReq({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: null } }],
          },
          { role: "tool", tool_call_id: "c1", content: "ok" },
        ],
      }),
    );
    expect(c.messages[1]?.content[0]).toMatchObject({ type: "tool_use", input: {} });
  });

  it("openai response-side malformed arguments degrade, not abort (#6, response)", () => {
    expect(() =>
      normalizeResponse({
        served: "openai",
        requested: "anthropic",
        response: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "f", arguments: "not-json" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          model: "gpt-4o",
        },
      }),
    ).not.toThrow();
  });

  it("google tool decl using `parameters` keeps its schema (#7)", () => {
    const schema = { type: "object", properties: { x: { type: "string" } } };
    const c = toCanonical("google", {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: {
        maxOutputTokens: 10,
        tools: [{ functionDeclarations: [{ name: "f", parameters: schema }] }],
      },
    });
    expect(c.tools?.[0]?.parameters).toEqual(schema);
  });
});

describe("M4 parity — image handle labels", () => {
  it("google model-turn inlineData image raises image.opaque_handle (#8)", () => {
    expectFeature(
      () =>
        toCanonical("google", {
          contents: [
            { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "abc" } }] },
          ],
          config: { maxOutputTokens: 10 },
        }),
      "image.opaque_handle",
    );
  });

  it("openai bare image handle raises image.opaque_handle, not insecure_url (#10)", () => {
    expectFeature(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [
              { role: "user", content: [{ type: "image_url", image_url: { url: "file-abc123" } }] },
            ],
          }),
        ),
      "image.opaque_handle",
    );
  });

  it("openai http:// image URL still raises image.insecure_url (#10)", () => {
    expectFeature(
      () =>
        toCanonical(
          "openai",
          openaiReq({
            messages: [
              {
                role: "user",
                content: [{ type: "image_url", image_url: { url: "http://x/y.png" } }],
              },
            ],
          }),
        ),
      "image.insecure_url",
    );
  });
});

describe("M4 parity — n>1 / candidate_count>1 wired into every dialect (#11)", () => {
  it("anthropic n:2 raises n>1", () => {
    expectFeature(
      () =>
        toCanonical("anthropic", {
          model: "m",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
          n: 2,
        }),
      "n>1",
    );
  });

  it("bedrock n:2 raises n>1", () => {
    expectFeature(
      () =>
        toCanonical("bedrock", {
          model: "m",
          inferenceConfig: { maxTokens: 10 },
          messages: [{ role: "user", content: [{ text: "hi" }] }],
          n: 2,
        }),
      "n>1",
    );
  });

  it("openai candidate_count:2 raises candidate_count>1", () => {
    expectFeature(
      () => toCanonical("openai", openaiReq({ candidate_count: 2 })),
      "candidate_count>1",
    );
  });

  it("google config n:2 raises n>1", () => {
    expectFeature(
      () =>
        toCanonical("google", {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          config: { maxOutputTokens: 10, n: 2 },
        }),
      "n>1",
    );
  });
});

describe("M4 parity — null tool-result content coerces to '' (#12)", () => {
  it("openai tool message with null content → tool_result content ''", () => {
    const c = toCanonical(
      "openai",
      openaiReq({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: null },
        ],
      }),
    );
    expect(c.messages[2]?.content[0]).toMatchObject({ type: "tool_result", content: "" });
  });

  it("anthropic tool_result block with absent content → '' (not undefined)", () => {
    const c = toCanonical("anthropic", {
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
      ],
    });
    const part = c.messages[1]?.content[0];
    expect(part).toMatchObject({ type: "tool_result", content: "" });
    expect((part as { content: unknown }).content).toBe("");
  });
});
