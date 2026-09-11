import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError, coverage, Solwyn } from "../../src/index";
import { buildRuntimes } from "../../src/registry";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const clientsToClose: Array<{ close(): Promise<void> }> = [];
let ioCalls = 0;
let providerCalls = 0;

function noIO(): never {
  ioCalls += 1;
  throw new Error("construction must not perform I/O");
}

function providerOperation(): never {
  providerCalls += 1;
  throw new Error("family inspection must not call a provider operation");
}

function openAIClient() {
  return { chat: { completions: { create: providerOperation } } };
}

function wrapPinned(client: object, provider: string, position: "primary" | "fallback") {
  const wrapped = new Solwyn(position === "primary" ? client : openAIClient(), {
    apiKey: API_KEY,
    provider: position === "primary" ? provider : "openai",
    fallback: position === "fallback" ? [[client, "fallback-model", {}, provider]] : [],
    reportUntrackedSurfaces: false,
    fetch: noIO,
  });
  clientsToClose.push(wrapped);
  return wrapped;
}

beforeEach(() => {
  ioCalls = 0;
  providerCalls = 0;
  vi.stubGlobal("fetch", noIO);
});

afterEach(async () => {
  await Promise.all(clientsToClose.splice(0).map((client) => client.close()));
  vi.unstubAllGlobals();
  expect(ioCalls).toBe(0);
  expect(providerCalls).toBe(0);
});

describe.each(["primary", "fallback"] as const)("%s pinned family construction", (position) => {
  it.each([
    ["stream-only", () => ({ models: { generateContentStream: providerOperation } })],
    ["legacy-only", () => ({ getGenerativeModel: providerOperation })],
  ])("rejects an unusable %s Google client synchronously", (_name, makeClient) => {
    let error: unknown;
    try {
      wrapPinned(makeClient(), "google", position);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      field: "client",
      message:
        "unsupported provider client pairing: provider 'google' requires a Google GenAI client",
    });
  });

  it.each([
    false,
    true,
  ])("accepts Google generateContent with streaming support = %s", (streaming) => {
    const client = {
      models: {
        generateContent: providerOperation,
        ...(streaming ? { generateContentStream: providerOperation } : {}),
      },
    };
    const wrapped = wrapPinned(client, "google", position);
    const report = coverage(wrapped);
    expect(report.providerChain).toHaveLength(position === "primary" ? 1 : 2);
    expect(report.providerChain.at(-1)).toMatchObject({
      provider: "google",
      dialect: "google",
      clientShape: "google_genai",
    });
    const chat = Reflect.get(wrapped, "chat");
    const completions = Reflect.get(chat, "completions");
    expect(Reflect.get(completions, "create")).toBeTypeOf("function");
  });

  it("rejects an accessor-only Google family method without evaluating it", () => {
    let reads = 0;
    const models = {
      get generateContent() {
        reads += 1;
        return providerOperation;
      },
      generateContentStream: providerOperation,
    };
    let error: unknown;
    try {
      wrapPinned({ models }, "google", position);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ field: "client" });
    expect(reads).toBe(0);
  });

  it("accepts an inherited Google family method", () => {
    class Models {
      generateContent(): never {
        return providerOperation();
      }
    }
    const wrapped = wrapPinned({ models: new Models() }, "google", position);
    expect(coverage(wrapped).providerChain.at(-1)).toMatchObject({
      provider: "google",
      clientShape: "google_genai",
    });
  });

  it.each([
    ["openai", () => ({ responses: { create: providerOperation } }), "openai", "openai_sdk"],
    ["groq", openAIClient, "openai", "openai_sdk"],
    [
      "anthropic",
      () => ({ messages: { create: providerOperation } }),
      "anthropic",
      "anthropic_sdk",
    ],
  ])("preserves the valid %s pin and object-derived shape", (provider, makeClient, dialect, clientShape) => {
    const wrapped = wrapPinned(makeClient(), provider, position);
    expect(coverage(wrapped).providerChain.at(-1)).toMatchObject({
      provider,
      dialect,
      clientShape,
    });
  });
});

