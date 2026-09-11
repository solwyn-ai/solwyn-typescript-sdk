import { describe, expect, it } from "vitest";
import {
  estimateContentLength,
  estimateEmbeddingInputTokens,
  estimateGoogleEmbeddingInputTokens,
  estimateResponseContentLength,
  estimateStreamChunkContentLength,
  estimateTokensFromLength,
  measureGoogleImageMedia,
  measureImageMedia,
  measureOpenAIVideoMedia,
  measureSpeechMedia,
  measureVideoMedia,
} from "../../src/privacy";

describe("estimateContentLength — content-field char walking", () => {
  it("sums plain-string content across OpenAI-style messages (additive)", () => {
    const kwargs = {
      messages: [
        { role: "user", content: "hello" }, // 5
        { role: "assistant", content: "world!" }, // 6
      ],
    };
    expect(estimateContentLength(kwargs)).toBe(11);
  });

  it("sums text fields inside Anthropic content-block lists ({type,text})", () => {
    const kwargs = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "abc" }, // 3
            { type: "text", text: "de" }, // 2
          ],
        },
      ],
    };
    expect(estimateContentLength(kwargs)).toBe(5);
  });

  it("adds a string system field to the messages total", () => {
    const kwargs = {
      system: "sys", // 3
      messages: [{ role: "user", content: "hi" }], // 2
    };
    expect(estimateContentLength(kwargs)).toBe(5);
  });

  it("returns exactly 0 for empty kwargs (no keys is not an error)", () => {
    expect(estimateContentLength({})).toBe(0);
  });

  it("counts Google-style contents as a bare string", () => {
    expect(estimateContentLength({ contents: "abcdef" })).toBe(6);
  });

  it("sums Google-style contents as a list of plain strings", () => {
    expect(estimateContentLength({ contents: ["ab", "cde"] })).toBe(5);
  });

  it("sums Google-style contents as a list of {text} part-dicts", () => {
    expect(estimateContentLength({ contents: [{ text: "ab" }, { text: "cde" }] })).toBe(5);
  });

  it("counts Bedrock message blocks ({text} with NO type key) via the same walk", () => {
    const kwargs = {
      messages: [
        {
          role: "user",
          content: [{ text: "abcd" }, { text: "ef" }], // no "type" key
        },
      ],
    };
    expect(estimateContentLength(kwargs)).toBe(6);
  });

  it("sums Bedrock system as a LIST of blocks (distinct from Anthropic's string)", () => {
    const kwargs = {
      system: [{ text: "aaa" }, { text: "bb" }], // 5
    };
    expect(estimateContentLength(kwargs)).toBe(5);
  });

  it("silently skips non-text Bedrock system blocks (cachePoint etc.)", () => {
    const kwargs = {
      system: [
        { text: "aaa" }, // 3
        { cachePoint: { type: "default" } }, // 0, must not break the sum
        { text: "bb" }, // 2
      ],
    };
    expect(estimateContentLength(kwargs)).toBe(5);
  });

  it("combines messages + system + contents additively across shapes", () => {
    const kwargs = {
      messages: [
        { content: "ab" }, // 2
        { content: [{ text: "cde" }] }, // 3
      ],
      system: "fg", // 2
      contents: ["h", { text: "ij" }], // 1 + 2
    };
    expect(estimateContentLength(kwargs)).toBe(10);
  });

  it("contributes 0 for missing/non-str/non-list content, never raising", () => {
    const kwargs = {
      messages: [
        { role: "user" }, // no content -> 0
        { role: "user", content: 123 }, // non-str/non-list -> 0
        "not-a-dict", // skipped
        { role: "user", content: "x" }, // 1
      ],
    };
    expect(estimateContentLength(kwargs)).toBe(1);
  });
});

