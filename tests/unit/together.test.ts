import NativeTogether from "together-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Solwyn } from "../../src/index";
import {
  __resetAdapterRegistry,
  ADAPTER_REGISTRATION_ORDER,
  getAdapterByName,
  getAdapterForClient,
} from "../../src/providers/index";
import {
  buildCompatAdapters,
  OpenAICompatibleAdapter,
} from "../../src/providers/openai-compatible";
import { TogetherAdapter } from "../../src/providers/together";
import * as proxies from "../../src/proxies";
import { classifyException, Disposition } from "../../src/routing";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const WARNING =
  "Provider '%s' client shape '%s' exposes untracked surface '%s' (scope: %s); no budget check and no cost event will be emitted. Tracking for this surface is coming.";

interface Capture {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  checks: Array<Record<string, unknown>>;
  confirms: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

function makeCapture(): Capture {
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
          remaining_budget: 950,
          reservation_id: "res-together",
          mode: "alert_only",
          budget_limit: 1000,
          current_usage: 50,
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
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(body)) {
      events.push(...(body as Array<Record<string, unknown>>));
    }
    return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), checks, confirms, events };
}

class Together {
  readonly chat: { completions: { create: ReturnType<typeof vi.fn> } };
  readonly baseURL?: string;

  constructor(create: (kwargs: Record<string, unknown>) => unknown, baseURL?: string) {
    this.chat = { completions: { create: vi.fn(create) } };
    this.baseURL = baseURL;
  }
}

class WrappedTogether extends Together {}
class TogetherWithoutChat {}
class OpenAI {
  readonly chat: { completions: { create: ReturnType<typeof vi.fn> } };

  constructor(
    create: (kwargs: Record<string, unknown>) => unknown,
    readonly baseURL: string,
  ) {
    this.chat = { completions: { create: vi.fn(create) } };
  }
}

function openAIClient(create: (kwargs: Record<string, unknown>) => unknown) {
  return { chat: { completions: { create: vi.fn(create) } } };
}

function chatCreate(solwyn: unknown, kwargs: Record<string, unknown>): Promise<unknown> {
  return (
    solwyn as {
      chat: { completions: { create(value: Record<string, unknown>): Promise<unknown> } };
    }
  ).chat.completions.create(kwargs);
}

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn<(message: string, ...args: unknown[]) => void>(),
    error: vi.fn(),
  };
}

beforeEach(() => {
  __resetAdapterRegistry();
  proxies.__resetUnmeteredSurfaceWarnings();
});

describe("TogetherAdapter registry and detection", () => {
  it("uses the dedicated adapter only for the Together profile slot", async () => {
    const together = await getAdapterByName("together");
    expect(together).toBeInstanceOf(TogetherAdapter);
    expect(together).toBe(await getAdapterByName("together"));

    const otherCompatNames = buildCompatAdapters()
      .map((adapter) => adapter.name)
      .filter((name) => name !== "together");
    for (const name of otherCompatNames) {
      expect((await getAdapterByName(name)).constructor).toBe(OpenAICompatibleAdapter);
    }
  });

  it("keeps Together before plain OpenAI and the generic catch-all last among compat adapters", () => {
    expect(ADAPTER_REGISTRATION_ORDER.indexOf("together")).toBeLessThan(
      ADAPTER_REGISTRATION_ORDER.indexOf("openai_compatible"),
    );
    expect(ADAPTER_REGISTRATION_ORDER.indexOf("openai_compatible")).toBeLessThan(
      ADAPTER_REGISTRATION_ORDER.indexOf("openai"),
    );
  });

  it("detects native Together subclasses only with chat.completions.create", async () => {
    const native = new WrappedTogether(() => ({ usage: {} }));
    expect(await getAdapterForClient(native)).toBe(await getAdapterByName("together"));
    await expect(getAdapterForClient(new TogetherWithoutChat())).rejects.toMatchObject({
      name: "ConfigurationError",
    });
  });

  it("inherits host-profile fallback and resolves host and native clients to one singleton", async () => {
    const openAIAtTogetherHost = new OpenAI(() => ({ usage: {} }), "https://api.together.ai/v1");
    const byHost = await getAdapterForClient(openAIAtTogetherHost);
    const byNative = await getAdapterForClient(new Together(() => ({ usage: {} })));
    expect(byHost).toBe(byNative);
    expect(byHost).toBe(await getAdapterByName("together"));
  });
});

