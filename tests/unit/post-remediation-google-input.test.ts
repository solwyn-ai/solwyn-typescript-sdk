import { isDeepStrictEqual } from "node:util";
import { type GenerateContentParameters, GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Solwyn, UntranslatableRequestError } from "../../src/index";
import { fromCanonical, toCanonical } from "../../src/providers/translation";
import { FakeControlPlane } from "../../src/testing";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
type Contents = GenerateContentParameters["contents"];
type Shape = "string" | "Part" | "Part[]" | "Content" | "Content[]";
const shapes: Shape[] = ["string", "Part", "Part[]", "Content", "Content[]"];

function input(shape: Shape, text: string): Contents {
  switch (shape) {
    case "string":
      return text;
    case "Part":
      return { text };
    case "Part[]":
      return [{ text }];
    case "Content":
      return { role: "user", parts: [{ text }] };
    case "Content[]":
      return [{ role: "user", parts: [{ text }] }];
  }
}

function request(contents: Contents): GenerateContentParameters {
  return { model: "gemini-2.5-flash", contents, config: { maxOutputTokens: 128 } };
}

function setup() {
  const plane = new FakeControlPlane();
  const nativeBodies: Array<{ contents?: unknown; tools?: unknown }> = [];
  const foreignBodies: Array<{ messages?: unknown; tools?: unknown }> = [];
  let nativeFails = true;
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    nativeBodies.push(JSON.parse(String(init.body)));
    return nativeFails
      ? Response.json({ error: { code: 503, status: "UNAVAILABLE", message: "" } }, { status: 503 })
      : Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
  });
  const primary = new GoogleGenAI({ apiKey: crypto.randomUUID() });
  const fallback = new OpenAI({
    apiKey: crypto.randomUUID(),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      foreignBodies.push(body);
      const response = {
        id: "response",
        object: body.stream ? "chat.completion.chunk" : "chat.completion",
        created: 0,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            ...(body.stream ? { delta: {} } : { message: { role: "assistant", content: "" } }),
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return body.stream
        ? new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(response);
    },
  });
  const wrapped = new Solwyn(primary, {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    logger,
    leaseEnabled: false,
    breakerReportingEnabled: false,
    circuitBreakerFailureThreshold: 1,
    failoverIdempotency: "always",
    fallback: [[fallback, "gpt-4o-mini"]],
  });
  return {
    primary,
    wrapped,
    nativeBodies,
    foreignBodies,
    plane,
    nativeSucceeds() {
      nativeFails = false;
    },
    nativeFails() {
      nativeFails = true;
    },
  };
}

async function consume(
  client: ReturnType<typeof setup>["wrapped"],
  params: GenerateContentParameters,
  stream: boolean,
) {
  if (stream) {
    const response = await client.models.generateContentStream(params);
    for await (const _chunk of response) {
      // Draining exercises the actual translated stream and its settlement owner.
    }
  } else {
    await client.models.generateContent(params);
  }
}

