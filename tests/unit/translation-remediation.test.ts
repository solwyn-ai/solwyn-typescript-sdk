import { randomUUID } from "node:crypto";
import {
  FunctionCallingConfigMode,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UntranslatableRequestError } from "../../src/errors";
import {
  type CanonicalMessage,
  fromCanonical,
  normalizeResponse,
  toCanonical,
  translateStreamChunk,
} from "../../src/providers/translation";

afterEach(() => vi.restoreAllMocks());

const exchange: [CanonicalMessage, CanonicalMessage] = [
  { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "tool_1", input: {} }] },
  { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "" }] },
];
const canonical = {
  messages: exchange,
  maxTokens: 128,
  topP: 0.4,
  stop: [],
  system: "",
  stream: false,
  parallelToolCalls: true,
  tools: [{ name: "tool_1", parameters: {} }],
  toolChoice: { mode: "force" as const, name: "tool_1" },
};
const nativeGoogle: GenerateContentParameters = {
  model: "gemini-2.5-flash",
  contents: [
    { role: "model", parts: [{ functionCall: { id: "call_1", name: "tool_1", args: {} } }] },
    {
      role: "user",
      parts: [{ functionResponse: { id: "call_1", name: "tool_1", response: { result: "" } } }],
    },
  ],
  config: {
    maxOutputTokens: 128,
    topP: 0.4,
    stopSequences: [],
    systemInstruction: "",
    tools: [{ functionDeclarations: [{ name: "tool_1", parametersJsonSchema: {} }] }],
    toolConfig: {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
        allowedFunctionNames: ["tool_1"],
      },
    },
  },
};

describe("F6 native Google translation boundary", () => {
  it("parses native configuration and buffered function exchanges", () => {
    expect(toCanonical("google", { ...nativeGoogle })).toEqual(canonical);
  });

  it.each([
    "openai",
    "anthropic",
    "bedrock",
  ])("composes native Google requests through %s", (provider) => {
    const source = toCanonical("google", { ...nativeGoogle });
    const rendered = fromCanonical(provider, source, "model", {
      bedrockCommandConstructor: (input) => input,
    }) as Record<string, unknown>;
    const returned = toCanonical(provider, rendered);
    expect(returned).toEqual(canonical);
  });

  it.each([
    "max_output_tokens",
    "maxOutputTokens",
  ])("rejects non-native top-level %s instead of accepting a discarded cap", (key) => {
    expect(() => toCanonical("google", { model: "model", contents: [], [key]: 16000 })).toThrow(
      UntranslatableRequestError,
    );
  });

  it("rejects native built-in and unknown Google tool keys before silently dropping them", () => {
    expect(() =>
      toCanonical("google", {
        ...nativeGoogle,
        config: { maxOutputTokens: 1, tools: [{ googleSearch: {} }] },
      }),
    ).toThrow("google.google_search");
    const marker = randomUUID();
    assertPrivate(
      () =>
        toCanonical("google", {
          ...nativeGoogle,
          config: { maxOutputTokens: 1, tools: [{ [marker]: {} }] },
        }),
      marker,
    );
  });

  it.each([
    "topK",
    "responseSchema",
    "responseMimeType",
    "thinkingConfig",
    "cachedContent",
  ])("rejects the native forbidden %s control", (key) => {
    expect(() =>
      toCanonical("google", { ...nativeGoogle, config: { maxOutputTokens: 1, [key]: {} } }),
    ).toThrow(UntranslatableRequestError);
  });

  it.each([
    false,
    true,
  ])("preserves translated controls and tools through the installed SDK converter (stream=%s)", async (stream) => {
    let sent: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      const response = {
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
      };
      return new Response(
        stream ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response),
        { headers: { "Content-Type": stream ? "text/event-stream" : "application/json" } },
      );
    });
    const client = new GoogleGenAI({ apiKey: "offline-test-key" });
    const request = fromCanonical(
      "google",
      canonical,
      "gemini-2.5-flash",
    ) as GenerateContentParameters;
    if (stream) {
      const response = await client.models.generateContentStream(request);
      for await (const chunk of response) {
        expect(
          translateStreamChunk({ served: "google", requested: "openai", chunk }),
        ).toMatchObject([{ choices: [{ finish_reason: "stop" }] }]);
      }
    } else {
      await client.models.generateContent(request);
    }
    expect(sent["generationConfig"]).toMatchObject({
      maxOutputTokens: 128,
      topP: 0.4,
      stopSequences: [],
    });
    expect(sent["systemInstruction"]).toEqual({ parts: [{ text: "" }], role: "user" });
    expect(sent["contents"]).toEqual(nativeGoogle.contents);
    expect(sent["tools"]).toEqual([
      { functionDeclarations: [{ name: "tool_1", parametersJsonSchema: {} }] },
    ]);
    expect(sent["toolConfig"]).toEqual(nativeGoogle.config?.toolConfig);
  });

  it.each([
    "openai",
    "anthropic",
    "bedrock",
  ])("preserves native Google response tools and finish reasons toward %s", async (requested) => {
    const wire = {
      modelVersion: "gemini-2.5-flash",
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { id: "call_1", name: "tool_1", args: {} } }],
          },
          finishReason: "STOP",
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(wire), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new GoogleGenAI({ apiKey: "offline-test-key" });
    const native = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [] }],
    });
    const roundtrip = normalizeResponse({
      served: requested,
      requested: "google",
      response: normalizeResponse({ served: "google", requested, response: native }),
    }) as GenerateContentResponse;
    expect(roundtrip.candidates?.[0]?.finishReason).toBe("STOP");
    expect(roundtrip.functionCalls).toEqual([{ id: "call_1", name: "tool_1", args: {} }]);
    expect(roundtrip.text).toBeUndefined();
  });

  it.each([
    "openai",
    "anthropic",
    "bedrock",
  ])("preserves native terminal events through %s streams", (requested) => {
    const native = { candidates: [{ finishReason: "MAX_TOKENS" }] };
    const converted = translateStreamChunk({ served: "google", requested, chunk: native });
    expect(converted).toHaveLength(1);
    const returned = translateStreamChunk({
      served: requested,
      requested: "google",
      chunk: converted[0],
    }) as GenerateContentResponse[];
    expect(returned[0]?.candidates?.[0]?.finishReason).toBe("MAX_TOKENS");
  });

  it.each([
    "functionCall",
    "inlineData",
    "fileData",
  ])("fails loudly for native %s stream parts", (key) => {
    expect(() =>
      translateStreamChunk({
        served: "google",
        requested: "openai",
        chunk: { candidates: [{ content: { parts: [{ [key]: {} }] } }] },
      }),
    ).toThrow(UntranslatableRequestError);
  });

  it("exposes the native text accessor on translated stream chunks", () => {
    const result = translateStreamChunk({
      served: "anthropic",
      requested: "google",
      chunk: { type: "content_block_delta", delta: { type: "text_delta", text: "" } },
    }) as GenerateContentResponse[];
    expect(result[0]?.text).toBe("");
  });
});