it("does not traverse a valid Google fallback's acknowledgment graph", () => {
  let reads = 0;
  const fallback = {
    models: { generateContent: providerOperation },
    get responses() {
      reads += 1;
      throw new Error("fallback acknowledgment graph must not be evaluated");
    },
  };
  const wrapped = new Solwyn(
    { ...openAIClient(), responses: { retrieve: providerOperation } },
    {
      apiKey: API_KEY,
      provider: "openai",
      fallback: [[fallback, "gemini-test", {}, "google"]],
      acknowledgeUntracked: ["responses.retrieve"],
      reportUntrackedSurfaces: false,
      fetch: noIO,
    },
  );
  clientsToClose.push(wrapped);
  expect(coverage(wrapped).providerChain.at(-1)).toMatchObject({ provider: "google" });
  expect(reads).toBe(0);
});

describe("descriptor-only lazy pinned family validation", () => {
  it.each([
    ["openai", "chat", { completions: { create: providerOperation } }],
    ["groq", "responses", { create: providerOperation }],
    ["anthropic", "messages", { create: providerOperation }],
    ["google", "models", { generateContent: providerOperation }],
    ["bedrock", "send", providerOperation],
  ])("rejects an accessor-backed %s family path without evaluating it", async (provider, key, value) => {
    let reads = 0;
    const client = Object.defineProperty({ config: {}, middlewareStack: {} }, key, {
      get() {
        reads += 1;
        return value;
      },
    });
    const runtime = buildRuntimes(client, "model", [], { primaryProvider: provider });
    await expect(runtime).rejects.toBeInstanceOf(ConfigurationError);
    await expect(runtime).rejects.toMatchObject({ field: "client" });
    expect(reads).toBe(0);
  });

  it("rejects a newly accessor-backed Google method without evaluating it", async () => {
    let reads = 0;
    const client = { models: { generateContent: providerOperation } };
    wrapPinned(client, "google", "primary");
    Object.defineProperty(client.models, "generateContent", {
      get() {
        reads += 1;
        return providerOperation;
      },
    });
    const runtime = buildRuntimes(client, "gemini-test", [], { primaryProvider: "google" });
    await expect(runtime).rejects.toBeInstanceOf(ConfigurationError);
    await expect(runtime).rejects.toMatchObject({ field: "client" });
    expect(reads).toBe(0);
  });

  it("preserves every accepted Bedrock runtime family signal", async () => {
    class BedrockRuntimeClient {
      send(): never {
        return providerOperation();
      }
    }
    const clients = [
      { send: providerOperation, meta: { service_model: { service_name: "bedrock-runtime" } } },
      new BedrockRuntimeClient(),
      { send: providerOperation, config: {}, middlewareStack: {} },
    ];
    for (const client of clients) {
      const [runtime] = await buildRuntimes(client, "model", [], { primaryProvider: "bedrock" });
      expect(runtime?.sdkClient).toBe(client);
      expect(runtime?.entry.provider).toBe("bedrock");
    }
    expect(
      coverage(wrapPinned(new BedrockRuntimeClient(), "bedrock", "primary")).providerChain[0],
    ).toMatchObject({ provider: "bedrock", dialect: "bedrock", clientShape: "bedrock_v3" });
  });

  it.each([
    ["bedrock", { send: providerOperation }],
    ["bedrock", { config: {}, middlewareStack: {} }],
    ["openai", { responses: Object.assign(() => undefined, { create: providerOperation }) }],
  ])("does not weaken the existing %s family predicate", async (provider, client) => {
    await expect(
      buildRuntimes(client, "model", [], { primaryProvider: provider }),
    ).rejects.toMatchObject({ name: "ConfigurationError", field: "client" });
  });
});
