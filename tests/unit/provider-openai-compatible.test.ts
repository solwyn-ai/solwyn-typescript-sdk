/**
 * Exercises `OpenAICompatibleAdapter`, the `COMPAT_PROFILES` table, and the
 * `CompatStreamAccumulator` three-tier usage settlement. Fully offline; no fetch, no
 * provider SDK — every fixture is a plain object shaped like an OpenAI Chat Completions
 * response/chunk or a client instance.
 */

import { describe, expect, it, vi } from "vitest";
import { ConfigurationError, UnsupportedSurfaceError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import type { Logger } from "../../src/logging";
import {
  buildCompatAdapters,
  COMPAT_PROFILES,
  CompatProfile,
  CompatStreamAccumulator,
  OpenAICompatibleAdapter,
} from "../../src/providers/openai-compatible";
import type { ProviderAdapter } from "../../src/providers/protocol";
import type { FetchLike } from "../../src/transport";
import { PROVIDER_NAMES } from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

function fakeLogger(): Logger & { infos: string[]; warnings: string[] } {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    debug: () => {},
    info: (message: string) => {
      infos.push(message);
    },
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
  };
}

/** An OpenAI-dialect-shaped client for a given base URL (has chat.completions.create). */
function openAIClient(baseURL: string): Record<string, unknown> {
  return { baseURL, chat: { completions: { create: () => undefined } } };
}

/** All compat adapters (fresh, with a silent logger by default). */
function adapters(logger?: Logger): OpenAICompatibleAdapter[] {
  return buildCompatAdapters(logger ? { logger } : {});
}

/** Registry-order detection: first adapter whose detectClient matches wins. */
function detectName(client: unknown, built = adapters()): string | undefined {
  return built.find((a) => a.detectClient(client))?.name;
}

// ---------------------------------------------------------------------------
// Profile table.
// ---------------------------------------------------------------------------

describe("COMPAT_PROFILES table", () => {
  it("has exactly 15 entries", () => {
    expect(COMPAT_PROFILES).toHaveLength(15);
  });

  it("profile names are unique (test_profile_names_are_unique)", () => {
    const names = COMPAT_PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every profile name is a valid ProviderName (test_profile_names_are_provider_name_values)", () => {
    for (const profile of COMPAT_PROFILES) {
      expect(PROVIDER_NAMES).toContain(profile.name);
    }
  });

  it("the catch-all is LAST and is the only catch_all (test_catch_all_is_last_profile)", () => {
    const last = COMPAT_PROFILES[COMPAT_PROFILES.length - 1] as CompatProfile;
    expect(last.name).toBe("openai_compatible");
    expect(last.catchAll).toBe(true);
    const catchAlls = COMPAT_PROFILES.filter((p) => p.catchAll);
    expect(catchAlls).toHaveLength(1);
  });

  it("the exact order matches the load-bearing spec table", () => {
    expect(COMPAT_PROFILES.map((p) => p.name)).toEqual([
      "xai",
      "deepseek",
      "mistral",
      "qwen",
      "zai",
      "groq",
      "together",
      "fireworks",
      "perplexity",
      "azure_openai",
      "openrouter",
      "ollama",
      "vllm",
      "lmstudio",
      "openai_compatible",
    ]);
  });

  it("supports_include_usage per profile matches the spec table", () => {
    const expected: Record<string, boolean> = {
      xai: false,
      deepseek: true,
      mistral: false,
      qwen: true,
      zai: true,
      groq: true,
      together: false,
      fireworks: false,
      perplexity: false,
      azure_openai: true,
      openrouter: false,
      ollama: true,
      vllm: true,
      lmstudio: true,
      openai_compatible: false,
    };
    for (const profile of COMPAT_PROFILES) {
      expect(profile.supportsIncludeUsage).toBe(expected[profile.name]);
    }
  });

  it("enables Responses only for Azure OpenAI", () => {
    for (const profile of COMPAT_PROFILES) {
      expect(profile.supportsResponses).toBe(profile.name === "azure_openai");
    }
  });

  it("defaults Responses capability to false for a future profile", () => {
    expect(new CompatProfile({ name: "openai_compatible" }).supportsResponses).toBe(false);
  });
});

