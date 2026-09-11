import { afterEach, describe, expect, it, vi } from "vitest";
import { SolwynCore } from "../../src/client";
import {
  ProviderUnavailableError,
  RunStoppedError,
  UntrackedSpendSurfaceError,
} from "../../src/errors";
import { Solwyn } from "../../src/index";
import { currentRun, run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import {
  clearRunTermination,
  markTerminated,
  postcheckTermination,
  resetRunControlForTest,
} from "../../src/run-control";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

afterEach(() => {
  resetRunControlForTest();
});

function allowFetch(): {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  budgetRequests: Record<string, unknown>[];
} {
  const budgetRequests: Record<string, unknown>[] = [];
  const impl: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    if (url.includes("/api/v1/budgets/check")) {
      budgetRequests.push(body as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 100,
          reservation_id: null,
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
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), budgetRequests };
}

function settlementFetch(): {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  confirms: Record<string, unknown>[];
  events: Record<string, unknown>[];
} {
  const confirms: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const impl: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    if (url.includes("/api/v1/budgets/check")) {
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 100,
          reservation_id: "reservation-responses-settlement",
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
      events.push(...(body as Record<string, unknown>[]));
      return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
    }
    throw new Error(`unexpected control-plane URL: ${url}`);
  };
  return { fetchMock: vi.fn(impl), confirms, events };
}