describe("estimateTokensFromLength — provider ratio table (D8)", () => {
  it("uses 4.0 for openai/google/bedrock and 3.8 for anthropic", () => {
    expect(estimateTokensFromLength(400, "openai")).toBe(100);
    expect(estimateTokensFromLength(400, "google")).toBe(100);
    expect(estimateTokensFromLength(400, "bedrock")).toBe(100);
    expect(estimateTokensFromLength(380, "anthropic")).toBe(100);
  });

  it("falls back to ratio 4.0 for unknown providers", () => {
    expect(estimateTokensFromLength(400, "totally-unknown")).toBe(100);
    expect(estimateTokensFromLength(400, "")).toBe(100);
  });

  it("keys only off the coarse provider string, ignoring model ratios", () => {
    // anthropic ratio 3.8 regardless of any model context.
    expect(estimateTokensFromLength(420, "anthropic")).toBe(Math.trunc(420 / 3.8));
  });

  it("truncates toward zero (not round)", () => {
    // 401/4 = 100.25 -> 100
    expect(estimateTokensFromLength(401, "openai")).toBe(100);
    // 399/4 = 99.75 -> 99 (trunc, not round-to-100)
    expect(estimateTokensFromLength(399, "openai")).toBe(99);
  });

  it("floors at a minimum of 1 token, even for a char_count of 0", () => {
    expect(estimateTokensFromLength(0, "openai")).toBe(1);
    expect(estimateTokensFromLength(1, "openai")).toBe(1);
    expect(estimateTokensFromLength(0, "anthropic")).toBe(1);
  });
});

