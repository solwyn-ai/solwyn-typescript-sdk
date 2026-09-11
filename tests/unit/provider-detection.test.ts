import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors";
import { AnthropicAdapter } from "../../src/providers/anthropic";
import * as providerRegistry from "../../src/providers/index";
import type { Dialect } from "../../src/providers/protocol";
import type { ProviderName } from "../../src/types";

interface ProviderIdentity {
  readonly provider: ProviderName;
  readonly dialect: Dialect;
}

type ProviderIdentityResolver = (client: unknown, providerOverride?: string) => ProviderIdentity;

function resolver(): ProviderIdentityResolver {
  const candidate = (providerRegistry as unknown as Record<string, unknown>)[
    "resolveProviderIdentity"
  ];
  expect(candidate, "providers index must export resolveProviderIdentity").toBeTypeOf("function");
  return candidate as ProviderIdentityResolver;
}

function openAIClient(baseURL?: string): object {
  return {
    chat: { completions: { create: () => undefined } },
    ...(baseURL === undefined ? {} : { baseURL }),
  };
}

class Together {
  readonly chat = { completions: { create: () => undefined } };
}

class WrappedTogether extends Together {}

class AzureOpenAI {}

afterEach(() => {
  providerRegistry.__resetAdapterRegistry();
});

describe("resolveProviderIdentity", () => {
  it.each([
    [openAIClient("https://api.groq.com/openai/v1"), "groq", "openai"],
    [openAIClient("https://private-gateway.example/v1"), "openai_compatible", "openai"],
    [openAIClient("https://eu.api.openai.com/v1"), "openai", "openai"],
    [openAIClient(), "openai", "openai"],
    [new WrappedTogether(), "together", "openai"],
    [new AzureOpenAI(), "azure_openai", "openai"],
    [{ messages: { create: () => undefined } }, "anthropic", "anthropic"],
    [
      {
        models: {
          generateContent: () => undefined,
          generateContentStream: () => undefined,
        },
      },
      "google",
      "google",
    ],
    [{ meta: { service_model: { service_name: "bedrock-runtime" } } }, "bedrock", "bedrock"],
  ] as const)("derives %s as provider %s with dialect %s in registration order", (client, provider, dialect) => {
    expect(resolver()(client)).toEqual({ provider, dialect });
  });

  it("matches the existing lazy registry for every built-in client family", async () => {
    const clients = [
      openAIClient("https://api.x.ai/v1"),
      openAIClient("https://api.together.xyz/v1"),
      openAIClient("https://unknown-compat.example/v1"),
      openAIClient(),
      new WrappedTogether(),
      new AzureOpenAI(),
      { messages: { create: () => undefined } },
      {
        models: {
          generateContent: () => undefined,
          generateContentStream: () => undefined,
        },
      },
      { meta: { service_model: { service_name: "bedrock-runtime" } } },
    ];

    for (const client of clients) {
      const synchronous = resolver()(client);
      const lazy = await providerRegistry.getAdapterForClient(client);
      expect(synchronous).toEqual({ provider: lazy.name, dialect: lazy.dialect });
    }
  });

  it("uses an explicit provider pin without inspecting the client", () => {
    let reads = 0;
    const client = {};
    for (const key of ["chat", "responses", "messages", "models", "meta", "constructor"]) {
      Object.defineProperty(client, key, {
        configurable: true,
        get() {
          reads += 1;
          throw new Error("provider getter must not run");
        },
      });
    }

    expect(resolver()(client, "groq")).toEqual({ provider: "groq", dialect: "openai" });
    expect(reads).toBe(0);
  });

  it("rejects an unknown provider pin without inspecting the client", () => {
    let reads = 0;
    const client = Object.defineProperty({}, "chat", {
      get() {
        reads += 1;
        throw new Error("provider getter must not run");
      },
    });

    expect(() => resolver()(client, "not_a_provider")).toThrowError(
      expect.objectContaining({ name: "ConfigurationError", field: "provider" }),
    );
    expect(reads).toBe(0);
  });

  it("never evaluates accessors while rejecting an unrecognized client", async () => {
    let reads = 0;
    const client = {};
    for (const key of [
      "chat",
      "responses",
      "messages",
      "models",
      "meta",
      "baseURL",
      "base_url",
      "constructor",
    ]) {
      Object.defineProperty(client, key, {
        configurable: true,
        get() {
          reads += 1;
          throw new Error("provider getter must not run");
        },
      });
    }

    expect(() => resolver()(client)).toThrowError(ConfigurationError);
    expect(reads).toBe(0);
    await expect(providerRegistry.getAdapterForClient(client)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    expect(reads).toBe(0);
  });

  it("does not load or replace injected adapters during synchronous detection", async () => {
    const injectedOnlyClient = {};
    class InjectedAnthropicAdapter extends AnthropicAdapter {
      override detectClient(client: unknown): boolean {
        return client === injectedOnlyClient;
      }
    }
    const injected = new InjectedAnthropicAdapter();
    let loaderCalls = 0;
    providerRegistry.__setAdapterLoadersForTesting({
      anthropic: async () => {
        loaderCalls += 1;
        return injected;
      },
    });

    expect(resolver()({ messages: { create: () => undefined } })).toEqual({
      provider: "anthropic",
      dialect: "anthropic",
    });
    expect(loaderCalls).toBe(0);

    expect(await providerRegistry.getAdapterForClient(injectedOnlyClient)).toBe(injected);
    expect(loaderCalls).toBe(1);
  });
});
