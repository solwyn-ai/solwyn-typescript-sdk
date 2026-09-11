import type OpenAI from "openai";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { BudgetExceededError, Solwyn, type UnsupportedSurfaceError } from "../../src/index";
import type { Logger } from "../../src/logging";
import { __resetAdapterRegistry } from "../../src/providers/index";
import { buildCompatAdapters } from "../../src/providers/openai-compatible";
import * as proxies from "../../src/proxies";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const UNTRACKED_WARNING =
  "Provider '%s' client shape '%s' exposes untracked surface '%s' (scope: %s); no budget check and no cost event will be emitted. Tracking for this surface is coming.";

class BedrockRuntimeClient {
  readonly meta = { service_model: { service_name: "bedrock-runtime" } };

  constructor(readonly send: ReturnType<typeof vi.fn>) {}
}

function makeWireCapture(allowed = true) {
  const checks: Array<Record<string, unknown>> = [];
  const confirms: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      checks.push(body as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          allowed,
          remaining_budget: allowed ? 100 : 0,
          reservation_id: allowed ? "res_audio" : null,
          mode: allowed ? "alert_only" : "hard_deny",
          budget_limit: 100,
          current_usage: allowed ? 0 : 100,
          denied_by_period: allowed ? null : "monthly",
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      confirms.push(body as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest")) {
      events.push(...(body as Array<Record<string, unknown>>));
      return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
    }
    if (url.includes("/providers/breaker-reports")) {
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }
    throw new Error(`unexpected test URL: ${url}`);
  };
  return { fetch: vi.fn(impl), checks, confirms, events };
}

function logger() {
  const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  } satisfies Logger;
}

function openAIClient(audio: Record<string, unknown>, baseURL?: string): object {
  return {
    chat: { completions: { create: vi.fn() } },
    audio,
    ...(baseURL === undefined ? {} : { baseURL }),
  };
}

async function transcribe(solwyn: unknown, kwargs: Record<string, unknown>, ...rest: unknown[]) {
  return (
    solwyn as {
      audio: {
        transcriptions: {
          create(value: Record<string, unknown>, ...args: unknown[]): Promise<unknown>;
        };
      };
    }
  ).audio.transcriptions.create(kwargs, ...rest);
}

async function speak(solwyn: unknown, kwargs: Record<string, unknown>, ...rest: unknown[]) {
  return (
    solwyn as {
      audio: {
        speech: { create(value: Record<string, unknown>, ...args: unknown[]): Promise<unknown> };
      };
    }
  ).audio.speech.create(kwargs, ...rest);
}

beforeEach(() => {
  __resetAdapterRegistry();
  proxies.__resetUnmeteredSurfaceWarnings();
});