describe("estimateEmbeddingInputTokens — content-in, integer-out", () => {
  it("estimates character-bearing inputs with the provider ratio", () => {
    expect(estimateEmbeddingInputTokens({ input: "x".repeat(40) }, "openai")).toBe(10);
    expect(
      estimateEmbeddingInputTokens({ input: ["x".repeat(19), "y".repeat(19)] }, "anthropic"),
    ).toBe(10);
  });

  it("counts flat and nested integer token ids one-to-one", () => {
    expect(estimateEmbeddingInputTokens({ input: [11, 22, 33, 44, 55] }, "openai")).toBe(5);
    expect(
      estimateEmbeddingInputTokens(
        {
          input: [
            [1, 2, 3],
            [4, 5],
          ],
        },
        "openai",
      ),
    ).toBe(5);
  });

  it("keeps genuinely empty character inputs at zero", () => {
    expect(estimateEmbeddingInputTokens({ input: "" }, "openai")).toBe(0);
    expect(estimateEmbeddingInputTokens({ input: [] }, "openai")).toBe(0);
    expect(estimateEmbeddingInputTokens({ input: ["", ""] }, "openai")).toBe(0);
  });

  it.each([
    true,
    [true],
    [1, true],
    [[1], [true]],
    ["ok", 1],
    42,
    null,
    { token: 1 },
  ])("returns zero for malformed or unrecognized input %#", (input) => {
    expect(estimateEmbeddingInputTokens({ input }, "openai")).toBe(0);
  });

  it("returns a bare number that cannot retain or serialize the source text", () => {
    const secret = "embedding-secret-2ce702";
    const result = estimateEmbeddingInputTokens({ input: secret }, "openai");
    expect(typeof result).toBe("number");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("estimateGoogleEmbeddingInputTokens — Google contents-in, integer-out", () => {
  it("estimates bare and structured Content request shapes", () => {
    expect(estimateGoogleEmbeddingInputTokens({ contents: "x".repeat(40) }, "google")).toBe(10);
    expect(
      estimateGoogleEmbeddingInputTokens(
        {
          contents: {
            parts: [
              { text: "x".repeat(19) },
              { inlineData: { data: "ignored" } },
              { text: "y".repeat(21) },
            ],
          },
        },
        "google",
      ),
    ).toBe(10);
    expect(
      estimateGoogleEmbeddingInputTokens(
        { contents: ["x".repeat(20), { parts: [{ text: "y".repeat(20) }] }] },
        "google",
      ),
    ).toBe(10);
  });

  it("estimates direct text Parts and arrays of PartUnion values", () => {
    expect(
      estimateGoogleEmbeddingInputTokens({ contents: { text: "a".repeat(40) } }, "google"),
    ).toBe(10);
    expect(
      estimateGoogleEmbeddingInputTokens(
        { contents: [{ text: "a".repeat(20) }, { text: "b".repeat(20) }] },
        "google",
      ),
    ).toBe(10);
    expect(
      estimateGoogleEmbeddingInputTokens(
        {
          contents: [
            { text: "a".repeat(20) },
            { inlineData: { data: "ignored" } },
            false,
            null,
            { fileData: { fileUri: "ignored" } },
            { text: "b".repeat(20) },
          ],
        },
        "google",
      ),
    ).toBe(10);
  });

  it("prefers Content parts over a malformed direct text sibling", () => {
    expect(
      estimateGoogleEmbeddingInputTokens(
        {
          contents: {
            parts: [{ text: "a".repeat(40) }],
            text: "must-not-be-double-counted".repeat(4),
          },
        },
        "google",
      ),
    ).toBe(10);
  });

  it("returns a bare number that cannot retain direct Part text", () => {
    const secret = "google-direct-part-secret-f71d";
    const result = estimateGoogleEmbeddingInputTokens({ contents: { text: secret } }, "google");
    expect(typeof result).toBe("number");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("ignores malformed and non-text values and keeps zero characters at zero", () => {
    expect(estimateGoogleEmbeddingInputTokens({}, "google")).toBe(0);
    expect(estimateGoogleEmbeddingInputTokens({ contents: false }, "google")).toBe(0);
    expect(
      estimateGoogleEmbeddingInputTokens(
        { contents: { parts: [{ text: true }, null, { inlineData: "opaque" }] } },
        "google",
      ),
    ).toBe(0);
  });
});

describe("measureImageMedia — non-content selectors only", () => {
  it.each([
    [0, 1],
    [-4, 1],
    [true, 1],
    ["two", 1],
    [null, 1],
    [1.5, 1],
    [2, 2],
  ])("normalizes image count %j to %i", (n, expected) => {
    expect(measureImageMedia({ n }).image_count).toBe(expected);
  });

  it("retains bounded size and quality selectors with explicit null carriers", () => {
    expect(measureImageMedia({ n: 2, size: "1024x1024", quality: "hd" })).toEqual({
      image_count: 2,
      generation_count: null,
      video_seconds: null,
      audio_seconds: null,
      input_characters: null,
      resolution: "1024x1024",
      quality: "hd",
      is_estimated: false,
    });
    expect(measureImageMedia({ size: "", quality: "x".repeat(33) })).toMatchObject({
      resolution: "",
      quality: null,
    });
    expect(measureImageMedia({ size: 1024, quality: true })).toMatchObject({
      resolution: null,
      quality: null,
    });
  });

  it("does not retain image prompt or byte-bearing fields", () => {
    const secret = "image-secret-f81969";
    const result = measureImageMedia({
      n: 1,
      size: "256x256",
      prompt: secret,
      image: secret,
      mask: secret,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("measureGoogleImageMedia — duck-typed config count", () => {
  it("reads numberOfImages from plain and property-accessible config objects", () => {
    class Config {
      numberOfImages = 4;
    }
    expect(measureGoogleImageMedia({ config: { numberOfImages: 4 } }).image_count).toBe(4);
    expect(measureGoogleImageMedia({ config: new Config() }).image_count).toBe(4);
  });

  it.each([
    undefined,
    null,
    0,
    -1,
    true,
    "4",
    1.5,
  ])("defaults absent or invalid numberOfImages %# to one", (numberOfImages) => {
    const config = numberOfImages === undefined ? {} : { numberOfImages };
    expect(measureGoogleImageMedia({ config }).image_count).toBe(1);
  });

  it("does not retain prompt content", () => {
    const secret = "google-image-secret-f842cd";
    expect(
      JSON.stringify(measureGoogleImageMedia({ config: { numberOfImages: 2 }, prompt: secret })),
    ).not.toContain(secret);
  });
});

describe("measureSpeechMedia — request character count", () => {
  it("measures exact string length, including empty input", () => {
    expect(measureSpeechMedia({ input: "hello world" }).input_characters).toBe(11);
    expect(measureSpeechMedia({ input: "" }).input_characters).toBe(0);
  });

  it.each([
    undefined,
    null,
    42,
    true,
    ["hello"],
  ])("uses null for invalid speech input %#", (input) => {
    expect(measureSpeechMedia({ input }).input_characters).toBeNull();
  });

  it("returns no reference to or serialization of the source text", () => {
    const secret = "speech-secret-e6135f";
    const result = measureSpeechMedia({ input: secret });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("measureOpenAIVideoMedia — Sora initiation estimate", () => {
  it("applies the conservative defaults", () => {
    expect(measureOpenAIVideoMedia({})).toEqual({
      image_count: null,
      generation_count: null,
      video_seconds: 4,
      audio_seconds: null,
      input_characters: null,
      resolution: "720p",
      quality: null,
      is_estimated: true,
    });
  });

  it.each([
    ["1280x720", "720p"],
    ["720x1280", "720p"],
    ["1792x1024", "1024p"],
    ["1024x1792", "1024p"],
    ["1920x1080", "1080p"],
    ["1280X720", "720p"],
  ])("normalizes orientation-independent size %s", (size, expected) => {
    expect(measureOpenAIVideoMedia({ size }).resolution).toBe(expected);
  });

  it.each([
    "720p",
    "big",
    "1280",
    "1280x720x30",
    "1280x",
    "x720",
    "",
  ])("passes through short unparseable size %j", (size) => {
    expect(measureOpenAIVideoMedia({ size }).resolution).toBe(size);
  });

  it("rejects non-string and overlong size selectors", () => {
    expect(measureOpenAIVideoMedia({ size: 720 }).resolution).toBeNull();
    expect(measureOpenAIVideoMedia({ size: "x".repeat(33) }).resolution).toBeNull();
  });

  it.each([
    -1,
    true,
    "eight",
    "4.5",
    "-4",
    [8],
    { s: 8 },
    Number.NaN,
    Infinity,
  ])("rejects invalid seconds %#", (seconds) => {
    expect(measureOpenAIVideoMedia({ seconds }).video_seconds).toBeNull();
  });

  it("keeps numeric and digit-string zero and accepts finite nonnegative numbers", () => {
    expect(measureOpenAIVideoMedia({ seconds: 0 }).video_seconds).toBe(0);
    expect(measureOpenAIVideoMedia({ seconds: "0" }).video_seconds).toBe(0);
    expect(measureOpenAIVideoMedia({ seconds: 5.5 }).video_seconds).toBe(5.5);
    expect(measureOpenAIVideoMedia({ seconds: "12" }).video_seconds).toBe(12);
  });

  it("does not retain prompt content", () => {
    const sentinelContent = "sora-secret-fcbd27";
    expect(
      JSON.stringify(measureOpenAIVideoMedia({ seconds: 8, prompt: sentinelContent })),
    ).not.toContain(sentinelContent);
  });
});

describe("measureVideoMedia — Veo initiation estimate", () => {
  it("reads plain and property-accessible config objects", () => {
    class Config {
      durationSeconds = 8;
      resolution = "720p";
    }
    expect(
      measureVideoMedia({ config: { durationSeconds: 6, resolution: "1080p" } }),
    ).toMatchObject({
      video_seconds: 6,
      resolution: "1080p",
    });
    expect(measureVideoMedia({ config: new Config() })).toMatchObject({
      video_seconds: 8,
      resolution: "720p",
    });
  });

  it("preserves zero and fractional durations while leaving absent duration null", () => {
    expect(measureVideoMedia({ config: { durationSeconds: 0 } }).video_seconds).toBe(0);
    expect(measureVideoMedia({ config: { durationSeconds: 5.5 } }).video_seconds).toBe(5.5);
    expect(measureVideoMedia({ config: {} }).video_seconds).toBeNull();
  });

  it.each([
    -1,
    true,
    "6",
    Number.NaN,
    Infinity,
    [],
    {},
  ])("rejects invalid Veo duration %#", (durationSeconds) => {
    expect(measureVideoMedia({ config: { durationSeconds } }).video_seconds).toBeNull();
  });

  it("bounds the resolution selector and does not retain prompt content", () => {
    const secret = "veo-secret-b6300e";
    expect(
      JSON.stringify(measureVideoMedia({ config: { resolution: "x".repeat(33) }, prompt: secret })),
    ).not.toContain(secret);
    expect(measureVideoMedia({ config: { resolution: "x".repeat(33) } }).resolution).toBeNull();
  });
});

describe("modality privacy helpers — hostile shape containment", () => {
  const FORBIDDEN_CONTENT_KEYS = [
    "prompt",
    "image",
    "mask",
    "file",
    "content",
    "messages",
    "system",
    "contents",
    "text",
    "response",
    "seed",
  ] as const;

  function recorded(
    values: Record<string, unknown>,
    forbiddenKeys: readonly string[] = FORBIDDEN_CONTENT_KEYS,
  ): {
    value: Record<string, unknown>;
    accesses: string[];
    forbiddenReads: string[];
  } {
    const accesses: string[] = [];
    const forbiddenReads: string[] = [];
    const target = { ...values };
    for (const key of forbiddenKeys) {
      Object.defineProperty(target, key, {
        configurable: true,
        get() {
          forbiddenReads.push(key);
          return `forbidden-secret-${key}`;
        },
      });
    }
    return {
      value: new Proxy(target, {
        get(inner, property, receiver) {
          if (typeof property === "string") {
            accesses.push(property);
          }
          return Reflect.get(inner, property, receiver);
        },
      }),
      accesses,
      forbiddenReads,
    };
  }

  function guarded(
    values: Record<string, unknown>,
    allowed: readonly string[],
  ): Record<string, unknown> {
    return new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === "string" && !allowed.includes(property)) {
          throw new Error(`unexpected traversal: ${property}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  it("records exactly the allowed root selector reads for embedding, speech, image, and Sora", () => {
    const embedding = recorded({ input: "abcd" });
    estimateEmbeddingInputTokens(embedding.value, "openai");
    expect(embedding.accesses).toEqual(["input"]);
    expect(embedding.forbiddenReads).toEqual([]);

    const googlePart = recorded(
      { text: "abcd", inlineData: "secret" },
      FORBIDDEN_CONTENT_KEYS.filter((key) => key !== "text"),
    );
    const googleContent = recorded({ parts: [googlePart.value], role: "user" });
    const googleEmbedding = recorded(
      { contents: googleContent.value, input: "secret" },
      FORBIDDEN_CONTENT_KEYS.filter((key) => key !== "contents"),
    );
    estimateGoogleEmbeddingInputTokens(googleEmbedding.value, "google");
    expect(googleEmbedding.accesses).toEqual(["contents"]);
    expect(googleContent.accesses).toEqual(["parts"]);
    expect(googlePart.accesses).toEqual(["text"]);
    expect(googleEmbedding.forbiddenReads).toEqual([]);
    expect(googleContent.forbiddenReads).toEqual([]);
    expect(googlePart.forbiddenReads).toEqual([]);

    const directPart = recorded(
      { text: "abcd", inlineData: "secret" },
      FORBIDDEN_CONTENT_KEYS.filter((key) => key !== "text"),
    );
    const directEmbedding = recorded(
      { contents: directPart.value, input: "secret" },
      FORBIDDEN_CONTENT_KEYS.filter((key) => key !== "contents"),
    );
    estimateGoogleEmbeddingInputTokens(directEmbedding.value, "google");
    expect(directEmbedding.accesses).toEqual(["contents"]);
    expect(directPart.accesses).toEqual(["parts", "text"]);
    expect(directEmbedding.forbiddenReads).toEqual([]);
    expect(directPart.forbiddenReads).toEqual([]);

    const speech = recorded({ input: "abcd" });
    measureSpeechMedia(speech.value);
    expect(speech.accesses).toEqual(["input"]);
    expect(speech.forbiddenReads).toEqual([]);

    const image = recorded({ n: 2, size: "256x256", quality: "hd" });
    measureImageMedia(image.value);
    expect(image.accesses).toEqual(["size", "n", "quality"]);
    expect(image.forbiddenReads).toEqual([]);

    const imageResolutionAlias = recorded({ n: 1, resolution: "512x512", quality: "standard" });
    measureImageMedia(imageResolutionAlias.value);
    expect(imageResolutionAlias.accesses).toEqual(["size", "resolution", "n", "quality"]);
    expect(imageResolutionAlias.forbiddenReads).toEqual([]);

    const sora = recorded({ seconds: 4, size: "1280x720" });
    measureOpenAIVideoMedia(sora.value);
    expect(sora.accesses).toEqual(["seconds", "size"]);
    expect(sora.forbiddenReads).toEqual([]);
  });

  it("records only config plus the allowed nested Google image and Veo selectors", () => {
    const googleConfig = recorded({ numberOfImages: 4 });
    const google = recorded({ config: googleConfig.value });
    measureGoogleImageMedia(google.value);
    expect(google.accesses).toEqual(["config"]);
    expect(googleConfig.accesses).toEqual(["numberOfImages"]);
    expect(google.forbiddenReads).toEqual([]);
    expect(googleConfig.forbiddenReads).toEqual([]);

    const veoConfig = recorded({ durationSeconds: 6, resolution: "1080p" });
    const veo = recorded({ config: veoConfig.value });
    measureVideoMedia(veo.value);
    expect(veo.accesses).toEqual(["config"]);
    expect(veoConfig.accesses).toEqual(["durationSeconds", "resolution"]);
    expect(veo.forbiddenReads).toEqual([]);
    expect(veoConfig.forbiddenReads).toEqual([]);
  });

  it("never throws when request proxies reject reads outside allowed selector paths", () => {
    expect(() =>
      estimateEmbeddingInputTokens(guarded({ input: "abcd" }, ["input"]), "openai"),
    ).not.toThrow();
    expect(() =>
      measureImageMedia(
        guarded({ n: 1, size: "256x256", quality: "hd" }, ["n", "size", "quality"]),
      ),
    ).not.toThrow();
    expect(() =>
      measureGoogleImageMedia(guarded({ config: { numberOfImages: 2 } }, ["config"])),
    ).not.toThrow();
    expect(() => measureSpeechMedia(guarded({ input: "abcd" }, ["input"]))).not.toThrow();
    expect(() =>
      measureOpenAIVideoMedia(guarded({ seconds: 4, size: "1280x720" }, ["seconds", "size"])),
    ).not.toThrow();
    expect(() =>
      measureVideoMedia(
        guarded({ config: { durationSeconds: 6, resolution: "1080p" } }, ["config"]),
      ),
    ).not.toThrow();
  });

  it("never throws when an allowed getter itself is hostile", () => {
    const hostile = Object.defineProperty({}, "input", {
      get() {
        throw new Error("hostile input getter");
      },
    });
    expect(() => estimateEmbeddingInputTokens(hostile, "openai")).not.toThrow();
    expect(() => estimateGoogleEmbeddingInputTokens(hostile, "google")).not.toThrow();
    expect(() => measureSpeechMedia(hostile)).not.toThrow();

    const hostileParts = Object.defineProperty({}, "parts", {
      get() {
        throw new Error("hostile parts getter");
      },
    });
    const hostileText = Object.defineProperty({}, "text", {
      get() {
        throw new Error("hostile text getter");
      },
    });
    expect(() =>
      estimateGoogleEmbeddingInputTokens(
        { contents: [hostileParts, { parts: [hostileText] }] },
        "google",
      ),
    ).not.toThrow();
  });
});

describe("estimateResponseContentLength — never-raises walk over response.choices", () => {
  it("sums choice.message.content across choices", () => {
    const response = {
      choices: [{ message: { content: "abc" } }, { message: { content: "de" } }],
    };
    expect(estimateResponseContentLength(response)).toBe(5);
  });

  it("adds reasoning_content on top of content (DeepSeek-style)", () => {
    const response = {
      choices: [{ message: { content: "abc", reasoning_content: "de" } }],
    };
    expect(estimateResponseContentLength(response)).toBe(5);
  });

  it("counts tool_call function.arguments (tool-only response is nonzero)", () => {
    const response = {
      choices: [
        {
          message: {
            content: "", // empty
            tool_calls: [
              { function: { arguments: '{"a":1}' } }, // 7
              { function: { arguments: "xy" } }, // 2
            ],
          },
        },
      ],
    };
    expect(estimateResponseContentLength(response)).toBe(9);
  });

  it("returns 0 (never raises) for a missing/malformed choices field", () => {
    expect(estimateResponseContentLength({})).toBe(0);
    expect(estimateResponseContentLength(null)).toBe(0);
    expect(estimateResponseContentLength({ choices: 42 })).toBe(0);
    expect(estimateResponseContentLength(undefined)).toBe(0);
  });

  it("returns the partial total accumulated before a mid-walk throw", () => {
    // A choices iterable that yields one good choice then throws on the second read.
    const response = {
      choices: {
        *[Symbol.iterator](): Iterator<unknown> {
          yield { message: { content: "abcd" } }; // 4 accumulated
          throw new Error("boom");
        },
      },
    };
    expect(estimateResponseContentLength(response)).toBe(4);
  });
});

describe("estimateStreamChunkContentLength — never-raises walk over chunk.choices", () => {
  it("sums choice.delta.content across choices", () => {
    const chunk = {
      choices: [{ delta: { content: "abc" } }, { delta: { content: "de" } }],
    };
    expect(estimateStreamChunkContentLength(chunk)).toBe(5);
  });

  it("counts delta reasoning_content and tool_calls arguments", () => {
    const chunk = {
      choices: [
        {
          delta: {
            content: "a", // 1
            reasoning_content: "bc", // 2
            tool_calls: [{ function: { arguments: "def" } }], // 3
          },
        },
      ],
    };
    expect(estimateStreamChunkContentLength(chunk)).toBe(6);
  });

  it("returns 0 (never raises) for missing/malformed choices", () => {
    expect(estimateStreamChunkContentLength({})).toBe(0);
    expect(estimateStreamChunkContentLength(null)).toBe(0);
    expect(estimateStreamChunkContentLength({ choices: "nope" })).toBe(0);
  });

  it("tolerates a null delta and null tool_calls without raising", () => {
    const chunk = {
      choices: [{ delta: null }, { delta: { content: "z", tool_calls: null } }],
    };
    expect(estimateStreamChunkContentLength(chunk)).toBe(1);
  });
});
