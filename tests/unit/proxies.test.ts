/**
 * Exercises full passthrough of the wrapped client's non-intercepted surface
 * (identity preserved),
 * interception of the OpenAI call paths (`chat.completions.create`,
 * `responses.create`) through the pipeline, `.chat.<other>` / `.models` passthrough,
 * and — at the type level — preservation of the wrapped client's TypeScript types on
 * intercepted paths (`new Solwyn(new OpenAI(), { apiKey })` keeps OpenAI's own
 * `.chat.completions.create` signature).
 *
 * `import type OpenAI from "openai"` below is a DEV-ONLY, fully-erased type import
 * used solely by the compile-time assertions; it produces no runtime value import.
 */

import type OpenAI from "openai";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { SolwynCore } from "../../src/client";
import { ConfigurationError, SolwynError, UntrackedSpendSurfaceError } from "../../src/errors";
import { coverage, Solwyn } from "../../src/index";
import type { Logger } from "../../src/logging";
import { currentRun, run } from "../../src/node";
import { __resetUnmeteredSurfaceWarnings, createClientProxy } from "../../src/proxies";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

/** A capturing logger for asserting the proxy's operational warnings. */
function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message: string, ...args: unknown[]) => {
      let rendered = message;
      for (const value of args) {
        rendered = rendered.replace("%s", String(value));
      }
      warnings.push(rendered);
    },
    error: () => {},
  };
}

function makeFetch(): {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  ingested: Array<Record<string, unknown>>;
} {
  const ingested: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(raw)) {
      ingested.push(...(raw as Array<Record<string, unknown>>));
    }
    // A valid ingest response keeps the console-backed default logger quiet, while a
    // malformed body would print an unparseable-response warning during flush.
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), ingested };
}

function makeTrackedMediaFetch(): {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  checks: Array<Record<string, unknown>>;
  ingested: Array<Record<string, unknown>>;
} {
  const checks: Array<Record<string, unknown>> = [];
  const ingested: Array<Record<string, unknown>> = [];
  const impl: FetchLike = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      checks.push(body as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 100,
          reservation_id: "res_media",
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
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(body)) {
      ingested.push(...(body as Array<Record<string, unknown>>));
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl), checks, ingested };
}

// ---------------------------------------------------------------------------
// Passthrough.
// ---------------------------------------------------------------------------

describe("proxies — passthrough", () => {
  it("forwards a non-intercepted top-level method to the wrapped client (preserving return + receiver)", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
      whoAmI(): string {
        return this === client ? "SELF" : "REBOUND";
      },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const proxied = solwyn as unknown as { whoAmI(): string };
    // Method forwards AND keeps `this` bound to the wrapped client.
    expect(proxied.whoAmI()).toBe("SELF");
    await solwyn.close();
  });

  it.each([
    { provider: "openai", path: "post" },
    { provider: "openai", path: "responses.retrieve" },
    { provider: "groq", path: "responses.retrieve" },
  ])("preserves $provider $path private receiver and mutation invalidation after validation", async ({
    provider,
    path,
  }) => {
    class Resource {
      readonly #result = "private result";
      retrieve(): string {
        return this.#result;
      }
    }
    class Client {
      readonly #result = "private result";
      chat = { completions: { create: vi.fn() } };
      responses = new Resource();
      post(): string {
        return this.#result;
      }
    }
    const client = new Client();
    const { fetchMock } = makeFetch();
    const wrapped = new Solwyn(client, {
      apiKey: API_KEY,
      provider,
      onUnmetered: "raise",
      acknowledgeUntracked: [path],
      fetch: fetchMock,
    });
    const nested = path.startsWith("responses.");
    const target = nested ? wrapped.responses : wrapped;
    const raw = nested ? client.responses : client;
    const property = nested ? "retrieve" : "post";
    const first = Reflect.get(target, property);
    expect(Reflect.get(target, property)).toBe(first);
    expect(first()).toBe("private result");
    const replacement = function (this: unknown): unknown {
      return this;
    };
    expect(Reflect.set(target, property, replacement)).toBe(true);
    const second = Reflect.get(target, property);
    expect(second).not.toBe(first);
    expect(second()).toBe(raw);
    expect(Object.getOwnPropertyDescriptor(target, property)?.value).toBe(second);
    const thirdRaw = function (this: unknown): unknown {
      return this;
    };
    expect(
      Reflect.defineProperty(target, property, {
        value: thirdRaw,
        configurable: true,
        writable: true,
      }),
    ).toBe(true);
    const third = Reflect.get(target, property);
    expect(third).not.toBe(second);
    expect(third()).toBe(raw);
    await wrapped.close();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards solwyn_tags unchanged to a genuinely non-intercepted sibling", async () => {
    const create = vi.fn((params: Record<string, unknown>) => params);
    const client = { chat: { completions: { create: () => ({}) } }, files: { create } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const tags = { customer: "acme" };

    const result = (
      solwyn as unknown as { files: { create(v: Record<string, unknown>): unknown } }
    ).files.create({ file: "raw", solwyn_tags: tags });

    expect(result).toMatchObject({ solwyn_tags: tags });
    expect(create).toHaveBeenCalledWith({ file: "raw", solwyn_tags: tags });
    await solwyn.close();
  });

  it("returns an identity-stable guarded .models namespace that still reaches the raw target", async () => {
    const models = { list: () => ["a"] };
    const client = { chat: { completions: { create: () => ({}) } }, models };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const wrapped = (solwyn as unknown as { models: typeof models }).models;
    expect(Object.is(wrapped, models)).toBe(false);
    expect(Object.is(wrapped, (solwyn as unknown as { models: typeof models }).models)).toBe(true);
    expect(wrapped.list()).toEqual(["a"]);
    await solwyn.close();
  });

  it("passes non-create attributes on .chat straight through to the wrapped client's chat", async () => {
    const client = {
      chat: { completions: { create: () => ({}) }, banner: "CHAT-BANNER" },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    expect((solwyn as unknown as { chat: { banner: string } }).chat.banner).toBe("CHAT-BANNER");
    await solwyn.close();
  });

  it("exposes the Solwyn-owned close() over any wrapped-client attribute", async () => {
    const client = { chat: { completions: { create: () => ({}) } }, close: () => "INNER" };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    // Solwyn's close() wins (returns a Promise), not the inner string-returning close.
    const result = solwyn.close();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});

describe("proxies — media tag boundaries", () => {
  it("captures non-enumerable image tags once before generate/edit provider dispatch", async () => {
    const generate = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const edit = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const client = {
      chat: { completions: { create: vi.fn() } },
      images: { generate, edit },
    };
    const { fetchMock, checks, ingested } = makeTrackedMediaFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    let reads = 0;
    const wrapped = solwyn as unknown as {
      images: {
        generate(kwargs: Record<string, unknown>): Promise<unknown>;
        edit(kwargs: Record<string, unknown>): Promise<unknown>;
      };
    };
    const requests = [
      { call: wrapped.images.generate, tags: { hidden: "generate" }, marker: "edit" },
      { call: wrapped.images.edit, tags: { hidden: "edit" }, marker: "generate" },
    ];
    const descriptors: PropertyDescriptor[] = [];
    for (const { call, tags, marker } of requests) {
      const request: Record<string, unknown> = {
        model: "gpt-image-1",
        prompt: "opaque",
        _solwyn_image_op: marker,
      };
      Object.defineProperty(request, "solwyn_tags", {
        configurable: false,
        enumerable: false,
        get() {
          reads += 1;
          return tags;
        },
      });
      descriptors.push(
        Object.getOwnPropertyDescriptor(request, "solwyn_tags") as PropertyDescriptor,
      );
      await call(request);
      expect(Object.getOwnPropertyDescriptor(request, "solwyn_tags")).toEqual(descriptors.at(-1));
    }
    await solwyn.close();

    expect(reads).toBe(2);
    expect(checks.map((check) => check["tags"])).toEqual([
      { hidden: "generate" },
      { hidden: "edit" },
    ]);
    expect(ingested.map((event) => event["tags"])).toEqual(
      expect.arrayContaining([{ hidden: "generate" }, { hidden: "edit" }]),
    );
    expect(generate.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
    expect(edit.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
    expect(generate).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
  });

  it("rejects non-enumerable invalid speech and transcription tags before I/O", async () => {
    const speechCreate = vi.fn();
    const transcriptionCreate = vi.fn();
    const client = {
      chat: { completions: { create: vi.fn() } },
      audio: {
        speech: { create: speechCreate },
        transcriptions: { create: transcriptionCreate },
      },
    };
    const { fetchMock } = makeTrackedMediaFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const speechRequest: Record<string, unknown> = { model: "gpt-4o-tts" };
    const transcriptionRequest: Record<string, unknown> = { model: "gpt-4o-transcribe" };
    for (const request of [speechRequest, transcriptionRequest]) {
      Object.defineProperty(request, "solwyn_tags", {
        configurable: false,
        enumerable: false,
        value: ["invalid"],
        writable: false,
      });
    }
    const wrapped = solwyn as unknown as {
      audio: {
        speech: { create(kwargs: Record<string, unknown>): Promise<unknown> };
        transcriptions: { create(kwargs: Record<string, unknown>): Promise<unknown> };
      };
    };

    await expect(wrapped.audio.speech.create(speechRequest)).rejects.toThrow(
      /solwyn_tags requires a plain record/,
    );
    await expect(wrapped.audio.transcriptions.create(transcriptionRequest)).rejects.toThrow(
      /solwyn_tags requires a plain record/,
    );
    await solwyn.close();

    expect(speechCreate).not.toHaveBeenCalled();
    expect(transcriptionCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains issuance-time attribution for tracked speech resolved after its run exits", async () => {
    const speechCreate = vi.fn((_kwargs: Record<string, unknown>) => ({ id: "speech" }));
    const client = {
      chat: { completions: { create: vi.fn() } },
      audio: { speech: { create: speechCreate } },
    };
    const { fetchMock, checks, ingested } = makeTrackedMediaFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      tags: { configured: "config", shared: "config" },
      defaultParams: { solwyn_tags: { ignored: "default" } },
    });
    const callerTags = { caller: "call", shared: "caller" };
    const request: {
      model: string;
      input: string;
      solwyn_tags: Record<string, string>;
    } = { model: "gpt-4o-tts", input: "opaque", solwyn_tags: callerTags };
    let pending: Promise<unknown> | undefined;
    let parentId = "";
    let childId = "";

    await run("speech-parent", { tags: { parent: "run" } }, async () => {
      parentId = currentRun()?.agentRunId ?? "";
      await run("speech-child", { tags: { child: "run", shared: "run" } }, () => {
        childId = currentRun()?.agentRunId ?? "";
        pending = (
          solwyn as unknown as {
            audio: { speech: { create(kwargs: Record<string, unknown>): Promise<unknown> } };
          }
        ).audio.speech.create(request);
      });
    });
    callerTags.caller = "mutated";
    request.solwyn_tags = { replacement: "late" };

    await pending;
    await solwyn.close();

    const expectedTags = {
      caller: "call",
      shared: "caller",
      child: "run",
      parent: "run",
      configured: "config",
    };
    expect(checks[0]).toMatchObject({ agent_run_id: childId, tags: expectedTags });
    expect(ingested[0]).toMatchObject({
      agent_run_id: childId,
      agent_run_name: "speech-child",
      parent_agent_run_id: parentId,
      tags: expectedTags,
      modality: "audio",
    });
    expect(speechCreate.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
  });

  it("strips tags from warned untracked speech while leaving an untracked audio sibling transparent", async () => {
    const speechCreate = vi.fn((kwargs: Record<string, unknown>) => kwargs);
    const translationCreate = vi.fn((kwargs: Record<string, unknown>) => kwargs);
    const client = {
      chat: { completions: { create: vi.fn() } },
      audio: {
        speech: { create: speechCreate },
        translations: { create: translationCreate },
      },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      reportUntrackedSurfaces: false,
      tags: { configured: "config" },
      defaultParams: { solwyn_tags: { ignored: "default" } },
    });
    const tags = { caller: "call" };

    const speech = await (
      solwyn as unknown as {
        audio: { speech: { create(kwargs: Record<string, unknown>): Promise<unknown> } };
      }
    ).audio.speech.create({ model: "gpt-4o-mini-tts", input: "opaque", solwyn_tags: tags });
    const sibling = (
      solwyn as unknown as {
        audio: { translations: { create(kwargs: Record<string, unknown>): unknown } };
      }
    ).audio.translations.create({ file: "opaque", solwyn_tags: tags });
    await solwyn.close();

    expect(speech).not.toHaveProperty("solwyn_tags");
    expect(speechCreate.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
    expect(sibling).toMatchObject({ solwyn_tags: tags });
    expect(translationCreate).toHaveBeenCalledWith({ file: "opaque", solwyn_tags: tags });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed speech tags before async resolution performs provider or control-plane I/O", async () => {
    const speechCreate = vi.fn();
    const client = {
      chat: { completions: { create: vi.fn() } },
      audio: { speech: { create: speechCreate } },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await expect(
      (
        solwyn as unknown as {
          audio: { speech: { create(kwargs: Record<string, unknown>): Promise<unknown> } };
        }
      ).audio.speech.create({ model: "gpt-4o-tts", solwyn_tags: ["invalid"] }),
    ).rejects.toThrow(/solwyn_tags requires a plain record/);
    await solwyn.close();

    expect(speechCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters and attributes each direct OpenAI media boundary", async () => {
    const embeddingsCreate = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 1 },
    }));
    const imagesGenerate = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const videosCreate = vi.fn((_kwargs: Record<string, unknown>) => ({ id: "video" }));
    const transcriptionsCreate = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { input_tokens: 1 },
    }));
    const client = {
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: embeddingsCreate },
      images: { generate: imagesGenerate },
      videos: { create: videosCreate },
      audio: { transcriptions: { create: transcriptionsCreate } },
    };
    const { fetchMock, checks, ingested } = makeTrackedMediaFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      tags: { configured: "config" },
    });
    const wrapped = solwyn as unknown as {
      embeddings: { create(kwargs: Record<string, unknown>): Promise<unknown> };
      images: { generate(kwargs: Record<string, unknown>): Promise<unknown> };
      videos: { create(kwargs: Record<string, unknown>): Promise<unknown> };
      audio: { transcriptions: { create(kwargs: Record<string, unknown>): Promise<unknown> } };
    };

    await wrapped.embeddings.create({
      model: "text-embedding-3-small",
      solwyn_tags: { op: "embedding" },
    });
    await wrapped.images.generate({ model: "gpt-image-1", solwyn_tags: { op: "image" } });
    await wrapped.videos.create({ model: "sora-2", solwyn_tags: { op: "video" } });
    await wrapped.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      solwyn_tags: { op: "transcription" },
    });
    await solwyn.close();

    expect(checks.map((check) => check["tags"])).toEqual([
      { op: "embedding", configured: "config" },
      { op: "image", configured: "config" },
      { op: "video", configured: "config" },
      { op: "transcription", configured: "config" },
    ]);
    expect(ingested).toHaveLength(4);
    for (const check of checks) {
      expect(ingested.map((event) => event["tags"])).toContainEqual(check["tags"]);
    }
    for (const native of [embeddingsCreate, imagesGenerate, videosCreate, transcriptionsCreate]) {
      expect(native.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
    }
  });
});

