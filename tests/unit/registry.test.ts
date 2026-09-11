/**
 * Unit tests for the adapter registry (`src/providers/index.ts`) and the runtime
 * chain builder (`src/registry.ts`).
 *
 * Tests can inject stub adapters through the registry's detection-override hook
 * (`__setAdapterLoadersForTesting`) to isolate registry behavior.
 * That also lets us observe laziness directly (a stub loader is a spy). No network,
 * no real provider SDKs, fully offline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors";
import {
  __resetAdapterRegistry,
  __setAdapterLoadersForTesting,
  ADAPTER_REGISTRATION_ORDER,
  type AdapterLoader,
  getAdapterByName,
  getAdapterForClient,
  getAdapterForModel,
} from "../../src/providers/index";
import type { Dialect, ProviderAdapter } from "../../src/providers/protocol";
import { buildRuntimes, type ProviderRuntime } from "../../src/registry";
import { zeroTokenDetails } from "../../src/token-details";
import type { ProviderName } from "../../src/types";

// ---------------------------------------------------------------------------
// Stub adapter factory (full ProviderAdapter surface; only name/dialect/detect*
// carry behavior — the rest are inert, never exercised by registry tests).
// ---------------------------------------------------------------------------

interface StubConfig {
  name: string;
  dialect: Dialect;
  detectClient?: (client: unknown) => boolean;
  detectModel?: (model: string) => boolean;
}

function makeAdapter(config: StubConfig): ProviderAdapter {
  return {
    name: config.name,
    dialect: config.dialect,
    detectClient: config.detectClient ?? (() => false),
    detectModel: config.detectModel ?? (() => false),
    extractUsage: () => zeroTokenDetails(),
    estimateMissingUsage: () => null,
    extractServiceTier: () => null,
    extractRegion: () => null,
    prepareStreaming: (kwargs) => ({ ...kwargs }),
    createStreamAccumulator: () => ({
      observe: () => {},
      finalize: () => zeroTokenDetails(),
      getServiceTier: () => null,
    }),
    prepareCall: () => () => undefined,
    unwrapStreamSource: (response) => response,
    wrapStreamResult: (wrapper) => wrapper,
  };
}

/** A loader that returns a fixed adapter and records how many times it ran. */
function spyLoader(adapter: ProviderAdapter): AdapterLoader & { calls: () => number } {
  let count = 0;
  const loader = (async () => {
    count += 1;
    return adapter;
  }) as AdapterLoader & { calls: () => number };
  loader.calls = () => count;
  return loader;
}