describe("F20 pending tool exchanges", () => {
  for (const provider of ["openai", "anthropic", "google", "bedrock"]) {
    const render = (messages: CanonicalMessage[]) =>
      fromCanonical(provider, { ...canonical, toolChoice: undefined, messages }, "model", {
        bedrockCommandConstructor: (input) => input,
      }) as Record<string, unknown>;
    it(`${provider}: rejects a duplicate result and an unanswered reused ID`, () => {
      expect(() => toCanonical(provider, render([...exchange, exchange[1]]))).toThrow(
        UntranslatableRequestError,
      );
      expect(() => toCanonical(provider, render([...exchange, exchange[0]]))).toThrow(
        UntranslatableRequestError,
      );
    });
    it(`${provider}: accepts two completed exchanges reusing an ID`, () => {
      expect(toCanonical(provider, render([...exchange, ...exchange])).messages).toEqual([
        ...exchange,
        ...exchange,
      ]);
    });
  }
  it("renders each reused ID with the tool name belonging to its own exchange", () => {
    const renamed: CanonicalMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "tool_2", input: {} }],
    };
    const rendered = fromCanonical(
      "google",
      { ...canonical, messages: [...exchange, renamed, exchange[1]] },
      "model",
    ) as GenerateContentParameters;
    const turns = rendered.contents as Array<{
      parts: Array<{ functionResponse?: { name: string } }>;
    }>;
    expect(turns[1]?.parts[0]?.functionResponse?.name).toBe("tool_1");
    expect(turns[3]?.parts[0]?.functionResponse?.name).toBe("tool_2");
  });
});

describe("F21 Anthropic none choice", () => {
  it.each([
    "none",
    "auto",
    "required",
    "force",
  ] as const)("renders the supported parallel flag for %s", (mode) => {
    const rendered = fromCanonical(
      "anthropic",
      { ...canonical, parallelToolCalls: false, toolChoice: { mode, name: "tool_1" } },
      "model",
    ) as { tool_choice: Record<string, unknown> };
    expect(Object.hasOwn(rendered.tool_choice, "disable_parallel_tool_use")).toBe(mode !== "none");
  });
});

describe("inherited translation privacy correction", () => {
  it.each([
    "openai",
    "anthropic",
    "google",
    "bedrock",
  ])("unknown %s keys never reach any exposed error field or serialization", (provider) => {
    const marker = randomUUID();
    const scopes =
      provider === "google"
        ? [{ [marker]: null }, { config: { [marker]: null } }]
        : provider === "bedrock"
          ? [{ [marker]: null }, { inferenceConfig: { [marker]: null } }]
          : [{ [marker]: null }];
    for (const scope of scopes) assertPrivate(() => toCanonical(provider, scope), marker);
  });
  it("unknown Anthropic tool types never reach any exposed error field or serialization", () => {
    const marker = randomUUID();
    assertPrivate(
      () => toCanonical("anthropic", { messages: [], max_tokens: 1, tools: [{ type: marker }] }),
      marker,
    );
  });
  it("preserves fixed known proprietary and unsupported labels", () => {
    expect(() =>
      toCanonical("anthropic", {
        messages: [],
        max_tokens: 1,
        tools: [{ type: "computer_20241022" }],
      }),
    ).toThrow("anthropic.computer");
    expect(() => toCanonical("openai", { messages: [], max_tokens: 1, n: 1 })).toThrow(
      "unsupported_kwarg.n",
    );
  });
});

function assertPrivate(fn: () => unknown, marker: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  // Only booleans enter assertions: a failing regression must not print the marker.
  expect(error instanceof UntranslatableRequestError).toBe(true);
  const object = error as UntranslatableRequestError;
  const values = Reflect.ownKeys(object).map((key) => Reflect.get(object, key));
  expect(values.some((value) => typeof value === "string" && value.includes(marker))).toBe(false);
  expect(String(object).includes(marker)).toBe(false);
  expect(JSON.stringify(object).includes(marker)).toBe(false);
  expect(JSON.stringify(object, Object.getOwnPropertyNames(object)).includes(marker)).toBe(false);
  expect(object.cause === undefined).toBe(true);
}