// ---------------------------------------------------------------------------
// Transparent top-level mutation + reflection (WS-W1a).
// ---------------------------------------------------------------------------

describe("proxies — transparent top-level mutation + reflection", () => {
  it("forwards string and symbol writes only to the wrapped client", async () => {
    const marker = Symbol("framework-marker");
    const client = {
      chat: { completions: { create: () => ({}) } },
    } as Record<PropertyKey, unknown> & {
      chat: { completions: { create(): object } };
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as Record<PropertyKey, unknown>;

    expect(Reflect.set(wrapper, "timeout", 5)).toBe(true);
    expect(Reflect.set(wrapper, marker, "present")).toBe(true);
    expect(client["timeout"]).toBe(5);
    expect(client[marker]).toBe("present");

    // Removing the provider properties directly makes them disappear from reflection too:
    // the writes did not also create shadow properties on the SolwynCore proxy target.
    expect(Reflect.deleteProperty(client, "timeout")).toBe(true);
    expect(Reflect.deleteProperty(client, marker)).toBe(true);
    expect(Reflect.getOwnPropertyDescriptor(wrapper, "timeout")).toBeUndefined();
    expect(Reflect.getOwnPropertyDescriptor(wrapper, marker)).toBeUndefined();
    await solwyn.close();
  });

  it("forwards an intercepted-name write while the Solwyn read remains intercepted", async () => {
    const originalChat = { completions: { create: () => ({}) } };
    const replacementChat = { frameworkOwned: true };
    const client: { chat: unknown } = { chat: originalChat };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as { chat: unknown };
    const intercepted = wrapper.chat;

    expect(Reflect.set(wrapper, "chat", replacementChat)).toBe(true);
    expect(client.chat).toBe(replacementChat);
    expect(wrapper.chat).toBe(intercepted);
    expect(wrapper.chat).not.toBe(replacementChat);
    await solwyn.close();
  });

  it("forwards ordinary and intercepted-name deletes to the wrapped client", async () => {
    const chat = { completions: { create: () => ({}) } };
    const client: { chat?: unknown; frameworkMarker?: string } = {
      chat,
      frameworkMarker: "present",
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as { chat: unknown; frameworkMarker?: string };
    const intercepted = wrapper.chat;

    expect(Reflect.deleteProperty(wrapper, "frameworkMarker")).toBe(true);
    expect(Reflect.deleteProperty(wrapper, "chat")).toBe(true);
    expect("frameworkMarker" in client).toBe(false);
    expect("chat" in client).toBe(false);
    expect(wrapper.chat).toBe(intercepted);
    await solwyn.close();
  });

  it("forwards defineProperty descriptors exactly and reports wrapped descriptors as configurable", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
    } as Record<PropertyKey, unknown> & {
      chat: { completions: { create(): object } };
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as Record<PropertyKey, unknown>;
    const descriptor: PropertyDescriptor = {
      value: 7,
      writable: false,
      enumerable: true,
      configurable: true,
    };

    expect(Reflect.defineProperty(wrapper, "locked", descriptor)).toBe(true);
    expect(Reflect.getOwnPropertyDescriptor(client, "locked")).toEqual(descriptor);
    expect(Reflect.getOwnPropertyDescriptor(wrapper, "locked")).toEqual({
      ...descriptor,
      configurable: true,
    });
    await solwyn.close();
  });

  it("preserves accessor descriptors and uses the provider as their receiver", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
    } as Record<PropertyKey, unknown> & {
      chat: { completions: { create(): object } };
    };
    let stored = "initial";
    let getterReceiver: unknown;
    let setterReceiver: unknown;
    const getter = function (this: unknown): string {
      getterReceiver = this;
      return stored;
    };
    const setter = function (this: unknown, value: unknown): void {
      setterReceiver = this;
      stored = String(value);
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as Record<PropertyKey, unknown>;

    expect(
      Reflect.defineProperty(wrapper, "setting", {
        get: getter,
        set: setter,
        enumerable: false,
        configurable: true,
      }),
    ).toBe(true);
    expect(Reflect.getOwnPropertyDescriptor(client, "setting")).toEqual({
      get: getter,
      set: setter,
      enumerable: false,
      configurable: true,
    });
    expect(wrapper["setting"]).toBe("initial");
    expect(getterReceiver).toBe(client);
    expect(Reflect.set(wrapper, "setting", "updated")).toBe(true);
    expect(setterReceiver).toBe(client);
    expect(stored).toBe("updated");
    await solwyn.close();
  });

  it("unions target and wrapped own keys, deduplicates collisions, and preserves target descriptors", async () => {
    const providerSymbol = Symbol("provider");
    const client = {
      chat: { completions: { create: () => ({}) } },
      providerOnly: "provider",
      collision: "wrapped",
      [providerSymbol]: "symbol",
    };
    Object.defineProperty(client, "providerLocked", {
      value: "locked",
      writable: false,
      enumerable: true,
      configurable: false,
    });
    const { fetchMock } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch: fetchMock });
    Object.defineProperty(core, "coreOnly", {
      value: "core",
      writable: false,
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(core, "collision", {
      value: "target",
      writable: true,
      enumerable: false,
      configurable: true,
    });
    const wrapper = createClientProxy(core, client);

    const keys = Reflect.ownKeys(wrapper);
    expect(keys).toEqual(
      expect.arrayContaining([
        "coreOnly",
        "collision",
        "chat",
        "providerOnly",
        "providerLocked",
        providerSymbol,
      ]),
    );
    expect(keys.filter((key) => key === "collision")).toHaveLength(1);
    expect(Object.keys(wrapper)).toEqual(
      expect.arrayContaining(["coreOnly", "chat", "providerOnly"]),
    );
    expect(Reflect.getOwnPropertyDescriptor(wrapper, "coreOnly")).toEqual({
      value: "core",
      writable: false,
      enumerable: true,
      configurable: false,
    });
    expect((wrapper as Record<string, unknown>)["coreOnly"]).toBe("core");
    expect("coreOnly" in wrapper).toBe(true);
    expect(Reflect.getOwnPropertyDescriptor(wrapper, "collision")?.value).toBe("target");
    expect(Reflect.getOwnPropertyDescriptor(wrapper, "providerOnly")).toEqual({
      value: "provider",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Reflect.getOwnPropertyDescriptor(wrapper, "providerLocked")).toEqual({
      value: "locked",
      writable: false,
      enumerable: true,
      configurable: true,
    });
    expect(Reflect.getOwnPropertyDescriptor(wrapper, providerSymbol)).toEqual({
      value: "symbol",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    await core.close();
  });

  it("falls back to target reflection invariants if callers make the proxy target non-extensible", async () => {
    class ProviderClient {
      readonly chat = { completions: { create: () => ({}) } };
      readonly providerOnly = "provider";
    }
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(new ProviderClient(), { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as { providerOnly: string };

    Object.preventExtensions(wrapper);

    expect(Reflect.ownKeys(wrapper)).toEqual([Symbol.for("nodejs.util.inspect.custom")]);
    expect(Reflect.getOwnPropertyDescriptor(wrapper, "providerOnly")).toBeUndefined();
    expect(Reflect.getPrototypeOf(wrapper)).toBe(SolwynCore.prototype);
    expect(wrapper.providerOnly).toBe("provider");
    await solwyn.close();
  });

  it("rejects invariant-breaking mutations before they can alter the provider", async () => {
    const client: Record<PropertyKey, unknown> = {
      chat: { completions: { create: () => ({}) } },
      targetCollision: "provider",
      locked: "provider-locked",
    };
    const { fetchMock } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch: fetchMock });
    Object.defineProperty(core, "targetCollision", {
      value: "core",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(core, "locked", {
      value: "core-locked",
      writable: false,
      enumerable: true,
      configurable: false,
    });
    const wrapper = createClientProxy(core, client);
    Object.preventExtensions(wrapper);

    expect(Reflect.defineProperty(wrapper, "newProviderKey", { value: "new" })).toBe(false);
    expect("newProviderKey" in client).toBe(false);
    expect(Reflect.deleteProperty(wrapper, "targetCollision")).toBe(false);
    expect(client["targetCollision"]).toBe("provider");
    expect(Reflect.set(wrapper, "locked", "changed")).toBe(false);
    expect(client["locked"]).toBe("provider-locked");
    await core.close();
  });

  it("rejects an explicitly non-configurable definition atomically when the target has no key", async () => {
    const client: Record<PropertyKey, unknown> = {
      chat: { completions: { create: () => ({}) } },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as Record<PropertyKey, unknown>;
    const descriptor: PropertyDescriptor = {
      configurable: false,
      enumerable: true,
      value: "locked",
      writable: true,
    };

    // A Proxy may report a new non-configurable property only when that property also exists
    // non-configurably on its target. Mirroring it onto SolwynCore would break intercepted/core
    // reads for keys such as chat and close, so the portable behavior is an atomic false.
    expect(Reflect.defineProperty(wrapper, "explicitLocked", descriptor)).toBe(false);
    expect(Reflect.getOwnPropertyDescriptor(client, "explicitLocked")).toBeUndefined();
    expect(Reflect.getOwnPropertyDescriptor(wrapper, "explicitLocked")).toBeUndefined();
    expect(() => Object.defineProperty(wrapper, "explicitLocked", descriptor)).toThrow(TypeError);
    expect(Reflect.getOwnPropertyDescriptor(client, "explicitLocked")).toBeUndefined();
    await solwyn.close();
  });

  it("invalidates only the mutated method key after replace, delete, and redefine", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
      mutable(): string {
        return this === client ? "original" : "wrong receiver";
      },
      unchanged(): string {
        return this === client ? "stable" : "wrong receiver";
      },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as {
      mutable?: () => string;
      unchanged(): string;
    };
    const original = wrapper.mutable;
    const unchanged = wrapper.unchanged;

    expect(original).toBe(wrapper.mutable);
    expect(
      Reflect.set(wrapper, "mutable", function (this: unknown) {
        return this === client ? "replacement" : "wrong receiver";
      }),
    ).toBe(true);
    const replacement = wrapper.mutable;
    expect(replacement).not.toBe(original);
    expect(replacement?.()).toBe("replacement");
    expect(wrapper.unchanged).toBe(unchanged);

    expect(Reflect.deleteProperty(wrapper, "mutable")).toBe(true);
    expect(wrapper.mutable).toBeUndefined();
    expect(wrapper.unchanged).toBe(unchanged);

    expect(
      Reflect.defineProperty(wrapper, "mutable", {
        value: function (this: unknown): string {
          return this === client ? "redefined" : "wrong receiver";
        },
        writable: true,
        enumerable: true,
        configurable: true,
      }),
    ).toBe(true);
    const redefined = wrapper.mutable;
    expect(redefined).not.toBe(replacement);
    expect(redefined?.()).toBe("redefined");
    expect(wrapper.unchanged).toBe(unchanged);
    await solwyn.close();
  });

  it("rebinds a surface method replaced on the raw object or its prototype after the first read", async () => {
    class Completions {
      create(): object {
        return {};
      }
      list(): string {
        return this === completions ? "original list" : "wrong receiver";
      }
      update(): string {
        return this === completions ? "original update" : "wrong receiver";
      }
      retrieve(): string {
        return this === completions ? "stable" : "wrong receiver";
      }
    }
    const completions = new Completions() as Completions & { list: () => string };
    const client = { chat: { completions } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapped = (
      solwyn as unknown as {
        chat: { completions: { list(): string; update(): string; retrieve(): string } };
      }
    ).chat.completions;

    const stable = wrapped.retrieve;
    const firstList = wrapped.list;
    const firstUpdate = wrapped.update;
    expect(wrapped.list).toBe(firstList);
    expect(wrapped.update).toBe(firstUpdate);
    expect(firstList()).toBe("original list");

    // Raw-side own replacement, bypassing the proxy's mutation traps.
    completions.list = function (this: unknown): string {
      return this === completions ? "replaced list" : "wrong receiver";
    };
    const replacedList = wrapped.list;
    expect(replacedList).not.toBe(firstList);
    expect(replacedList()).toBe("replaced list");
    expect(wrapped.list).toBe(replacedList);

    // Prototype patch after the first wrapped read.
    const originalUpdate = Completions.prototype.update;
    Completions.prototype.update = function (this: unknown): string {
      return this === completions ? "patched update" : "wrong receiver";
    };
    try {
      const patchedUpdate = wrapped.update;
      expect(patchedUpdate).not.toBe(firstUpdate);
      expect(patchedUpdate()).toBe("patched update");
      expect(wrapped.update).toBe(patchedUpdate);
    } finally {
      Completions.prototype.update = originalUpdate;
    }
    expect(wrapped.update()).toBe("original update");

    // Nothing changed for this key: identity is unchanged across every read above.
    expect(wrapped.retrieve).toBe(stable);
    await solwyn.close();
  });

  it("keeps the same binding when a mutation fails and the method is unchanged", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
    } as Record<PropertyKey, unknown> & {
      chat: { completions: { create(): object } };
    };
    const locked = function (this: unknown): unknown {
      return this;
    };
    Object.defineProperty(client, "locked", {
      value: locked,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as { locked(): unknown };
    const bound = wrapper.locked;

    expect(Reflect.set(wrapper, "locked", () => "replacement")).toBe(false);
    expect(Reflect.deleteProperty(wrapper, "locked")).toBe(false);
    expect(Reflect.defineProperty(wrapper, "locked", { value: () => "redefined" })).toBe(false);
    expect(wrapper.locked).toBe(bound);
    expect(wrapper.locked()).toBe(client);
    await solwyn.close();
  });

  it("invalidates a symbol-keyed method without disturbing another binding", async () => {
    const mutable = Symbol("mutable");
    const stable = Symbol("stable");
    const client = {
      chat: { completions: { create: () => ({}) } },
      [mutable](): string {
        return this === client ? "original" : "wrong receiver";
      },
      [stable](): string {
        return this === client ? "stable" : "wrong receiver";
      },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as Record<PropertyKey, unknown>;
    const original = wrapper[mutable];
    const stableBinding = wrapper[stable];

    expect(
      Reflect.set(wrapper, mutable, function (this: unknown): string {
        return this === client ? "replacement" : "wrong receiver";
      }),
    ).toBe(true);
    expect(wrapper[mutable]).not.toBe(original);
    expect((wrapper[mutable] as () => string)()).toBe("replacement");
    expect(wrapper[stable]).toBe(stableBinding);
    await solwyn.close();
  });

  it("keeps the core close binding stable when a provider close is replaced", async () => {
    const client: Record<PropertyKey, unknown> = {
      chat: { completions: { create: () => ({}) } },
      close: () => "original provider close",
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as Record<PropertyKey, unknown> & {
      close(): Promise<void>;
    };
    const coreClose = wrapper.close;
    const replacement = vi.fn(() => undefined);

    expect(Reflect.set(wrapper, "close", replacement)).toBe(true);
    expect(client["close"]).toBe(replacement);
    expect(wrapper.close).toBe(coreClose);
    await wrapper.close();
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it("does not run passthrough warning or provider-detection logic for mutations", async () => {
    const client = { chat: { completions: { create: () => ({}) } } } as Record<
      PropertyKey,
      unknown
    >;
    const { fetchMock } = makeFetch();
    const logger = fakeLogger();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock, logger });
    const wrapper = solwyn as unknown as Record<PropertyKey, unknown>;

    expect(Reflect.set(wrapper, "frameworkMarker", 1)).toBe(true);
    expect(Reflect.defineProperty(wrapper, "frameworkFlag", { value: true })).toBe(true);
    expect(Reflect.deleteProperty(wrapper, "frameworkMarker")).toBe(true);
    expect(logger.warnings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });
});

// ---------------------------------------------------------------------------
// Specialized namespace mutation uses the same raw-receiver contract as the root.
// ---------------------------------------------------------------------------

describe("proxies — specialized namespace mutation", () => {
  const namespaces = [
    { provider: "openai", path: "chat" },
    { provider: "openai", path: "chat.completions" },
    { provider: "openai", path: "responses" },
    { provider: "openai", path: "embeddings" },
    { provider: "openai", path: "images" },
    { provider: "openai", path: "videos" },
    { provider: "openai", path: "audio" },
    { provider: "openai", path: "audio.transcriptions" },
    { provider: "openai", path: "audio.speech" },
    { provider: "anthropic", path: "messages" },
    { provider: "google", path: "models" },
  ] as const;

  function namespaceFixture(
    { provider, path }: { provider: (typeof namespaces)[number]["provider"]; path: string },
    fields: object,
    onUnmetered: "raise" | "warn" | "allow" = "allow",
    wrapTarget: (target: object) => object = (target) => target,
  ) {
    __resetUnmeteredSurfaceWarnings();
    let raw: object =
      provider === "anthropic"
        ? { messages: { create: () => ({}) } }
        : provider === "google"
          ? { models: { generateContent: () => ({}) } }
          : {
              chat: { completions: { create: () => ({}) } },
              responses: { create: () => ({}), stream: () => ({}) },
              embeddings: { create: () => ({}) },
              images: { generate: () => ({}) },
              videos: { create: () => ({}) },
              audio: {
                transcriptions: { create: () => ({}) },
                speech: { create: () => ({}) },
              },
              future: {},
            };
    const segments = path === "" ? [] : path.split(".");
    const descend = (root: object): Record<PropertyKey, unknown> =>
      segments.reduce<object>((value, key) => Reflect.get(value, key), root) as Record<
        PropertyKey,
        unknown
      >;
    const originalTarget = descend(raw);
    Object.defineProperties(originalTarget, Object.getOwnPropertyDescriptors(fields));
    const target = wrapTarget(originalTarget) as Record<PropertyKey, unknown>;
    const property = segments.at(-1);
    if (property === undefined) raw = target;
    else {
      const owner = segments
        .slice(0, -1)
        .reduce<object>((value, key) => Reflect.get(value, key), raw);
      Reflect.set(owner, property, target);
    }
    const logger = fakeLogger();
    const { fetchMock } = makeFetch();
    const core = new SolwynCore(raw, {
      apiKey: API_KEY,
      provider,
      onUnmetered,
      reportUntrackedSurfaces: onUnmetered !== "allow",
      logger,
      fetch: fetchMock,
    });
    const wrapper = createClientProxy(core, raw);
    return { core, target, namespace: descend(wrapper), logger, fetchMock };
  }

  describe.each([
    { provider: "openai", path: "" },
    ...namespaces,
  ] as const)("reflected callable setter at $path ($provider)", (namespaceCase) => {
    it("invokes the captured setter and invalidates its binding only after synchronous success", async () => {
      let method = function (this: unknown) {
        return { receiver: this, version: "original" };
      };
      const failedMethod = function (this: unknown) {
        return { receiver: this, version: "failed" };
      };
      const result = { accepted: true };
      const failure = new Error("original setter failed");
      let setterReceiver: unknown;
      const fields = {
        unchanged() {
          return "stable";
        },
      };
      Object.defineProperty(fields, "mutable", {
        configurable: true,
        get: () => method,
        set(value: typeof method) {
          setterReceiver = this;
          if (value === failedMethod) throw failure;
          method = value;
          return result;
        },
      });
      const { core, target, namespace } = namespaceFixture(namespaceCase, fields);
      const original = namespace["mutable"];
      const unchanged = namespace["unchanged"];
      const descriptor = Reflect.getOwnPropertyDescriptor(namespace, "mutable");
      Object.defineProperty(target, "mutable", {
        configurable: true,
        get: () => method,
        set() {
          throw new Error("replacement setter must not be called");
        },
      });
      const reads = vi.spyOn(core, "resolveSurfaceRead");
      try {
        expect(descriptor?.set).toBeTypeOf("function");
        let caught: unknown;
        try {
          descriptor?.set?.call({}, failedMethod);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(reads).not.toHaveBeenCalled();
        expect(namespace["mutable"]).toBe(original);
        reads.mockClear();
        expect(
          descriptor?.set?.call({}, function (this: unknown) {
            return { receiver: this, version: "replacement" };
          }),
        ).toBe(result);
        expect(setterReceiver).toBe(target);
        expect(reads).not.toHaveBeenCalled();
        const updated = namespace["mutable"] as () => unknown;
        expect(updated).not.toBe(original);
        expect(updated()).toEqual({ receiver: target, version: "replacement" });
        expect(namespace["unchanged"]).toBe(unchanged);
      } finally {
        reads.mockRestore();
        await core.close();
      }
    });
  });

  describe.each(namespaces)("$path ($provider)", (namespaceCase) => {
    it.each([
      "raise",
      "warn",
    ] as const)("updates existing unknown data fields without read posture under %s", async (onUnmetered) => {
      const fixture = namespaceFixture(
        namespaceCase,
        { futureSetting: "before", futureMethod: () => "before" },
        onUnmetered,
      );
      const { core, target, namespace, logger, fetchMock } = fixture;
      const reads = vi.spyOn(core, "resolveSurfaceRead");
      const replacement = () => "after";
      try {
        expect(Reflect.set(namespace, "futureSetting", "after")).toBe(true);
        expect(Reflect.set(namespace, "futureMethod", replacement)).toBe(true);
        expect(target["futureSetting"]).toBe("after");
        expect(target["futureMethod"]).toBe(replacement);
        expect(
          Reflect.defineProperty(namespace, "futureSetting", {
            value: "defined",
            writable: true,
            configurable: true,
          }),
        ).toBe(true);
        expect(target["futureSetting"]).toBe("defined");
        expect(Reflect.deleteProperty(namespace, "futureSetting")).toBe(true);
        expect(Reflect.has(target, "futureSetting")).toBe(false);
        expect(reads).not.toHaveBeenCalled();
        expect(logger.warnings).toEqual([]);
        await core.close();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
        await core.close();
      }
    });

    it.each([
      "raise",
      "warn",
    ] as const)("updates existing accessors with the raw receiver and no guarded reads under %s", async (onUnmetered) => {
      let setterReceiver: unknown;
      const fields: { futureSetting: string; setting: string } = {
        futureSetting: "before",
        get setting(): string {
          throw new Error("assignment must not evaluate the getter");
        },
        set setting(value: string) {
          setterReceiver = this;
          this.futureSetting = value;
        },
      };
      const { core, target, namespace, logger, fetchMock } = namespaceFixture(
        namespaceCase,
        fields,
        onUnmetered,
      );
      const reads = vi.spyOn(core, "resolveSurfaceRead");
      try {
        expect(Reflect.set(namespace, "setting", "after")).toBe(true);
        expect(Object.is(setterReceiver, target)).toBe(true);
        expect(target["futureSetting"]).toBe("after");
        expect(reads).not.toHaveBeenCalled();
        expect(logger.warnings).toEqual([]);
        await core.close();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
        await core.close();
      }
    });

    it.each([
      "set",
      "deleteProperty",
      "defineProperty",
    ] as const)("%s invalidates only the changed passthrough method binding", async (operation) => {
      const { core, target, namespace } = namespaceFixture(namespaceCase, {
        mutable() {
          return { receiver: this, version: "original" };
        },
        unchanged() {
          return "stable";
        },
      });
      const replacement = function (this: unknown) {
        return { receiver: this, version: "replacement" };
      };
      Object.setPrototypeOf(target, { mutable: replacement });
      const original = namespace["mutable"];
      const unchanged = namespace["unchanged"];
      const reads = vi.spyOn(core, "resolveSurfaceRead");
      try {
        const mutations = {
          set: () => Reflect.set(namespace, "mutable", replacement),
          deleteProperty: () => Reflect.deleteProperty(namespace, "mutable"),
          defineProperty: () =>
            Reflect.defineProperty(namespace, "mutable", { value: replacement }),
        };
        expect(mutations[operation]()).toBe(true);
        expect(reads).not.toHaveBeenCalled();
        const updated = namespace["mutable"] as () => unknown;
        expect(updated).not.toBe(original);
        expect(updated).toBe(namespace["mutable"]);
        expect(updated()).toEqual({ receiver: target, version: "replacement" });
        expect(namespace["unchanged"]).toBe(unchanged);
      } finally {
        reads.mockRestore();
        await core.close();
      }
    });

    it("preserves fixed inert descriptors but refuses active accessors without reading them", async () => {
      const fields = Object.defineProperties(
        {},
        {
          inert: { configurable: false, enumerable: true, get: undefined, set: undefined },
          getter: {
            configurable: false,
            get: () => {
              throw new Error("getter evaluated");
            },
          },
          setter: {
            configurable: false,
            set: () => {
              throw new Error("setter invoked");
            },
          },
        },
      );
      const { core, target, namespace, logger, fetchMock } = namespaceFixture(
        namespaceCase,
        fields,
        "raise",
      );
      const reads = vi.spyOn(core, "resolveSurfaceRead");
      try {
        expect(Object.getOwnPropertyDescriptor(namespace, "inert")).toEqual(
          Object.getOwnPropertyDescriptor(target, "inert"),
        );
        for (const property of ["getter", "setter"]) {
          expect(() => Object.getOwnPropertyDescriptor(namespace, property)).toThrow(SolwynError);
        }
        expect(reads).not.toHaveBeenCalled();
        expect(logger.warnings).toEqual([]);
        await core.close();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
        await core.close();
      }
    });

    it("preserves the binding when a mutation is rejected", async () => {
      const method = function (this: unknown) {
        return this;
      };
      const fields = Object.defineProperty({}, "locked", {
        configurable: false,
        get: () => method,
      });
      const { core, target, namespace } = namespaceFixture(namespaceCase, fields);
      const original = namespace["locked"] as () => unknown;
      try {
        expect(Reflect.set(namespace, "locked", () => "replacement")).toBe(false);
        expect(Reflect.deleteProperty(namespace, "locked")).toBe(false);
        expect(Reflect.defineProperty(namespace, "locked", { value: () => "replacement" })).toBe(
          false,
        );
        expect(namespace["locked"]).toBe(original);
        expect(original()).toBe(target);
      } finally {
        await core.close();
      }
    });
  });

  describe.each(["", "chat", "future"])("reflected setter at '%s'", (path) => {
    it.each([
      "pass",
      "false",
      "throw",
      "true without write",
    ] as const)("bypasses the provider's %s set trap while direct assignment still uses it", async (mode) => {
      const result = { accepted: true };
      const failure = new Error("captured setter failed");
      const trapFailure = new Error("provider set trap failed");
      const calls: Array<{ receiver: unknown; value: unknown }> = [];
      let trapCalls = 0;
      const fields = Object.defineProperty({}, "setting", {
        configurable: true,
        set(value: unknown) {
          if (value === failure) throw failure;
          calls.push({ receiver: this, value });
          return result;
        },
      });
      const { core, target, namespace, logger, fetchMock } = namespaceFixture(
        { provider: "openai", path },
        fields,
        "allow",
        (target) =>
          new Proxy(target, {
            set(current, property, value, receiver) {
              trapCalls++;
              if (mode === "false") return false;
              if (mode === "throw") throw trapFailure;
              if (mode === "true without write") return true;
              return Reflect.set(current, property, value, receiver);
            },
          }),
      );
      const reads = vi.spyOn(core, "resolveSurfaceRead");
      const setter = Object.getOwnPropertyDescriptor(namespace, "setting")?.set;
      try {
        expect(setter).toBeTypeOf("function");
        expect(setter?.call({}, 123)).toBe(result);
        expect(calls).toEqual([{ receiver: target, value: 123 }]);
        let caught: unknown;
        try {
          setter?.call({}, failure);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(trapCalls).toBe(0);
        if (mode === "throw") {
          let assignmentFailure: unknown;
          try {
            Reflect.set(namespace, "setting", 456);
          } catch (error) {
            assignmentFailure = error;
          }
          expect(assignmentFailure).toBe(trapFailure);
        } else {
          expect(Reflect.set(namespace, "setting", 456)).toBe(mode !== "false");
        }
        expect(trapCalls).toBe(1);
        expect(calls.map(({ value }) => value)).toEqual(mode === "pass" ? [123, 456] : [123]);
        expect(reads).not.toHaveBeenCalled();
        expect(logger.warnings).toEqual([]);
        await core.close();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
        await core.close();
      }
    });

    it("retains the captured setter and its private-field receiver after property replacement", async () => {
      const result = { accepted: true };
      class Resource {
        #stored = 0;
        assign(value: number) {
          this.#stored = value;
          return result;
        }
        stored() {
          return this.#stored;
        }
      }
      const resource = new Resource();
      Object.defineProperty(resource, "setting", {
        configurable: true,
        set: Resource.prototype.assign,
      });
      const { core, namespace } = namespaceFixture(
        { provider: "openai", path },
        {},
        "allow",
        (target) => Object.defineProperties(resource, Object.getOwnPropertyDescriptors(target)),
      );
      const setter = Object.getOwnPropertyDescriptor(namespace, "setting")?.set;
      Object.defineProperty(resource, "setting", { value: "replaced", configurable: true });
      try {
        expect(setter?.call({}, 123)).toBe(result);
        expect(resource.stored()).toBe(123);
        expect(Object.getOwnPropertyDescriptor(resource, "setting")?.value).toBe("replaced");
      } finally {
        await core.close();
      }
    });
  });

  it.each([
    "",
    "future",
  ])("preserves root/generic fixed accessor controls at '%s'", async (path) => {
    const fields = Object.defineProperty({}, "inert", {
      configurable: false,
      enumerable: true,
      get: undefined,
      set: undefined,
    });
    Object.defineProperty(fields, "active", {
      configurable: false,
      get() {
        throw new Error("getter evaluated");
      },
      set(_value: unknown) {
        throw new Error("setter invoked");
      },
    });
    const { core, namespace, logger, fetchMock } = namespaceFixture(
      { provider: "openai", path },
      fields,
      path === "" ? "raise" : "allow",
    );
    const reads = vi.spyOn(core, "resolveSurfaceRead");
    try {
      expect(Object.getOwnPropertyDescriptor(namespace, "inert")).toEqual({
        configurable: path === "",
        enumerable: true,
        get: undefined,
        set: undefined,
      });
      if (path === "") {
        const active = Object.getOwnPropertyDescriptor(namespace, "active");
        expect(active?.configurable).toBe(true);
        expect(active?.get).toBeTypeOf("function");
        expect(active?.set).toBeTypeOf("function");
      } else {
        expect(() => Object.getOwnPropertyDescriptor(namespace, "active")).toThrow(SolwynError);
      }
      expect(reads).not.toHaveBeenCalled();
      expect(logger.warnings).toEqual([]);
      await core.close();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      await core.close();
    }
  });

  it.each([
    "set",
    "deleteProperty",
    "defineProperty",
    "reflected setter",
  ] as const)("%s refreshes the deferred Responses stream target without replacing its wrapper", async (operation) => {
    let streamMethod = function (this: unknown) {
      return { receiver: this, version: "original" };
    };
    const failure = new Error("stream setter failed");
    const result = { accepted: true };
    const failedMethod = function (this: unknown) {
      return { receiver: this, version: "failed" };
    };
    const fields = Object.defineProperty({}, "stream", {
      configurable: true,
      get: () => streamMethod,
      set(value: typeof streamMethod) {
        streamMethod = value;
        if (value === failedMethod) throw failure;
        return result;
      },
    });
    const { core, target, namespace } = namespaceFixture(
      { provider: "openai", path: "responses" },
      fields,
      "raise",
    );
    const replacement = function (this: unknown) {
      return { receiver: this, version: "replacement" };
    };
    Object.setPrototypeOf(target, { stream: replacement });
    const stream = namespace["stream"] as (options: object) => unknown;
    try {
      expect(stream({ response_id: "resp_existing" })).toEqual({
        receiver: target,
        version: "original",
      });
      const mutations = {
        set: () => Reflect.set(namespace, "stream", replacement),
        deleteProperty: () => Reflect.deleteProperty(namespace, "stream"),
        defineProperty: () =>
          Reflect.defineProperty(namespace, "stream", {
            value: replacement,
            configurable: true,
          }),
        "reflected setter": () => {
          const descriptor = Reflect.getOwnPropertyDescriptor(namespace, "stream");
          expect(descriptor?.set).toBeTypeOf("function");
          Object.defineProperty(target, "stream", {
            set() {
              throw new Error("replacement setter must not be called");
            },
          });
          let caught: unknown;
          try {
            descriptor?.set?.call({}, failedMethod);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(failure);
          expect(namespace["stream"]).toBe(stream);
          expect(stream({ response_id: "resp_existing" })).toEqual({
            receiver: target,
            version: "original",
          });
          expect(descriptor?.set?.call({}, replacement)).toBe(result);
          return true;
        },
      };
      expect(mutations[operation]()).toBe(true);
      expect(namespace["stream"]).toBe(stream);
      expect(stream({ response_id: "resp_existing" })).toEqual({
        receiver: target,
        version: "replacement",
      });
    } finally {
      await core.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Interception.
// ---------------------------------------------------------------------------

describe("proxies — interception", () => {
  it("intercepts chat.completions.create (routes through the pipeline, not raw passthrough)", async () => {
    const rawKwargs = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }));
    const client = { chat: { completions: { create } } };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create(rawKwargs);
    await solwyn.close();

    // Interception side effect: a metadata event was produced (raw passthrough wouldn't).
    expect(ingested).toHaveLength(1);
    // The provider receives a SHAPED copy, not the caller's exact object.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).not.toBe(rawKwargs);
  });

  it("intercepts responses.create", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { input_tokens: 4, output_tokens: 6 },
    }));
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create },
    };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.responses.create({ model: "gpt-4o", input: "hi" });
    await solwyn.close();

    expect(create).toHaveBeenCalledTimes(1);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["status"]).toBe("success");
  });

  it("intercepts responses.parse with stable identity and copied Solwyn-owned request controls", async () => {
    const parse = vi.fn((..._args: unknown[]) => ({
      usage: { input_tokens: 2, output_tokens: 3 },
    }));
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: () => ({}), parse },
    };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const first = solwyn.responses.parse;
    const options = { headers: { "x-test": "1" }, timeout: 123 };

    await first({ model: "gpt-4o", input: "hi" }, options);
    await solwyn.close();

    expect(solwyn.responses.parse).toBe(first);
    expect(parse.mock.calls[0]?.[1]).not.toBe(options);
    expect(parse.mock.calls[0]?.[1]).toEqual({
      headers: options.headers,
      timeout: 600_000,
      maxRetries: 0,
    });
    expect((parse.mock.calls[0]?.[1] as typeof options).headers).toBe(options.headers);
    expect(options).toEqual({ headers: { "x-test": "1" }, timeout: 123 });
    expect(ingested).toHaveLength(1);
  });

  it.each([
    null,
    "",
    0,
    false,
    undefined,
  ])("passes existing responses.stream response_id=%j through verbatim without posture warning", async (responseId) => {
    const rawResult = { raw: true };
    const stream = vi.fn((..._args: unknown[]) => rawResult);
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: () => ({}), stream },
    };
    const { fetchMock } = makeFetch();
    const logger = fakeLogger();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger,
      defaultParams: { model: "must-not-merge", input: "must-not-merge" },
    });
    const params = { response_id: responseId };
    const options = { headers: { x: "1" } };

    const result = solwyn.responses.stream(params, options);

    expect(result).toBe(rawResult);
    expect(stream).toHaveBeenCalledWith(params, options);
    expect(stream.mock.calls[0]?.[0]).toBe(params);
    expect(stream.mock.calls[0]?.[1]).toBe(options);
    expect(logger.warnings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("treats a falsey starting_after own key as an existing-response raw stream selector", async () => {
    const stream = vi.fn((..._args: unknown[]) => "raw");
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: () => ({}), stream },
    };
    const { fetchMock } = makeFetch();
    const logger = fakeLogger();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock, logger });
    const params = { starting_after: false };

    expect(solwyn.responses.stream(params)).toBe("raw");
    expect(stream).toHaveBeenCalledWith(params);
    expect(logger.warnings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it.each([
    "response_id",
    "starting_after",
  ] as const)("treats an inherited %s key as an existing-response raw stream selector", async (selector) => {
    const rawResult = { raw: true };
    const stream = vi.fn((..._args: unknown[]) => rawResult);
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: () => ({}), stream },
    };
    const { fetchMock } = makeFetch();
    const logger = fakeLogger();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger,
      onUnmetered: "raise",
    });
    const params = Object.create({ [selector]: null }) as Record<string, unknown>;

    expect(solwyn.responses.stream(params)).toBe(rawResult);
    expect(stream).toHaveBeenCalledWith(params);
    expect(stream.mock.calls[0]?.[0]).toBe(params);
    expect(logger.warnings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it.each([
    { posture: "warn" as const, warnings: 1 },
    { posture: "allow" as const, warnings: 0 },
  ])("defers a new metered native responses.stream request under $posture", async ({
    posture,
    warnings,
  }) => {
    const resource = {
      create: () => ({}),
      stream: vi.fn(() => "raw-stream"),
      cancel(this: unknown) {
        return this === resource ? "cancelled" : "rebound";
      },
    };
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: resource,
    };
    const { fetchMock } = makeFetch();
    const logger = fakeLogger();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger,
      onUnmetered: posture,
      reportUntrackedSurfaces: false,
    });

    const params = { model: "gpt-4o" };
    const responses = solwyn.responses as unknown as {
      stream(params: Record<string, unknown>): unknown;
      cancel(): string;
    };
    expect(responses.stream(params)).toHaveProperty("finalResponse", expect.any(Function));
    expect(resource.stream).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(responses.cancel()).toBe("cancelled");
    expect(logger.warnings).toHaveLength(warnings);
    if (warnings > 0) {
      expect(logger.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("responses.cancel")]),
      );
    }
    await solwyn.close();
  });

  it("defers a new native responses.stream request without I/O in strict posture", async () => {
    const stream = vi.fn(() => "raw-stream");
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: () => ({}), stream },
    };
    const { fetchMock } = makeFetch();
    const logger = fakeLogger();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      logger,
      onUnmetered: "raise",
    });

    const responses = solwyn.responses as unknown as {
      stream(params: Record<string, unknown>): unknown;
    };
    expect(responses.stream({ model: "gpt-4o" })).toHaveProperty("done", expect.any(Function));
    expect(stream).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("logs a guarded Responses raw leaf only once per process", async () => {
    __resetUnmeteredSurfaceWarnings();
    const logger = fakeLogger();
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: () => ({}), cancel: () => "cancelled" },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock, logger });

    void (solwyn.responses as unknown as { cancel(): string }).cancel;
    void (solwyn.responses as unknown as { cancel(): string }).cancel;
    await vi.waitFor(() => expect(logger.warnings).toHaveLength(1));
    expect(logger.warnings[0]).toContain("responses.cancel");
    await solwyn.close();
  });

  it("preserves a missing native responses namespace instead of synthesizing one", async () => {
    const client = { chat: { completions: { create: () => ({}) } } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    expect((solwyn as unknown as { responses?: unknown }).responses).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await solwyn.close();
  });

  it("intercepts a response-only client when provider is explicitly pinned", async () => {
    const create = vi.fn((..._args: unknown[]) => ({
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const client = { responses: { create } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      provider: "openai",
    });

    await solwyn.responses.create({ model: "gpt-4o", input: "hi" });

    expect(create).toHaveBeenCalledTimes(1);
    await solwyn.close();
  });

  it("copies request options and overwrites provider controls on buffered create (F13)", async () => {
    const create = vi.fn((..._args: unknown[]) => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const client = { chat: { completions: { create } } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const controller = new AbortController();
    const options = { signal: controller.signal, headers: { "x-test": "1" }, timeout: 1234 };
    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }, options);
    await solwyn.close();

    // The wrapped create receives both arguments, with a fresh shallow request-options copy.
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0] as unknown[];
    expect(args).toHaveLength(2);
    expect(args[1]).not.toBe(options);
    expect(args[1]).toEqual({
      signal: controller.signal,
      headers: options.headers,
      timeout: 600_000,
      maxRetries: 0,
    });
    expect((args[1] as typeof options).headers).toBe(options.headers);
    expect(options).toEqual({
      signal: controller.signal,
      headers: { "x-test": "1" },
      timeout: 1234,
    });
  });

  it("copies request options and overwrites provider controls on streaming create (F13)", async () => {
    async function* one(): AsyncGenerator<unknown> {
      yield {
        choices: [{ delta: { content: "x" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    }
    const create = vi.fn((..._args: unknown[]) => one());
    const client = { chat: { completions: { create } } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const controller = new AbortController();
    const options = { signal: controller.signal };
    const stream = (await solwyn.chat.completions.create(
      { model: "gpt-4o", messages: [], stream: true },
      options,
    )) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      // drain
    }
    await solwyn.close();

    const args = create.mock.calls[0] as unknown[];
    expect(args).toHaveLength(2);
    expect(args[1]).not.toBe(options);
    expect(args[1]).toEqual({ signal: controller.signal, timeout: 600_000, maxRetries: 0 });
    expect(options).toEqual({ signal: controller.signal });
  });

  it("passes non-create attributes on .responses straight through", async () => {
    const client = {
      chat: { completions: { create: () => ({}) } },
      responses: { create: () => ({}), banner: "RESP-BANNER" },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    expect((solwyn as unknown as { responses: { banner: string } }).responses.banner).toBe(
      "RESP-BANNER",
    );
    await solwyn.close();
  });
});

// ---------------------------------------------------------------------------
// Dialect-gated interception surfaces (Anthropic, Google, Bedrock, and compatible APIs).
//
// Clients are plain duck-typed objects (never a real provider SDK). The wiring uses the
// REAL adapter registry, so provider NAME attribution is exercised too (invariant 5).
// ---------------------------------------------------------------------------

/** A budget-deny fetch (for the short-circuit tests): `/budgets/check` returns allowed:false. */
function makeDenyFetch(): { fetchMock: ReturnType<typeof vi.fn<FetchLike>> } {
  const impl: FetchLike = async (url) => {
    if (url.includes("/api/v1/budgets/check")) {
      return new Response(
        JSON.stringify({
          allowed: false,
          remaining_budget: 0,
          reservation_id: null,
          mode: "hard_deny",
          budget_limit: 100,
          current_usage: 150,
          denied_by_period: "monthly",
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetchMock: vi.fn(impl) };
}

describe("proxies — Anthropic messages interception", () => {
  it("intercepts messages.create (routes through the pipeline; provider attributed 'anthropic')", async () => {
    const rawKwargs = { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }] };
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { input_tokens: 3, output_tokens: 4 },
    }));
    const client = { messages: { create } };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await (
      solwyn as unknown as { messages: { create(k: unknown): Promise<unknown> } }
    ).messages.create(rawKwargs);
    await solwyn.close();

    expect(create).toHaveBeenCalledTimes(1);
    // A shaped COPY reaches the provider, not the caller's exact object.
    expect(create.mock.calls[0]?.[0]).not.toBe(rawKwargs);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["provider"]).toBe("anthropic");
  });

  it("short-circuits on a budget deny: BudgetExceededError, underlying create never called", async () => {
    const create = vi.fn(() => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const client = { messages: { create } };
    const { fetchMock } = makeDenyFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await expect(
      (solwyn as unknown as { messages: { create(k: unknown): Promise<unknown> } }).messages.create(
        { model: "claude-3-5-sonnet", messages: [] },
      ),
    ).rejects.toThrow();
    await solwyn.close();

    expect(create).not.toHaveBeenCalled();
  });

  it("passes non-create attributes on .messages straight through", async () => {
    const client = {
      messages: { create: () => ({ usage: {} }), countTokens: () => "COUNTED" },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    expect(
      (solwyn as unknown as { messages: { countTokens(): string } }).messages.countTokens(),
    ).toBe("COUNTED");
    await solwyn.close();
  });
});

describe("proxies — Google models interception", () => {
  describe.each(["raise", "warn", "allow"] as const)("%s optional methods", (posture) => {
    it.each([
      "embedContent",
      "generateImages",
      "generateVideos",
    ])("does not synthesize absent %s or probe an invisible strict method", async (method) => {
      __resetUnmeteredSurfaceWarnings();
      let reads = 0;
      const models = new Proxy(
        { generateContent: vi.fn(), generateContentStream: vi.fn() },
        {
          get(target, property, receiver) {
            if (property === method) reads += 1;
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const { fetchMock } = makeFetch();
      const logger = fakeLogger();
      const wrapped = new Solwyn(
        { models },
        { apiKey: API_KEY, fetch: fetchMock, logger, onUnmetered: posture },
      );
      try {
        if (posture === "raise") {
          expect(() => Reflect.get(wrapped.models, method)).toThrow(UntrackedSpendSurfaceError);
          expect(reads).toBe(0);
        } else {
          expect(Reflect.get(wrapped.models, method)).toBeUndefined();
          expect(reads).toBe(1);
        }
        expect(Reflect.has(wrapped.models, method)).toBe(false);
        expect(Object.getOwnPropertyDescriptor(wrapped.models, method)).toBeUndefined();
        expect(logger.warnings).toEqual([]);
      } finally {
        await wrapped.close();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(
      [
        {
          method: "embedContent",
          model: "gemini-embedding-001",
          modality: "embedding",
          result: { embeddings: [], usageMetadata: { promptTokenCount: 10 } },
        },
        {
          method: "generateImages",
          model: "imagen-3.0-generate-002",
          modality: "image",
          result: { generatedImages: [] },
        },
        {
          method: "generateVideos",
          model: "veo-3.0-generate-preview",
          modality: "video",
          result: { name: "operations/video" },
        },
      ].flatMap((testCase) =>
        ["field", "getter"].map((descriptor) => ({ ...testCase, descriptor })),
      ),
    )("keeps valid $method $descriptor direct/reflected identity and metered dispatch", async ({
      method,
      model,
      modality,
      result,
      descriptor: shape,
    }) => {
      __resetUnmeteredSurfaceWarnings();
      const models: Record<string, unknown> = {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
      };
      const calls: unknown[][] = [];
      models[method] = function (this: unknown, ...args: unknown[]) {
        expect(this).toBe(models);
        calls.push(args);
        return result;
      };
      let getterReads = 0;
      if (shape === "getter") {
        const native = models[method];
        Object.defineProperty(models, method, {
          get() {
            getterReads += 1;
            return native;
          },
        });
      }
      const { fetchMock, checks, ingested } = makeTrackedMediaFetch();
      const logger = fakeLogger();
      const wrapped = new Solwyn(
        { models },
        { apiKey: API_KEY, fetch: fetchMock, logger, onUnmetered: posture },
      );
      const kwargs = {
        model,
        config: { durationSeconds: 2, numberOfImages: 1 },
        contents: "hello",
      };
      const options = { requestMarker: true };
      try {
        if (shape === "getter" && posture === "raise") {
          expect(() => Reflect.get(wrapped.models, method)).toThrow(UntrackedSpendSurfaceError);
          expect(getterReads).toBe(0);
          expect(calls).toEqual([]);
          expect(fetchMock).not.toHaveBeenCalled();
          expect(logger.warnings).toEqual([]);
          return;
        }
        const direct = Reflect.get(wrapped.models, method);
        const descriptor = Object.getOwnPropertyDescriptor(wrapped.models, method);
        const reflected =
          descriptor && "value" in descriptor
            ? descriptor.value
            : descriptor?.get?.call(wrapped.models);
        expect(reflected).toBe(direct);
        expect(Reflect.get(wrapped.models, method)).toBe(direct);
        expect(calls).toEqual([]);
        if (typeof direct !== "function") {
          throw new TypeError("Expected a callable optional method interceptor");
        }
        await expect(direct(kwargs, options)).resolves.toBe(result);
      } finally {
        await wrapped.close();
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(2);
      expect(calls[0]?.[0]).toMatchObject(kwargs);
      // Admission snapshots native request options before awaiting control-plane work.
      expect(calls[0]?.[1]).toStrictEqual(options);
      expect(calls[0]?.[1]).not.toBe(options);
      expect(kwargs.config).toEqual({ durationSeconds: 2, numberOfImages: 1 });
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ provider: "google", model });
      expect(ingested).toHaveLength(1);
      expect(ingested[0]).toMatchObject({ provider: "google", modality, model });
      expect(logger.warnings).toHaveLength(shape === "getter" && posture === "warn" ? 1 : 0);
    });
  });

  it("does not inspect unrelated optional media getters during ordinary generation", async () => {
    let optionalReads = 0;
    const models = {
      generateContent: vi.fn(() => ({
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      })),
      generateContentStream: vi.fn(),
      get generateVideos(): never {
        optionalReads += 1;
        throw new Error("optional method getter must stay untouched");
      },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn({ models }, { apiKey: API_KEY, fetch: fetchMock });
    const generateContent = (
      solwyn as unknown as { models: { generateContent(value: unknown): Promise<unknown> } }
    ).models.generateContent;

    expect(optionalReads).toBe(0);
    await generateContent({ model: "gemini-2.0-flash", contents: "hi" });
    expect(optionalReads).toBe(0);
    await solwyn.close();
  });

  it("starts intercepting an optional media method when it becomes callable", async () => {
    const models: Record<string, unknown> = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
    };
    const { fetchMock, checks, ingested } = makeTrackedMediaFetch();
    const solwyn = new Solwyn(
      { models },
      {
        apiKey: API_KEY,
        fetch: fetchMock,
        tags: { configured: "config" },
        logger: fakeLogger(),
      },
    );
    const wrappedModels = (solwyn as unknown as { models: Record<string, unknown> }).models;

    expect(wrappedModels["embedContent"]).toBeUndefined();
    const native = vi.fn(function (this: unknown, _kwargs: Record<string, unknown>) {
      expect(this).toBe(models);
      return { embeddings: [], usageMetadata: { promptTokenCount: 10 } };
    });
    let nativeReads = 0;
    Object.defineProperty(models, "embedContent", {
      configurable: true,
      get() {
        nativeReads += 1;
        expect(this).toBe(models);
        return native;
      },
    });

    const intercepted = wrappedModels["embedContent"];
    expect(intercepted).toBe(wrappedModels["embedContent"]);
    expect(nativeReads).toBe(2);
    await (intercepted as (value: Record<string, unknown>) => Promise<unknown>)({
      model: "gemini-embedding-001",
      contents: "x".repeat(40),
      solwyn_tags: { boundary: "google" },
    });
    await solwyn.close();

    expect(native).toHaveBeenCalledTimes(1);
    expect(checks[0]?.["tags"]).toEqual({ boundary: "google", configured: "config" });
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      modality: "embedding",
      tags: { boundary: "google", configured: "config" },
    });
    expect(native.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
  });

  it("stops intercepting when an optional media method becomes absent or noncallable", async () => {
    const models: Record<string, unknown> = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn(),
    };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(
      { models },
      { apiKey: API_KEY, fetch: fetchMock, logger: fakeLogger() },
    );
    const wrappedModels = (solwyn as unknown as { models: Record<string, unknown> }).models;
    const intercepted = wrappedModels["embedContent"];

    expect(intercepted).toBe(wrappedModels["embedContent"]);
    models["embedContent"] = undefined;
    expect(wrappedModels["embedContent"]).toBeUndefined();
    expect(() => (wrappedModels["embedContent"] as () => unknown)()).toThrow(TypeError);
    models["embedContent"] = "not-callable";
    expect(wrappedModels["embedContent"]).toBe("not-callable");
    expect(() => (wrappedModels["embedContent"] as () => unknown)()).toThrow(TypeError);

    await solwyn.close();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.every(([url]) => url.endsWith("/api/v1/untracked-surfaces"))).toBe(
      true,
    );
    expect(ingested).toEqual([]);
  });

  it("does not synthesize missing or noncallable optional media methods", async () => {
    const models = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
    };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn({ models }, { apiKey: API_KEY, fetch: fetchMock });
    const wrappedModels = (solwyn as unknown as { models: Record<string, unknown> }).models;

    expect(wrappedModels["embedContent"]).toBeUndefined();
    expect(wrappedModels["generateImages"]).toBeUndefined();
    expect(wrappedModels["generateVideos"]).toBeUndefined();
    expect("embedContent" in wrappedModels).toBe(false);
    expect("generateImages" in wrappedModels).toBe(false);
    expect("generateVideos" in wrappedModels).toBe(false);
    expect(() => (wrappedModels["embedContent"] as () => unknown)()).toThrow(TypeError);

    const noncallable = new Solwyn(
      {
        models: {
          generateContent: vi.fn(),
          generateContentStream: vi.fn(),
          generateVideos: "not-callable",
        },
      },
      { apiKey: API_KEY, fetch: fetchMock, logger: fakeLogger() },
    );
    const noncallableModels = (noncallable as unknown as { models: Record<string, unknown> })
      .models;
    expect(noncallableModels["generateVideos"]).toBe("not-callable");
    expect(() => (noncallableModels["generateVideos"] as () => unknown)()).toThrow(TypeError);

    await solwyn.close();
    await noncallable.close();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.every(([url]) => url.endsWith("/api/v1/untracked-surfaces"))).toBe(
      true,
    );
    expect(ingested).toEqual([]);
  });

  it("intercepts models.generateContent (provider attributed 'google')", async () => {
    const generateContent = vi.fn(() => ({
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 },
    }));
    const generateContentStream = vi.fn();
    const client = { models: { generateContent, generateContentStream } };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await (
      solwyn as unknown as { models: { generateContent(k: unknown): Promise<unknown> } }
    ).models.generateContent({ model: "gemini-2.0-flash", contents: "hi" });
    await solwyn.close();

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContentStream).not.toHaveBeenCalled();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["provider"]).toBe("google");
  });

  it("dispatches generateContentStream to the streaming method, never generateContent", async () => {
    async function* googleStream(): AsyncGenerator<unknown> {
      yield { candidates: [{ content: { parts: [{ text: "he" }] } }] };
      yield {
        candidates: [{ content: { parts: [{ text: "llo" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
      };
    }
    const generateContent = vi.fn();
    const generateContentStream = vi.fn(() => googleStream());
    const client = { models: { generateContent, generateContentStream } };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const stream = (await (
      solwyn as unknown as {
        models: { generateContentStream(k: unknown): Promise<AsyncIterable<unknown>> };
      }
    ).models.generateContentStream({
      model: "gemini-2.0-flash",
      contents: "hi",
    })) as AsyncIterable<unknown>;
    let count = 0;
    for await (const _chunk of stream) {
      count += 1;
    }
    await solwyn.close();

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(generateContent).not.toHaveBeenCalled();
    expect(count).toBe(2);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["output_tokens"]).toBe(7);
  });

  it("passes non-generate attributes on .models straight through", async () => {
    const client = {
      models: {
        generateContent: () => ({ usageMetadata: {} }),
        generateContentStream: () => ({}),
        list: () => "MODELS-LIST",
      },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    expect((solwyn as unknown as { models: { list(): string } }).models.list()).toBe("MODELS-LIST");
    await solwyn.close();
  });
});

// AWS SDK v3-shaped command classes: plain, AWS-import-free, named exactly like the real
// commands so the proxy's constructor-name classification recognizes them. Dispatch is
// `client.send(command)` — the v3 client has no `.converse()`/`.converse_stream()` methods.
class ConverseCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}
class ConverseStreamCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}
class InvokeModelCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}
class InvokeModelWithResponseStreamCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}
class ListFoundationModelsCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

class BedrockRuntimeClient {
  readonly meta = {
    service_model: { service_name: "bedrock-runtime" },
    region_name: "us-east-1",
  };

  constructor(readonly send: ReturnType<typeof vi.fn>) {}
}

/** Count fetch calls that hit the budget-check endpoint (fail-loud must never spend). */
function budgetCheckCalls(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): unknown[] {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/v1/budgets/check"));
}

describe("proxies — Bedrock send(command) interception (AWS SDK v3)", () => {
  /** A v3-shaped `bedrock-runtime` client: dispatch via `send`, region via `meta`. */
  function bedrockClient(send: ReturnType<typeof vi.fn>) {
    return new BedrockRuntimeClient(send);
  }

  it("intercepts a ConverseCommand via send (provider 'bedrock', region rides the event, raw response returned, original command untouched)", async () => {
    const rawResponse = { usage: { inputTokens: 10, outputTokens: 5 }, output: { message: {} } };
    const command = new ConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
    });
    const send = vi.fn((_command: unknown) => rawResponse);
    const client = bedrockClient(send);
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const result = await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(
      command,
    );
    await solwyn.close();

    expect(result).toBe(rawResponse); // drop-in: identical raw Converse response
    expect(send).toHaveBeenCalledTimes(1);
    // The customer's ORIGINAL command instance is dispatched untouched (no reconstruction).
    expect(send.mock.calls[0]?.[0]).toBe(command);
    expect(command.input["modelId"]).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["provider"]).toBe("bedrock");
    expect(ingested[0]?.["provider_region"]).toBe("us-east-1");
    expect(ingested[0]?.["input_tokens"]).toBe(10);
  });

  it("rebuilds Bedrock defaults without forwarding reserved caller or default tags", async () => {
    const command = new ConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      solwyn_tags: { caller: "call" },
    });
    const defaults = {
      inferenceConfig: { maxTokens: 12 },
      solwyn_tags: { global: "default" },
    };
    const send = vi.fn((_command: unknown) => ({
      usage: { inputTokens: 1, outputTokens: 1 },
      output: { message: {} },
    }));
    const client = bedrockClient(send);
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      defaultParams: defaults,
    });

    await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(command);
    await solwyn.close();

    const rebuilt = send.mock.calls[0]?.[0] as ConverseCommand;
    expect(rebuilt).not.toBe(command);
    expect(rebuilt.input).toMatchObject({ inferenceConfig: { maxTokens: 12 } });
    expect(rebuilt.input).not.toHaveProperty("solwyn_tags");
    expect(command.input).toMatchObject({ solwyn_tags: { caller: "call" } });
    expect(defaults).toEqual({
      inferenceConfig: { maxTokens: 12 },
      solwyn_tags: { global: "default" },
    });
  });

  it("rejects an invalid non-enumerable Bedrock tag before budget or provider I/O without changing input", async () => {
    const input: Record<string, unknown> = {
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
    };
    Object.defineProperty(input, "solwyn_tags", {
      value: "invalid",
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(input, "solwyn_tags");
    const command = new ConverseCommand(input);
    const send = vi.fn();
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(bedrockClient(send), { apiKey: API_KEY, fetch: fetchMock });

    await expect(
      (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(command),
    ).rejects.toThrow(/solwyn_tags requires a plain record/);

    expect(budgetCheckCalls(fetchMock)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(command.input).toBe(input);
    expect(Object.getOwnPropertyDescriptor(input, "solwyn_tags")).toEqual(descriptor);
    await solwyn.close();
  });

  it("captures an accessor-backed Bedrock tag once for budget and event attribution without changing input", async () => {
    const input: Record<string, unknown> = {
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
    };
    let tagReads = 0;
    Object.defineProperty(input, "solwyn_tags", {
      get: () => {
        tagReads += 1;
        return { customer: "acme" };
      },
      enumerable: true,
      configurable: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(input, "solwyn_tags");
    const command = new ConverseCommand(input);
    const send = vi.fn((_command: unknown) => ({
      usage: { inputTokens: 1, outputTokens: 1 },
      output: { message: {} },
    }));
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(bedrockClient(send), { apiKey: API_KEY, fetch: fetchMock });

    await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(command);
    await solwyn.close();

    const budget = fetchMock.mock.calls
      .map(([, init]) => (typeof init?.body === "string" ? JSON.parse(init.body) : undefined))
      .find((body) => body?.provider === "bedrock") as Record<string, unknown>;
    const sent = send.mock.calls[0]?.[0] as ConverseCommand;
    expect(tagReads).toBe(1);
    expect(budget["tags"]).toEqual({ customer: "acme" });
    expect(ingested[0]?.["tags"]).toEqual({ customer: "acme" });
    expect(sent).not.toBe(command);
    expect(sent.input).not.toHaveProperty("solwyn_tags");
    expect(command.input).toBe(input);
    expect(Object.getOwnPropertyDescriptor(input, "solwyn_tags")).toEqual(descriptor);
  });

  it("rebuilds tagged shape-classified plain and null-prototype commands without clobbering user fields", async () => {
    const makeInput = (): Record<string, unknown> => ({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      unrelatedInput: { survives: true },
      __solwyn_bedrock_input_snapshot: "user-input-key",
      solwyn_tags: { customer: "acme" },
    });
    const ordinaryInput = makeInput();
    const ordinary = {
      input: ordinaryInput,
      unrelatedCommand: { survives: true },
      __solwyn_bedrock_input_snapshot: "user-command-key",
    };
    const nullInput = makeInput();
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(nullPrototype, {
      input: {
        value: nullInput,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      unrelatedCommand: {
        value: { survives: "also" },
        enumerable: true,
        configurable: true,
        writable: true,
      },
      __solwyn_bedrock_input_snapshot: {
        value: "user-null-command-key",
        enumerable: true,
        configurable: true,
        writable: true,
      },
    });
    const cases = [
      { command: ordinary as unknown, input: ordinaryInput, prototype: Object.prototype },
      { command: nullPrototype as unknown, input: nullInput, prototype: null },
    ];

    for (const { command, input, prototype } of cases) {
      const commandDescriptors = Object.getOwnPropertyDescriptors(command as object);
      const inputDescriptors = Object.getOwnPropertyDescriptors(input);
      const send = vi.fn((_command: unknown) => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        output: { message: {} },
      }));
      const { fetchMock } = makeFetch();
      const solwyn = new Solwyn(bedrockClient(send), { apiKey: API_KEY, fetch: fetchMock });

      await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(command);
      await solwyn.close();

      const sibling = send.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sibling).not.toBe(command);
      expect(Object.getPrototypeOf(sibling)).toBe(prototype);
      expect(sibling["unrelatedCommand"]).toEqual(
        (command as Record<string, unknown>)["unrelatedCommand"],
      );
      expect(sibling["__solwyn_bedrock_input_snapshot"]).toBe(
        (command as Record<string, unknown>)["__solwyn_bedrock_input_snapshot"],
      );
      expect(sibling["input"]).toMatchObject({
        modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        messages: [],
        unrelatedInput: { survives: true },
        __solwyn_bedrock_input_snapshot: "user-input-key",
      });
      expect(sibling["input"]).not.toHaveProperty("solwyn_tags");
      expect(Object.getOwnPropertyDescriptors(command as object)).toEqual(commandDescriptors);
      expect(Object.getOwnPropertyDescriptors(input)).toEqual(inputDescriptors);
      expect((command as Record<string, unknown>)["input"]).toBe(input);
      expect(budgetCheckCalls(fetchMock)).toHaveLength(1);
    }
  });

  it("rebuilds a tagged Converse subclass through its constructor to preserve private state", async () => {
    class BrandedConverseCommand extends ConverseCommand {
      #trace = "constructor-brand";

      trace(): string {
        return this.#trace;
      }
    }
    const command = new BrandedConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      solwyn_tags: { customer: "acme" },
    });
    const send = vi.fn((candidate: unknown) => ({
      usage: { inputTokens: 1, outputTokens: 1 },
      output: { message: {} },
      trace: (candidate as BrandedConverseCommand).trace(),
    }));
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(bedrockClient(send), { apiKey: API_KEY, fetch: fetchMock });

    const result = await (
      solwyn as unknown as { send(c: unknown): Promise<{ trace: string }> }
    ).send(command);
    await solwyn.close();

    expect(result.trace).toBe("constructor-brand");
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(BrandedConverseCommand);
    expect(send.mock.calls[0]?.[0]).not.toBe(command);
    expect((send.mock.calls[0]?.[0] as BrandedConverseCommand).input).not.toHaveProperty(
      "solwyn_tags",
    );
    expect(command.input).toMatchObject({ solwyn_tags: { customer: "acme" } });
  });

  it("intercepts a ConverseStreamCommand via send and settles from the terminal metadata event", async () => {
    async function* eventStream(): AsyncGenerator<unknown> {
      yield { messageStart: { role: "assistant" } };
      yield { contentBlockDelta: { delta: {}, contentBlockIndex: 0 } };
      yield { metadata: { usage: { inputTokens: 12, outputTokens: 8 } } };
    }
    const command = new ConverseStreamCommand({
      modelId: "meta.llama3-1-70b-instruct-v1:0",
      messages: [],
    });
    // v3 ConverseStream output exposes its events as an async-iterable `.stream` property.
    const send = vi.fn((_command: unknown) => ({ stream: eventStream() }));
    const client = bedrockClient(send);
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const result = (await (
      solwyn as unknown as {
        send(c: unknown): Promise<{ stream: AsyncIterable<unknown> }>;
      }
    ).send(command)) as { stream: AsyncIterable<unknown> };
    let count = 0;
    for await (const _event of result.stream) {
      count += 1;
    }
    await solwyn.close();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(command);
    expect(count).toBe(3);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["input_tokens"]).toBe(12);
    expect(ingested[0]?.["output_tokens"]).toBe(8);
  });

  it("throws (before any dispatch) when a ConverseCommand carries no modelId", async () => {
    const send = vi.fn();
    const client = bedrockClient(send);
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await expect(
      (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(
        new ConverseCommand({ messages: [] }),
      ),
    ).rejects.toThrow(/modelId/);
    await solwyn.close();

    expect(send).not.toHaveBeenCalled();
  });

  it("fails loud on InvokeModelCommand / InvokeModelWithResponseStreamCommand (never dispatches, never budget-checks)", async () => {
    const send = vi.fn();
    const client = bedrockClient(send);
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const s = solwyn as unknown as { send(c: unknown): Promise<unknown> };

    await expect(s.send(new InvokeModelCommand({ modelId: "x", body: "{}" }))).rejects.toThrow(
      /Converse/,
    );
    await expect(
      s.send(new InvokeModelWithResponseStreamCommand({ modelId: "x" })),
    ).rejects.toThrow(/Converse/);
    await solwyn.close();

    expect(send).not.toHaveBeenCalled();
    // Fail-loud is BEFORE spend: no budget check ever left the client for these commands.
    expect(budgetCheckCalls(fetchMock)).toHaveLength(0);
  });

  it("passes a non-Converse command straight through to the wrapped client's send (full-surface passthrough)", async () => {
    const passthroughResult = { modelSummaries: [] };
    const send = vi.fn((_command: unknown) => passthroughResult);
    const client = bedrockClient(send);
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const command = new ListFoundationModelsCommand({ byProvider: "anthropic" });
    const result = await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(
      command,
    );
    await solwyn.close();

    expect(result).toBe(passthroughResult);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(command);
    // Not intercepted: no metadata event and no budget check.
    expect(ingested).toHaveLength(0);
    expect(budgetCheckCalls(fetchMock)).toHaveLength(0);
  });

  it("uses the current provider send after replacement, deletion, and redefinition", async () => {
    const original = vi.fn(() => ({ source: "original" }));
    const replacement = vi.fn(() => ({ source: "replacement" }));
    const redefined = vi.fn(() => ({ source: "redefined" }));
    const client = bedrockClient(original);
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    const wrapper = solwyn as unknown as {
      send(command: unknown): Promise<unknown>;
    };
    const command = new ListFoundationModelsCommand({ byProvider: "anthropic" });

    expect(Reflect.set(wrapper, "send", replacement)).toBe(true);
    await expect(wrapper.send(command)).resolves.toEqual({ source: "replacement" });
    expect(original).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();

    expect(Reflect.deleteProperty(wrapper, "send")).toBe(true);
    await expect(wrapper.send(command)).rejects.toThrow(/does not expose send/);
    expect(replacement).toHaveBeenCalledOnce();

    expect(
      Reflect.defineProperty(wrapper, "send", {
        configurable: true,
        enumerable: true,
        value: redefined,
        writable: true,
      }),
    ).toBe(true);
    await expect(wrapper.send(command)).resolves.toEqual({ source: "redefined" });
    expect(redefined).toHaveBeenCalledOnce();
    expect(ingested).toHaveLength(0);
    await solwyn.close();
  });

  // Robust command classification for subclasses, minified shapes, and untracked commands.

  it("intercepts a SUBCLASS of ConverseCommand via the prototype-chain name walk", async () => {
    // An instrumentation wrapper subclasses the real command; its own constructor.name differs,
    // but the base 'ConverseCommand' is still in its prototype chain.
    class TracedConverseCommand extends ConverseCommand {}
    const rawResponse = { usage: { inputTokens: 4, outputTokens: 2 } };
    const send = vi.fn((_command: unknown) => rawResponse);
    const client = bedrockClient(send);
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const command = new TracedConverseCommand({ modelId: "anthropic.claude-x", messages: [] });
    const result = await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(
      command,
    );
    await solwyn.close();

    expect(result).toBe(rawResponse);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["provider"]).toBe("bedrock");
    expect(ingested[0]?.["input_tokens"]).toBe(4);
  });

  it("classifies a name-mangled (minified) Converse-shaped command by input SHAPE, with a warning", async () => {
    // A plain object with the Converse input shape but no recognizable constructor name (the
    // esbuild/terser-minified case): classified 'converse' by shape and metered, not bypassed.
    const rawResponse = { usage: { inputTokens: 9, outputTokens: 3 } };
    const send = vi.fn((_command: unknown) => rawResponse);
    const client = bedrockClient(send);
    const logger = fakeLogger();
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock, logger });

    const command = { input: { modelId: "anthropic.claude-x", messages: [] } };
    const result = await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(
      command,
    );
    await solwyn.close();

    expect(result).toBe(rawResponse);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["provider"]).toBe("bedrock");
    expect(ingested[0]?.["input_tokens"]).toBe(9);
    // Shape classification can't tell streaming from buffered — it warns (never silent).
    expect(logger.warnings.some((w) => w.includes("input shape"))).toBe(true);
  });

  it("fails loud on a name-mangled InvokeModel-shaped command (raw body) by input SHAPE", async () => {
    const send = vi.fn();
    const client = bedrockClient(send);
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    // modelId + raw `body` and no Converse-structured input ⇒ InvokeModel-family ⇒ fail loud.
    const command = {
      input: { modelId: "anthropic.claude-x", body: "{}", contentType: "application/json" },
    };
    await expect(
      (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(command),
    ).rejects.toThrow(/Converse/);
    await solwyn.close();

    expect(send).not.toHaveBeenCalled();
    expect(budgetCheckCalls(fetchMock)).toHaveLength(0);
  });

  it("warns when an unrecognized command carrying input.modelId passes through UNTRACKED", async () => {
    const passthroughResult = { ok: true };
    const send = vi.fn((_command: unknown) => passthroughResult);
    const client = bedrockClient(send);
    const logger = fakeLogger();
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock, logger });

    // modelId present but neither Converse- nor InvokeModel-shaped, and no known name ⇒ 'other'.
    const command = { input: { modelId: "anthropic.claude-x" } };
    const result = await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(
      command,
    );
    await solwyn.close();

    expect(result).toBe(passthroughResult); // still passes through (drop-in)
    expect(send).toHaveBeenCalledTimes(1);
    expect(ingested).toHaveLength(0); // untracked
    expect(logger.warnings.some((w) => w.includes("UNTRACKED"))).toBe(true);
  });

  // A stray `stream` on a ConverseCommand must not drive the streaming path.

  it("runs a ConverseCommand carrying input.stream=true on the BUFFERED pipeline (stream stripped)", async () => {
    const rawResponse = { usage: { inputTokens: 10, outputTokens: 5 }, output: { message: {} } };
    const send = vi.fn((_command: unknown) => rawResponse);
    const client = bedrockClient(send);
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    // A plausible leftover `stream: true` from OpenAI-style code — command TYPE is buffered.
    const command = new ConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [],
      stream: true,
    });
    const result = await (solwyn as unknown as { send(c: unknown): Promise<unknown> }).send(
      command,
    );
    await solwyn.close();

    // Buffered dispatch: the raw response is returned (never routed through the stream pipeline).
    expect(result).toBe(rawResponse);
    expect(send).toHaveBeenCalledTimes(1);
    // The customer's original command reaches the wire untouched (stray stream key intact on it).
    expect(send.mock.calls[0]?.[0]).toBe(command);
    expect(command.input["stream"]).toBe(true);
    // A metered success, not a discarded/errored paid call.
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["status"]).toBe("success");
    expect(ingested[0]?.["input_tokens"]).toBe(10);
    expect(ingested[0]?.["output_tokens"]).toBe(5);
  });

  // Callback-style send(command, cb) must fail loudly before spend.

  it("fails loud EARLY on callback-style send(command, cb) for an intercepted Converse command", async () => {
    const send = vi.fn((_command: unknown) => ({ usage: { inputTokens: 1, outputTokens: 1 } }));
    const client = bedrockClient(send);
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const command = new ConverseCommand({ modelId: "anthropic.claude-x", messages: [] });
    await expect(
      (solwyn as unknown as { send(c: unknown, cb: unknown): Promise<unknown> }).send(
        command,
        () => {},
      ),
    ).rejects.toThrow(/Promise/);
    await solwyn.close();

    // Fail-loud is BEFORE spend: neither the provider nor the budget API was ever called.
    expect(send).not.toHaveBeenCalled();
    expect(budgetCheckCalls(fetchMock)).toHaveLength(0);
  });

  it("fails loud on callback-style send(command, options, cb) for an intercepted ConverseStream command", async () => {
    const send = vi.fn();
    const client = bedrockClient(send);
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const command = new ConverseStreamCommand({ modelId: "anthropic.claude-x", messages: [] });
    await expect(
      (solwyn as unknown as { send(c: unknown, o: unknown, cb: unknown): Promise<unknown> }).send(
        command,
        { abortSignal: undefined },
        () => {},
      ),
    ).rejects.toThrow(/Promise/);
    await solwyn.close();

    expect(send).not.toHaveBeenCalled();
  });

  it("still forwards a trailing callback for a NON-intercepted command (full passthrough)", async () => {
    const passthroughResult = { modelSummaries: [] };
    const send = vi.fn((..._args: unknown[]) => passthroughResult);
    const client = bedrockClient(send);
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    const command = new ListFoundationModelsCommand({});
    const cb = () => {};
    const result = await (
      solwyn as unknown as { send(c: unknown, cb: unknown): Promise<unknown> }
    ).send(command, cb);
    await solwyn.close();

    expect(result).toBe(passthroughResult);
    expect(send).toHaveBeenCalledTimes(1);
    // The callback is forwarded verbatim on the passthrough path.
    expect(send.mock.calls[0]?.[1]).toBe(cb);
  });

  it("rejects a mangled generic Smithy client synchronously at construction", () => {
    // Generic structural send clients are deliberately undeclared; they must not become a
    // Bedrock runtime merely because they resemble Smithy internals.
    const send = vi.fn((_command: unknown) => ({ usage: { inputTokens: 1, outputTokens: 1 } }));
    const client = {
      send,
      config: { region: "us-east-1" },
      middlewareStack: { add: () => {} },
    };
    const { fetchMock } = makeFetch();
    let constructionError: unknown;
    try {
      new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });
    } catch (error) {
      constructionError = error;
    }
    expect(constructionError).toBeInstanceOf(ConfigurationError);
    expect(constructionError).toMatchObject({ field: "provider" });
    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("proxies — OpenAI-compatible (Groq) interception", () => {
  it("intercepts chat.completions.create with the compat NAME attribution ('groq')", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }));
    const client = {
      chat: { completions: { create } },
      baseURL: "https://api.groq.com/openai/v1",
    };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    await solwyn.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [] });
    await solwyn.close();

    expect(create).toHaveBeenCalledTimes(1);
    expect(ingested).toHaveLength(1);
    // Same-dialect vendor: dialect is openai, but NAME attribution is 'groq' (invariant 5).
    expect(ingested[0]?.["provider"]).toBe("groq");
  });
});

