import { beforeEach, describe, expect, it, vi } from "vitest";
import { Solwyn } from "../../src/index";
import * as proxies from "../../src/proxies";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const WARNING =
  "Provider '%s' client shape '%s' exposes untracked surface '%s' (scope: %s); no budget check and no cost event will be emitted. Tracking for this surface is coming.";

function logger() {
  const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
}

const fetchMock = vi.fn<FetchLike>(
  async () => new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 }),
);

function resetWarnings(): void {
  const reset = (proxies as unknown as { __resetUnmeteredSurfaceWarnings?: () => void })
    .__resetUnmeteredSurfaceWarnings;
  reset?.();
}

function openAIClient(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chat: { completions: { create: () => ({ usage: {} }) } },
    ...extra,
  };
}

async function waitForWarnings(log: ReturnType<typeof logger>, count: number): Promise<void> {
  await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(count));
}

beforeEach(() => {
  fetchMock.mockClear();
  resetWarnings();
});

describe("unmetered spend posture", () => {
  it("warns once per process and returns an identity-stable guarded resource", async () => {
    const translations = { create: vi.fn(() => "raw") };
    const client = openAIClient({ audio: { translations } });
    const log = logger();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: log,
      reportUntrackedSurfaces: false,
    });
    const audio = (solwyn as unknown as { audio: { translations: object } }).audio;

    const first = audio.translations;
    const second = audio.translations;
    expect(Object.is(first, translations)).toBe(false);
    expect(Object.is(first, second)).toBe(true);
    expect((first as { create(): string }).create()).toBe("raw");
    expect(translations.create).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        WARNING,
        "openai",
        "openai_sdk",
        "audio.translations",
        "resource",
      ),
    );
    expect(log.warn).toHaveBeenCalledWith(
      WARNING,
      "openai",
      "openai_sdk",
      "audio.translations",
      "resource",
    );
    await solwyn.close();
  });

  it("shares the warning latch across two Solwyn clients", async () => {
    const one = logger();
    const two = logger();
    const resource = { create: () => "raw" };
    const first = new Solwyn(openAIClient({ audio: { translations: resource } }), {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: one,
    });
    const second = new Solwyn(openAIClient({ audio: { translations: resource } }), {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: two,
    });

    void (first as unknown as { audio: { translations: unknown } }).audio.translations;
    void (second as unknown as { audio: { translations: unknown } }).audio.translations;
    await vi.waitFor(() => expect(one.warn.mock.calls.length + two.warn.mock.calls.length).toBe(1));
    await first.close();
    await second.close();
  });

  it("returns embeddings/images sub-proxies and guarded unlisted OpenAI resources", async () => {
    const embeddings = { create: () => "embedding", with_raw_response: {} };
    const images = { generate: () => "image", variations: () => "variation" };
    const moderations = { create: () => "moderation" };
    const files = { list: () => [] };
    const models = { list: () => [] };
    const client = openAIClient({ embeddings, images, moderations, files, models });
    const log = logger();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: log,
      reportUntrackedSurfaces: false,
    });
    const wrapped = solwyn as unknown as Record<string, unknown>;

    expect(Object.is(wrapped["embeddings"], embeddings)).toBe(false);
    expect(Object.is(wrapped["images"], images)).toBe(false);
    for (const [surface, raw] of Object.entries({ moderations, files, models })) {
      const first = wrapped[surface];
      expect(Object.is(first, raw)).toBe(false);
      expect(Object.is(first, wrapped[surface])).toBe(true);
    }
    await waitForWarnings(log, 3);
    expect(log.warn).toHaveBeenCalledWith(WARNING, "openai", "openai_sdk", "moderations", null);
    expect(log.warn).toHaveBeenCalledWith(WARNING, "openai", "openai_sdk", "files", null);
    expect(log.warn).toHaveBeenCalledWith(WARNING, "openai", "openai_sdk", "models", null);
    await solwyn.close();
  });

  it("does not warn or consume the latch for a missing or unrelated attribute", async () => {
    const firstLog = logger();
    const missing = new Solwyn(openAIClient({ audio: {} }), {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: firstLog,
    });
    expect((missing as unknown as { audio: { translations?: unknown } }).audio.translations).toBe(
      undefined,
    );
    void (missing as unknown as { moderations?: unknown }).moderations;
    await Promise.resolve();
    expect(firstLog.warn).not.toHaveBeenCalled();

    const secondLog = logger();
    const translations = { create: () => "raw" };
    const present = new Solwyn(openAIClient({ audio: { translations } }), {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: secondLog,
    });
    void (present as unknown as { audio: { translations: unknown } }).audio.translations;
    await waitForWarnings(secondLog, 1);
    await missing.close();
    await present.close();
  });

  it("preserves undefined for an entirely missing media resource", async () => {
    const log = logger();
    const solwyn = new Solwyn(openAIClient(), {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: log,
    });

    expect((solwyn as unknown as { audio?: unknown }).audio).toBeUndefined();
    expect((solwyn as unknown as { embeddings?: unknown }).embeddings).toBeUndefined();
    expect((solwyn as unknown as { images?: unknown }).images).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
    await solwyn.close();
  });
});

class StartAsyncInvokeCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

class BedrockRuntimeClient {
  readonly meta = { service_model: { service_name: "bedrock-runtime" } };

  constructor(readonly send: ReturnType<typeof vi.fn>) {}
}

describe("Bedrock async invoke posture", () => {
  it("fails loudly without dispatching StartAsyncInvokeCommand", async () => {
    const send = vi.fn();
    const client = new BedrockRuntimeClient(send);
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await expect(
      (solwyn as unknown as { send(command: unknown): Promise<unknown> }).send(
        new StartAsyncInvokeCommand({ modelId: "video-model" }),
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      message: expect.stringMatching(/StartAsyncInvokeCommand.*unwrapped client/i),
    });
    expect(send).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("fails loudly on a name-mangled async-invoke command detected by shape", async () => {
    const send = vi.fn();
    const client = new BedrockRuntimeClient(send);
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const command = {
      input: {
        modelId: "video-model",
        outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://test/output" } },
      },
    };

    await expect(
      (solwyn as unknown as { send(value: unknown): Promise<unknown> }).send(command),
    ).rejects.toMatchObject({ name: "ConfigurationError" });
    expect(send).not.toHaveBeenCalled();
    await solwyn.close();
  });
});