describe("audio transcriptions", () => {
  it("preserves OpenAI parameter types and exposes plain Promise returns", () => {
    const _typeAssertions = (oa: OpenAI): void => {
      const client = new Solwyn(oa, { apiKey: API_KEY });
      expectTypeOf<ReturnType<typeof client.audio.transcriptions.create>>().not.toHaveProperty(
        "withResponse",
      );
      expectTypeOf<ReturnType<typeof client.audio.speech.create>>().not.toHaveProperty(
        "withResponse",
      );
      expectTypeOf<ReturnType<typeof oa.audio.transcriptions.create>>().toHaveProperty(
        "withResponse",
      );
    };
    void _typeAssertions;
  });

  it("maps speech-only, transcription-only, and optional audio children independently", () => {
    type ProviderPromise<T> = Promise<T> & { withResponse(): Promise<{ data: T }> };
    type Create = (value: { model?: string }) => ProviderPromise<string>;
    const _typeAssertions = (
      speechOnly: { audio: { speech: { create: Create } } },
      transcriptionOnly: { audio: { transcriptions: { create: Create } } },
      optional: {
        audio: {
          speech?: { create: Create };
          transcriptions?: { create: Create };
        };
      },
    ): void => {
      const speechClient = new Solwyn(speechOnly, { apiKey: API_KEY });
      expectTypeOf<ReturnType<typeof speechClient.audio.speech.create>>().not.toHaveProperty(
        "withResponse",
      );
      expectTypeOf(speechClient.audio).not.toHaveProperty("transcriptions");

      const transcriptionClient = new Solwyn(transcriptionOnly, { apiKey: API_KEY });
      expectTypeOf<
        ReturnType<typeof transcriptionClient.audio.transcriptions.create>
      >().not.toHaveProperty("withResponse");
      expectTypeOf(transcriptionClient.audio).not.toHaveProperty("speech");

      const optionalClient = new Solwyn(optional, { apiKey: API_KEY });
      type OptionalSpeech = NonNullable<typeof optionalClient.audio.speech>;
      type OptionalTranscriptions = NonNullable<typeof optionalClient.audio.transcriptions>;
      expectTypeOf<ReturnType<OptionalSpeech["create"]>>().not.toHaveProperty("withResponse");
      expectTypeOf<ReturnType<OptionalTranscriptions["create"]>>().not.toHaveProperty(
        "withResponse",
      );
    };
    void _typeAssertions;
  });

  it("settles token usage and audio input tokens exactly", async () => {
    const response = {
      text: "opaque-provider-response",
      usage: {
        type: "tokens",
        input_tokens: 100,
        output_tokens: 20,
        input_token_details: { audio_tokens: 30 },
      },
    };
    const create = vi.fn(() => response);
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ transcriptions: { create } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    expect(await transcribe(solwyn, { model: "whisper-1", file: Symbol.for("opaque") })).toBe(
      response,
    );
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({ modality: "audio", estimated_input_tokens: 0 });
    expect(wire.checks[0]).not.toHaveProperty("estimated_media");
    expect(wire.confirms[0]).toMatchObject({
      modality: "audio",
      token_details: { input_tokens: 100, output_tokens: 20, audio_input_tokens: 30 },
    });
    expect(wire.confirms[0]).not.toHaveProperty("media_usage");
    expect(wire.events[0]).toMatchObject({
      status: "success",
      modality: "audio",
      input_tokens: 100,
      output_tokens: 20,
      token_details: { audio_input_tokens: 30 },
    });
    expect(wire.events[0]).not.toHaveProperty("media_usage");
  });

  it.each([
    [7, 7.84, 7],
    [8, 7.84, 8],
  ])("settles usage.seconds %s instead of top-level duration %s", async (seconds, duration, expected) => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(
      openAIClient({
        transcriptions: {
          create: vi.fn(() => ({ duration, usage: { type: "duration", seconds } })),
        },
      }),
      { apiKey: API_KEY, fetch: wire.fetch },
    );

    await transcribe(solwyn, { model: "whisper-1", file: Symbol.for("opaque") });
    await solwyn.close();

    expect(wire.confirms[0]).toMatchObject({
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { audio_seconds: expected, is_estimated: false },
    });
    expect(wire.events[0]).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      media_usage: { audio_seconds: expected, is_estimated: false },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it("records repeated bare responses as unpriced success and emits one response-format hint", async () => {
    const wire = makeWireCapture();
    const log = logger();
    const solwyn = new Solwyn(
      openAIClient({ transcriptions: { create: vi.fn(() => "bare transcript") } }),
      { apiKey: API_KEY, fetch: wire.fetch, logger: log },
    );

    await transcribe(solwyn, { model: "whisper-1", file: Symbol.for("one") });
    await transcribe(solwyn, { model: "whisper-1", file: Symbol.for("two") });
    await solwyn.close();

    // The second identical check may be served by the normal budget cache; both calls remain
    // tracked as distinct successes.
    expect(wire.checks).toHaveLength(1);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(2);
    expect(wire.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "success",
          modality: "audio",
          input_tokens: 0,
          output_tokens: 0,
        }),
      ]),
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.join(" ")).toMatch(/response_format.*json/i);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("bare transcript");
  });

  it("records unknown usage types unpriced without the response-format hint", async () => {
    const wire = makeWireCapture();
    const log = logger();
    const solwyn = new Solwyn(
      openAIClient({ transcriptions: { create: vi.fn(() => ({ usage: { type: "future" } })) } }),
      { apiKey: API_KEY, fetch: wire.fetch, logger: log },
    );

    await transcribe(solwyn, { model: "whisper-1", file: Symbol.for("opaque") });
    await solwyn.close();

    expect(wire.confirms).toHaveLength(0);
    expect(wire.events[0]).toMatchObject({ status: "success", input_tokens: 0, output_tokens: 0 });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("settles explicitly reported zero transcription tokens", async () => {
    const response = { usage: { type: "tokens", input_tokens: 0, output_tokens: 0 } };
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ transcriptions: { create: () => response } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      breakerReportingEnabled: false,
    });
    await expect(transcribe(solwyn, { model: "gpt-4o-transcribe" })).resolves.toBe(response);
    await solwyn.close();
    expect(wire.confirms).toHaveLength(1);
    expect(wire.confirms[0]?.["token_details"]).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(wire.confirms[0]?.["token_details"]).not.toHaveProperty("is_estimated");
    expect(wire.events[0]?.["token_details"]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    expect(wire.events[0]?.["token_details"]).not.toHaveProperty("is_estimated");
  });

  it.each([
    ["garbage tokens", { usage: { type: "tokens", input_tokens: true, output_tokens: 1.5 } }],
    ["negative duration", { usage: { type: "duration", seconds: -1 } }],
    ["boolean duration", { usage: { type: "duration", seconds: true } }],
    ["string duration", { usage: { type: "duration", seconds: "7" } }],
    ["object duration", { usage: { type: "duration", seconds: { value: 7 } } }],
    ["symbol duration", { usage: { type: "duration", seconds: Symbol.for("bad") } }],
    ["non-finite duration", { usage: { type: "duration", seconds: Number.POSITIVE_INFINITY } }],
    [
      "arbitrary response",
      {
        arbitrary: new Proxy(
          {},
          {
            get: () => {
              throw new Error("hostile");
            },
          },
        ),
      },
    ],
    [
      "hostile usage getter",
      Object.defineProperty({}, "usage", {
        get: () => {
          throw new Error("hostile");
        },
      }),
    ],
  ])("never throws for %s and leaves both bases unobservable", async (_label, response) => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ transcriptions: { create: vi.fn(() => response) } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    await expect(
      transcribe(solwyn, { model: "whisper-1", file: Symbol.for("opaque") }),
    ).resolves.toBe(response);
    await solwyn.close();

    expect(wire.confirms).toHaveLength(0);
    expect(wire.events[0]).not.toHaveProperty("token_details");
    expect(wire.events[0]).not.toHaveProperty("media_usage");
  });

  it("short-circuits a hard deny before provider dispatch", async () => {
    const create = vi.fn();
    const wire = makeWireCapture(false);
    const solwyn = new Solwyn(openAIClient({ transcriptions: { create } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    await expect(
      transcribe(solwyn, { model: "whisper-1", file: Symbol.for("opaque") }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();

    expect(create).not.toHaveBeenCalled();
    expect(wire.events[0]).toMatchObject({ status: "budget_denied", modality: "audio" });
  });

  it("routes Groq transcription through the compatible OpenAI dialect", async () => {
    const create = vi.fn(() => ({ usage: { type: "tokens", input_tokens: 12, output_tokens: 3 } }));
    const wire = makeWireCapture();
    const solwyn = new Solwyn(
      openAIClient({ transcriptions: { create } }, "https://api.groq.com/openai/v1"),
      { apiKey: API_KEY, fetch: wire.fetch },
    );

    await transcribe(solwyn, { model: "whisper-large-v3", file: Symbol.for("opaque") });
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({ provider: "groq", modality: "audio" });
    expect(wire.confirms[0]).toMatchObject({
      token_details: { input_tokens: 12, output_tokens: 3 },
    });
  });

  it("routes transcriptions through every compatible adapter dispatch seam", () => {
    for (const adapter of buildCompatAdapters()) {
      const resource = {
        marker: adapter.name,
        create(this: { marker: string }, value: unknown): unknown {
          return { receiver: this.marker, value };
        },
      };
      const kwargs = { model: "whisper", _solwyn_audio_op: "transcriptions" };
      const prepared = adapter.prepareMediaCall?.(
        "audio.transcriptions",
        { audio: { transcriptions: resource } },
        kwargs,
        { timeout: 30, maxRetries: 0 },
      );

      expect(prepared?.kwargs).not.toHaveProperty("_solwyn_audio_op");
      expect(prepared?.method(prepared.kwargs)).toEqual({
        receiver: adapter.name,
        value: { model: "whisper" },
      });
    }
  });

  it.each([
    "anthropic",
    "google",
    "bedrock",
  ])("refuses unsupported audio for the %s dialect before any I/O", async (dialect) => {
    const create = vi.fn();
    const dialectShape =
      dialect === "anthropic"
        ? { messages: { create: vi.fn() } }
        : dialect === "google"
          ? { models: { generateContent: vi.fn(), generateContentStream: vi.fn() } }
          : new BedrockRuntimeClient(vi.fn());
    const client =
      dialect === "bedrock"
        ? Object.assign(dialectShape, { audio: { transcriptions: { create } } })
        : { ...dialectShape, audio: { transcriptions: { create } } };
    const wire = makeWireCapture();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: wire.fetch,
      model: "audio-model",
    });

    await expect(transcribe(solwyn, { file: Symbol.for("opaque") })).rejects.toMatchObject({
      name: "UnsupportedSurfaceError",
      surface: "audio.transcriptions.create",
      provider: dialect,
    } satisfies Partial<UnsupportedSurfaceError>);
    await solwyn.close();

    expect(create).not.toHaveBeenCalled();
    expect(wire.checks).toHaveLength(0);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
  });
});

describe("audio speech", () => {
  it.each([
    "tts-1",
    "tts-1-hd",
  ])("tracks %s by request characters with a zero token confirmation carrier", async (model) => {
    const secret = "hello world";
    const response = new Uint8Array([1, 2, 3]);
    const create = vi.fn((kwargs: Record<string, unknown>) => {
      expect(kwargs).not.toHaveProperty("_solwyn_audio_op");
      return response;
    });
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ speech: { create } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    expect(await speak(solwyn, { model, input: secret, _solwyn_audio_op: "transcriptions" })).toBe(
      response,
    );
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({
      modality: "audio",
      estimated_media: { input_characters: 11, is_estimated: false },
    });
    expect(wire.confirms[0]).toMatchObject({
      modality: "audio",
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { input_characters: 11, is_estimated: false },
    });
    expect(wire.events[0]).toMatchObject({
      modality: "audio",
      input_tokens: 0,
      output_tokens: 0,
      media_usage: { input_characters: 11, is_estimated: false },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it("stamps the trusted speech marker and applies copied request controls", async () => {
    const requestOptions = { timeout: 321 };
    const resource = {
      marker: "speech-resource",
      create: vi.fn(function (
        this: { marker: string },
        kwargs: Record<string, unknown>,
        options: unknown,
      ) {
        expect(this).toBe(resource);
        expect(kwargs).not.toHaveProperty("_solwyn_audio_op");
        expect(options).toEqual({ timeout: 600_000, maxRetries: 0 });
        expect(options).not.toBe(requestOptions);
        return this.marker;
      }),
    };
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ speech: resource }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      defaultParams: { _solwyn_audio_op: "transcriptions" },
    });

    expect(
      await speak(
        solwyn,
        { model: "tts-1", input: "hello", _solwyn_audio_op: "transcriptions" },
        requestOptions,
      ),
    ).toBe("speech-resource");
    await solwyn.close();
    expect(resource.create).toHaveBeenCalledTimes(1);
    expect(requestOptions).toEqual({ timeout: 321 });
  });

  it.each([
    ["gpt-4o-mini-tts", true],
    ["gpt-4o-mini-tts-2025-12-15", true],
    ["gpt-4o-mini-tts-custom", true],
    ["Gpt-4o-mini-tts", false],
    ["tts-1", false],
    ["xgpt-4o-mini-tts", false],
    [null, false],
    [42, false],
  ])("uses exact string-prefix carveout for %j", async (model, untracked) => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => new Uint8Array([1]));
    const wire = makeWireCapture();
    const log = logger();
    const solwyn = new Solwyn(openAIClient({ speech: { create } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      logger: log,
      model: "tts-1",
    });

    await speak(solwyn, { model, input: "secret-speech-value" });
    await solwyn.close();

    expect(wire.checks).toHaveLength(untracked ? 0 : 1);
    expect(wire.confirms).toHaveLength(untracked ? 0 : 1);
    expect(wire.events).toHaveLength(untracked ? 0 : 1);
    expect(log.warn).toHaveBeenCalledTimes(untracked ? 1 : 0);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-speech-value");
  });

  it("uses configured effective model when omitted and warns only once for two raw calls", async () => {
    const secret = "configured-model-secret";
    const resource = {
      marker: "speech",
      create: vi.fn(function (this: { marker: string }, kwargs: Record<string, unknown>) {
        expect(this).toBe(resource);
        expect(kwargs).not.toHaveProperty("_solwyn_audio_op");
        expect(kwargs["model"]).toBe("gpt-4o-mini-tts-2026-01-01");
        return this.marker;
      }),
    };
    const wire = makeWireCapture();
    const log = logger();
    const solwyn = new Solwyn(openAIClient({ speech: resource }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      logger: log,
      model: "gpt-4o-mini-tts-2026-01-01",
      defaultParams: { _solwyn_audio_op: "transcriptions" },
    });

    expect(await speak(solwyn, { input: secret, _solwyn_audio_op: "transcriptions" })).toBe(
      "speech",
    );
    expect(await speak(solwyn, { input: secret })).toBe("speech");
    await solwyn.close();

    expect(wire.checks).toHaveLength(0);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      UNTRACKED_WARNING,
      "openai",
      "openai_sdk",
      "audio.speech.create",
      "operation",
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(secret);
  });

  it("snapshots configured model and defaults against post-construction mutation", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wire = makeWireCapture();
    const create = vi.fn((kwargs: Record<string, unknown>) => {
      seen.push(kwargs);
      return new Uint8Array([1]);
    });
    const defaultParams: Record<string, unknown> = {
      model: "gpt-4o-mini-tts-snapshot",
      voice: "alloy",
    };
    const options = {
      apiKey: API_KEY,
      fetch: wire.fetch,
      model: "tts-1",
      defaultParams,
      logger: logger(),
    };
    const solwyn = new Solwyn(openAIClient({ speech: { create } }), options);

    options.model = "tts-1-hd";
    defaultParams["model"] = "tts-1";
    defaultParams["voice"] = "mutated";

    await speak(solwyn, { input: "opaque" });
    await solwyn.close();

    expect(seen).toEqual([
      expect.objectContaining({ model: "gpt-4o-mini-tts-snapshot", voice: "alloy" }),
    ]);
    expect(wire.checks).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
  });

  it.each([
    [undefined],
    [null],
  ])("resolves explicit model %s through the configured carveout model", async (model) => {
    const create = vi.fn((kwargs: Record<string, unknown>) => {
      expect(kwargs["model"]).toBe("gpt-4o-mini-tts-configured");
      return new Uint8Array([1]);
    });
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ speech: { create } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      logger: logger(),
      model: "gpt-4o-mini-tts-configured",
    });

    await speak(solwyn, { model, input: "opaque" });
    await solwyn.close();

    expect(create).toHaveBeenCalledTimes(1);
    expect(wire.checks).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
  });

  it("uses the same resolved tracked model for the decision and provider kwargs", async () => {
    const create = vi.fn((kwargs: Record<string, unknown>) => {
      expect(kwargs["model"]).toBe("tts-1");
      return new Uint8Array([1]);
    });
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ speech: { create } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      model: "tts-1",
    });

    await speak(solwyn, { model: null, input: "hello" });
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({ model: "tts-1", modality: "audio" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("turns a synchronous raw provider throw into a rejected Promise", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => {
      throw new Error("sync-provider-failure");
    });
    const solwyn = new Solwyn(openAIClient({ speech: { create } }), {
      apiKey: API_KEY,
      fetch: makeWireCapture().fetch,
      logger: logger(),
      model: "gpt-4o-mini-tts",
    });
    const speech = (
      solwyn as unknown as {
        audio: { speech: { create(value: Record<string, unknown>): Promise<unknown> } };
      }
    ).audio.speech;
    let returned: Promise<unknown> | undefined;

    expect(() => {
      returned = speech.create({ input: "opaque" });
    }).not.toThrow();
    await expect(returned).rejects.toThrow("sync-provider-failure");
    await solwyn.close();
  });

  it("cannot force or bypass the carveout with a caller marker", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => new Uint8Array([1]));
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ speech: { create } }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      model: "tts-1",
    });

    await speak(solwyn, { input: "hello", _solwyn_audio_op: "speech" });
    await solwyn.close();

    expect(wire.checks).toHaveLength(1);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("_solwyn_audio_op");
  });
});