describe("TogetherAdapter inherited OpenAI-compatible behavior", () => {
  it("uses the existing Together profile", () => {
    const adapter = new TogetherAdapter();
    expect(adapter.name).toBe("together");
    expect(adapter.dialect).toBe("openai");
    expect(adapter.profile.hosts).toEqual(["api.together.xyz", "api.together.ai"]);
    expect(adapter.profile.supportsIncludeUsage).toBe(false);
  });

  it("never injects stream_options and strips caller options on a failover hop", () => {
    const adapter = new TogetherAdapter();
    expect(adapter.prepareStreaming({ model: "meta-llama/Llama-3" })).toEqual({
      model: "meta-llama/Llama-3",
    });
    const caller = {
      model: "meta-llama/Llama-3",
      stream_options: { include_usage: true },
    };
    expect(adapter.prepareStreaming(caller, { crossProvider: true })).toEqual({
      model: "meta-llama/Llama-3",
    });
    expect(caller.stream_options).toEqual({ include_usage: true });
  });

  it("settles terminal streaming usage, cached tokens, tier, and missing-usage estimates", () => {
    const adapter = new TogetherAdapter();
    const observed = adapter.createStreamAccumulator({ estimatedInputTokens: 3 });
    observed.observe({
      usage: {
        prompt_tokens: 21,
        completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 6 },
      },
      service_tier: "priority",
    });
    expect(observed.finalize()).toMatchObject({
      input_tokens: 21,
      output_tokens: 8,
      cached_input_tokens: 6,
      is_estimated: false,
    });
    expect(observed.getServiceTier()).toBe("priority");

    const estimated = adapter.createStreamAccumulator({ estimatedInputTokens: 3 });
    estimated.observe({ choices: [{ delta: { content: "x".repeat(40) } }] });
    expect(estimated.finalize()).toMatchObject({
      input_tokens: 3,
      output_tokens: 10,
      is_estimated: true,
    });
  });

  it("settles flat cached_tokens from a terminal stream chunk", () => {
    const accumulator = new TogetherAdapter().createStreamAccumulator();
    accumulator.observe({
      usage: {
        prompt_tokens: 500,
        completion_tokens: 25,
        cached_tokens: 400,
      },
    });

    expect(accumulator.finalize()).toMatchObject({
      input_tokens: 500,
      output_tokens: 25,
      cached_input_tokens: 400,
      is_estimated: false,
    });
  });
});