function guardedResponsesClient(leaf: "create" | "parse" = "create") {
  let accesses = 0;
  const method = vi.fn(() => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
  const responses: Record<string, unknown> = {};
  Object.defineProperty(responses, leaf, {
    configurable: true,
    get() {
      accesses += 1;
      return method;
    },
  });
  return {
    client: { chat: { completions: { create: () => ({}) } }, responses },
    method,
    accesses: () => accesses,
  };
}

function responsesApi(value: unknown): {
  create(...args: unknown[]): Promise<unknown>;
  parse(...args: unknown[]): Promise<unknown>;
} {
  return (value as { responses: unknown }).responses as {
    create(...args: unknown[]): Promise<unknown>;
    parse(...args: unknown[]): Promise<unknown>;
  };
}

describe("Responses pre-I/O gates", () => {
  it("capability wins before background and RequestOptions without budget or method access", async () => {
    const guarded = guardedResponsesClient();
    const client = { ...guarded.client, baseURL: "https://api.groq.com/openai/v1" };
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      onUnmetered: "raise",
    });

    let caught: unknown;
    try {
      responsesApi(solwyn).create(
        { model: "llama", input: "hi", background: true },
        { body: { stream: true } },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "UntrackedSpendSurfaceError",
      surface: "responses.create",
      provider: "groq",
    });
    expect(caught).toBeInstanceOf(UntrackedSpendSurfaceError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guarded.accesses()).toBe(0);
    await solwyn.close();
  });

  it("background refusal wins over RequestOptions before budget or method access", async () => {
    const guarded = guardedResponsesClient();
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(guarded.client, { apiKey: API_KEY, fetch: fetchMock });

    const call = responsesApi(solwyn).create(
      { model: "gpt-4o", input: "hi", background: true },
      { query: { stream: true } },
    );

    await expect(call).rejects.toMatchObject({ name: "ConfigurationError", field: "background" });
    await expect(call).rejects.toThrow(/Queued background responses expose no create-time usage/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guarded.accesses()).toBe(0);
    await solwyn.close();
  });

  it("does not read an unrelated raw stream getter before a metered refusal", async () => {
    let streamAccesses = 0;
    const responses = {
      create: vi.fn(() => ({ usage: { input_tokens: 1, output_tokens: 1 } })),
    } as Record<string, unknown>;
    Object.defineProperty(responses, "stream", {
      get() {
        streamAccesses += 1;
        throw new Error("must not read raw stream");
      },
    });
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses,
    };
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const call = responsesApi(solwyn).create({
      model: "gpt-4o",
      input: "hi",
      background: true,
    });

    await expect(call).rejects.toMatchObject({ field: "background" });
    expect(streamAccesses).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("applies the background refusal to the effective default view", async () => {
    const guarded = guardedResponsesClient();
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(guarded.client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      defaultParams: { background: true },
    });

    const call = responsesApi(solwyn).create({ model: "gpt-4o", input: "hi" });

    await expect(call).rejects.toMatchObject({ field: "background" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guarded.accesses()).toBe(0);
    await solwyn.close();
  });

  it("parse streaming refusal wins over RequestOptions before budget or method access", async () => {
    const guarded = guardedResponsesClient("parse");
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(guarded.client, { apiKey: API_KEY, fetch: fetchMock });

    const call = responsesApi(solwyn).parse(
      { model: "gpt-4o", input: "hi", stream: 1 },
      { body: null },
    );

    await expect(call).rejects.toMatchObject({ name: "ConfigurationError", field: "stream" });
    await expect(call).rejects.toThrow(/does not meter streaming responses\.parse/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guarded.accesses()).toBe(0);
    await solwyn.close();
  });

  it("refuses forced streaming parse before budget or method access", async () => {
    const guarded = guardedResponsesClient("parse");
    const { fetchMock } = allowFetch();
    const core = new SolwynCore(guarded.client, { apiKey: API_KEY, fetch: fetchMock });

    const call = core.interceptedCall(
      "responses",
      { model: "gpt-4o", input: "hi" },
      { responsesLeaf: "parse", forceStream: true },
    );

    await expect(call).rejects.toMatchObject({ field: "stream" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guarded.accesses()).toBe(0);
    await core.close();
  });

  it("applies the parse streaming refusal to the effective default view", async () => {
    const guarded = guardedResponsesClient("parse");
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(guarded.client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      defaultParams: { stream: "yes" },
    });

    const call = responsesApi(solwyn).parse({ model: "gpt-4o", input: "hi" });

    await expect(call).rejects.toMatchObject({ field: "stream" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guarded.accesses()).toBe(0);
    await solwyn.close();
  });

  it("refuses sorted body/query RequestOptions keys before budget or method access", async () => {
    const guarded = guardedResponsesClient();
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(guarded.client, { apiKey: API_KEY, fetch: fetchMock });

    const call = responsesApi(solwyn).create(
      { model: "gpt-4o", input: "hi" },
      { query: undefined, body: null },
    );

    await expect(call).rejects.toMatchObject({ name: "ConfigurationError", field: "extra_body" });
    await expect(call).rejects.toThrow(/body, query/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guarded.accesses()).toBe(0);
    await solwyn.close();
  });

  it("copies allowed RequestOptions and overwrites provider controls", async () => {
    const create = vi.fn((..._args: unknown[]) => ({
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const client = { responses: { create } };
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
    });
    const options = {
      headers: { "x-test": "1" },
      signal: new AbortController().signal,
      timeout: 20,
      maxRetries: 0,
    };

    await solwyn.responses.create({ model: "gpt-4o", input: "hi" }, options);

    expect(create.mock.calls[0]?.[1]).not.toBe(options);
    expect(create.mock.calls[0]?.[1]).toEqual({
      headers: options.headers,
      signal: options.signal,
      timeout: 600_000,
      maxRetries: 0,
    });
    expect((create.mock.calls[0]?.[1] as typeof options).headers).toBe(options.headers);
    expect(options).toEqual({
      headers: { "x-test": "1" },
      signal: options.signal,
      timeout: 20,
      maxRetries: 0,
    });
    await solwyn.close();
  });

  it("applies the shared background gate to Azure before budget or method access", async () => {
    const guarded = guardedResponsesClient();
    const client = {
      ...guarded.client,
      baseURL: "https://example.openai.azure.com/openai/v1",
    };
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const call = responsesApi(solwyn).create({
      model: "deployment",
      input: "hi",
      background: true,
    });

    await expect(call).rejects.toMatchObject({ field: "background" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(guarded.accesses()).toBe(0);
    await solwyn.close();
  });
});

describe("Responses primary-only walk", () => {
  it("does not dispatch to a healthy fallback after a primary provider error", async () => {
    const providerError = new Error("boom") as Error & { status: number };
    providerError.status = 500;
    const primaryCreate = vi.fn((..._args: unknown[]) => {
      throw providerError;
    });
    const fallbackCreate = vi.fn((..._args: unknown[]) => ({
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const primary = { responses: { create: primaryCreate } };
    const fallback = { responses: { create: fallbackCreate } };
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
      fallback: [[fallback, "fallback-model", {}, "openai"]],
    });

    await expect(solwyn.responses.create({ model: "gpt-4o", input: "hi" })).rejects.toBe(
      providerError,
    );
    expect(primaryCreate).toHaveBeenCalledTimes(1);
    expect(fallbackCreate).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("reports an empty attempted list when an open primary leaves only a healthy fallback", async () => {
    const primaryCreate = vi.fn((..._args: unknown[]) => {
      const error = new Error("provider unavailable") as Error & { status: number };
      error.status = 500;
      throw error;
    });
    const fallbackCreate = vi.fn((..._args: unknown[]) => ({
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const primary = { responses: { create: primaryCreate } };
    const fallback = { responses: { create: fallbackCreate } };
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
      fallback: [[fallback, "fallback-model", {}, "openai"]],
      circuitBreakerFailureThreshold: 1,
      circuitBreakerRecoveryTimeout: 60,
    });
    await expect(solwyn.responses.create({ model: "gpt-4o", input: "hi" })).rejects.toThrow();

    const second = solwyn.responses.create({ model: "gpt-4o", input: "again" });
    await expect(second).rejects.toMatchObject({ attempted: [] });
    await expect(second).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(fallbackCreate).not.toHaveBeenCalled();
    await solwyn.close();
  });
});

describe("Responses effective request and budget preflight", () => {
  it("passes a fresh shallow effective bag without mutating the caller's Responses values", async () => {
    let dispatched: Record<string, unknown> | undefined;
    const client = {
      responses: {
        create: vi.fn((kwargs: Record<string, unknown>) => {
          dispatched = kwargs;
          return { usage: { input_tokens: 1, output_tokens: 1 } };
        }),
      },
    };
    const { fetchMock } = allowFetch();
    const input = [{ role: "user", content: "hello" }];
    const metadata = { trace: "trace-1" };
    const caller: Record<string, unknown> = { model: null, input, metadata };
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
      model: "configured-model",
    });

    await solwyn.responses.create(caller);

    expect(dispatched).toMatchObject({ model: "configured-model", input, metadata });
    expect(dispatched).not.toBe(caller);
    expect(dispatched?.["input"]).toBe(input);
    expect(dispatched?.["metadata"]).toBe(metadata);
    expect(caller).toEqual({ model: null, input, metadata });
    await solwyn.close();
  });

  it("filters defaults only, preserves caller/future keys, fills model, and uses text primary-only budget hints", async () => {
    const create = vi.fn((kwargs: Record<string, unknown>) => ({
      usage: { input_tokens: 2, output_tokens: 1 },
      echoed: kwargs,
    }));
    const client = { responses: { create } };
    const defaults = {
      instructions: "abc",
      temperature: 0.1,
      max_tokens: 100,
      max_completion_tokens: 200,
      stream_options: { include_usage: true },
      solwyn_tags: { default: true },
      future_default: "kept",
    };
    const caller = {
      model: null,
      input: "hello",
      max_tokens: 7,
      stream_options: { caller: true },
      solwyn_tags: { caller: "tag" },
      future_call: 42,
    };
    const fallback = { responses: { create: vi.fn() } };
    const { fetchMock, budgetRequests } = allowFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
      model: "configured-model",
      defaultParams: defaults,
      fallback: [[fallback, "fallback-model", {}, "openai"]],
    });

    await solwyn.responses.create(caller);

    expect(create).toHaveBeenCalledWith(
      {
        instructions: "abc",
        temperature: 0.1,
        future_default: "kept",
        model: "configured-model",
        input: "hello",
        max_tokens: 7,
        stream_options: { caller: true },
        future_call: 42,
      },
      { timeout: 600_000, maxRetries: 0 },
    );
    expect(defaults).toEqual({
      instructions: "abc",
      temperature: 0.1,
      max_tokens: 100,
      max_completion_tokens: 200,
      stream_options: { include_usage: true },
      solwyn_tags: { default: true },
      future_default: "kept",
    });
    expect(caller).toMatchObject({
      model: null,
      max_tokens: 7,
      future_call: 42,
      solwyn_tags: { caller: "tag" },
    });
    expect(budgetRequests[0]).toMatchObject({
      estimated_input_tokens: 2,
      provider: "openai",
      model: "configured-model",
      modality: "text",
      fallback_providers: [],
      fallback_models: [],
      tags: { caller: "tag" },
    });
    await solwyn.close();
  });

  it("keeps an empty Responses estimate at zero", async () => {
    const client = {
      responses: {
        create: vi.fn((..._args: unknown[]) => ({
          usage: { input_tokens: 0, output_tokens: 0 },
        })),
      },
    };
    const { fetchMock, budgetRequests } = allowFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock, provider: "openai" });

    await solwyn.responses.create({ model: "gpt-4o" });

    expect(budgetRequests[0]?.["estimated_input_tokens"]).toBe(0);
    await solwyn.close();
  });

  it("does not apply the create-only background refusal to parse", async () => {
    const parse = vi.fn((..._args: unknown[]) => ({
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const client = { responses: { create: () => ({}), parse } };
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock, provider: "openai" });

    await expect(
      solwyn.responses.parse({ model: "gpt-4o", input: "hi", background: true }),
    ).resolves.toMatchObject({ usage: { input_tokens: 1, output_tokens: 1 } });
    await solwyn.close();
  });

  it("keeps an explicit OpenAI pin on a custom base URL and meters Responses as OpenAI", async () => {
    const create = vi.fn((..._args: unknown[]) => ({
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const client = {
      baseURL: "https://local-gateway.example/v1",
      chat: { completions: { create: vi.fn() } },
      responses: { create },
    };
    const { fetchMock, budgetRequests } = allowFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
    });

    await solwyn.responses.create({ model: "gpt-4o", input: "hi" });

    expect(create).toHaveBeenCalledOnce();
    expect(budgetRequests[0]?.["provider"]).toBe("openai");
    await solwyn.close();
  });

  it.each([
    "create",
    "parse",
  ] as const)("meters Azure Responses.%s with Azure attribution", async (leaf) => {
    const method = vi.fn((..._args: unknown[]) => ({
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const client = {
      baseURL: "https://example.openai.azure.com/openai/v1",
      chat: { completions: { create: vi.fn() } },
      responses: { create: vi.fn(), parse: vi.fn(), [leaf]: method },
    };
    const { fetchMock, budgetRequests } = allowFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await responsesApi(solwyn)[leaf]({ model: "deployment", input: "hi" });

    expect(method).toHaveBeenCalledOnce();
    expect(budgetRequests[0]?.["provider"]).toBe("azure_openai");
    await solwyn.close();
  });
});

const bufferedSettlementCases = (["openai", "azure_openai"] as const).flatMap((provider) =>
  (["create", "parse"] as const).flatMap((leaf) =>
    (["missing", "zero", "measured"] as const).map((usage) => ({ provider, leaf, usage })),
  ),
);

describe("Responses buffered settlement", () => {
  it.each(
    bufferedSettlementCases,
  )("$provider Responses.$leaf settles $usage usage through one confirm/event shape", async ({
    provider,
    leaf,
    usage,
  }) => {
    const response =
      usage === "missing"
        ? { id: "resp-missing" }
        : usage === "zero"
          ? {
              id: "resp-zero",
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                input_tokens_details: { cached_tokens: 5 },
                output_tokens_details: { reasoning_tokens: 3 },
              },
            }
          : {
              id: "resp-measured",
              usage: {
                input_tokens: 120,
                output_tokens: 45,
                input_tokens_details: { cached_tokens: 9 },
                output_tokens_details: { reasoning_tokens: 6 },
              },
              service_tier: "priority",
            };
    const method = vi.fn(() => response);
    const responses = { create: vi.fn(), parse: vi.fn(), [leaf]: method };
    const sdkClient =
      provider === "azure_openai"
        ? {
            baseURL: "https://example.openai.azure.com/openai/v1",
            chat: { completions: { create: vi.fn() } },
            responses,
          }
        : { responses };
    const traffic = settlementFetch();
    const solwyn = new Solwyn(sdkClient, {
      apiKey: API_KEY,
      fetch: traffic.fetchMock,
      ...(provider === "openai" ? { provider: "openai" as const } : {}),
      leaseEnabled: false,
    });

    await responsesApi(solwyn)[leaf]({ model: "gpt-4o", input: "12345678" });
    await solwyn.close();

    expect(traffic.confirms).toHaveLength(1);
    expect(traffic.events).toHaveLength(1);
    const confirm = traffic.confirms[0] as Record<string, unknown>;
    const event = traffic.events[0] as Record<string, unknown>;
    const expectedDetails =
      usage === "measured"
        ? expect.objectContaining({
            input_tokens: 120,
            output_tokens: 45,
            cached_input_tokens: 9,
            reasoning_tokens: 6,
          })
        : expect.objectContaining({
            input_tokens: 2,
            output_tokens: 0,
            is_estimated: true,
          });
    expect(confirm).toMatchObject({
      reservation_id: "reservation-responses-settlement",
      provider,
      token_details: expectedDetails,
    });
    expect(event).toMatchObject({
      status: "success",
      provider,
      input_tokens: usage === "measured" ? 120 : 2,
      output_tokens: usage === "measured" ? 45 : 0,
      token_details: expectedDetails,
    });
    expect(confirm["token_details"]).toEqual(event["token_details"]);
    expect(confirm["call_id"]).toBe(event["call_id"]);
    if (usage === "measured") {
      expect(confirm["token_details"]).not.toHaveProperty("is_estimated");
      expect(confirm["service_tier"]).toBe("priority");
      expect(event["service_tier"]).toBe("priority");
    }
  });
});

const streamingSettlementCases = (["openai", "azure_openai"] as const).flatMap((provider) =>
  (["missing", "zero", "measured"] as const).map((usage) => ({ provider, usage })),
);

describe("Responses streaming settlement", () => {
  it.each(
    streamingSettlementCases,
  )("$provider streaming settles $usage nested usage through one confirm/event shape", async ({
    provider,
    usage,
  }) => {
    async function* rawStream(): AsyncGenerator<unknown> {
      yield { type: "response.in_progress", response: { usage: null } };
      if (usage === "zero") {
        yield {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              input_tokens_details: { cached_tokens: 5 },
              output_tokens_details: { reasoning_tokens: 3 },
            },
            service_tier: "flex",
          },
        };
      } else if (usage === "measured") {
        yield {
          type: "response.completed",
          response: {
            usage: { input_tokens: 18, output_tokens: 7 },
            service_tier: "flex",
          },
        };
      }
    }
    const create = vi.fn(() => rawStream());
    const sdkClient =
      provider === "azure_openai"
        ? {
            baseURL: "https://example.openai.azure.com/openai/v1",
            chat: { completions: { create: vi.fn() } },
            responses: { create },
          }
        : { responses: { create } };
    const traffic = settlementFetch();
    const solwyn = new Solwyn(sdkClient, {
      apiKey: API_KEY,
      fetch: traffic.fetchMock,
      ...(provider === "openai" ? { provider: "openai" as const } : {}),
      leaseEnabled: false,
    });

    const stream = (await responsesApi(solwyn).create({
      model: "gpt-4o",
      input: "12345678",
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _event of stream) {
      // Drain through the terminal completion.
    }
    await solwyn.close();

    expect(traffic.confirms).toHaveLength(1);
    expect(traffic.events).toHaveLength(1);
    const confirm = traffic.confirms[0] as Record<string, unknown>;
    const event = traffic.events[0] as Record<string, unknown>;
    const expectedDetails =
      usage === "measured"
        ? expect.objectContaining({ input_tokens: 18, output_tokens: 7 })
        : expect.objectContaining({ input_tokens: 2, output_tokens: 0, is_estimated: true });
    expect(confirm).toMatchObject({ provider, token_details: expectedDetails });
    expect(event).toMatchObject({
      provider,
      input_tokens: usage === "measured" ? 18 : 2,
      output_tokens: usage === "measured" ? 7 : 0,
      token_details: expectedDetails,
    });
    expect(confirm["token_details"]).toEqual(event["token_details"]);
    expect(confirm["call_id"]).toBe(event["call_id"]);
    if (usage === "measured") {
      expect(confirm["service_tier"]).toBe("flex");
      expect(event["service_tier"]).toBe("flex");
    }
  });

  it.each([
    "openai",
    "azure_openai",
  ] as const)("%s abandonment settles its preflight estimate exactly once", async (provider) => {
    async function* rawStream(): AsyncGenerator<unknown> {
      yield { type: "response.output_text.delta", delta: "ignored by settlement" };
      yield {
        type: "response.completed",
        response: { usage: { input_tokens: 99, output_tokens: 44 } },
      };
    }
    const create = vi.fn(() => rawStream());
    const sdkClient =
      provider === "azure_openai"
        ? {
            baseURL: "https://example.openai.azure.com/openai/v1",
            chat: { completions: { create: vi.fn() } },
            responses: { create },
          }
        : { responses: { create } };
    const traffic = settlementFetch();
    const solwyn = new Solwyn(sdkClient, {
      apiKey: API_KEY,
      fetch: traffic.fetchMock,
      ...(provider === "openai" ? { provider: "openai" as const } : {}),
      leaseEnabled: false,
    });

    const stream = (await responsesApi(solwyn).create({
      model: "gpt-4o",
      input: "12345678",
      stream: true,
    })) as AsyncIterableIterator<unknown>;
    await stream.next();
    await stream.return?.();
    await stream.return?.();
    await solwyn.close();

    expect(traffic.confirms).toHaveLength(1);
    expect(traffic.events).toHaveLength(1);
    expect(traffic.confirms[0]).toMatchObject({
      token_details: { input_tokens: 2, output_tokens: 0, is_estimated: true },
    });
    expect(traffic.events[0]).toMatchObject({
      input_tokens: 2,
      output_tokens: 0,
      token_details: { input_tokens: 2, output_tokens: 0, is_estimated: true },
    });
  });

  it.each([
    "openai",
    "azure_openai",
  ] as const)("%s duplicate terminal events still settle once with the last usage", async (provider) => {
    async function* rawStream(): AsyncGenerator<unknown> {
      yield {
        type: "response.completed",
        response: { usage: { input_tokens: 3, output_tokens: 1 } },
      };
      yield {
        type: "response.completed",
        response: { usage: { input_tokens: 8, output_tokens: 4 } },
      };
    }
    const create = vi.fn(() => rawStream());
    const sdkClient =
      provider === "azure_openai"
        ? {
            baseURL: "https://example.openai.azure.com/openai/v1",
            chat: { completions: { create: vi.fn() } },
            responses: { create },
          }
        : { responses: { create } };
    const traffic = settlementFetch();
    const solwyn = new Solwyn(sdkClient, {
      apiKey: API_KEY,
      fetch: traffic.fetchMock,
      ...(provider === "openai" ? { provider: "openai" as const } : {}),
      leaseEnabled: false,
    });

    const stream = (await responsesApi(solwyn).create({
      model: "gpt-4o",
      input: "12345678",
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _event of stream) {
      // Drain both terminal events; only wrapper completion settles.
    }
    await solwyn.close();

    expect(traffic.confirms).toHaveLength(1);
    expect(traffic.events).toHaveLength(1);
    expect(traffic.confirms[0]).toMatchObject({
      token_details: { input_tokens: 8, output_tokens: 4 },
    });
  });
});

describe("Responses stopped-run denial ordering", () => {
  it.each([
    "create",
    "parse",
  ] as const)("reports then preserves the typed stop before Responses.%s dispatch", async (leaf) => {
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<FetchLike>(async (url, init) => {
      const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.includes("/api/v1/budgets/check")) {
        return new Response(
          JSON.stringify({
            allowed: false,
            remaining_budget: 0,
            reservation_id: null,
            mode: "hard_deny",
            budget_limit: 100,
            current_usage: 100,
            denied_by_period: "run_stopped",
            project_id: `proj_${"0".repeat(24)}`,
            price_hints: null,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/metadata/ingest") && Array.isArray(raw)) {
        events.push(...(raw as Array<Record<string, unknown>>));
      }
      return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
    });
    const order: string[] = [];
    const dispatch = vi.fn(() => {
      order.push("dispatch");
      return { usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const client = {
      chat: { completions: { create: vi.fn() } },
      responses: {
        create: leaf === "create" ? dispatch : vi.fn(),
        parse: leaf === "parse" ? dispatch : vi.fn(),
      },
    };
    const originalReport = MetadataReporter.prototype.report;
    const report = vi.spyOn(MetadataReporter.prototype, "report").mockImplementation(function (
      this: MetadataReporter,
      event,
    ) {
      order.push("report");
      originalReport.call(this, event);
      throw new Error("report failure must not mask the stop");
    });
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      leaseEnabled: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    let caught: unknown;
    try {
      await run(`responses-stopped-${leaf}`, async () => {
        caught = await responsesApi(solwyn)
          [leaf]({ model: "gpt-4o", input: "stop before dispatch" })
          .then(
            () => null,
            (error: unknown) => {
              order.push("error");
              return error;
            },
          );
      });
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(caught).toBeInstanceOf(RunStoppedError);
    expect(caught).toMatchObject({ reason: "run_stopped", source: "server" });
    expect(order).toEqual(["report", "error"]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "budget_denied" });
  });
});

describe("Responses active-stream run control", () => {
  it("settles with the immutable child, parent, and tags snapshot after the run scope exits", async () => {
    async function* rawStream(): AsyncGenerator<unknown> {
      yield {
        type: "response.completed",
        response: { usage: { input_tokens: 7, output_tokens: 3 } },
      };
    }
    const create = vi.fn(() => rawStream());
    const { fetchMock, budgetRequests } = allowFetch();
    const reports: Array<Record<string, unknown>> = [];
    const report = vi
      .spyOn(MetadataReporter.prototype, "report")
      .mockImplementation((event) => reports.push(event as unknown as Record<string, unknown>));
    const solwyn = new Solwyn(
      { chat: { completions: { create: vi.fn() } }, responses: { create } },
      {
        apiKey: API_KEY,
        fetch: fetchMock,
        leaseEnabled: false,
        velocityMode: "off",
        tags: { environment: "test" },
      },
    );
    const childTags = { phase: "entry" };
    const callTags: { phase: string; request?: string } = { phase: "call", request: "stream" };
    let parentId = "";
    let childId = "";
    let stream: AsyncIterable<unknown> | undefined;

    try {
      await run("responses-parent", { tags: { team: "sdk" } }, async () => {
        parentId = currentRun()?.agentRunId ?? "";
        await run("responses-child", { tags: childTags }, async () => {
          childId = currentRun()?.agentRunId ?? "";
          stream = (await responsesApi(solwyn).create({
            model: "gpt-4o",
            input: "snapshot",
            stream: true,
            solwyn_tags: callTags,
          })) as AsyncIterable<unknown>;
        });
      });
      childTags.phase = "mutated-after-entry";
      callTags.phase = "mutated-after-entry";
      delete callTags.request;
      for await (const _item of stream as AsyncIterable<unknown>) {
        // Settle outside both run scopes.
      }
    } finally {
      report.mockRestore();
      await solwyn.close();
    }

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "success",
      agent_run_id: childId,
      agent_run_name: "responses-child",
      parent_agent_run_id: parentId,
      tags: { phase: "call", request: "stream", team: "sdk", environment: "test" },
      input_tokens: 7,
      output_tokens: 3,
    });
    expect(budgetRequests[0]).toMatchObject({
      tags: { phase: "call", request: "stream", team: "sdk", environment: "test" },
    });
  });

  it("acquires the logical handle before dispatch so a dispatch-time stop survives eviction and clear", async () => {
    let runId = "";
    let pulls = 0;
    let closes = 0;
    async function* rawStream(): AsyncGenerator<unknown> {
      try {
        pulls += 1;
        yield {
          type: "response.completed",
          response: { usage: { input_tokens: 700, output_tokens: 300 } },
        };
      } finally {
        closes += 1;
      }
    }
    const create = vi.fn(() => {
      markTerminated(runId, { reason: "dispatch_time_stop", source: "server" });
      for (let index = 0; index < 257; index += 1) {
        markTerminated(`evict-dispatch-time-${index}`, { reason: "evict", source: "server" });
      }
      clearRunTermination(runId);
      return rawStream();
    });
    const { fetchMock } = allowFetch();
    const solwyn = new Solwyn(
      { chat: { completions: { create: vi.fn() } }, responses: { create } },
      { apiKey: API_KEY, fetch: fetchMock, leaseEnabled: false, velocityMode: "off" },
    );

    let errors: unknown[] = [];
    try {
      await run("responses-dispatch-time-stop", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const stream = (await responsesApi(solwyn).create({
          model: "gpt-4o",
          input: "dispatch stop",
          stream: true,
        })) as AsyncIterableIterator<unknown>;
        errors = [
          await stream.next().catch((error: unknown) => error),
          await stream.next().catch((error: unknown) => error),
        ];
      });
    } finally {
      await solwyn.close();
    }

    expect(create).toHaveBeenCalledOnce();
    expect(pulls).toBe(1);
    expect(closes).toBe(1);
    expect(errors[0]).toBeInstanceOf(RunStoppedError);
    expect(errors[0]).toMatchObject({
      agentRunId: runId,
      reason: "dispatch_time_stop",
      source: "server",
    });
    expect(errors[1]).toBe(errors[0]);
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-released-dispatch-time-${index}`, {
        reason: "evict",
        source: "server",
      });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });

  it("keeps two old handles stopped across eviction and clear while a new stream starts clean", async () => {
    const pulls: [number, number, number] = [0, 0, 0];
    const closes: [number, number, number] = [0, 0, 0];
    async function* rawStream(index: number): AsyncGenerator<unknown> {
      try {
        pulls[index] = (pulls[index] ?? 0) + 1;
        yield {
          type: "response.completed",
          response: { usage: { input_tokens: 4 + index, output_tokens: 2 + index } },
        };
        if (index < 2) {
          pulls[index] = (pulls[index] ?? 0) + 1;
          yield {
            type: "response.completed",
            response: { usage: { input_tokens: 900, output_tokens: 900 } },
          };
        }
      } finally {
        closes[index] = (closes[index] ?? 0) + 1;
      }
    }
    let created = 0;
    const create = vi.fn(() => rawStream(created++));
    let checks = 0;
    const events: Array<Record<string, unknown>> = [];
    const confirms: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<FetchLike>(async (url, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.includes("/api/v1/budgets/check")) {
        checks += 1;
        return new Response(
          JSON.stringify({
            allowed: true,
            remaining_budget: 100,
            reservation_id: `reservation-${checks}`,
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
        return new Response(
          JSON.stringify({ ingested: (body as unknown[]).length, rejected: [] }),
          { status: 202 },
        );
      }
      throw new Error(`unexpected path: ${url}`);
    });
    const solwyn = new Solwyn(
      { chat: { completions: { create: vi.fn() } }, responses: { create } },
      { apiKey: API_KEY, fetch: fetchMock, leaseEnabled: false, velocityMode: "off" },
    );

    const firstItems: IteratorResult<unknown>[] = [];
    const terminalErrors: unknown[][] = [[], []];
    let runId = "";
    try {
      await run("responses-two-stream-stop", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const streams = (await Promise.all([
          responsesApi(solwyn).create({ model: "gpt-4o", input: "one", stream: true }),
          responsesApi(solwyn).create({ model: "gpt-4o", input: "two", stream: true }),
        ])) as [AsyncIterableIterator<unknown>, AsyncIterableIterator<unknown>];
        firstItems.push(await streams[0].next(), await streams[1].next());
        markTerminated(runId, { reason: "operator_stop", source: "server" });
        for (let index = 0; index < 257; index += 1) {
          markTerminated(`evict-responses-${index}`, { reason: "evict", source: "server" });
        }
        clearRunTermination(runId);
        for (let index = 0; index < streams.length; index += 1) {
          const stream = streams[index];
          const errors = terminalErrors[index];
          if (stream === undefined || errors === undefined) {
            throw new Error("two-stream fixture lost an indexed stream");
          }
          errors.push(
            await stream.next().catch((error: unknown) => error),
            await stream.next().catch((error: unknown) => error),
          );
        }

        const cleanStream = (await responsesApi(solwyn).create({
          model: "gpt-4o",
          input: "after clear",
          stream: true,
        })) as AsyncIterableIterator<unknown>;
        await expect(cleanStream.next()).resolves.toMatchObject({ done: false });
        await expect(cleanStream.next()).resolves.toEqual({ done: true, value: undefined });
      });
    } finally {
      await solwyn.close();
    }

    expect(firstItems).toHaveLength(2);
    expect(firstItems.every((item) => item.done === false)).toBe(true);
    for (const errors of terminalErrors) {
      expect(errors[0]).toBeInstanceOf(RunStoppedError);
      expect(errors[0]).toMatchObject({
        agentRunId: runId,
        reason: "operator_stop",
        source: "server",
      });
      expect(errors[1]).toBe(errors[0]);
    }
    expect(pulls).toEqual([2, 2, 1]);
    expect(closes).toEqual([1, 1, 1]);
    expect(events).toHaveLength(3);
    expect(confirms).toHaveLength(3);
    expect(events.map((event) => [event["input_tokens"], event["output_tokens"]])).toEqual([
      [4, 2],
      [5, 3],
      [6, 4],
    ]);
    expect(confirms.map((confirm) => confirm["token_details"])).toEqual([
      expect.objectContaining({ input_tokens: 4, output_tokens: 2 }),
      expect.objectContaining({ input_tokens: 5, output_tokens: 3 }),
      expect.objectContaining({ input_tokens: 6, output_tokens: 4 }),
    ]);
    expect(confirms.map((confirm) => confirm["reservation_id"])).toEqual([
      "reservation-1",
      "reservation-2",
      "reservation-3",
    ]);
    expect(confirms.map((confirm) => confirm["call_id"])).toEqual(
      events.map((event) => event["call_id"]),
    );
    for (let index = 0; index <= 256; index += 1) {
      markTerminated(`evict-released-responses-${index}`, { reason: "evict", source: "server" });
    }
    expect(postcheckTermination(runId)).toBeUndefined();
  });
});
