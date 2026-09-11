import type OpenAI from "openai";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { BudgetExceededError, Solwyn, type UnsupportedSurfaceError } from "../../src/index";
import type { Logger } from "../../src/logging";
import { measureOpenAIVideoMedia, measureVideoMedia } from "../../src/privacy";
import { __resetAdapterRegistry } from "../../src/providers/index";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const UNTRACKED_WARNING =
  "Provider '%s' client shape '%s' exposes untracked surface '%s' (scope: %s); no budget check and no cost event will be emitted. Tracking for this surface is coming.";

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
          reservation_id: allowed ? "res_video" : null,
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
    throw new Error(`unexpected test URL: ${url}`);
  };
  return { fetch: vi.fn(impl), checks, confirms, events };
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies Logger;
}

function openAIClient(videos: Record<string, unknown>, baseURL?: string): object {
  return {
    chat: { completions: { create: vi.fn() } },
    videos,
    ...(baseURL === undefined ? {} : { baseURL }),
  };
}

function googleClient(models: Record<string, unknown>): object {
  return {
    models: {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      ...models,
    },
  };
}

async function createVideo(
  solwyn: unknown,
  kwargs: Record<string, unknown>,
  ...rest: unknown[]
): Promise<unknown> {
  return (
    solwyn as {
      videos: {
        create(value: Record<string, unknown>, ...args: unknown[]): Promise<unknown>;
      };
    }
  ).videos.create(kwargs, ...rest);
}

async function generateVideos(
  solwyn: unknown,
  kwargs: Record<string, unknown>,
  ...rest: unknown[]
): Promise<unknown> {
  return (
    solwyn as {
      models: {
        generateVideos(value: Record<string, unknown>, ...args: unknown[]): Promise<unknown>;
      };
    }
  ).models.generateVideos(kwargs, ...rest);
}

afterEach(() => {
  __resetAdapterRegistry();
});