describe("Together end-to-end lifecycle", () => {
  it("budgets before buffered dispatch and reports exact Together usage once", async () => {
    const { fetchMock, checks, confirms, events } = makeCapture();
    const client = new Together(() => {
      expect(checks).toHaveLength(1);
      return {
        usage: {
          prompt_tokens: 13,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      };
    });
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await chatCreate(solwyn, { model: "meta-llama/Llama-3", messages: [] });
    await solwyn.close();

    expect(checks).toHaveLength(1);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(confirms).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(checks[0]?.["provider"]).toBe("together");
    expect(confirms[0]).toMatchObject({
      provider: "together",
      token_details: { input_tokens: 13, output_tokens: 5 },
    });
    expect(events[0]).toMatchObject({ provider: "together", input_tokens: 13, output_tokens: 5 });
    expect((events[0]?.["token_details"] as Record<string, unknown>)["cached_input_tokens"]).toBe(
      4,
    );
    expect(events[0]?.["token_details"] as Record<string, unknown>).not.toHaveProperty(
      "is_estimated",
    );
  });

  it("settles Together streaming usage only after exhaustion without injecting stream_options", async () => {
    async function* chunks(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "hello" } }] };
      yield {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 6 },
        },
        service_tier: "priority",
      };
    }
    const client = new Together(() => chunks());
    const { fetchMock, events } = makeCapture();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const stream = (await chatCreate(solwyn, {
      model: "meta-llama/Llama-3",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;

    expect(events).toHaveLength(0);
    const dispatched = client.chat.completions.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(dispatched["stream"]).toBe(true);
    expect(dispatched).not.toHaveProperty("stream_options");
    for await (const _chunk of stream) {
      // Drain to terminal settlement.
    }
    await solwyn.close();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "together",
      input_tokens: 21,
      output_tokens: 8,
      service_tier: "priority",
    });
    expect((events[0]?.["token_details"] as Record<string, unknown>)["cached_input_tokens"]).toBe(
      6,
    );
  });

  it("settles a usage-less Together stream through the wrapper with an estimated event", async () => {
    async function* chunks(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "x".repeat(40) } }] };
      yield { choices: [{ delta: {} }] };
    }
    const client = new Together(() => chunks());
    const { fetchMock, confirms, events } = makeCapture();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const stream = (await chatCreate(solwyn, {
      model: "meta-llama/Llama-3",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;

    expect(events).toHaveLength(0);
    for await (const _chunk of stream) {
      // Drain the real wrapper so terminal settlement owns the estimate.
    }
    await solwyn.close();

    expect(confirms).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "together",
      output_tokens: 10,
      token_details: {
        output_tokens: 10,
        is_estimated: true,
      },
    });
  });

  it("strips foreign stream_options when failing over into Together", async () => {
    const primary = openAIClient(() => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });
    async function* chunks(): AsyncGenerator<unknown> {
      yield { usage: { prompt_tokens: 2, completion_tokens: 1 } };
    }
    const fallback = new Together(() => chunks());
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[fallback, "meta-llama/Llama-3"]],
    });
    const stream = (await chatCreate(solwyn, {
      model: "gpt-4o",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      // Drain.
    }
    await solwyn.close();

    const dispatched = fallback.chat.completions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(dispatched).not.toHaveProperty("stream_options");
  });

  it("passes through a same-provider Together model swap", async () => {
    let calls = 0;
    const client = new Together((kwargs) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }
      return { usage: { prompt_tokens: 4, completion_tokens: 2 }, kwargs };
    });
    const { fetchMock, events } = makeCapture();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[client, "meta-llama/Llama-3.1"]],
    });

    await chatCreate(solwyn, { model: "meta-llama/Llama-3", messages: [] });
    await solwyn.close();

    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(client.chat.completions.create.mock.calls[1]?.[0]).toMatchObject({
      model: "meta-llama/Llama-3.1",
    });
    const success = events.find((event) => event["status"] === "success");
    expect(success).toMatchObject({
      provider: "together",
      is_model_fallback: true,
      is_provider_fallback: false,
    });
  });

  it("normalizes the modern cap alias before native Together serialization", async () => {
    let nativeCap: unknown;
    let hasModernAlias = false;
    const together = new NativeTogether({
      apiKey: crypto.randomUUID(),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        nativeCap = body.max_tokens;
        hasModernAlias = Object.hasOwn(body, "max_completion_tokens");
        return Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(together, { apiKey: API_KEY, fetch: fetchMock });
    try {
      await chatCreate(solwyn, {
        model: "meta-llama/Llama-3",
        messages: [],
        max_completion_tokens: 10,
      });
      expect(nativeCap).toBe(10);
      expect(hasModernAlias).toBe(false);
    } finally {
      await solwyn.close();
    }
  });

  it("stops the chain when Together rejects a model-unsupported kwarg", async () => {
    const rejected = Object.assign(new Error("unknown parameter"), { status: 400 });
    const together = new Together((kwargs) => {
      // Cap aliases are normalized before dispatch; this unrelated native
      // model capability remains provider-validated (Together's compatibility docs).
      if ("logit_bias" in kwargs) {
        throw rejected;
      }
      return { usage: {} };
    });
    const later = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(together, {
      apiKey: API_KEY,
      fetch: fetchMock,
      fallback: [[later, "gpt-4o-mini"]],
    });

    try {
      await expect(
        chatCreate(solwyn, {
          model: "meta-llama/Llama-3",
          messages: [],
          max_completion_tokens: 10,
          logit_bias: { "0": -1 },
        }),
      ).rejects.toBe(rejected);
    } finally {
      await solwyn.close();
    }
    expect(later.chat.completions.create).not.toHaveBeenCalled();
  });
});