describe("audio posture and passthrough", () => {
  it("guards translations and unknown siblings with stable identity and bound methods", async () => {
    const translations = {
      marker: "translations",
      create(this: { marker: string }) {
        return this.marker;
      },
    };
    const other = { marker: "other" };
    const log = logger();
    const solwyn = new Solwyn(openAIClient({ translations, other }), {
      apiKey: API_KEY,
      fetch: makeWireCapture().fetch,
      logger: log,
      reportUntrackedSurfaces: false,
    });
    const audio = (
      solwyn as unknown as { audio: { translations: typeof translations; other: object } }
    ).audio;

    const guardedTranslations = audio.translations;
    const guardedOther = audio.other;
    expect(Object.is(guardedTranslations, audio.translations)).toBe(true);
    expect(Object.is(guardedTranslations, translations)).toBe(false);
    expect(guardedTranslations.create()).toBe("translations");
    expect(Object.is(guardedOther, audio.other)).toBe(true);
    expect(Object.is(guardedOther, other)).toBe(false);
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(3));
    expect(log.warn).toHaveBeenCalledWith(
      UNTRACKED_WARNING,
      "openai",
      "openai_sdk",
      "audio.translations",
      "resource",
    );
    expect(log.warn).toHaveBeenCalledWith(
      UNTRACKED_WARNING,
      "openai",
      "openai_sdk",
      "audio.translations.create",
      null,
    );
    expect(log.warn).toHaveBeenCalledWith(
      UNTRACKED_WARNING,
      "openai",
      "openai_sdk",
      "audio.other",
      null,
    );
    await solwyn.close();
  });

  it("keeps intercepted create identity stable and passes other child methods through bound", async () => {
    const wire = makeWireCapture();
    const transcriptions = {
      marker: "transcriptions",
      create: vi.fn((_kwargs: Record<string, unknown>) => ({
        usage: { type: "tokens", input_tokens: 1, output_tokens: 0 },
      })),
      list(this: { marker: string }) {
        return this.marker;
      },
    };
    const solwyn = new Solwyn(openAIClient({ transcriptions }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });
    const resource = (solwyn as unknown as { audio: { transcriptions: typeof transcriptions } })
      .audio.transcriptions;

    expect(resource.create).toBe(resource.create);
    expect(resource.list).toBe(resource.list);
    expect(resource.list()).toBe("transcriptions");
    await resource.create({ model: "whisper-1", file: Symbol.for("opaque") } as never);
    await solwyn.close();
    expect(wire.checks).toHaveLength(1);
  });
});