describe("buildCompatAdapters", () => {
  it("builds one adapter per profile, in order (test_all_adapters_satisfy_protocol/order)", () => {
    const built = adapters();
    expect(built).toHaveLength(15);
    expect(built.map((a) => a.name)).toEqual(COMPAT_PROFILES.map((p) => p.name));
    expect(built[0]?.name).toBe("xai");
    expect(built[built.length - 1]?.name).toBe("openai_compatible");
  });

  it("every adapter satisfies the ProviderAdapter interface and speaks the openai dialect", () => {
    for (const built of adapters()) {
      const asAdapter: ProviderAdapter = built; // compile-time conformance
      expect(asAdapter.dialect).toBe("openai");
      expect(typeof asAdapter.detectClient).toBe("function");
      expect(typeof asAdapter.detectModel).toBe("function");
      expect(typeof asAdapter.extractUsage).toBe("function");
      expect(typeof asAdapter.estimateMissingUsage).toBe("function");
      expect(typeof asAdapter.extractServiceTier).toBe("function");
      expect(typeof asAdapter.extractRegion).toBe("function");
      expect(typeof asAdapter.prepareStreaming).toBe("function");
      expect(typeof asAdapter.createStreamAccumulator).toBe("function");
      expect(typeof asAdapter.prepareCall).toBe("function");
      expect(typeof asAdapter.unwrapStreamSource).toBe("function");
      expect(typeof asAdapter.wrapStreamResult).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Client detection by base URL.
// ---------------------------------------------------------------------------

describe("detectClient — host detection matrix (test_known_host_detects_named_provider)", () => {
  const cases: Array<[string, string]> = [
    ["https://api.x.ai/v1", "xai"],
    ["https://api.deepseek.com/v1", "deepseek"],
    ["https://api.mistral.ai/v1", "mistral"],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen"],
    ["https://dashscope-us.aliyuncs.com/compatible-mode/v1", "qwen"],
    ["https://api.z.ai/api/paas/v4", "zai"],
    ["https://API.Z.AI/api/paas/v4", "zai"],
    ["https://api.groq.com/openai/v1", "groq"],
    ["https://api.together.xyz/v1", "together"],
    ["https://api.together.ai/v1", "together"],
    ["https://api.fireworks.ai/inference/v1", "fireworks"],
    ["https://api.perplexity.ai", "perplexity"],
    ["https://my-resource.openai.azure.com/openai/deployments/gpt-4o", "azure_openai"],
    ["https://my-resource.cognitiveservices.azure.com", "azure_openai"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["http://localhost:11434/v1", "ollama"],
    ["http://127.0.0.1:11434/v1", "ollama"],
    // IPv6 loopback literal: URL.hostname keeps the brackets ('[::1]'); the parser must strip
    // them so the local-host set matches the exact `::1` constant.
    ["http://[::1]:11434/v1", "ollama"],
    ["http://[::1]:8000/v1", "vllm"],
    ["http://localhost:8000/v1", "vllm"],
    ["http://localhost:1234/v1", "lmstudio"],
  ];

  it.each(cases)("%s detects as %s", (baseURL, expected) => {
    expect(detectName(openAIClient(baseURL))).toBe(expected);
  });
});

describe("Z.ai end-to-end attribution", () => {
  it("attributes the budget check and metadata event to zai and reports cached tokens", async () => {
    const checks: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.includes("/api/v1/budgets/check")) {
        checks.push(body as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            allowed: true,
            remaining_budget: 950,
            reservation_id: "res-zai",
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
        return new Response(null, { status: 204 });
      }
      if (url.includes("/api/v1/metadata/ingest") && Array.isArray(body)) {
        events.push(...(body as Array<Record<string, unknown>>));
      }
      return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
    };
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    }));
    const client = {
      baseURL: "https://api.z.ai/api/paas/v4",
      chat: { completions: { create } },
    };
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: vi.fn(fetchImpl) });

    await solwyn.chat.completions.create({ model: "glm-4.6", messages: [] });
    await solwyn.close();

    expect(create).toHaveBeenCalledTimes(1);
    expect(checks[0]?.["provider"]).toBe("zai");
    expect(events).toHaveLength(1);
    expect(events[0]?.["provider"]).toBe("zai");
    expect((events[0]?.["token_details"] as Record<string, unknown>)["cached_input_tokens"]).toBe(
      4,
    );
  });
});

describe("detectClient — snake_case base_url fallback (finding 8)", () => {
  it("a client exposing only base_url (no baseURL) detects the expected named provider", () => {
    const client = {
      base_url: "https://api.groq.com/openai/v1",
      chat: { completions: { create: () => undefined } },
    };
    expect(detectName(client)).toBe("groq");
  });

  it("when both baseURL and base_url are present, baseURL wins", () => {
    // baseURL → groq host, base_url → xai host: the camelCase property takes precedence.
    const client = {
      baseURL: "https://api.groq.com/openai/v1",
      base_url: "https://api.x.ai/v1",
      chat: { completions: { create: () => undefined } },
    };
    expect(detectName(client)).toBe("groq");
  });
});

describe("detectClient — fallthrough & OpenAI-host exclusion", () => {
  it("an unknown remote https host falls to the generic catch-all (test_unknown_remote_host)", () => {
    expect(detectName(openAIClient("https://api.some-unknown-vendor.example/v1"))).toBe(
      "openai_compatible",
    );
  });

  it("localhost on a non-default port falls to the catch-all (test_localhost_nonstandard_port)", () => {
    expect(detectName(openAIClient("http://localhost:9999/v1"))).toBe("openai_compatible");
  });

  it("api.openai.com is claimed by NO compat adapter (test_openai_default_base_url_stays_openai)", () => {
    expect(detectName(openAIClient("https://api.openai.com/v1"))).toBeUndefined();
  });

  it.each([
    "https://eu.api.openai.com/v1",
    "https://us.api.openai.com/v1",
  ])("OpenAI regional host %s is claimed by NO compat adapter (test_openai_regional_hosts)", (baseURL) => {
    expect(detectName(openAIClient(baseURL))).toBeUndefined();
  });

  it("a client with no base URL is claimed by NO compat adapter (test_missing_base_url)", () => {
    const client = { chat: { completions: { create: () => undefined } } };
    expect(detectName(client)).toBeUndefined();
  });

  it("an unparseable garbage base URL never throws and matches NO compat adapter (test_unparseable_base_url)", () => {
    const client = openAIClient("<MagicMock id='0x7f'>");
    expect(() => detectName(client)).not.toThrow();
    expect(detectName(client)).toBeUndefined();
  });

  it("a non-openai-shaped client is rejected even if its base URL matches a compat host (test_non_openai_module)", () => {
    // Anthropic-shaped: messages.create only, constructor not 'openai', but Groq's host.
    const client = {
      baseURL: "https://api.groq.com/openai/v1",
      messages: { create: () => undefined },
    };
    expect(detectName(client)).toBeUndefined();
    // The groq adapter specifically rejects it.
    const groq = adapters().find((a) => a.name === "groq");
    expect(groq?.detectClient(client)).toBe(false);
  });
});

