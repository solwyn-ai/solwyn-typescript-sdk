import type OpenAI from "openai";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { Solwyn } from "../../src/index";
import { __resetAdapterRegistry } from "../../src/providers/index";
import { buildCompatAdapters } from "../../src/providers/openai-compatible";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

function makeWireCapture() {
  const checks: Array<Record<string, unknown>> = [];
  const confirms: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      checks.push(body as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 100,
          reservation_id: "res_image",
          mode: "alert_only",
          budget_limit: 100,
          current_usage: 0,
          denied_by_period: null,
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

function openAIClient(images: Record<string, unknown>, baseURL?: string): object {
  return {
    chat: { completions: { create: vi.fn() } },
    images,
    ...(baseURL === undefined ? {} : { baseURL }),
  };
}

async function generateImage(solwyn: unknown, kwargs: Record<string, unknown>): Promise<unknown> {
  return (
    solwyn as { images: { generate(value: Record<string, unknown>): Promise<unknown> } }
  ).images.generate(kwargs);
}

afterEach(() => {
  __resetAdapterRegistry();
});

describe("images surface", () => {
  it("preserves image parameter types while exposing plain Promise returns", () => {
    const _typeAssertions = (oa: OpenAI): void => {
      const client = new Solwyn(oa, { apiKey: API_KEY });
      expectTypeOf<ReturnType<typeof client.images.generate>>().not.toHaveProperty("withResponse");
      expectTypeOf<ReturnType<typeof client.images.edit>>().not.toHaveProperty("withResponse");
      expectTypeOf<ReturnType<typeof oa.images.generate>>().toHaveProperty("withResponse");
      expectTypeOf(client.images.createVariation).toEqualTypeOf(oa.images.createVariation);
    };
    void _typeAssertions;
  });

  it("settles native image token and media bases independently without exposing request data", async () => {
    const secret = "image-prompt-secret-a91d";
    const response = {
      data: [{ id: "generated" }],
      usage: {
        input_tokens: 222,
        output_tokens: 1100,
        input_tokens_details: { image_tokens: 194 },
        output_tokens_details: { image_tokens: 1024 },
      },
    };
    const generate = vi.fn(() => response);
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ generate }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    expect(
      await generateImage(solwyn, {
        model: "gpt-image-1-2026-06-01",
        prompt: secret,
        n: 2,
        size: "1024x1024",
        quality: "high",
      }),
    ).toBe(response);
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({
      modality: "image",
      estimated_input_tokens: 0,
      estimated_media: {
        image_count: 2,
        resolution: "1024x1024",
        quality: "high",
        is_estimated: false,
      },
    });
    expect(wire.confirms[0]).toMatchObject({
      modality: "image",
      token_details: {
        input_tokens: 222,
        output_tokens: 1100,
        image_input_tokens: 194,
        image_output_tokens: 1024,
      },
      media_usage: { image_count: 2, is_estimated: false },
    });
    expect(wire.events[0]).toMatchObject({
      modality: "image",
      input_tokens: 222,
      output_tokens: 1100,
      token_details: { image_input_tokens: 194, image_output_tokens: 1024 },
      media_usage: { image_count: 2, is_estimated: false },
    });
    expect(JSON.stringify({ wire, response })).not.toContain(secret);
  });

  it("uses zero token details only for the media-only confirmation carrier", async () => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(
      openAIClient({
        generate: vi.fn(() => ({
          data: [],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            input_tokens_details: { image_tokens: 5 },
          },
        })),
      }),
      { apiKey: API_KEY, fetch: wire.fetch },
    );

    await generateImage(solwyn, { model: "dall-e-3" });
    await solwyn.close();

    expect(wire.confirms[0]).toMatchObject({
      modality: "image",
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { image_count: 1, is_estimated: false },
    });
    expect(wire.events[0]).toMatchObject({
      modality: "image",
      input_tokens: 0,
      output_tokens: 0,
      media_usage: { image_count: 1, is_estimated: false },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it("keeps a native non-gpt-image model media-only even when its response resembles usage", async () => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(
      openAIClient({
        generate: vi.fn(() => ({
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            input_tokens_details: { image_tokens: 5 },
          },
        })),
      }),
      { apiKey: API_KEY, fetch: wire.fetch },
    );

    await generateImage(solwyn, { model: "chatgpt-image-latest" });
    await solwyn.close();

    expect(wire.confirms[0]).toMatchObject({
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { image_count: 1 },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it("uses the configured effective model when the image call omits model", async () => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(
      openAIClient({
        generate: vi.fn(() => ({
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            output_tokens_details: { image_tokens: 15 },
          },
        })),
      }),
      { apiKey: API_KEY, fetch: wire.fetch, model: "dall-e-3" },
    );

    await generateImage(solwyn, {});
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({ model: "dall-e-3" });
    expect(wire.confirms[0]).toMatchObject({
      model: "dall-e-3",
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { image_count: 1 },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it("keeps an explicitly relabeled OpenAI-shaped client media-only", async () => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(
      openAIClient({
        generate: vi.fn(() => ({
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            input_tokens_details: { image_tokens: 5 },
          },
        })),
      }),
      { apiKey: API_KEY, fetch: wire.fetch, provider: "groq" },
    );

    await generateImage(solwyn, { model: "gpt-image-compatible" });
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({ provider: "groq" });
    expect(wire.confirms[0]).toMatchObject({
      provider: "groq",
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { image_count: 1 },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it("uses lifecycle attribution when a client's base URL changes after wrapping", async () => {
    const wire = makeWireCapture();
    const client = openAIClient({
      generate: vi.fn(() => ({
        usage: { input_tokens: 10, output_tokens: 20 },
      })),
    }) as { baseURL?: string };
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: wire.fetch });
    void (solwyn as unknown as { images: unknown }).images;
    client.baseURL = "https://api.groq.com/openai/v1";

    await generateImage(solwyn, { model: "gpt-image-compatible" });
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({ provider: "groq" });
    expect(wire.confirms[0]).toMatchObject({
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { image_count: 1 },
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it.each([
    ["null usage", null, null],
    ["zero totals", { input_tokens: 0, output_tokens: 0 }, { input_tokens: 0, output_tokens: 0 }],
    [
      "missing details",
      { input_tokens: 2, output_tokens: 3 },
      { input_tokens: 2, output_tokens: 3, image_input_tokens: 0, image_output_tokens: 0 },
    ],
    [
      "garbage fields",
      {
        input_tokens: true,
        output_tokens: "3",
        input_tokens_details: { image_tokens: -2 },
        output_tokens_details: { image_tokens: 1.5 },
      },
      null,
    ],
  ])("degrades native extractor safely for %s", async (_label, usage, expected) => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ generate: vi.fn(() => ({ usage })) }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    await expect(generateImage(solwyn, { model: "gpt-image-1" })).resolves.toBeDefined();
    await solwyn.close();

    if (expected === null) {
      expect(wire.events[0]).not.toHaveProperty("token_details");
    } else {
      expect(wire.events[0]?.["token_details"]).toMatchObject(expected);
      expect(wire.events[0]?.["token_details"]).not.toHaveProperty("is_estimated");
    }
  });

  it("routes edit through the raw edit method and strips the private operation marker", async () => {
    const edit = vi.fn((kwargs: Record<string, unknown>) => {
      expect(kwargs).not.toHaveProperty("_solwyn_image_op");
      return { data: [] };
    });
    const generate = vi.fn();
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ generate, edit }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });

    await (
      solwyn as unknown as { images: { edit(value: Record<string, unknown>): Promise<unknown> } }
    ).images.edit({ model: "gpt-image-1", image: Symbol.for("opaque") });
    await solwyn.close();

    expect(edit).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(wire.checks[0]).toMatchObject({ modality: "image" });
    expect(wire.confirms[0]).toMatchObject({ media_usage: { image_count: 1 } });
    expect(wire.events[0]).toMatchObject({ status: "success", modality: "image" });
  });

  it("stamps generate over caller and default operation-marker collisions", async () => {
    const generate = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const edit = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ generate, edit }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      defaultParams: { _solwyn_image_op: "edit" },
    });

    await generateImage(solwyn, {
      model: "gpt-image-1",
      _solwyn_image_op: "edit",
    });
    await solwyn.close();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    expect(generate.mock.calls[0]?.[0]).not.toHaveProperty("_solwyn_image_op");
  });

  it("stamps edit over caller and default operation-marker collisions", async () => {
    const generate = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const edit = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ generate, edit }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      defaultParams: { _solwyn_image_op: "generate" },
    });

    await (
      solwyn as unknown as { images: { edit(value: Record<string, unknown>): Promise<unknown> } }
    ).images.edit({ model: "gpt-image-1", _solwyn_image_op: "generate" });
    await solwyn.close();

    expect(edit).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(edit.mock.calls[0]?.[0]).not.toHaveProperty("_solwyn_image_op");
  });

  it("settles compatible endpoints as media-only and preserves bounded selectors", async () => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(
      openAIClient(
        {
          generate: vi.fn(() => ({
            data: [],
            usage: {
              input_tokens: 99,
              output_tokens: 88,
              input_tokens_details: { image_tokens: 77 },
            },
          })),
        },
        "https://api.groq.com/openai/v1",
      ),
      { apiKey: API_KEY, fetch: wire.fetch },
    );

    await generateImage(solwyn, {
      model: "compat-image",
      n: 2,
      size: "1792x1024",
      quality: "x".repeat(33),
    });
    await solwyn.close();

    expect(wire.checks[0]).toMatchObject({
      provider: "groq",
      estimated_media: { image_count: 2, resolution: "1792x1024", quality: null },
    });
    expect(wire.events[0]).toMatchObject({ media_usage: { image_count: 2 } });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it("passes createVariation through with stable identity and binding without tracking", async () => {
    const resource = {
      marker: "images",
      createVariation(this: { marker: string }): string {
        return this.marker;
      },
    };
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient(resource), { apiKey: API_KEY, fetch: wire.fetch });
    const images = (solwyn as unknown as { images: typeof resource }).images;

    expect(images.createVariation).toBe(images.createVariation);
    expect(images.createVariation()).toBe("images");
    await solwyn.close();

    expect(wire.checks).toHaveLength(0);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
  });

  it.each([
    [0],
    [-4],
    [true],
    ["two"],
    [null],
    [1.5],
  ])("defaults invalid image quantity %j to one", async (n) => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient({ generate: vi.fn(() => ({})) }), {
      apiKey: API_KEY,
      fetch: wire.fetch,
    });
    await generateImage(solwyn, { model: "dall-e-3", n });
    await solwyn.close();
    expect((wire.checks[0]?.["estimated_media"] as Record<string, unknown>)["image_count"]).toBe(1);
  });

  it.each([
    [4, 4],
    [undefined, 1],
  ])("tracks Google generateImages quantity %j as %i", async (numberOfImages, expected) => {
    const generateImages = vi.fn(() => ({ generatedImages: [] }));
    const models = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      generateImages,
    };
    const wire = makeWireCapture();
    const solwyn = new Solwyn({ models }, { apiKey: API_KEY, fetch: wire.fetch });
    const config = numberOfImages === undefined ? {} : { numberOfImages };

    await (
      solwyn as unknown as {
        models: { generateImages(value: Record<string, unknown>): Promise<unknown> };
      }
    ).models.generateImages({ model: "imagen-3.0-generate-002", config });
    await solwyn.close();

    expect(generateImages).toHaveBeenCalledTimes(1);
    expect(wire.checks[0]).toMatchObject({
      provider: "google",
      modality: "image",
      estimated_media: { image_count: expected, is_estimated: false },
    });
    expect(wire.confirms[0]).toMatchObject({
      token_details: { input_tokens: 0, output_tokens: 0 },
      media_usage: { image_count: expected, is_estimated: false },
    });
    expect(wire.events[0]).toMatchObject({ media_usage: { image_count: expected } });
    expect(wire.events[0]).not.toHaveProperty("token_details");
  });

  it("routes images through every OpenAI-compatible adapter dispatcher", () => {
    for (const adapter of buildCompatAdapters()) {
      const images = {
        marker: adapter.name,
        generate(this: { marker: string }, value: unknown): unknown {
          return { receiver: this.marker, value };
        },
      };
      const kwargs = { model: "compat-image" };
      const prepared = adapter.prepareMediaCall?.("images", { images }, kwargs, {
        timeout: 30,
        maxRetries: 0,
      });
      expect(prepared?.method(prepared.kwargs)).toEqual({ receiver: adapter.name, value: kwargs });
    }
  });
});