describe("video initiation measurement", () => {
  it("measures Sora selectors, defaults, and exact orientation matrix", () => {
    expect(measureOpenAIVideoMedia({ seconds: 8, size: "1280x720" })).toMatchObject({
      video_seconds: 8,
      resolution: "720p",
      is_estimated: true,
    });
    expect(measureOpenAIVideoMedia({})).toMatchObject({
      video_seconds: 4,
      resolution: "720p",
    });
    expect(measureOpenAIVideoMedia({ seconds: null, size: null })).toMatchObject({
      video_seconds: 4,
      resolution: "720p",
    });
    for (const [size, expected] of [
      ["1280x720", "720p"],
      ["720x1280", "720p"],
      ["1792x1024", "1024p"],
      ["1024x1792", "1024p"],
      ["1920x1080", "1080p"],
      ["1280X720", "720p"],
    ] as const) {
      expect(measureOpenAIVideoMedia({ size }).resolution).toBe(expected);
    }
  });

  it("retains the exact Sora raw-size and seconds validity matrices", () => {
    for (const size of ["720p", "big", "1280", "1280x720x30", "1280x", "x720", ""]) {
      expect(measureOpenAIVideoMedia({ size }).resolution).toBe(size);
    }
    expect(measureOpenAIVideoMedia({ size: 720 }).resolution).toBeNull();
    expect(measureOpenAIVideoMedia({ size: "x".repeat(33) }).resolution).toBeNull();
    for (const seconds of [-1, true, "eight", "4.5", "-4", [8], { s: 8 }]) {
      expect(measureOpenAIVideoMedia({ seconds }).video_seconds).toBeNull();
    }
    expect(measureOpenAIVideoMedia({ seconds: 0 }).video_seconds).toBe(0);
    expect(measureOpenAIVideoMedia({ seconds: "0" }).video_seconds).toBe(0);
  });

  it("measures index- and property-accessible Veo configs without duration defaults", () => {
    class Config {
      durationSeconds = 8;
      resolution = "720p";
    }
    expect(
      measureVideoMedia({ config: { durationSeconds: 6, resolution: "1080p" } }),
    ).toMatchObject({ video_seconds: 6, resolution: "1080p", is_estimated: true });
    expect(measureVideoMedia({ config: new Config() })).toMatchObject({
      video_seconds: 8,
      resolution: "720p",
      is_estimated: true,
    });
    expect(measureVideoMedia({ config: { durationSeconds: 5.5 } }).video_seconds).toBe(5.5);
    expect(measureVideoMedia({ config: {} }).video_seconds).toBeNull();
  });

  it("never reads or serializes video source text", () => {
    const secret = "video-secret-5b995d";
    const sora = Object.defineProperty({ seconds: 8, size: "1280x720" }, "prompt", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const veo = Object.defineProperty(
      { config: { durationSeconds: 6, resolution: "1080p" } },
      "prompt",
      {
        enumerable: true,
        get: () => {
          throw new Error(secret);
        },
      },
    );

    expect(() => measureOpenAIVideoMedia(sora)).not.toThrow();
    expect(() => measureVideoMedia(veo)).not.toThrow();
    expect(JSON.stringify(measureOpenAIVideoMedia(sora))).not.toContain(secret);
    expect(JSON.stringify(measureVideoMedia(veo))).not.toContain(secret);
  });
});

describe("OpenAI videos.create", () => {
  it("preserves OpenAI video parameter types while exposing a plain Promise", () => {
    const _typeAssertions = (oa: OpenAI): void => {
      const client = new Solwyn(oa, { apiKey: API_KEY });
      expectTypeOf<ReturnType<typeof client.videos.create>>().not.toHaveProperty("withResponse");
      expectTypeOf<ReturnType<typeof oa.videos.create>>().toHaveProperty("withResponse");
      expectTypeOf(client.videos.retrieve).toEqualTypeOf(oa.videos.retrieve);
    };
    void _typeAssertions;
  });

  it("settles at initiation with estimated media, no token basis, and the untouched job", async () => {
    const secret = "sora-secret-064d";
    const job = { id: "video_1", wait: vi.fn(), poll: vi.fn() };
    const create = vi.fn(() => job);
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ create }), { apiKey: API_KEY, fetch: wire.fetch });

    expect(
      await createVideo(solwyn, {
        model: "sora-2",
        prompt: secret,
        seconds: 8,
        size: "1280x720",
      }),
    ).toBe(job);
    await solwyn.close();

    expect(create).toHaveBeenCalledTimes(1);
    expect(job.wait).not.toHaveBeenCalled();
    expect(job.poll).not.toHaveBeenCalled();
    expect(wire.checks[0]).toMatchObject({
      provider: "openai",
      model: "sora-2",
      modality: "video",
      estimated_input_tokens: 0,
      estimated_media: { video_seconds: 8, resolution: "720p", is_estimated: true },
    });
    expect(wire.confirms[0]).toMatchObject({
      provider: "openai",
      model: "sora-2",
      modality: "video",
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { video_seconds: 8, resolution: "720p", is_estimated: true },
    });
    expect(wire.events[0]).toMatchObject({
      provider: "openai",
      model: "sora-2",
      modality: "video",
      input_tokens: 0,
      output_tokens: 0,
      media_usage: { video_seconds: 8, resolution: "720p", is_estimated: true },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
    expect(
      JSON.stringify({ checks: wire.checks, confirms: wire.confirms, events: wire.events }),
    ).not.toContain(secret);
  });

  it("uses bare Sora defaults for both preflight and settlement", async () => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ create: vi.fn(() => ({ id: "bare" })) }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      model: "sora-2",
    });

    await createVideo(solwyn, {});
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({
      model: "sora-2",
      estimated_media: { video_seconds: 4, resolution: "720p", is_estimated: true },
    });
    expect(wire.confirms[0]).toMatchObject({
      model: "sora-2",
      media_usage: { video_seconds: 4, resolution: "720p", is_estimated: true },
    });
  });

  it("denies before provider dispatch", async () => {
    const create = vi.fn();
    const wire = makeWireCapture(false);
    const solwyn = new Solwyn(openAIClient({ create }), { apiKey: API_KEY, fetch: wire.fetch });

    await expect(
      createVideo(solwyn, { model: "sora-2", seconds: 8, size: "1280x720" }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();

    expect(create).not.toHaveBeenCalled();
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events[0]).toMatchObject({ status: "budget_denied", modality: "video" });
  });

  it.each([
    ["Together", "https://api.together.xyz/v1", "together"],
    ["generic compatible", "https://example.test/v1", "openai_compatible"],
  ])("fails %s videos loudly without provider dispatch", async (_label, baseURL, provider) => {
    const create = vi.fn();
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ create }, baseURL), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    await expect(createVideo(solwyn, { model: "video-model" })).rejects.toMatchObject({
      name: "UnsupportedSurfaceError",
      surface: "videos.create",
      provider,
    } satisfies Partial<UnsupportedSurfaceError>);
    await solwyn.close();

    expect(create).not.toHaveBeenCalled();
    expect(wire.checks).toHaveLength(0);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
  });

  it("guards unlisted non-create members with stable identity and binding", async () => {
    const resource = {
      marker: "videos",
      retrieve(this: { marker: string }): string {
        return this.marker;
      },
      list: vi.fn(() => ["video"]),
      download: vi.fn(() => new Uint8Array()),
    };
    const wire = makeWireCapture();
    const log = logger();
    const solwyn = new Solwyn(openAIClient(resource), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      logger: log,
      reportUntrackedSurfaces: false,
    });
    const videos = (solwyn as unknown as { videos: typeof resource }).videos;

    expect(Object.is(videos, resource)).toBe(false);
    expect(videos.retrieve).toBe(videos.retrieve);
    expect(videos.retrieve()).toBe("videos");
    expect(videos.list).toBe(videos.list);
    expect(videos.list()).toEqual(["video"]);
    expect(videos.download).toBe(videos.download);
    await solwyn.close();

    expect(log.warn).toHaveBeenCalledTimes(3);
    for (const surface of ["videos.retrieve", "videos.list", "videos.download"]) {
      expect(log.warn).toHaveBeenCalledWith(
        UNTRACKED_WARNING,
        "openai",
        "openai_sdk",
        surface,
        null,
      );
    }
    expect(wire.checks).toHaveLength(0);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
  });

  it("binds create, applies copied request controls, and does not mutate caller state", async () => {
    const callOptions = { timeout: 123, maxRetries: 7 };
    const defaults = { seconds: 6, size: "1792x1024" };
    const resource = {
      marker: "videos",
      create(this: { marker: string }, kwargs: Record<string, unknown>, options: unknown) {
        return { receiver: this.marker, kwargs, options };
      },
    };
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient(resource), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      model: "sora-configured",
      defaultParams: defaults,
    });
    const videos = (solwyn as unknown as { videos: typeof resource }).videos;

    expect(videos.create).toBe(videos.create);
    const result = await createVideo(solwyn, { seconds: 9 }, callOptions);
    await solwyn.close();

    expect(result).toMatchObject({
      receiver: "videos",
      kwargs: { model: "sora-configured", seconds: 9, size: "1792x1024" },
      options: { timeout: 600_000, maxRetries: 0 },
    });
    expect((result as { options: unknown }).options).not.toBe(callOptions);
    expect(defaults).toEqual({ seconds: 6, size: "1792x1024" });
    expect(callOptions).toEqual({ timeout: 123, maxRetries: 7 });
  });
});