describe("detectClient — Azure class-name detection (independent of base URL)", () => {
  it("class name AzureOpenAI is detected as azure_openai without any base URL (test_azure_by_class_name)", () => {
    class AzureOpenAI {}
    expect(detectName(new AzureOpenAI())).toBe("azure_openai");
  });

  it("class name AsyncAzureOpenAI is detected as azure_openai (test_async_azure_by_class_name)", () => {
    class AsyncAzureOpenAI {}
    expect(detectName(new AsyncAzureOpenAI())).toBe("azure_openai");
  });
});

describe("detectClient — local-port heuristic one-time INFO log", () => {
  it("logs one INFO (provider name, not URL) on first local-port detection, once only", () => {
    const logger = fakeLogger();
    const ollama = adapters(logger).find((a) => a.name === "ollama");
    expect(ollama).toBeDefined();
    ollama?.detectClient(openAIClient("http://localhost:11434/v1"));
    ollama?.detectClient(openAIClient("http://127.0.0.1:11434/v1"));
    expect(logger.infos).toHaveLength(1);
    expect(logger.infos[0]).toContain("ollama");
    // Never leaks the URL.
    expect(logger.infos[0]).not.toContain("11434");
    expect(logger.infos[0]).not.toContain("localhost");
  });

  it("does not log the port heuristic for a plain host match (e.g. groq)", () => {
    const logger = fakeLogger();
    const groq = adapters(logger).find((a) => a.name === "groq");
    groq?.detectClient(openAIClient("https://api.groq.com/openai/v1"));
    expect(logger.infos).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Model-prefix detection.
// ---------------------------------------------------------------------------

describe("detectModel — distinctive prefixes (test_distinctive_prefix_detects_provider)", () => {
  const cases: Array<[string, string]> = [
    ["grok-4", "xai"],
    ["deepseek-chat", "deepseek"],
    ["mistral-large-latest", "mistral"],
    ["codestral-2405", "mistral"],
    ["qwen-max", "qwen"],
    ["qwq-32b", "qwen"],
    ["glm-4.6", "zai"],
    ["sonar-pro", "perplexity"],
    ["accounts/fireworks/models/llama-v3p1-70b-instruct", "fireworks"],
  ];

  it.each(cases)("%s detects as %s", (model, expected) => {
    const matches = adapters().filter((a) => a.detectModel(model));
    expect(matches.map((a) => a.name)).toContain(expected);
  });

  it("a shared open-weight model with no distinctive prefix matches NO adapter (test_shared_open_weight)", () => {
    const matches = adapters().filter((a) => a.detectModel("llama-3-8b"));
    expect(matches).toEqual([]);
  });

  it("gpt-4o matches NO compat adapter (test_gpt_model_still_detects_openai)", () => {
    const matches = adapters().filter((a) => a.detectModel("gpt-4o"));
    expect(matches).toEqual([]);
  });

  it("catch-all and shared-catalog vendors carry no model prefixes", () => {
    for (const name of [
      "groq",
      "together",
      "openrouter",
      "ollama",
      "vllm",
      "lmstudio",
      "azure_openai",
      "openai_compatible",
    ]) {
      const profile = COMPAT_PROFILES.find((p) => p.name === name);
      expect(profile?.modelPrefixes).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// prepareStreaming — include_usage injection policy.
// ---------------------------------------------------------------------------

const INJECTING = ["deepseek", "qwen", "zai", "groq", "azure_openai", "ollama", "vllm", "lmstudio"];
const NON_INJECTING = [
  "xai",
  "mistral",
  "together",
  "fireworks",
  "perplexity",
  "openrouter",
  "openai_compatible",
];

function adapterNamed(name: string): OpenAICompatibleAdapter {
  const found = adapters().find((a) => a.name === name);
  if (!found) {
    throw new Error(`no adapter ${name}`);
  }
  return found;
}

describe("prepareStreaming — injection policy", () => {
  it.each(
    INJECTING,
  )("%s injects stream_options.include_usage without mutating input (test_supported_providers_inject)", (name) => {
    const adapter = adapterNamed(name);
    const kwargs = { model: "m" };
    const prepared = adapter.prepareStreaming(kwargs);
    expect(prepared).not.toBe(kwargs);
    expect(prepared["stream_options"]).toEqual({ include_usage: true });
    // Input untouched.
    expect(kwargs).toEqual({ model: "m" });
    expect("stream_options" in kwargs).toBe(false);
  });

  it.each(
    NON_INJECTING,
  )("%s never injects stream_options on the caller's own target (test_unsupported_providers_do_not_inject)", (name) => {
    const adapter = adapterNamed(name);
    const prepared = adapter.prepareStreaming({ model: "m" });
    expect("stream_options" in prepared).toBe(false);
  });

  it.each(
    NON_INJECTING,
  )("%s STRIPS a caller stream_options on a cross-provider hop (test_unsupported_providers_strip_on_failover_hop)", (name) => {
    const adapter = adapterNamed(name);
    const kwargs = { model: "m", stream_options: { include_usage: true } };
    const prepared = adapter.prepareStreaming(kwargs, { crossProvider: true });
    expect("stream_options" in prepared).toBe(false);
    // Input untouched.
    expect(kwargs.stream_options).toEqual({ include_usage: true });
  });

  it.each(
    NON_INJECTING,
  )("%s PRESERVES a caller stream_options on its own target (test_caller_stream_options_preserved_on_own_target)", (name) => {
    const adapter = adapterNamed(name);
    const streamOptions = { include_usage: true };
    const kwargs = { model: "m", stream_options: streamOptions };
    const prepared = adapter.prepareStreaming(kwargs); // crossProvider defaults false
    expect(prepared["stream_options"]).toEqual({ include_usage: true });
  });

  it("merges into an existing stream_options rather than replacing it (test_supported_provider_merges_existing)", () => {
    const adapter = adapterNamed("groq");
    const kwargs = { model: "m", stream_options: { other: 1 } };
    const prepared = adapter.prepareStreaming(kwargs);
    expect(prepared["stream_options"]).toEqual({ other: 1, include_usage: true });
    // Input's nested object untouched.
    expect(kwargs.stream_options).toEqual({ other: 1 });
  });
});

describe("prepareStreaming — Azure on-your-data caveat", () => {
  it("azure skips injection when top-level data_sources present (test_azure_skips_injection_for_data_sources)", () => {
    const adapter = adapterNamed("azure_openai");
    const prepared = adapter.prepareStreaming({ model: "m", data_sources: [{ type: "x" }] });
    expect("stream_options" in prepared).toBe(false);
  });

  it("azure skips injection when extra_body.data_sources present (test_azure_skips_injection_for_extra_body)", () => {
    const adapter = adapterNamed("azure_openai");
    const prepared = adapter.prepareStreaming({
      model: "m",
      extra_body: { data_sources: [{ type: "x" }] },
    });
    expect("stream_options" in prepared).toBe(false);
  });

  it("azure SKIPS injection for a NON-NULL extra_body.data_sources list (value-not-null, matches Python is-not-None)", () => {
    // A genuine on-your-data pipeline: a populated list is `is not None` → skip include_usage.
    const adapter = adapterNamed("azure_openai");
    const prepared = adapter.prepareStreaming({
      model: "m",
      extra_body: { data_sources: [{ type: "azure_search" }] },
    });
    expect("stream_options" in prepared).toBe(false);
  });

  it("azure INJECTS when extra_body.data_sources is null (value-not-null, matches Python `is not None`)", () => {
    // An explicit null does not activate the on-your-data pipeline, so include_usage injection
    // still happens. A key-presence-only check would wrongly skip injection here.
    const adapter = adapterNamed("azure_openai");
    const prepared = adapter.prepareStreaming({
      model: "m",
      extra_body: { data_sources: null },
    });
    expect(prepared["stream_options"]).toEqual({ include_usage: true });
  });

  it("azure data_sources preserves caller stream_options on own target (test_azure_data_sources_preserves_own_target)", () => {
    const adapter = adapterNamed("azure_openai");
    const kwargs = { model: "m", data_sources: [{}], stream_options: { include_usage: true } };
    const prepared = adapter.prepareStreaming(kwargs);
    expect(prepared["stream_options"]).toEqual({ include_usage: true });
  });

  it("azure data_sources strips caller stream_options on a failover hop (test_azure_data_sources_strips_on_failover_hop)", () => {
    const adapter = adapterNamed("azure_openai");
    const kwargs = { model: "m", data_sources: [{}], stream_options: { include_usage: true } };
    const prepared = adapter.prepareStreaming(kwargs, { crossProvider: true });
    expect("stream_options" in prepared).toBe(false);
  });

  it("the data_sources caveat is azure-specific: groq with extra_body.data_sources still injects (test_non_azure_extra_body_data_sources_still_injects)", () => {
    const adapter = adapterNamed("groq");
    const prepared = adapter.prepareStreaming({
      model: "m",
      extra_body: { data_sources: [{}] },
    });
    expect(prepared["stream_options"]).toEqual({ include_usage: true });
  });
});

// ---------------------------------------------------------------------------
// prepareCall — streaming dispatch honors the profile policy.
// ---------------------------------------------------------------------------

describe("prepareCall", () => {
  const baseOptions = {
    surface: "chat" as const,
    isStreaming: false,
    crossProvider: false,
    timeout: 30,
    maxRetries: 2,
  };

  function makeClient() {
    const create = vi.fn((..._args: unknown[]) => "dispatched");
    return { client: { chat: { completions: { create } } }, create };
  }

  it("dispatches through chat.completions.create bound to its receiver, kwargs copied", () => {
    const adapter = adapterNamed("groq");
    const { client, create } = makeClient();
    const kwargs = { model: "m" };
    const result = adapter.prepareCall(client, kwargs, baseOptions)();
    expect(result).toBe("dispatched");
    expect(create.mock.instances[0]).toBe(client.chat.completions);
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed).not.toBe(kwargs);
    expect(passed).toEqual({ model: "m" });
    expect(passed["stream"]).toBeUndefined();
  });

  it("streaming groq call is invoked WITH stream_options.include_usage and stream:true", () => {
    const adapter = adapterNamed("groq");
    const { client, create } = makeClient();
    const kwargs: Record<string, unknown> = { model: "m" };
    adapter.prepareCall(client, kwargs, { ...baseOptions, isStreaming: true })();
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed["stream"]).toBe(true);
    expect(passed["stream_options"]).toEqual({ include_usage: true });
    expect(kwargs["stream"]).toBeUndefined();
    expect(kwargs["stream_options"]).toBeUndefined();
  });

  it("streaming Z.ai call injects exactly stream_options.include_usage and stream:true", () => {
    const adapter = adapterNamed("zai");
    const { client, create } = makeClient();
    adapter.prepareCall(client, { model: "glm-4.6" }, { ...baseOptions, isStreaming: true })();
    expect(create.mock.calls[0]?.[0]).toEqual({
      model: "glm-4.6",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it.each([
    "xai",
    "mistral",
  ])("streaming %s call is invoked WITHOUT any stream_options key", (name) => {
    const adapter = adapterNamed(name);
    const { client, create } = makeClient();
    adapter.prepareCall(client, { model: "m" }, { ...baseOptions, isStreaming: true })();
    const passed = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed["stream"]).toBe(true);
    expect("stream_options" in passed).toBe(false);
  });

  it.each([
    "openai_compatible",
    "together",
  ])("%s inherits the copied timeout/retry request-options carrier", (name) => {
    const adapter = adapterNamed(name);
    const { client, create } = makeClient();
    const requestOptions = { signal: "abort", timeout: 5, maxRetries: 8 };
    const tail = Symbol("tail");
    adapter.prepareCall(client, { model: "m" }, baseOptions)(requestOptions, tail);
    expect(create.mock.calls[0]?.[1]).toEqual({
      signal: "abort",
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(create.mock.calls[0]?.[1]).not.toBe(requestOptions);
    expect(create.mock.calls[0]?.[2]).toBe(tail);
    expect(requestOptions).toEqual({ signal: "abort", timeout: 5, maxRetries: 8 });
  });

  it("creates request options when the caller omits them", () => {
    const adapter = adapterNamed("groq");
    const { client, create } = makeClient();
    adapter.prepareCall(client, { model: "m" }, baseOptions)();
    expect(create.mock.calls[0]?.[1]).toEqual({ timeout: 30_000, maxRetries: 0 });
  });

  it("throws ConfigurationError when chat.completions.create is absent", () => {
    const adapter = adapterNamed("groq");
    expect(() =>
      adapter.prepareCall({ chat: { completions: {} } }, { model: "m" }, baseOptions),
    ).toThrow(ConfigurationError);
  });

  it("fails loud on Responses for a non-Azure compat profile", () => {
    const adapter = adapterNamed("groq");
    let clientAccesses = 0;
    const client = Object.defineProperty({}, "responses", {
      get() {
        clientAccesses += 1;
        throw new Error("must not touch client");
      },
    });
    const call = () =>
      adapter.prepareCall(
        client,
        { model: "m", input: "hi" },
        { ...baseOptions, surface: "responses", responsesLeaf: "parse" },
      );
    expect(call).toThrow(UnsupportedSurfaceError);
    expect(call).toThrow(/groq/);
    expect(call).toThrow(/responses\.parse/);
    expect(clientAccesses).toBe(0);
  });

  it.each([
    "create",
    "parse",
  ] as const)("dispatches Azure Responses.%s with receiver/copy/passthrough and no stream_options", (leaf) => {
    const adapter = adapterNamed("azure_openai");
    const method = vi.fn((..._args: unknown[]) => "azure-response");
    const responses = { create: vi.fn(), parse: vi.fn(), [leaf]: method };
    const client = { responses };
    const kwargs = { model: "deployment", input: "hi" };
    const requestOptions = { headers: { x: "1" } };
    const result = adapter.prepareCall(client, kwargs, {
      ...baseOptions,
      surface: "responses",
      responsesLeaf: leaf,
      isStreaming: leaf === "create",
    })(requestOptions);

    expect(result).toBe("azure-response");
    expect(method.mock.instances[0]).toBe(responses);
    const passed = method.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed).not.toBe(kwargs);
    expect(passed["stream"]).toBe(leaf === "create" ? true : undefined);
    expect(passed["stream_options"]).toBeUndefined();
    expect(method.mock.calls[0]?.[1]).toEqual({
      headers: { x: "1" },
      timeout: 30_000,
      maxRetries: 0,
    });
    expect(method.mock.calls[0]?.[1]).not.toBe(requestOptions);
  });

  it("fails loud on an unsupported Azure Responses leaf before client attribute access", () => {
    const adapter = adapterNamed("azure_openai");
    let responsesAccesses = 0;
    const client = Object.defineProperty({}, "responses", {
      get() {
        responsesAccesses += 1;
        throw new Error("must not touch client");
      },
    });

    const call = () =>
      adapter.prepareCall(
        client,
        { model: "deployment" },
        {
          ...baseOptions,
          surface: "responses",
          responsesLeaf: "retrieve" as "create",
        },
      );

    expect(call).toThrow(ConfigurationError);
    expect(call).toThrow(/unsupported Azure OpenAI Responses leaf: retrieve/);
    expect(responsesAccesses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractUsage / extractServiceTier / extractRegion.
// ---------------------------------------------------------------------------

describe("extractUsage — non-streaming", () => {
  const adapter = adapterNamed("groq");

  it("standard block maps prompt/completion to input/output, not estimated (test_standard_usage_block_extracts)", () => {
    const td = adapter.extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(td.input_tokens).toBe(10);
    expect(td.output_tokens).toBe(5);
    expect(td.is_estimated).toBe(false);
  });

  it("usage null extracts estimated zeros without claiming measured zero spend", () => {
    const td = adapter.extractUsage({ usage: null });
    expect(td.input_tokens).toBe(0);
    expect(td.output_tokens).toBe(0);
    expect(td.is_estimated).toBe(true);
  });

  it("negative counts degrade to zeros, never raise (test_negative_usage_extracts_zeros_not_raise)", () => {
    const td = adapter.extractUsage({ usage: { prompt_tokens: -1, completion_tokens: -7 } });
    expect(td.input_tokens).toBe(0);
    expect(td.output_tokens).toBe(0);
  });

  it("extractRegion is always null", () => {
    expect(adapter.extractRegion({ region: "us-east-1" })).toBeNull();
  });

  it("extractServiceTier reads a tier and returns null when absent", () => {
    expect(adapter.extractServiceTier({ service_tier: "on_demand" })).toBe("on_demand");
    expect(adapter.extractServiceTier({})).toBeNull();
  });

  it("extracts Z.ai cache reads and writes through the shared OpenAI path", () => {
    const td = adapterNamed("zai").extractUsage({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 9 },
      },
    });
    expect(td.cached_input_tokens).toBe(4);
    expect(td.cache_creation_5m_tokens).toBe(9);
    expect(td.cache_creation_1h_tokens).toBe(0);
    expect(td.reasoning_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// estimateMissingUsage — three-tier / anti-silent-zero-spend.
// ---------------------------------------------------------------------------

describe("estimateMissingUsage", () => {
  const adapter = adapterNamed("groq");
  const opts = { estimatedInputTokens: 100 };

  it("returns null when usage parsed to non-zero (test_usage_present_returns_none)", () => {
    const result = adapter.estimateMissingUsage(
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      opts,
    );
    expect(result).toBeNull();
  });

  it("all-zero usage with NO content returns null — provider truth (test_provider_reported_zero_usage_is_not_estimated)", () => {
    const result = adapter.estimateMissingUsage(
      { usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [] },
      opts,
    );
    expect(result).toBeNull();
  });

  it("absent usage + 40 chars content estimates and flags (test_absent_usage_estimates_and_flags)", () => {
    const result = adapter.estimateMissingUsage(
      { choices: [{ message: { content: "x".repeat(40) } }] },
      { estimatedInputTokens: 100 },
    );
    expect(result).not.toBeNull();
    expect(result?.is_estimated).toBe(true);
    expect(result?.input_tokens).toBe(100);
    expect(result?.output_tokens).toBe(10); // 40 / 4.0
  });

  it("absent usage + no content estimates zero output (test_absent_usage_with_no_content_estimates_zero_output)", () => {
    const result = adapter.estimateMissingUsage({ choices: [] }, { estimatedInputTokens: 7 });
    expect(result).not.toBeNull();
    expect(result?.is_estimated).toBe(true);
    expect(result?.input_tokens).toBe(7);
    expect(result?.output_tokens).toBe(0);
  });

  it("foreign usage shape {input_tokens,output_tokens} + content still estimates (test_unparseable_usage_shape_with_content)", () => {
    const result = adapter.estimateMissingUsage(
      {
        usage: { input_tokens: 999, output_tokens: 999 },
        choices: [{ message: { content: "x".repeat(40) } }],
      },
      opts,
    );
    expect(result?.output_tokens).toBe(10);
    expect(result?.is_estimated).toBe(true);
  });

  it("negative usage + content estimates, never raises (test_negative_usage_with_content_estimates_not_raise)", () => {
    const result = adapter.estimateMissingUsage(
      {
        usage: { prompt_tokens: -3, completion_tokens: -9 },
        choices: [{ message: { content: "x".repeat(40) } }],
      },
      opts,
    );
    expect(result?.output_tokens).toBe(10);
  });

  it("all-zero usage WITH visible content is untrusted and estimates (test_zeroed_usage_with_real_content)", () => {
    const result = adapter.estimateMissingUsage(
      {
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        choices: [{ message: { content: "x".repeat(40) } }],
      },
      opts,
    );
    expect(result?.output_tokens).toBe(10);
    expect(result?.is_estimated).toBe(true);
  });

  it("tool_call arguments count toward the estimate when content is null (test_tool_call_arguments_count)", () => {
    const result = adapter.estimateMissingUsage(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { arguments: "x".repeat(40) } }],
            },
          },
        ],
      },
      opts,
    );
    expect(result?.output_tokens).toBe(10);
  });

  it("reasoning_content counts toward the estimate when content is null (test_reasoning_content_counts)", () => {
    const result = adapter.estimateMissingUsage(
      { choices: [{ message: { content: null, reasoning_content: "x".repeat(40) } }] },
      opts,
    );
    expect(result?.output_tokens).toBe(10);
  });

  it("fires the missing-usage WARNING exactly once across multiple estimations", () => {
    const logger = fakeLogger();
    const local = new OpenAICompatibleAdapter(
      COMPAT_PROFILES.find((p) => p.name === "groq") as CompatProfile,
      { logger },
    );
    local.estimateMissingUsage({ choices: [{ message: { content: "x".repeat(40) } }] }, opts);
    local.estimateMissingUsage({ choices: [{ message: { content: "y".repeat(40) } }] }, opts);
    expect(logger.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CompatStreamAccumulator — three-tier settlement.
// ---------------------------------------------------------------------------

function makeAccumulator(estimatedInputTokens = 0, logger?: Logger): CompatStreamAccumulator {
  const adapter = new OpenAICompatibleAdapter(
    COMPAT_PROFILES.find((p) => p.name === "groq") as CompatProfile,
    logger ? { logger } : {},
  );
  return new CompatStreamAccumulator({ adapter, estimatedInputTokens, logger });
}

describe("CompatStreamAccumulator — tier 1 (standard usage)", () => {
  it("extracts Azure Responses usage and tier from the nested terminal response", () => {
    const acc = new CompatStreamAccumulator({
      adapter: adapterNamed("azure_openai"),
      estimatedInputTokens: 11,
    });
    acc.observe({ type: "response.in_progress", response: { usage: null } });
    acc.observe({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 18,
          output_tokens: 7,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
        service_tier: "priority",
      },
    });

    expect(acc.finalize()).toMatchObject({
      input_tokens: 18,
      output_tokens: 7,
      cached_input_tokens: 4,
      reasoning_tokens: 3,
      is_estimated: false,
    });
    expect(acc.getServiceTier()).toBe("priority");
  });

  it("usage only on the final chunk extracts exactly, not estimated (test_usage_in_final_chunk)", () => {
    const acc = makeAccumulator();
    acc.observe({ choices: [{ delta: { content: "he" } }] });
    acc.observe({ choices: [{ delta: { content: "llo" } }] });
    acc.observe({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(12);
    expect(td.output_tokens).toBe(4);
    expect(td.is_estimated).toBe(false);
  });

  it("cumulative usage on every chunk: last wins (test_usage_on_every_chunk_last_wins)", () => {
    const acc = makeAccumulator();
    acc.observe({ usage: { prompt_tokens: 5, completion_tokens: 1 } });
    acc.observe({ usage: { prompt_tokens: 5, completion_tokens: 2 } });
    acc.observe({ usage: { prompt_tokens: 5, completion_tokens: 9 } });
    expect(acc.finalize().output_tokens).toBe(9);
  });

  it("usage before a trailing usage-less terminal chunk is still captured (test_usage_in_second_to_last_chunk)", () => {
    const acc = makeAccumulator();
    acc.observe({ usage: { prompt_tokens: 8, completion_tokens: 3 } });
    acc.observe({ choices: [], usage: null }); // xAI's empty terminal chunk
    const td = acc.finalize();
    expect(td.input_tokens).toBe(8);
    expect(td.output_tokens).toBe(3);
  });

  it("after standard usage latches, skips later structural content reads while usage and tier keep updating", () => {
    const acc = makeAccumulator();
    let contentWalks = 0;
    acc.observe({
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      service_tier: "initial",
    });
    acc.observe({
      usage: { prompt_tokens: 3, completion_tokens: 4 },
      service_tier: "later",
      get choices() {
        contentWalks += 1;
        throw new Error("usage latch must skip content walking");
      },
    });

    expect(contentWalks).toBe(0);
    expect(acc.finalize()).toMatchObject({
      input_tokens: 3,
      output_tokens: 4,
      is_estimated: false,
    });
    expect(acc.getServiceTier()).toBe("later");
  });
});

describe("CompatStreamAccumulator — tier 2 (x_groq)", () => {
  it("x_groq.usage as a raw dict on the final chunk extracts (test_x_groq_dict_usage_fallback)", () => {
    const acc = makeAccumulator();
    acc.observe({ id: "c1", x_groq: { usage: { prompt_tokens: 21, completion_tokens: 6 } } });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(21);
    expect(td.output_tokens).toBe(6);
    expect(td.is_estimated).toBe(false);
  });

  it("x_groq as a nested attr-style object extracts identically (test_x_groq_attr_usage_fallback)", () => {
    // Both shapes are plain objects and must produce the same extraction.
    const acc = makeAccumulator();
    acc.observe({ x_groq: { usage: { prompt_tokens: 21, completion_tokens: 6 } } });
    expect(acc.finalize().input_tokens).toBe(21);
  });

  it("standard usage wins over x_groq when both present (test_standard_usage_wins_over_x_groq)", () => {
    const acc = makeAccumulator();
    acc.observe({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      x_groq: { usage: { prompt_tokens: 99, completion_tokens: 99 } },
    });
    const td = acc.finalize();
    expect(td.input_tokens).toBe(10);
    expect(td.output_tokens).toBe(5);
  });

  it("negative x_groq usage falls to estimation, never latches (test_x_groq_negative_usage_falls_to_estimation)", () => {
    const acc = makeAccumulator(15);
    acc.observe({
      x_groq: { usage: { prompt_tokens: -1, completion_tokens: -1 } },
      choices: [{ delta: { content: "x".repeat(40) } }],
    });
    const td = acc.finalize();
    expect(td.is_estimated).toBe(true);
    expect(td.input_tokens).toBe(15);
    expect(td.output_tokens).toBe(10);
  });

  it("after x_groq usage latches, skips later structural content reads while legacy usage and tier keep updating", () => {
    const acc = makeAccumulator();
    let contentWalks = 0;
    acc.observe({
      x_groq: { usage: { prompt_tokens: 1, completion_tokens: 2 } },
      service_tier: "initial",
    });
    acc.observe({
      x_groq: { usage: { prompt_tokens: 3, completion_tokens: 4 } },
      service_tier: "later",
      get choices() {
        contentWalks += 1;
        throw new Error("usage latch must skip content walking");
      },
    });

    expect(contentWalks).toBe(0);
    expect(acc.finalize()).toMatchObject({
      input_tokens: 3,
      output_tokens: 4,
      is_estimated: false,
    });
    expect(acc.getServiceTier()).toBe("later");
  });
});

describe("CompatStreamAccumulator — tier 3 (length estimate)", () => {
  it("no usage anywhere estimates and flags (test_no_usage_anywhere_estimates_and_flags)", () => {
    const acc = makeAccumulator(15);
    acc.observe({ choices: [{ delta: { content: "x".repeat(20) } }] });
    acc.observe({ choices: [{ delta: { content: "y".repeat(20) } }] });
    const td = acc.finalize();
    expect(td.is_estimated).toBe(true);
    expect(td.input_tokens).toBe(15);
    expect(td.output_tokens).toBe(10); // 40 / 4.0
  });

  it("usage-less Z.ai stream estimates 40 output chars as 10 flagged tokens", () => {
    const acc = new CompatStreamAccumulator({
      adapter: adapterNamed("zai"),
      estimatedInputTokens: 15,
    });
    acc.observe({ choices: [{ delta: { content: "x".repeat(40) } }] });
    const td = acc.finalize();
    expect(td.is_estimated).toBe(true);
    expect(td.input_tokens).toBe(15);
    expect(td.output_tokens).toBe(10);
  });

  it("empty stream estimates zero output but carries input + flag (test_empty_stream_estimates_zero_output)", () => {
    const acc = makeAccumulator(9);
    const td = acc.finalize();
    expect(td.is_estimated).toBe(true);
    expect(td.input_tokens).toBe(9);
    expect(td.output_tokens).toBe(0);
  });

  it("all-zero placeholder usage chunks never latch, fall to estimation (test_zeroed_placeholder_usage_chunks_never_latch)", () => {
    const acc = makeAccumulator(0);
    acc.observe({
      choices: [{ delta: { content: "x".repeat(40) } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
    const td = acc.finalize();
    expect(td.is_estimated).toBe(true);
    expect(td.output_tokens).toBe(10);
  });

  it("fires the missing-usage WARNING once on tier-3 finalize", () => {
    const logger = fakeLogger();
    const acc = makeAccumulator(0, logger);
    acc.observe({ choices: [{ delta: { content: "x".repeat(40) } }] });
    acc.finalize();
    expect(logger.warnings).toHaveLength(1);
  });
});

describe("CompatStreamAccumulator — never raises / garbage tolerance", () => {
  it("a malformed chunk (choices = 42) never raises out of observe; finalize still estimates (test_malformed_chunk_never_raises)", () => {
    const acc = makeAccumulator(3);
    expect(() => acc.observe({ choices: 42 })).not.toThrow();
    expect(() => acc.observe(null)).not.toThrow();
    expect(() => acc.observe(undefined)).not.toThrow();
    const td = acc.finalize();
    expect(td.is_estimated).toBe(true);
    expect(td.input_tokens).toBe(3);
    expect(td.output_tokens).toBe(0);
  });

  it("negative usage mid-stream never latches; estimation uses other chunks' content (test_negative_usage_chunk_falls_to_estimation)", () => {
    const acc = makeAccumulator(0);
    acc.observe({ choices: [{ delta: { content: "x".repeat(40) } }] });
    acc.observe({ usage: { prompt_tokens: -5, completion_tokens: -5 } });
    const td = acc.finalize();
    expect(td.is_estimated).toBe(true);
    expect(td.output_tokens).toBe(10);
  });

  it("non-integer usage values never latch; falls to estimation (test_non_int_usage_chunk_falls_to_estimation)", () => {
    const acc = makeAccumulator(0);
    acc.observe({
      choices: [{ delta: { content: "x".repeat(40) } }],
      usage: { prompt_tokens: "abc", completion_tokens: "def" },
    });
    const td = acc.finalize();
    expect(td.is_estimated).toBe(true);
    expect(td.output_tokens).toBe(10);
  });
});

describe("CompatStreamAccumulator — streaming content-length surfaces", () => {
  it("streaming tool_call arguments count toward the estimate (test_stream_tool_call_arguments_count)", () => {
    const acc = makeAccumulator(0);
    acc.observe({
      choices: [
        { delta: { content: null, tool_calls: [{ function: { arguments: "x".repeat(20) } }] } },
      ],
    });
    expect(acc.finalize().output_tokens).toBe(5); // 20 / 4.0
  });

  it("streaming reasoning_content deltas count toward the estimate (test_stream_reasoning_content_counts)", () => {
    const acc = makeAccumulator(0);
    acc.observe({ choices: [{ delta: { content: null, reasoning_content: "x".repeat(40) } }] });
    expect(acc.finalize().output_tokens).toBe(10);
  });
});

describe("CompatStreamAccumulator — service tier", () => {
  it("returns the service_tier observed on a usage-carrying chunk (test_service_tier_from_usage_chunk)", () => {
    const acc = makeAccumulator();
    acc.observe({ usage: { prompt_tokens: 1, completion_tokens: 1 }, service_tier: "on_demand" });
    expect(acc.getServiceTier()).toBe("on_demand");
  });

  it("returns null when no chunk carried a service_tier (test_service_tier_none_without_usage_chunk)", () => {
    const acc = makeAccumulator();
    acc.observe({ choices: [{ delta: { content: "hi" } }] });
    expect(acc.getServiceTier()).toBeNull();
  });
});