/** Read a `__stub` marker off a fixture client without leaking `any`. */
function stubKind(client: unknown): string | undefined {
  if (client !== null && typeof client === "object" && "__stub" in client) {
    const value = (client as { __stub: unknown }).__stub;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** OpenAI-shaped fixture client. */
const openaiClient = {
  __stub: "openai",
  chat: { completions: { create: () => ({}) } },
};

// The four native adapters wired with realistic-enough detection to exercise the
// order-sensitive routing rules (bedrock-shaped ids beat native anthropic, etc.).
function nativeAdapters(): Partial<Record<ProviderName, ProviderAdapter>> {
  return {
    openai: makeAdapter({
      name: "openai",
      dialect: "openai",
      detectClient: (c) => stubKind(c) === "openai",
      detectModel: (m) => m.startsWith("gpt-") || m.startsWith("o3-") || m.startsWith("o4-"),
    }),
    anthropic: makeAdapter({
      name: "anthropic",
      dialect: "anthropic",
      detectClient: (c) => stubKind(c) === "anthropic",
      detectModel: (m) => m.startsWith("claude-"),
    }),
    google: makeAdapter({
      name: "google",
      dialect: "google",
      detectClient: (c) => stubKind(c) === "google",
      detectModel: (m) => m.startsWith("gemini-"),
    }),
    bedrock: makeAdapter({
      name: "bedrock",
      dialect: "bedrock",
      // Structural AWS-runtime client shape (module path is irrelevant in TS).
      detectClient: (c) => {
        if (c === null || typeof c !== "object") {
          return false;
        }
        const meta = (c as { meta?: { service_model?: { service_name?: unknown } } }).meta;
        return meta?.service_model?.service_name === "bedrock-runtime";
      },
      // Bedrock inference-profile / model-id shapes (region prefix + vendor), which a
      // plain `claude-3-5-sonnet` id must NOT match.
      detectModel: (m) => /^(us|eu|apac)\.[a-z]+\./.test(m) || /^[a-z]+\.[a-z-]+:\d+$/.test(m),
    }),
  };
}

function loadersFrom(
  adapters: Partial<Record<ProviderName, ProviderAdapter>>,
): Partial<Record<ProviderName, AdapterLoader>> {
  const out: Partial<Record<ProviderName, AdapterLoader>> = {};
  for (const [name, adapter] of Object.entries(adapters)) {
    if (adapter !== undefined) {
      out[name as ProviderName] = async () => adapter;
    }
  }
  return out;
}

function installNative(): void {
  __setAdapterLoadersForTesting(loadersFrom(nativeAdapters()));
}

afterEach(() => {
  __resetAdapterRegistry();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Registration order (load-bearing).
// ---------------------------------------------------------------------------

describe("ADAPTER_REGISTRATION_ORDER", () => {
  it("is the exact, final, load-bearing sequence", () => {
    expect([...ADAPTER_REGISTRATION_ORDER]).toEqual([
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
      "openai",
      "anthropic",
      "google",
      "bedrock",
    ]);
  });

  it("places every named compat profile before the generic catch-all", () => {
    const order = [...ADAPTER_REGISTRATION_ORDER];
    const catchAll = order.indexOf("openai_compatible");
    const namedCompat = [
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
    ] as const;
    for (const name of namedCompat) {
      expect(order.indexOf(name)).toBeLessThan(catchAll);
    }
  });

  it("places the generic catch-all last among compat adapters, before plain openai", () => {
    const order = [...ADAPTER_REGISTRATION_ORDER];
    expect(order.indexOf("openai_compatible")).toBeLessThan(order.indexOf("openai"));
  });

  it("places plain openai after every compat adapter (so it never shadows them)", () => {
    const order = [...ADAPTER_REGISTRATION_ORDER];
    const openai = order.indexOf("openai");
    const compat = [
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
    ] as const;
    for (const name of compat) {
      expect(order.indexOf(name)).toBeLessThan(openai);
    }
  });
});

// ---------------------------------------------------------------------------
// Laziness: adapters not loaded until the first lookup call.
// ---------------------------------------------------------------------------

describe("lazy loading", () => {
  it("does not invoke any adapter loader until the first lookup", async () => {
    const loader = spyLoader(makeAdapter({ name: "openai", dialect: "openai" }));
    __setAdapterLoadersForTesting({ openai: loader });

    expect(loader.calls()).toBe(0); // nothing loaded merely by installing the table

    await getAdapterByName("openai");
    expect(loader.calls()).toBe(1); // loaded on first use
  });

  it("loads each adapter exactly once across many lookups (idempotent singleton)", async () => {
    const loader = spyLoader(
      makeAdapter({
        name: "openai",
        dialect: "openai",
        detectClient: (c) => stubKind(c) === "openai",
        detectModel: (m) => m.startsWith("gpt-"),
      }),
    );
    __setAdapterLoadersForTesting({ openai: loader });

    await getAdapterByName("openai");
    await getAdapterForModel("gpt-4o");
    await getAdapterForClient(openaiClient);

    expect(loader.calls()).toBe(1);
  });

  it("shares a single load across concurrent first-callers", async () => {
    const loader = spyLoader(makeAdapter({ name: "openai", dialect: "openai" }));
    __setAdapterLoadersForTesting({ openai: loader });

    await Promise.all([
      getAdapterByName("openai"),
      getAdapterByName("openai"),
      getAdapterByName("openai"),
    ]);

    expect(loader.calls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getAdapterByName.
// ---------------------------------------------------------------------------

describe("getAdapterByName", () => {
  it("returns the concrete adapter registered under each native name", async () => {
    installNative();
    for (const name of ["openai", "anthropic", "google", "bedrock"] as const) {
      const adapter = await getAdapterByName(name);
      expect(adapter.name).toBe(name);
    }
  });

  it("throws ConfigurationError echoing the queried name on an unknown name", async () => {
    installNative();
    await expect(getAdapterByName("unknown_provider")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(getAdapterByName("unknown_provider")).rejects.toThrow(/unknown_provider/);
  });

  it("sets field 'provider' on the unknown-name error", async () => {
    installNative();
    await expect(getAdapterByName("unknown_provider")).rejects.toMatchObject({
      field: "provider",
    });
  });

  it("treats the empty string as unknown (no default/wildcard adapter)", async () => {
    installNative();
    await expect(getAdapterByName("")).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// getAdapterForModel.
// ---------------------------------------------------------------------------

describe("getAdapterForModel", () => {
  it("routes gpt-/o3-/o4- prefixes to the openai adapter", async () => {
    installNative();
    for (const model of ["gpt-4o", "o3-mini", "o4-mini"]) {
      expect((await getAdapterForModel(model)).name).toBe("openai");
    }
  });

  it("routes the claude- prefix to the anthropic adapter", async () => {
    installNative();
    expect((await getAdapterForModel("claude-3-5-sonnet-20241022")).name).toBe("anthropic");
  });

  it("routes the gemini- prefix to the google adapter", async () => {
    installNative();
    expect((await getAdapterForModel("gemini-2.0-flash")).name).toBe("google");
  });

  it("throws ConfigurationError echoing the model on an unknown model", async () => {
    installNative();
    await expect(getAdapterForModel("completely-unknown-model")).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    await expect(getAdapterForModel("completely-unknown-model")).rejects.toThrow(
      /completely-unknown-model/,
    );
  });

  it("never silently falls back for a plausible-but-unregistered model", async () => {
    installNative();
    await expect(getAdapterForModel("llama-3-8b")).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("routes a Bedrock inference-profile model id to bedrock, not anthropic", async () => {
    installNative();
    const adapter = await getAdapterForModel("us.anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(adapter.name).toBe("bedrock");
  });

  it("routes a direct (non-Bedrock) anthropic model id to anthropic", async () => {
    installNative();
    // Bedrock's pattern must not shadow the native claude- match for a plain id.
    expect((await getAdapterForModel("claude-3-5-sonnet")).name).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// getAdapterForClient.
// ---------------------------------------------------------------------------

describe("getAdapterForClient", () => {
  it("detects the native clients by structural shape", async () => {
    installNative();
    expect((await getAdapterForClient({ __stub: "openai" })).name).toBe("openai");
    expect((await getAdapterForClient({ __stub: "anthropic" })).name).toBe("anthropic");
    expect((await getAdapterForClient({ __stub: "google" })).name).toBe("google");
  });

  it("detects a botocore-shaped Bedrock runtime client by service_name", async () => {
    installNative();
    const bedrockClient = {
      meta: { service_model: { service_name: "bedrock-runtime" }, region_name: "us-east-1" },
    };
    expect((await getAdapterForClient(bedrockClient)).name).toBe("bedrock");
  });

  it("throws ConfigurationError for an unrecognized client, never a default", async () => {
    installNative();
    await expect(getAdapterForClient({ __stub: "huggingface" })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    await expect(getAdapterForClient({ some: "unknown vendor object" })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("honors registration order: the earlier-registered adapter wins a tie", async () => {
    // Both a compat profile (groq) and plain openai match this client. groq is
    // registered BEFORE openai, so it must win — this is invariant 4 in miniature.
    const shared = { __stub: "shared" };
    __setAdapterLoadersForTesting({
      groq: async () =>
        makeAdapter({
          name: "groq",
          dialect: "openai",
          detectClient: (c) => stubKind(c) === "shared",
        }),
      openai: async () =>
        makeAdapter({
          name: "openai",
          dialect: "openai",
          detectClient: (c) => stubKind(c) === "shared",
        }),
    });

    expect((await getAdapterForClient(shared)).name).toBe("groq");
  });
});

// ---------------------------------------------------------------------------
// All adapters registered / name integrity.
// ---------------------------------------------------------------------------

describe("registered adapter integrity", () => {
  it("resolves all four native providers by name", async () => {
    installNative();
    for (const name of ["openai", "anthropic", "google", "bedrock"] as const) {
      expect((await getAdapterByName(name)).name).toBe(name);
    }
  });

  it("every adapter's name equals the key it is looked up by (no name drift)", async () => {
    installNative();
    for (const name of ["openai", "anthropic", "google", "bedrock"] as const) {
      expect((await getAdapterByName(name)).name).toBe(name);
    }
  });

  it("every adapter name is a valid ProviderName enum value", async () => {
    installNative();
    const valid = new Set<string>([
      "openai",
      "anthropic",
      "google",
      "bedrock",
      "xai",
      "deepseek",
      "mistral",
      "qwen",
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
    for (const name of ["openai", "anthropic", "google", "bedrock"] as const) {
      expect(valid.has((await getAdapterByName(name)).name)).toBe(true);
    }
  });

  it("each adapter structurally satisfies the ProviderAdapter interface", async () => {
    installNative();
    const adapter = await getAdapterByName("openai");
    expect(typeof adapter.detectClient).toBe("function");
    expect(typeof adapter.detectModel).toBe("function");
    expect(typeof adapter.extractUsage).toBe("function");
    expect(typeof adapter.prepareCall).toBe("function");
    expect(["openai", "anthropic", "google", "bedrock"]).toContain(adapter.dialect);
  });
});

// ---------------------------------------------------------------------------
// buildRuntimes — chain assembly.
// ---------------------------------------------------------------------------

describe("buildRuntimes", () => {
  it("builds a single runtime for a primary-only chain", async () => {
    installNative();
    const runtimes = await buildRuntimes(openaiClient, "gpt-4o", []);

    expect(runtimes).toHaveLength(1);
    const [primary] = runtimes as [ProviderRuntime];
    expect(primary.entry.provider).toBe("openai");
    expect(primary.entry.model).toBe("gpt-4o");
    expect(primary.entry.default_params).toEqual({});
    expect(primary.sdkClient).toBe(openaiClient); // identity preserved
    expect(primary.adapter.name).toBe("openai");
  });

  it("returns runtimes in [primary, ...fallbacks] order, preserving spec order", async () => {
    installNative();
    const anthropicClient = { __stub: "anthropic" };
    const googleClient = { __stub: "google" };

    const runtimes = await buildRuntimes(openaiClient, "gpt-4o", [
      [anthropicClient, "claude-3-5-sonnet"],
      [googleClient, "gemini-2.0-flash"],
    ]);

    expect(runtimes.map((r) => r.entry.provider)).toEqual(["openai", "anthropic", "google"]);
    expect(runtimes.map((r) => r.entry.model)).toEqual([
      "gpt-4o",
      "claude-3-5-sonnet",
      "gemini-2.0-flash",
    ]);
    expect(runtimes[1]?.sdkClient).toBe(anthropicClient);
    expect(runtimes[2]?.sdkClient).toBe(googleClient);
  });

  it("always derives entry.provider from the detected adapter name", async () => {
    installNative();
    const runtimes = await buildRuntimes(openaiClient, "gpt-4o", [
      [{ __stub: "anthropic" }, "claude-3-5-sonnet"],
    ]);
    for (const runtime of runtimes) {
      expect(runtime.entry.provider).toBe(runtime.adapter.name);
    }
  });

  it("forces the primary entry's default_params to {} regardless of anything", async () => {
    installNative();
    const [primary] = (await buildRuntimes(openaiClient, "gpt-4o", [])) as [ProviderRuntime];
    expect(primary.entry.default_params).toEqual({});
  });

  it("gives a 2-tuple fallback spec empty default_params", async () => {
    installNative();
    const runtimes = await buildRuntimes(openaiClient, "gpt-4o", [
      [{ __stub: "anthropic" }, "claude-3-5-sonnet"],
    ]);
    expect(runtimes[1]?.entry.default_params).toEqual({});
  });

  it("carries a 3-tuple fallback spec's default_params through unmodified (same reference)", async () => {
    installNative();
    const params = { temperature: 0.2, max_tokens: 512 };
    const runtimes = await buildRuntimes(openaiClient, "gpt-4o", [
      [{ __stub: "anthropic" }, "claude-3-5-sonnet", params],
    ]);
    expect(runtimes[1]?.entry.default_params).toBe(params);
    expect(runtimes[1]?.entry.default_params).toEqual({ temperature: 0.2, max_tokens: 512 });
  });

  it("maps an omitted/null primary model to an empty string", async () => {
    installNative();
    const [primary] = (await buildRuntimes(openaiClient, null, [])) as [ProviderRuntime];
    expect(primary.entry.model).toBe("");
  });

  it("produces immutable (frozen) runtimes — field reassignment throws", async () => {
    installNative();
    const [primary] = (await buildRuntimes(openaiClient, "gpt-4o", [])) as [ProviderRuntime];
    expect(Object.isFrozen(primary)).toBe(true);
    expect(() => {
      (primary as { sdkClient: unknown }).sdkClient = {};
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildRuntimes — malformed fallback specs.
// ---------------------------------------------------------------------------

describe("buildRuntimes malformed fallback specs", () => {
  const cases: Array<{ label: string; spec: unknown }> = [
    { label: "1-element array (missing model)", spec: [openaiClient] },
    { label: "non-array value (bare string)", spec: "not-a-spec" },
    { label: "non-string model (number)", spec: [openaiClient, 123] },
    { label: "non-object default_params (string)", spec: [openaiClient, "m", "not-a-dict"] },
  ];

  for (const { label, spec } of cases) {
    it(`rejects ${label} with ConfigurationError`, async () => {
      installNative();
      await expect(buildRuntimes(openaiClient, "gpt-4o", [spec])).rejects.toBeInstanceOf(
        ConfigurationError,
      );
    });
  }

  it("tags spec-shape errors with field 'fallback_specs'", async () => {
    installNative();
    await expect(buildRuntimes(openaiClient, "gpt-4o", [[openaiClient]])).rejects.toMatchObject({
      field: "fallback_specs",
    });
  });

  it("rejects a 4-element spec with an UNKNOWN provider override via the name path, not arity", async () => {
    installNative();
    // 4 elements is a VALID arity; this fails because 'extra' is not a known provider,
    // raising via the unknown-adapter-name path (field 'provider'), NOT a "too long"
    // complaint. (Do not add arity-based rejection of 4-element specs.)
    const promise = buildRuntimes(openaiClient, "gpt-4o", [
      [{ __stub: "anthropic" }, "m", {}, "extra"],
    ]);
    await expect(promise).rejects.toBeInstanceOf(ConfigurationError);
    await expect(promise).rejects.toMatchObject({ field: "provider" });
    await expect(promise).rejects.toThrow(/extra/);
  });
});

// ---------------------------------------------------------------------------
// buildRuntimes — provider override resolution (name vs detection).
// ---------------------------------------------------------------------------

describe("buildRuntimes provider override", () => {
  it("resolves a primary pin directly without structural detection", async () => {
    const detectClient = vi.fn(() => {
      throw new Error("explicit pins must bypass detection");
    });
    __setAdapterLoadersForTesting({
      groq: async () => makeAdapter({ name: "groq", dialect: "openai" }),
      openai: async () =>
        makeAdapter({
          name: "openai",
          dialect: "openai",
          detectClient,
        }),
    });

    const [primary] = (await buildRuntimes(openaiClient, "llama-3-70b", [], {
      primaryProvider: "groq",
    })) as [ProviderRuntime];
    expect(primary.entry.provider).toBe("groq");
    expect(primary.adapter.name).toBe("groq");
    expect(detectClient).not.toHaveBeenCalled();
  });

  it("resolves a fallback pin directly without structural detection", async () => {
    const primaryClient = {
      chat: { completions: { create: () => ({}) } },
    };
    const detectClient = vi.fn((client: unknown) => {
      if (client === primaryClient) {
        return true;
      }
      throw new Error("fallback pins must bypass detection");
    });
    __setAdapterLoadersForTesting({
      groq: async () => makeAdapter({ name: "groq", dialect: "openai" }),
      openai: async () =>
        makeAdapter({
          name: "openai",
          dialect: "openai",
          detectClient,
        }),
    });

    const runtimes = await buildRuntimes(primaryClient, "gpt-4o", [
      [openaiClient, "llama-3-70b", {}, "groq"],
    ]);
    expect(runtimes[1]?.entry.provider).toBe("groq");
    expect(detectClient).toHaveBeenCalledOnce();
    expect(detectClient).toHaveBeenCalledWith(primaryClient);
  });

  it("throws for an unknown override name (via the unknown-adapter path)", async () => {
    installNative();
    const promise = buildRuntimes(openaiClient, "gpt-4o", [], { primaryProvider: "nope" });
    await expect(promise).rejects.toBeInstanceOf(ConfigurationError);
    await expect(promise).rejects.toMatchObject({ field: "provider" });
    await expect(promise).rejects.toThrow(/nope/);
  });

  it("rejects a pinned client from the wrong family with field client", async () => {
    installNative();
    const promise = buildRuntimes(openaiClient, "gpt-4o", [], { primaryProvider: "anthropic" });
    await expect(promise).rejects.toBeInstanceOf(ConfigurationError);
    await expect(promise).rejects.toMatchObject({ field: "client" });
    await expect(promise).rejects.toThrow(
      /unsupported provider client pairing: provider 'anthropic' requires an Anthropic client/,
    );
  });

  it("accepts a response-only OpenAI client for an OpenAI-dialect pin", async () => {
    installNative();
    const responsesOnly = { responses: { create: () => ({}) } };
    const [runtime] = (await buildRuntimes(responsesOnly, "gpt-4o", [], {
      primaryProvider: "openai",
    })) as [ProviderRuntime];
    expect(runtime.sdkClient).toBe(responsesOnly);
    expect(runtime.entry.provider).toBe("openai");
  });

  it.each([
    ["openai", { chat: { completions: { create: () => ({}) } } }],
    ["anthropic", { messages: { create: () => ({}) } }],
    ["google", { models: { generateContent: () => ({}) } }],
    ["bedrock", { send: () => ({}), config: {}, middlewareStack: {} }],
  ])("accepts the %s client family", async (provider, client) => {
    installNative();
    await expect(
      buildRuntimes(client, "model", [], { primaryProvider: provider }),
    ).resolves.toHaveLength(1);
  });

  it("accepts every supported Bedrock Runtime family signal", async () => {
    class BedrockRuntimeClient {
      send(): Record<string, never> {
        return {};
      }
    }
    installNative();
    const clients = [
      {
        send: () => ({}),
        meta: { service_model: { service_name: "bedrock-runtime" } },
      },
      new BedrockRuntimeClient(),
      { send: () => ({}), config: {}, middlewareStack: {} },
    ];

    for (const client of clients) {
      await expect(
        buildRuntimes(client, "model", [], { primaryProvider: "bedrock" }),
      ).resolves.toHaveLength(1);
    }
  });

  it("names bedrock-runtime in a Bedrock family mismatch", async () => {
    installNative();
    const promise = buildRuntimes({ send: () => ({}) }, "model", [], {
      primaryProvider: "bedrock",
    });
    await expect(promise).rejects.toMatchObject({ field: "client" });
    await expect(promise).rejects.toThrow(/requires a bedrock-runtime client/);
  });

  it("validates a fallback pin through the same client-family path", async () => {
    installNative();
    const wrongFamilyFallback = { messages: { create: () => ({}) } };
    const promise = buildRuntimes(openaiClient, "gpt-4o", [
      [wrongFamilyFallback, "fallback-model", {}, "openai"],
    ]);
    await expect(promise).rejects.toMatchObject({ field: "client" });
    await expect(promise).rejects.toThrow(/provider 'openai' requires an OpenAI-compatible client/);
  });

  it.each([
    ["openai", { messages: { create: () => ({}) } }, /OpenAI-compatible/],
    ["anthropic", { models: { generateContent: () => ({}) } }, /Anthropic/],
    ["google", { chat: { completions: { create: () => ({}) } } }, /Google GenAI/],
    ["bedrock", { messages: { create: () => ({}) } }, /bedrock-runtime/],
  ])("rejects a mismatched %s client family", async (provider, client, message) => {
    installNative();
    const promise = buildRuntimes(client, "model", [], { primaryProvider: provider });
    await expect(promise).rejects.toMatchObject({ field: "client" });
    await expect(promise).rejects.toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// Real default (production) adapters, with no stubs.
//
// These exercise DEFAULT_LOADERS end to end: the four native adapters plus the 15
// OpenAI-compatible profiles are lazily loaded and detection follows the real, final
// registration order. Fixtures are plain duck-typed objects — never a real provider SDK.
// ---------------------------------------------------------------------------

describe("real default adapters (production loaders)", () => {
  beforeEach(() => {
    // Ensure the production loader table + a cold singleton (independent of test order).
    __resetAdapterRegistry();
  });

  const ALL_NAMES = [
    "openai",
    "anthropic",
    "google",
    "bedrock",
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
  ] as const;

  it("resolves all 19 provider names by name with no name drift", async () => {
    for (const name of ALL_NAMES) {
      const adapter = await getAdapterByName(name);
      expect(adapter.name).toBe(name);
    }
  });

  it("assigns the four native dialects and dialect 'openai' to every compat profile", async () => {
    expect((await getAdapterByName("openai")).dialect).toBe("openai");
    expect((await getAdapterByName("anthropic")).dialect).toBe("anthropic");
    expect((await getAdapterByName("google")).dialect).toBe("google");
    expect((await getAdapterByName("bedrock")).dialect).toBe("bedrock");
    for (const name of [
      "xai",
      "deepseek",
      "zai",
      "groq",
      "azure_openai",
      "ollama",
      "openai_compatible",
    ] as const) {
      expect((await getAdapterByName(name)).dialect).toBe("openai");
    }
  });

  // --- Client detection precedence (invariant 4) with the real adapters. ---

  it("detects a native OpenAI-shaped client (no baseURL) as 'openai'", async () => {
    const client = { chat: { completions: { create: () => ({}) } } };
    expect((await getAdapterForClient(client)).name).toBe("openai");
  });

  it("detects an openai-SDK client pointed at a Groq baseURL as 'groq' (compat BEFORE openai)", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
      baseURL: "https://api.groq.com/openai/v1",
    };
    expect((await getAdapterForClient(client)).name).toBe("groq");
  });

  it("detects an openai-SDK client pointed at the Z.ai baseURL as 'zai'", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
      baseURL: "https://api.z.ai/api/paas/v4",
    };
    expect((await getAdapterForClient(client)).name).toBe("zai");
  });

  it("routes a generic openai-shaped client at an unknown baseURL to the catch-all (LAST among compat)", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
      baseURL: "https://my-private-llm.example.com/v1",
    };
    expect((await getAdapterForClient(client)).name).toBe("openai_compatible");
  });

  it("keeps an OpenAI-host client on the plain openai adapter (catch-all never claims openai hosts)", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
      baseURL: "https://api.openai.com/v1",
    };
    expect((await getAdapterForClient(client)).name).toBe("openai");
  });

  it("detects native Anthropic / Google / Bedrock clients by structural shape", async () => {
    const anthropicClient = { messages: { create: () => ({}) } };
    const googleClient = {
      models: { generateContent: () => ({}), generateContentStream: () => ({}) },
    };
    const bedrockClient = {
      meta: { service_model: { service_name: "bedrock-runtime" }, region_name: "us-east-1" },
    };
    expect((await getAdapterForClient(anthropicClient)).name).toBe("anthropic");
    expect((await getAdapterForClient(googleClient)).name).toBe("google");
    expect((await getAdapterForClient(bedrockClient)).name).toBe("bedrock");
  });

  it("throws (never a default) for an unrecognized client", async () => {
    await expect(getAdapterForClient({ some: "foreign vendor sdk" })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  // --- Model-string routing (invariant 4 + Bedrock-vs-native tie-breaks). ---

  it("routes native model prefixes to the right adapter", async () => {
    expect((await getAdapterForModel("gpt-4o")).name).toBe("openai");
    expect((await getAdapterForModel("o3-mini")).name).toBe("openai");
    expect((await getAdapterForModel("o4-mini")).name).toBe("openai");
    expect((await getAdapterForModel("claude-3-5-sonnet-20241022")).name).toBe("anthropic");
    expect((await getAdapterForModel("gemini-2.0-flash")).name).toBe("google");
  });

  it("routes compat model prefixes to their named profiles", async () => {
    expect((await getAdapterForModel("grok-2-latest")).name).toBe("xai");
    expect((await getAdapterForModel("deepseek-chat")).name).toBe("deepseek");
    expect((await getAdapterForModel("mistral-large-2411")).name).toBe("mistral");
    expect((await getAdapterForModel("glm-4.6")).name).toBe("zai");
  });

  it("routes a Bedrock inference-profile id to 'bedrock', not the native vendor it wraps", async () => {
    expect((await getAdapterForModel("us.anthropic.claude-3-5-sonnet-20241022-v2:0")).name).toBe(
      "bedrock",
    );
  });

  it("still routes a bare claude- id to 'anthropic' (Bedrock pattern never shadows it)", async () => {
    expect((await getAdapterForModel("claude-3-5-sonnet")).name).toBe("anthropic");
  });

  it("never silently falls back for an unregistered model", async () => {
    await expect(getAdapterForModel("llama-3-8b")).rejects.toBeInstanceOf(ConfigurationError);
  });

  // --- buildRuntimes across all four dialects with the real adapters. ---

  it("builds a mixed-dialect [primary, ...fallbacks] chain deriving each provider from detection", async () => {
    const openaiClient = { chat: { completions: { create: () => ({}) } } };
    const anthropicClient = { messages: { create: () => ({}) } };
    const googleClient = {
      models: { generateContent: () => ({}), generateContentStream: () => ({}) },
    };
    const bedrockClient = {
      meta: { service_model: { service_name: "bedrock-runtime" }, region_name: "eu-west-1" },
    };

    const runtimes = await buildRuntimes(openaiClient, "gpt-4o", [
      [anthropicClient, "claude-3-5-sonnet"],
      [googleClient, "gemini-2.0-flash"],
      [bedrockClient, "us.anthropic.claude-3-5-sonnet-20241022-v2:0"],
    ]);

    expect(runtimes.map((r) => r.entry.provider)).toEqual([
      "openai",
      "anthropic",
      "google",
      "bedrock",
    ]);
    expect(runtimes.map((r) => r.adapter.dialect)).toEqual([
      "openai",
      "anthropic",
      "google",
      "bedrock",
    ]);
    for (const runtime of runtimes) {
      expect(runtime.entry.provider).toBe(runtime.adapter.name);
    }
  });

  it("pins an openai-SDK client to a compat identity via primaryProvider", async () => {
    const client = { chat: { completions: { create: () => ({}) } } };
    const [primary] = (await buildRuntimes(client, "llama-3-70b", [], {
      primaryProvider: "groq",
    })) as [ProviderRuntime];
    expect(primary.entry.provider).toBe("groq");
    expect(primary.adapter.dialect).toBe("openai");
  });

  it("explicit zai pin accepts a generic OpenAI-family client on an unknown host", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
      baseURL: "https://unknown-openai-compatible.example/v1",
    };
    const [primary] = (await buildRuntimes(client, "glm-4.6", [], {
      primaryProvider: "zai",
    })) as [ProviderRuntime];
    expect(primary.entry.provider).toBe("zai");
    expect(primary.adapter.name).toBe("zai");
    expect(primary.adapter.dialect).toBe("openai");
  });

  it("rejects a mismatched provider pin against the real adapters", async () => {
    const openaiClient = { chat: { completions: { create: () => ({}) } } };
    await expect(
      buildRuntimes(openaiClient, "gpt-4o", [], { primaryProvider: "anthropic" }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ---------------------------------------------------------------------------
// Sans-I/O guarantee.
// ---------------------------------------------------------------------------

describe("sans-I/O", () => {
  it("performs no network calls across detection and chain assembly", async () => {
    installNative();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("registry must not perform I/O");
    });

    await getAdapterByName("openai");
    await getAdapterForModel("gpt-4o");
    await getAdapterForClient(openaiClient);
    await buildRuntimes(openaiClient, "gpt-4o", [[{ __stub: "anthropic" }, "claude-3-5-sonnet"]]);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