function assertStructural(error: unknown, marker: string) {
  expect(error instanceof UntranslatableRequestError).toBe(true);
  if (!(error instanceof UntranslatableRequestError)) return;
  expect(error.source).toBe("google");
  expect(error.target).toBe("*");
  expect(String(error).includes(marker)).toBe(false);
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(marker)).toBe(false);
  expect(error.cause === undefined).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("post-remediation finding 4: native Google shorthand input", () => {
  for (const stream of [false, true]) {
    it.each(
      shapes,
    )(`preserves %s through the native serializer and public failover (stream=${stream})`, async (shape) => {
      const marker = crypto.randomUUID();
      const state = setup();
      const params = request(input(shape, marker));
      const before = JSON.stringify(params);
      try {
        await consume(state.wrapped, params, stream);
        expect(state.nativeBodies.length).toBe(1);
        expect(
          isDeepStrictEqual(state.nativeBodies[0]?.contents, [
            { role: "user", parts: [{ text: marker }] },
          ]),
        ).toBe(true);
        expect(state.foreignBodies.length).toBe(1);
        expect(
          isDeepStrictEqual(state.foreignBodies[0]?.messages, [{ role: "user", content: marker }]),
        ).toBe(true);
        expect(JSON.stringify(params) === before).toBe(true);
      } finally {
        await state.wrapped.close();
      }
      expect(state.plane.confirms.length).toBe(1);
    });
  }

  it("coalesces native strings and text parts into one ordered user turn", async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const state = setup();
    try {
      await consume(state.wrapped, request([first, { text: second }]), false);
      expect(
        isDeepStrictEqual(state.nativeBodies[0]?.contents, [
          { role: "user", parts: [{ text: first }, { text: second }] },
        ]),
      ).toBe(true);
      expect(
        isDeepStrictEqual(state.foreignBodies[0]?.messages, [
          { role: "user", content: first + second },
        ]),
      ).toBe(true);
    } finally {
      await state.wrapped.close();
    }
  });

  for (const shape of ["Part", "Part[]", "Content", "Content[]"] as const) {
    it(`preserves an inline image in ${shape} through native and foreign serializers`, async () => {
      const data = btoa(crypto.randomUUID());
      const part = { inlineData: { mimeType: "image/png", data } };
      const content = { role: "user", parts: [part] };
      const contents =
        shape === "Part"
          ? part
          : shape === "Part[]"
            ? [part]
            : shape === "Content"
              ? content
              : [content];
      const state = setup();
      try {
        await consume(state.wrapped, request(contents), false);
        expect(isDeepStrictEqual(state.nativeBodies[0]?.contents, [content])).toBe(true);
        expect(
          isDeepStrictEqual(state.foreignBodies[0]?.messages, [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }],
            },
          ]),
        ).toBe(true);
      } finally {
        await state.wrapped.close();
      }
    });
  }

  it("preserves model roles and a complete function exchange in Content[]", async () => {
    const marker = crypto.randomUUID();
    const state = setup();
    const contents = [
      {
        role: "model",
        parts: [{ functionCall: { name: "tool", id: "call_1", args: { value: marker } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "tool", id: "call_1", response: { result: marker } } }],
      },
    ];
    try {
      const params = request(contents);
      params.config = {
        ...params.config,
        tools: [
          { functionDeclarations: [{ name: "tool", parametersJsonSchema: { type: "object" } }] },
        ],
      };
      await consume(state.wrapped, params, false);
      expect(isDeepStrictEqual(state.nativeBodies[0]?.contents, contents)).toBe(true);
      expect(isDeepStrictEqual(state.nativeBodies[0]?.tools, params.config.tools)).toBe(true);
      expect(
        isDeepStrictEqual(state.foreignBodies[0]?.tools, [
          {
            type: "function",
            function: { name: "tool", description: null, parameters: { type: "object" } },
          },
        ]),
      ).toBe(true);
      expect(
        isDeepStrictEqual(state.foreignBodies[0]?.messages, [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "tool", arguments: JSON.stringify({ value: marker }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: marker },
        ]),
      ).toBe(true);
    } finally {
      await state.wrapped.close();
    }
  });

  it.each([
    false,
    true,
  ])("preserves text and inline-image order in shorthand parts (stream=%s)", async (stream) => {
    const first = crypto.randomUUID();
    const last = crypto.randomUUID();
    const data = btoa(crypto.randomUUID());
    const state = setup();
    try {
      await consume(
        state.wrapped,
        request([first, { inlineData: { mimeType: "image/png", data } }, { text: last }]),
        stream,
      );
      expect(
        isDeepStrictEqual(state.nativeBodies[0]?.contents, [
          {
            role: "user",
            parts: [
              { text: first },
              { inlineData: { mimeType: "image/png", data } },
              { text: last },
            ],
          },
        ]),
      ).toBe(true);
      expect(
        isDeepStrictEqual(state.foreignBodies[0]?.messages, [
          {
            role: "user",
            content: [
              { type: "text", text: first },
              { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
              { type: "text", text: last },
            ],
          },
        ]),
      ).toBe(true);
    } finally {
      await state.wrapped.close();
    }
  });

  const rejected: Array<{
    name: string;
    value: (marker: string) => unknown;
    nativeAccepted: boolean;
  }> = [
    {
      name: "mixed Content and Part",
      value: (text) => [{ parts: [{ text }] }, { text }],
      nativeAccepted: false,
    },
    {
      name: "mixed Part and Content",
      value: (text) => [{ text }, { parts: [{ text }] }],
      nativeAccepted: false,
    },
    {
      name: "scalar function call",
      value: () => ({ functionCall: { name: "tool", args: {} } }),
      nativeAccepted: false,
    },
    {
      name: "shorthand function response",
      value: () => [{ functionResponse: { name: "tool", response: {} } }],
      nativeAccepted: false,
    },
    { name: "null", value: () => null, nativeAccepted: true },
    { name: "numeric Part", value: () => [42], nativeAccepted: false },
    { name: "empty contents", value: () => [], nativeAccepted: false },
    {
      name: "invalid parts shape",
      value: (text) => ({ role: "user", parts: text }),
      nativeAccepted: true,
    },
    { name: "unknown Part", value: (marker) => ({ [marker]: marker }), nativeAccepted: true },
    {
      name: "conflicting Part fields",
      value: (text) => ({ text, inlineData: { mimeType: "image/png", data: btoa(text) } }),
      nativeAccepted: true,
    },
    { name: "thought metadata", value: (text) => ({ text, thought: true }), nativeAccepted: true },
    {
      name: "thought signature",
      value: (text) => ({ text, thoughtSignature: text }),
      nativeAccepted: true,
    },
    { name: "nested Part array", value: (text) => [[{ text }]], nativeAccepted: true },
    {
      name: "scalar Content with unknown role",
      value: (role) => ({ role, parts: [{ text: "" }] }),
      nativeAccepted: true,
    },
    {
      name: "opaque image handle",
      value: (fileUri) => ({ fileData: { mimeType: "image/png", fileUri } }),
      nativeAccepted: true,
    },
    {
      name: "audio Part",
      value: (data) => ({ inlineData: { mimeType: "audio/wav", data } }),
      nativeAccepted: true,
    },
  ];

  it.each(rejected)("rejects $name structurally before foreign dispatch", async ({
    value,
    nativeAccepted,
  }) => {
    const marker = crypto.randomUUID();
    const params = request(value(marker) as Contents);
    const state = setup();
    try {
      state.nativeSucceeds();
      let serialized = false;
      try {
        await state.primary.models.generateContent(params);
        serialized = true;
      } catch {
        // Native serializer failures are asserted by outcome, never arbitrary error text.
      }
      expect(serialized).toBe(nativeAccepted);
      expect(state.nativeBodies.length).toBe(nativeAccepted ? 1 : 0);
      state.nativeFails();
      // A real native 503 opens the primary breaker. The next call must translate
      // before dispatch, including shapes the native serializer itself rejects.
      await consume(state.wrapped, request([{ role: "user", parts: [{ text: marker }] }]), false);
      expect(state.foreignBodies.length).toBe(1);
      const primaryCalls = state.nativeBodies.length;
      let error: unknown;
      try {
        await consume(state.wrapped, params, false);
      } catch (caught) {
        error = caught;
      }
      assertStructural(error, marker);
      expect(state.foreignBodies.length).toBe(1);
      expect(state.nativeBodies.length).toBe(primaryCalls);
    } finally {
      await state.wrapped.close();
    }
  });

  it("retains the cross-provider tool-stream refusal after shorthand normalization", async () => {
    const marker = crypto.randomUUID();
    const state = setup();
    try {
      const params = request(marker);
      params.config = {
        ...params.config,
        tools: [{ functionDeclarations: [{ name: "tool", parametersJsonSchema: {} }] }],
      };
      let error: unknown;
      try {
        await consume(state.wrapped, params, true);
      } catch (caught) {
        error = caught;
      }
      expect(error instanceof UntranslatableRequestError).toBe(true);
      if (error instanceof UntranslatableRequestError) {
        expect(error.feature).toBe("cross_provider_tool_stream");
        expect(String(error).includes(marker)).toBe(false);
      }
      expect(state.nativeBodies.length).toBe(1);
      expect(state.foreignBodies.length).toBe(0);
    } finally {
      await state.wrapped.close();
    }
  });

  it.each([
    "topK",
    "thinkingConfig",
    "responseSchema",
  ])("keeps unsupported %s controls loud with shorthand input", async (key) => {
    const marker = crypto.randomUUID();
    const state = setup();
    try {
      let error: unknown;
      try {
        await state.wrapped.models.generateContent({
          ...request(marker),
          config: { maxOutputTokens: 128, [key]: {} },
        });
      } catch (caught) {
        error = caught;
      }
      assertStructural(error, marker);
      expect(state.foreignBodies.length).toBe(0);
    } finally {
      await state.wrapped.close();
    }
  });

  it("preserves explicit empty Content turns without changing the Google renderer policy", () => {
    const source = { contents: { role: "model", parts: [] }, config: { maxOutputTokens: 1 } };
    const canonical = toCanonical("google", source);
    expect(canonical.messages.length).toBe(1);
    expect(canonical.messages[0]?.role).toBe("assistant");
    expect(canonical.messages[0]?.content.length).toBe(0);
    expect(fromCanonical("google", canonical, "gemini-2.5-flash")).toMatchObject({
      contents: [{ role: "model", parts: [] }],
    });
  });
});