describe("Together unmetered spend posture", () => {
  it.each([
    "completions",
    "rerank",
    "codeInterpreter",
    "evals",
  ])("warns once and passes through existing %s without budget or event I/O", async (surface) => {
    proxies.__resetUnmeteredSurfaceWarnings();
    const raw = { run: vi.fn(() => "raw") };
    const secret = "never-log-this-secret";
    const client = new Together(() => ({ usage: {} })) as Together & Record<string, unknown>;
    client[surface] = raw;
    client["secret"] = secret;
    const log = logger();
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: log,
      reportUntrackedSurfaces: false,
    });
    const wrapped = solwyn as unknown as Record<string, unknown>;

    const first = wrapped[surface];
    expect(Object.is(first, raw)).toBe(false);
    expect(Object.is(first, wrapped[surface])).toBe(true);
    expect((first as { run(): string }).run()).toBe("raw");
    expect(raw.run).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        WARNING,
        "together",
        "native_together",
        surface,
        "resource",
      ),
    );
    expect(log.warn).toHaveBeenCalledWith(
      WARNING,
      "together",
      "native_together",
      surface,
      "resource",
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("guards the unlisted code_interpreter alias as an unknown surface", async () => {
    const raw = { run: vi.fn(() => "raw") };
    const client = new Together(() => ({ usage: {} })) as Together & Record<string, unknown>;
    client["code_interpreter"] = raw;
    const log = logger();
    const { fetchMock } = makeCapture();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger: log,
      reportUntrackedSurfaces: false,
    });

    const wrapped = (solwyn as unknown as Record<string, unknown>)["code_interpreter"];
    expect(Object.is(wrapped, raw)).toBe(false);
    expect((wrapped as { run(): string }).run()).toBe("raw");
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        WARNING,
        "together",
        "native_together",
        "code_interpreter",
        null,
      ),
    );
    expect(log.warn).toHaveBeenCalledWith(
      WARNING,
      "together",
      "native_together",
      "code_interpreter",
      null,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("does not warn for a missing attribute, while a plain OpenAI unknown leaf is guarded", async () => {
    const togetherLog = logger();
    const together = new Solwyn(new Together(() => ({ usage: {} })), {
      apiKey: API_KEY,
      fetch: makeCapture().fetchMock,
      logger: togetherLog,
    });
    expect((together as unknown as Record<string, unknown>)["rerank"]).toBeUndefined();
    await Promise.resolve();
    expect(togetherLog.warn).not.toHaveBeenCalled();
    await together.close();

    const openAILog = logger();
    const raw = { run: () => "raw" };
    const openai = new Solwyn(
      { ...openAIClient(() => ({ usage: {} })), rerank: raw },
      {
        apiKey: API_KEY,
        fetch: makeCapture().fetchMock,
        logger: openAILog,
      },
    );
    const wrapped = (openai as unknown as Record<string, unknown>)["rerank"];
    expect(Object.is(wrapped, raw)).toBe(false);
    await vi.waitFor(() => expect(openAILog.warn).toHaveBeenCalledTimes(1));
    expect(openAILog.warn).toHaveBeenCalledWith(WARNING, "openai", "openai_sdk", "rerank", null);
    await openai.close();
  });
});

describe("Together-shaped exception classification", () => {
  class APIConnectionError extends Error {}
  class APITimeoutError extends APIConnectionError {}

  it("classifies timeout, HTTP, and refused-connection fixtures without importing Together", () => {
    expect(classifyException(new APITimeoutError())).toBe(Disposition.POST_SEND_AMBIGUOUS);
    expect(classifyException({ status: 429 })).toBe(Disposition.FAILOVER);
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifyException({ status })).toBe(Disposition.FAIL_FAST);
    }
    for (const status of [500, 503]) {
      expect(classifyException({ status })).toBe(Disposition.POST_SEND_AMBIGUOUS);
    }
    const refused = Object.assign(new APIConnectionError(), {
      cause: Object.assign(new Error(), { code: "ECONNREFUSED" }),
    });
    expect(classifyException(refused)).toBe(Disposition.FAILOVER);
  });
});