describe("Google models.generateVideos", () => {
  it("preserves a Google client's generateVideos method type", () => {
    type Operation = { readonly name: string };
    type Generate = (
      value: { model: string; config?: { durationSeconds?: number } },
      options?: { signal?: AbortSignal },
    ) => Promise<Operation>;
    const _typeAssertions = (client: {
      models: {
        generateContent(value: unknown): Promise<unknown>;
        generateContentStream(value: unknown): Promise<unknown>;
        generateVideos: Generate;
      };
    }): void => {
      const wrapped = new Solwyn(client, { apiKey: API_KEY });
      expectTypeOf(wrapped.models.generateVideos).toEqualTypeOf(client.models.generateVideos);
    };
    void _typeAssertions;
  });

  it("settles Veo initiation through the bound camelCase method and returns the operation", async () => {
    const secret = "veo-secret-b174";
    const operation = { name: "operations/1", wait: vi.fn(), poll: vi.fn() };
    let receiver: unknown;
    let dispatched: unknown;
    const generate = vi.fn(function (this: { marker: string }, kwargs: unknown) {
      receiver = this.marker;
      dispatched = kwargs;
      return operation;
    });
    const wire = makeWireCapture();
    const models = { marker: "models", generateVideos: generate };
    const solwyn = new Solwyn(googleClient(models), { apiKey: API_KEY, fetch: wire.fetch });

    const result = await generateVideos(solwyn, {
      model: "veo-3.0-generate-preview",
      prompt: secret,
      config: { durationSeconds: 6, resolution: "1080p", seed: 7 },
    });
    await solwyn.close();

    expect(result).toBe(operation);
    expect(receiver).toBe("models");
    expect(dispatched).toMatchObject({
      model: "veo-3.0-generate-preview",
      config: { durationSeconds: 6, resolution: "1080p", seed: 7 },
    });
    expect(operation.wait).not.toHaveBeenCalled();
    expect(operation.poll).not.toHaveBeenCalled();
    expect(wire.checks[0]).toMatchObject({
      provider: "google",
      model: "veo-3.0-generate-preview",
      modality: "video",
      estimated_input_tokens: 0,
      estimated_media: { video_seconds: 6, resolution: "1080p", is_estimated: true },
    });
    expect(wire.confirms[0]).toMatchObject({
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { video_seconds: 6, resolution: "1080p", is_estimated: true },
    });
    expect(wire.events[0]).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      media_usage: { video_seconds: 6, resolution: "1080p", is_estimated: true },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
    expect(
      JSON.stringify({ checks: wire.checks, confirms: wire.confirms, events: wire.events }),
    ).not.toContain(secret);
  });

  it("denies before Veo dispatch", async () => {
    const generateVideosMethod = vi.fn();
    const wire = makeWireCapture(false);
    const solwyn = new Solwyn(googleClient({ generateVideos: generateVideosMethod }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    await expect(
      generateVideos(solwyn, {
        model: "veo-3.0-generate-preview",
        config: { durationSeconds: 8, resolution: "720p" },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();

    expect(generateVideosMethod).not.toHaveBeenCalled();
    expect(wire.events[0]).toMatchObject({ status: "budget_denied", modality: "video" });
  });

  it("shapes timeout/retries without mutating caller config and keeps sibling methods stable", async () => {
    const config = {
      durationSeconds: 5.5,
      resolution: "720p",
      httpOptions: { timeout: 99, retryOptions: { attempts: 9, custom: "keep" } },
    };
    const list = vi.fn(function (this: { marker: string }) {
      return this.marker;
    });
    const generate = vi.fn((kwargs: Record<string, unknown>) => kwargs);
    const models = { marker: "models", generateVideos: generate, list };
    const wire = makeWireCapture();
    const solwyn = new Solwyn(googleClient(models), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      model: "veo-configured",
    });
    const wrappedModels = (solwyn as unknown as { models: typeof models }).models;

    const result = (await generateVideos(solwyn, { config })) as Record<string, unknown>;
    expect(wrappedModels.generateVideos).toBe(wrappedModels.generateVideos);
    expect(wrappedModels.list).toBe(wrappedModels.list);
    expect(wrappedModels.list()).toBe("models");
    await solwyn.close();

    expect(result).toMatchObject({
      model: "veo-configured",
      config: {
        durationSeconds: 5.5,
        resolution: "720p",
        httpOptions: { timeout: expect.any(Number), retryOptions: { attempts: 1, custom: "keep" } },
      },
    });
    expect(config).toEqual({
      durationSeconds: 5.5,
      resolution: "720p",
      httpOptions: { timeout: 99, retryOptions: { attempts: 9, custom: "keep" } },
    });
    expect(wire.checks[0]).toMatchObject({
      model: "veo-configured",
      estimated_media: { video_seconds: 5.5, resolution: "720p" },
    });
  });
});
