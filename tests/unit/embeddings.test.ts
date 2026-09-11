import type OpenAI from "openai";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { BudgetExceededError, Solwyn, type UnsupportedSurfaceError } from "../../src/index";
import type { Logger } from "../../src/logging";
import { __resetAdapterRegistry } from "../../src/providers/index";
import { buildCompatAdapters } from "../../src/providers/openai-compatible";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

interface WireCapture {
  fetch: ReturnType<typeof vi.fn<FetchLike>>;
  checks: Array<Record<string, unknown>>;
  confirms: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

function makeWireCapture(allowed = true): WireCapture {
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
          reservation_id: allowed ? "res_embedding" : null,
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

function logger(): Logger & { calls: Array<readonly unknown[]> } {
  const calls: Array<readonly unknown[]> = [];
  return {
    calls,
    debug: (...args) => calls.push(args),
    info: (...args) => calls.push(args),
    warn: (...args) => calls.push(args),
    error: (...args) => calls.push(args),
  };
}

function openAIClient(create: (...args: unknown[]) => unknown, baseURL?: string): object {
  return {
    chat: { completions: { create: vi.fn() } },
    embeddings: { create },
    ...(baseURL === undefined ? {} : { baseURL }),
  };
}

async function createEmbedding(
  solwyn: unknown,
  kwargs: Record<string, unknown>,
  ...rest: unknown[]
) {
  return (
    solwyn as {
      embeddings: { create(k: Record<string, unknown>, ...r: unknown[]): Promise<unknown> };
    }
  ).embeddings.create(kwargs, ...rest);
}

afterEach(() => {
  __resetAdapterRegistry();
});

describe("embeddings surface", () => {
  it("preserves OpenAI embedding parameter types and exposes the intercepted plain Promise", () => {
    const _typeAssertions = (oa: OpenAI): void => {
      const client = new Solwyn(oa, { apiKey: API_KEY });

      void client.embeddings.create({ model: "text-embedding-3-small", input: "hello" }, undefined);
      expectTypeOf<ReturnType<typeof client.embeddings.create>>().not.toHaveProperty(
        "withResponse",
      );
      expectTypeOf<ReturnType<typeof oa.embeddings.create>>().toHaveProperty("withResponse");
    };
    void _typeAssertions;
  });

  it("settles exact OpenAI usage and applies copied request controls without leaking content", async () => {
    const secret = "embedding-secret-9a4b7f";
    const input = secret.padEnd(40, "x");
    const requestOptions = { timeout: 321, maxRetries: 7, headers: { "x-test": "yes" } };
    const resource = {
      marker: "embeddings-resource",
      create: vi.fn(function (this: { marker: string }, kwargs: unknown, options: unknown) {
        expect(this).toBe(resource);
        expect(kwargs).toMatchObject({ model: "text-embedding-3-small", input });
        expect(options).toEqual({
          timeout: 600_000,
          maxRetries: 0,
          headers: { "x-test": "yes" },
        });
        expect(options).not.toBe(requestOptions);
        return { data: [{ embedding: [0.1] }], usage: { prompt_tokens: 42 } };
      }),
      status(this: { marker: string }): string {
        return this.marker;
      },
    };
    const client = {
      chat: { completions: { create: vi.fn() } },
      embeddings: resource,
    };
    const wire = makeWireCapture();
    const log = logger();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: wire.fetch, logger: log });
    const wrapped = solwyn as unknown as {
      embeddings: {
        create: unknown;
        status(): string;
      };
    };

    expect(wrapped.embeddings).toBe(wrapped.embeddings);
    expect(wrapped.embeddings.create).toBe(wrapped.embeddings.create);
    expect(wrapped.embeddings.status).toBe(wrapped.embeddings.status);
    expect(wrapped.embeddings.status()).toBe("embeddings-resource");

    const result = await createEmbedding(
      solwyn,
      { model: "text-embedding-3-small", input },
      requestOptions,
    );
    await solwyn.close();

    expect(result).toMatchObject({ data: [{ embedding: [0.1] }] });
    expect(requestOptions).toEqual({
      timeout: 321,
      maxRetries: 7,
      headers: { "x-test": "yes" },
    });
    expect(resource.create).toHaveBeenCalledTimes(1);
    expect(wire.checks).toHaveLength(1);
    expect(wire.confirms).toHaveLength(1);
    expect(wire.events).toHaveLength(1);
    expect(wire.checks[0]).toMatchObject({
      provider: "openai",
      modality: "embedding",
      estimated_input_tokens: 10,
    });
    expect(wire.checks[0]).not.toHaveProperty("estimated_media");
    expect(wire.checks[0]).not.toHaveProperty("fallback_providers");
    expect(wire.checks[0]).not.toHaveProperty("fallback_models");
    expect(wire.confirms[0]).toMatchObject({
      modality: "embedding",
      token_details: { input_tokens: 42, output_tokens: 0 },
    });
    expect(wire.confirms[0]?.["token_details"] as object).not.toHaveProperty("is_estimated");
    expect(wire.events[0]).toMatchObject({
      status: "success",
      modality: "embedding",
      input_tokens: 42,
      output_tokens: 0,
      token_details: { input_tokens: 42, output_tokens: 0 },
    });
    expect(JSON.stringify({ wire, logs: log.calls })).not.toContain(secret);
  });

  it.each([
    ["absent", {}, 10],
    ["boolean", { usage: { prompt_tokens: true } }, 10],
    ["non-integer", { usage: { prompt_tokens: 1.5 } }, 10],
    ["garbage", { usage: { prompt_tokens: "42" } }, 10],
  ])("falls back to estimated OpenAI input when usage is %s", async (_label, response, expected) => {
    const create = vi.fn(() => response);
    const wire = makeWireCapture();
    const solwyn = new Solwyn(openAIClient(create), { apiKey: API_KEY, fetch: wire.fetch });

    await createEmbedding(solwyn, { model: "text-embedding-3-small", input: "x".repeat(40) });
    await solwyn.close();

    expect(create).toHaveBeenCalledTimes(1);
    expect(wire.checks[0]).toMatchObject({
      modality: "embedding",
      estimated_input_tokens: expected,
    });
    expect(wire.confirms[0]).toMatchObject({
      modality: "embedding",
      token_details: { input_tokens: expected, output_tokens: 0, is_estimated: true },
    });
    expect(wire.events[0]).toMatchObject({
      modality: "embedding",
      input_tokens: expected,
      output_tokens: 0,
      token_details: { input_tokens: expected, output_tokens: 0, is_estimated: true },
    });
  });

  it.each([
    "openai",
    "google",
  ] as const)("preserves explicit %s zero over a nonzero request estimate", async (provider) => {
    const wire = makeWireCapture();
    const create = () => ({ usage: { prompt_tokens: 0 } });
    const models = {
      generateContent() {},
      generateContentStream() {},
      embedContent: () => ({ usageMetadata: { promptTokenCount: 0 } }),
    };
    const solwyn = new Solwyn(provider === "google" ? { models } : openAIClient(create), {
      apiKey: API_KEY,
      fetch: wire.fetch,
      breakerReportingEnabled: false,
    });
    if (provider === "google") {
      await (
        solwyn as unknown as {
          models: { embedContent(kwargs: Record<string, unknown>): Promise<unknown> };
        }
      ).models.embedContent({
        model: "gemini-embedding-001",
        contents: "x".repeat(40),
      });
    } else {
      await createEmbedding(solwyn, { model: "text-embedding-3-small", input: "x".repeat(40) });
    }
    await solwyn.close();
    expect(Number(wire.checks[0]?.["estimated_input_tokens"])).toBeGreaterThan(0);
    expect(wire.confirms).toHaveLength(1);
    expect(wire.confirms[0]?.["token_details"]).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(wire.confirms[0]?.["token_details"]).not.toHaveProperty("is_estimated");
    expect(wire.events[0]?.["token_details"]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    expect(wire.events[0]?.["token_details"]).not.toHaveProperty("is_estimated");
  });

  it("hard-denies before OpenAI dispatch and reports an embedding denial", async () => {
    const create = vi.fn();
    const wire = makeWireCapture(false);
    const solwyn = new Solwyn(openAIClient(create), { apiKey: API_KEY, fetch: wire.fetch });

    await expect(
      createEmbedding(solwyn, { model: "text-embedding-3-small", input: "x".repeat(40) }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();

    expect(create).not.toHaveBeenCalled();
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(1);
    expect(wire.events[0]).toMatchObject({
      status: "budget_denied",
      modality: "embedding",
      input_tokens: 10,
      output_tokens: 0,
    });
  });

  it("settles exact Google usage and injects the one-attempt HTTP bound without mutating kwargs", async () => {
    const originalConfig = {
      candidateCount: 2,
      httpOptions: { headers: { "x-customer": "kept" }, retryOptions: { jitter: 0.2 } },
    };
    const kwargs = {
      model: "gemini-embedding-001",
      contents: { parts: [{ text: "x".repeat(19) }, { text: "y".repeat(21) }] },
      config: originalConfig,
    };
    const models = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn(function (this: unknown, shaped: Record<string, unknown>) {
        expect(this).toBe(models);
        const config = shaped["config"] as Record<string, unknown>;
        const http = config["httpOptions"] as Record<string, unknown>;
        expect(config["candidateCount"]).toBe(2);
        expect(http["headers"]).toEqual({ "x-customer": "kept" });
        expect(http["timeout"]).toBe(600_000);
        expect(config["abortSignal"]).toBeInstanceOf(AbortSignal);
        expect(http["retryOptions"]).toEqual({ jitter: 0.2, attempts: 1 });
        return { embeddings: [], usageMetadata: { promptTokenCount: 55 } };
      }),
    };
    const wire = makeWireCapture();
    const solwyn = new Solwyn({ models }, { apiKey: API_KEY, fetch: wire.fetch });

    await (
      solwyn as unknown as {
        models: { embedContent(k: Record<string, unknown>): Promise<unknown> };
      }
    ).models.embedContent(kwargs);
    await solwyn.close();

    expect(kwargs.config).toBe(originalConfig);
    expect(originalConfig).toEqual({
      candidateCount: 2,
      httpOptions: { headers: { "x-customer": "kept" }, retryOptions: { jitter: 0.2 } },
    });
    expect(models.embedContent).toHaveBeenCalledTimes(1);
    expect(wire.checks[0]).toMatchObject({
      provider: "google",
      modality: "embedding",
      estimated_input_tokens: 10,
    });
    expect(wire.confirms[0]).toMatchObject({
      modality: "embedding",
      token_details: { input_tokens: 55, output_tokens: 0 },
    });
    expect(wire.confirms[0]?.["token_details"] as object).not.toHaveProperty("is_estimated");
  });

  it("falls back to estimated Google usage when usageMetadata is absent", async () => {
    const secret = "google-embedding-secret-7c4e";
    const embedContent = vi.fn(() => ({ embeddings: [] }));
    const models = { generateContent: vi.fn(), generateContentStream: vi.fn(), embedContent };
    const wire = makeWireCapture();
    const solwyn = new Solwyn({ models }, { apiKey: API_KEY, fetch: wire.fetch });

    await (
      solwyn as unknown as {
        models: { embedContent(k: Record<string, unknown>): Promise<unknown> };
      }
    ).models.embedContent({ model: "gemini-embedding-001", contents: secret.padEnd(40, "x") });
    await solwyn.close();

    expect(wire.confirms[0]).toMatchObject({
      modality: "embedding",
      token_details: { input_tokens: 10, output_tokens: 0, is_estimated: true },
    });
    expect(wire.events[0]).toMatchObject({
      modality: "embedding",
      input_tokens: 10,
      output_tokens: 0,
      token_details: { is_estimated: true },
    });
    expect(JSON.stringify(wire)).not.toContain(secret);
  });

  it.each([
    ["direct text Part", { text: "x".repeat(40) }],
    [
      "PartUnion array",
      [{ text: "x".repeat(20) }, { inlineData: "ignored" }, { text: "y".repeat(20) }],
    ],
  ])("estimates Google %s contents when usageMetadata is absent", async (_label, contents) => {
    const embedContent = vi.fn(() => ({ embeddings: [] }));
    const models = { generateContent: vi.fn(), generateContentStream: vi.fn(), embedContent };
    const wire = makeWireCapture();
    const solwyn = new Solwyn({ models }, { apiKey: API_KEY, fetch: wire.fetch });

    await (
      solwyn as unknown as {
        models: { embedContent(k: Record<string, unknown>): Promise<unknown> };
      }
    ).models.embedContent({ model: "gemini-embedding-001", contents });
    await solwyn.close();

    expect(wire.checks[0]?.["estimated_input_tokens"]).toBe(10);
    expect(wire.confirms[0]).toMatchObject({
      modality: "embedding",
      token_details: { input_tokens: 10, output_tokens: 0, is_estimated: true },
    });
  });

  it.each([
    ["integer ids", [11, 22, 33, 44, 55], 5],
    [
      "nested integer ids",
      [
        [11, 22],
        [33, 44, 55],
      ],
      5,
    ],
    ["empty input", "", 0],
    ["unrecognized input", { opaque: true }, 0],
    ["boolean ids", [true, false], 0],
  ])("integrates the privacy estimator for %s", async (_label, input, expected) => {
    const wire = makeWireCapture();
    const solwyn = new Solwyn(
      openAIClient(() => ({})),
      {
        apiKey: API_KEY,
        fetch: wire.fetch,
      },
    );

    await createEmbedding(solwyn, { model: "text-embedding-3-small", input });
    await solwyn.close();

    expect(wire.checks[0]?.["estimated_input_tokens"]).toBe(expected);
    expect(wire.confirms[0]).toMatchObject({
      token_details: { input_tokens: expected, output_tokens: 0, is_estimated: true },
    });
  });

  it("routes embeddings through every OpenAI-compatible adapter implementation", () => {
    for (const adapter of buildCompatAdapters()) {
      const resource = {
        marker: adapter.name,
        create(this: { marker: string }, value: unknown): unknown {
          return { receiver: this.marker, value };
        },
      };
      const kwargs = { model: "compat-embedding", opaque: Symbol.for("opaque") };
      const prepared = adapter.prepareMediaCall?.("embeddings", { embeddings: resource }, kwargs, {
        timeout: 30,
        maxRetries: 0,
      });

      expect(prepared).toBeDefined();
      expect(prepared?.kwargs).toEqual(kwargs);
      expect(prepared?.kwargs).not.toBe(kwargs);
      expect(prepared?.method(prepared.kwargs)).toEqual({ receiver: adapter.name, value: kwargs });
    }
  });

  it("refuses an unsupported non-embedding dialect before provider or control-plane I/O", async () => {
    const nativeCreate = vi.fn();
    const client = {
      messages: { create: vi.fn() },
      embeddings: { create: nativeCreate },
    };
    const wire = makeWireCapture();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: wire.fetch });

    await expect(
      createEmbedding(solwyn, { model: "claude-3-5-sonnet", input: "x".repeat(40) }),
    ).rejects.toMatchObject({
      name: "UnsupportedSurfaceError",
      surface: "embeddings.create",
      provider: "anthropic",
    } satisfies Partial<UnsupportedSurfaceError>);
    await solwyn.close();

    expect(nativeCreate).not.toHaveBeenCalled();
    expect(wire.checks).toHaveLength(0);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
  });
});