// ---------------------------------------------------------------------------
// probeDialect and registry attribution agree for a multi-surface client.
// ---------------------------------------------------------------------------

describe("proxies — multi-surface client: proxy surface and registry NAME agree (invariant 5)", () => {
  it("a client exposing BOTH chat.completions.create AND messages.create is dialect 'openai' end-to-end", async () => {
    // A gateway/unified wrapper exposing two dialects' surfaces. The registry attributes it
    // 'openai' (chat.completions.create matches first in ADAPTER_REGISTRATION_ORDER), so the
    // proxy must intercept the OpenAI surface (not messages) — otherwise the served NAME and the
    // intercepted surface disagree and Anthropic-shaped kwargs get misdispatched under an
    // 'openai' label.
    const chatCreate = vi.fn((_k: Record<string, unknown>) => ({
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }));
    const messagesCreate = vi.fn((_k: Record<string, unknown>) => ({ id: "raw-messages-result" }));
    const client = {
      chat: { completions: { create: chatCreate } },
      messages: { create: messagesCreate },
    };
    const { fetchMock, ingested } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    // The OpenAI surface is intercepted and attributed 'openai'.
    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    expect(chatCreate).toHaveBeenCalledTimes(1);

    // The messages surface is NOT intercepted (dialect is 'openai') — it passes straight through
    // to the wrapped client uninstrumented and is never misattributed as `openai` on the wire.
    const raw = await (
      solwyn as unknown as { messages: { create(k: unknown): unknown } }
    ).messages.create({ model: "claude-3-5-sonnet", messages: [] });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect((raw as { id: string }).id).toBe("raw-messages-result");

    await solwyn.close();

    // Exactly ONE metered event (the chat call), attributed 'openai' — the messages passthrough
    // produced no wire traffic and no wrong-name attribution.
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.["provider"]).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// Dialect-gated `.chat.<other>` rejection on non-OpenAI clients.
// ---------------------------------------------------------------------------

describe("proxies — chat proxy is OpenAI-dialect-specific (proxies-run.md behavior 9)", () => {
  const syntheticClients = [
    { name: "Anthropic", client: () => ({ messages: { create: () => ({}) } }) },
    {
      name: "Google",
      client: () => ({
        models: { generateContent: () => ({}), generateContentStream: () => ({}) },
      }),
    },
    {
      name: "Bedrock",
      client: () => new BedrockRuntimeClient(vi.fn(() => ({}))),
    },
    {
      name: "OpenAI Responses-only",
      client: () => ({ responses: { create: () => ({}) } }),
      provider: "openai",
    },
    {
      name: "Anthropic with empty chat",
      client: () => ({ messages: { create: () => ({}) }, chat: {} }),
    },
    {
      name: "OpenAI with empty chat",
      client: () => ({ responses: { create: () => ({}) }, chat: {} }),
      provider: "openai",
    },
  ];

  describe.each(["raise", "warn", "allow"] as const)("%s posture", (onUnmetered) => {
    it.each(
      syntheticClients,
    )("exposes the advertised synthetic chat facade for $name without I/O", async ({
      client,
      provider,
    }) => {
      const { fetchMock } = makeFetch();
      const logger = fakeLogger();
      const solwyn = new Solwyn(client(), {
        apiKey: API_KEY,
        provider,
        fetch: fetchMock,
        logger,
        onUnmetered,
      });
      try {
        const report = coverage(solwyn);
        expect(report.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ surface: "chat", kind: "namespace" }),
            expect.objectContaining({ surface: "chat.completions", kind: "namespace" }),
          ]),
        );
        expect(report.entries).toContainEqual(
          expect.objectContaining({ surface: "chat.completions.create", kind: "metered" }),
        );
        const facade = solwyn as unknown as {
          chat: { completions: { create: unknown } };
        };
        const chat = facade.chat;
        const completions = chat.completions;
        expect(typeof completions.create).toBe("function");
        expect(facade.chat).toBe(chat);
        expect(facade.chat.completions).toBe(completions);
        expect(Reflect.get(chat, "then")).toBeUndefined();
        expect(Reflect.get(completions, "then")).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(logger.warnings).toEqual([]);
      } finally {
        await solwyn.close();
      }
      // Closing also flushes advisory reports: synthetic access records none.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warnings).toEqual([]);
    });
  });

  it.each([
    "chat",
    "completions",
  ])("does not evaluate an invisible raw %s lookup when exposing the synthetic facade", async (property) => {
    let evaluations = 0;
    const dynamic = new Proxy(property === "chat" ? { responses: { create: () => ({}) } } : {}, {
      get(target, key, receiver) {
        if (key === property) {
          evaluations += 1;
          throw new Error("raw dynamic namespace must not be evaluated");
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const client =
      property === "chat" ? dynamic : { chat: dynamic, responses: { create: () => ({}) } };
    const { fetchMock } = makeFetch();
    const logger = fakeLogger();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      provider: "openai",
      fetch: fetchMock,
      logger,
      onUnmetered: "raise",
    });
    try {
      const facade = solwyn as unknown as { chat: { completions: { create: unknown } } };
      expect(typeof facade.chat.completions.create).toBe("function");
      expect(evaluations).toBe(0);
    } finally {
      await solwyn.close();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warnings).toEqual([]);
  });

  it.each([
    false,
    true,
  ])("retains cached synthetic namespaces after raw mutation (native chat: %s)", async (nativeChat) => {
    const client = {
      responses: { create: () => ({}) },
      ...(nativeChat ? { chat: { completions: { create: () => ({}) } } } : {}),
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      provider: "openai",
      fetch: fetchMock,
      onUnmetered: "raise",
    });
    try {
      const facade = solwyn as unknown as { chat: { completions: { create: unknown } } };
      const chat = facade.chat;
      const completions = chat.completions;
      const create = completions.create;
      for (const namespace of [facade, chat]) {
        const property = namespace === facade ? "chat" : "completions";
        expect(Reflect.set(namespace, property, {})).toBe(true);
        expect(facade.chat).toBe(chat);
        expect(chat.completions).toBe(completions);
        expect(Reflect.deleteProperty(namespace, property)).toBe(true);
        expect(facade.chat).toBe(chat);
        expect(chat.completions).toBe(completions);
        expect(completions.create).toBe(create);
      }
    } finally {
      await solwyn.close();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "chat",
    "completions",
  ])("still refuses a present but drifted %s namespace under strict posture", async (property) => {
    const client = {
      responses: { create: () => ({}) },
      chat: property === "chat" ? "not a resource" : { completions: "not a resource" },
    };
    const { fetchMock } = makeFetch();
    const logger = fakeLogger();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      provider: "openai",
      fetch: fetchMock,
      logger,
      onUnmetered: "raise",
    });
    try {
      const facade = solwyn as unknown as { chat: { completions: unknown } };
      expect(() => facade.chat.completions).toThrowError(UntrackedSpendSurfaceError);
    } finally {
      await solwyn.close();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warnings).toEqual([]);
  });

  it("throws a guided error on `.chat.<other>` for a non-OpenAI (Anthropic) client", async () => {
    const client = { messages: { create: () => ({ usage: {} }) } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    expect(() => (solwyn as unknown as { chat: { foo: unknown } }).chat.foo).toThrow(
      /'chat\.foo' is not supported.*messages.*models/s,
    );
    await solwyn.close();
  });

  it("still exposes `.chat.completions` on a non-OpenAI client (the synthetic surface)", async () => {
    const client = { messages: { create: () => ({ usage: {} }) } };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    expect(
      (solwyn as unknown as { chat: { completions: unknown } }).chat.completions,
    ).toBeDefined();
    await solwyn.close();
  });

  it("keeps `.chat.<other>` passthrough for an OpenAI-dialect client", async () => {
    const client = {
      chat: { completions: { create: () => ({ usage: {} }) }, banner: "CHAT-BANNER" },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    expect((solwyn as unknown as { chat: { banner: string } }).chat.banner).toBe("CHAT-BANNER");
    await solwyn.close();
  });
});

// ---------------------------------------------------------------------------
// Compatible providers are chat-surface-only; responses.create fails loudly.
// ---------------------------------------------------------------------------

describe("proxies — responses.create on a compat client fails loud (never rewritten to chat)", () => {
  it("raises for a Groq Responses leaf without dispatching to chat.completions", async () => {
    const chatCreate = vi.fn(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const responsesCreate = vi.fn(() => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const client = {
      chat: { completions: { create: chatCreate } },
      responses: { create: responsesCreate },
      baseURL: "https://api.groq.com/openai/v1",
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: fetchMock,
      onUnmetered: "raise",
    });

    expect(() =>
      (
        solwyn as unknown as { responses: { create(k: unknown): Promise<unknown> } }
      ).responses.create({ model: "llama-3.3-70b-versatile", input: "hi" }),
    ).toThrow(UntrackedSpendSurfaceError);
    await solwyn.close();

    // The Responses-shaped call is NEVER silently swapped onto chat.completions.create.
    expect(chatCreate).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// instanceof behavior and stable method identity.
// ---------------------------------------------------------------------------

describe("proxies — instanceof + method identity", () => {
  it("holds `instanceof` against the wrapped client's class (F22)", async () => {
    class FakeOpenAI {
      chat = {
        completions: { create: () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }) },
      };
    }
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(new FakeOpenAI(), { apiKey: API_KEY, fetch: fetchMock });

    // A library gating on `llm instanceof FakeOpenAI` must take the right branch.
    expect(solwyn instanceof FakeOpenAI).toBe(true);
    await solwyn.close();
  });

  it("returns a STABLE function identity across reads for intercepted and passthrough methods (F23)", async () => {
    const client = {
      chat: {
        completions: { create: () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }) },
      },
      embeddings: { create: () => ({}) },
      ping(): string {
        return "pong";
      },
    };
    const { fetchMock } = makeFetch();
    const solwyn = new Solwyn(client, { apiKey: API_KEY, fetch: fetchMock });

    // Intercepted create: same function object on every read.
    const s = solwyn as unknown as {
      chat: { completions: { create: unknown } };
      ping: unknown;
      close: unknown;
    };
    expect(s.chat.completions.create).toBe(s.chat.completions.create);
    // Passthrough method: stable bound identity (memoization, map keys, spies hold).
    expect(s.ping).toBe(s.ping);
    // Core-owned lifecycle method: stable too.
    expect(s.close).toBe(s.close);
    await solwyn.close();
  });
});

// ---------------------------------------------------------------------------
// Type-level: intercepted paths keep the wrapped client's TypeScript types.
// ---------------------------------------------------------------------------

describe("proxies — type preservation (compile-time)", () => {
  it("keeps OpenAI's param types on intercepted paths but honestly narrows the return to a plain Promise (F15)", () => {
    // This closure is intentionally NEVER invoked — it exists purely for the
    // compile-time assertions below (enforced by `tsc --noEmit` over tests/). No
    // OpenAI client is constructed at runtime, so nothing here does real I/O.
    const _typeAssertions = (oa: OpenAI): void => {
      const client = new Solwyn(oa, { apiKey: API_KEY });

      // Parameter types are preserved: an OpenAI-shaped params object still type-checks
      // (drop-in for the request side).
      void client.chat.completions.create({ model: "gpt-4o", messages: [] });
      void client.responses.create({ model: "gpt-4o", input: "hi" });

      // The intercepted return is deliberately a plain Promise, so it
      // does NOT carry OpenAI's APIPromise `.withResponse()` — accessing it must be a
      // COMPILE error, not a runtime crash. The raw OpenAI method still has it.
      expectTypeOf<ReturnType<typeof client.chat.completions.create>>().not.toHaveProperty(
        "withResponse",
      );
      expectTypeOf<ReturnType<typeof oa.chat.completions.create>>().toHaveProperty("withResponse");
      expectTypeOf<ReturnType<typeof client.responses.create>>().not.toHaveProperty("withResponse");
      expectTypeOf<ReturnType<typeof client.responses.parse>>().not.toHaveProperty("withResponse");
      expectTypeOf<ReturnType<typeof oa.responses.parse>>().toHaveProperty("withResponse");

      // A NON-intercepted sub-surface keeps OpenAI's exact type (full passthrough).
      expectTypeOf(client.models).toEqualTypeOf(oa.models);

      // Solwyn adds lifecycle without erasing the wrapped surface.
      expectTypeOf(client.close()).toEqualTypeOf<Promise<void>>();
    };
    void _typeAssertions;

    expect(typeof Solwyn).toBe("function");
  });
});
