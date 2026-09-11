import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { __resetUnmeteredSurfaceWarnings } from "../../src/client";
import {
  ConfigurationError,
  coverage,
  Solwyn,
  type SolwynOptions,
  UntrackedSpendSurfaceError,
} from "../../src/index";
import type { Logger } from "../../src/logging";
import { buildRuntimes } from "../../src/registry";
import { MetadataReporter } from "../../src/reporter";
import type { FetchLike } from "../../src/transport";
import { UntrackedSurfaceReporter } from "../../src/untracked-reporter";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const MODEL = "gpt-4o-mini";
const UNTRACKED_REPORT_PATH = "/api/v1/untracked-surfaces";

const PUBLIC_SURFACE_OPTIONS = {
  apiKey: API_KEY,
  provider: "openai",
  model: MODEL,
  onUnmetered: "warn" as const,
  acknowledgeUntracked: [] as string[],
  reportUntrackedSurfaces: true,
} satisfies SolwynOptions;

interface SurfaceOptionOverrides {
  readonly onUnmetered?: "warn" | "raise" | "allow";
  readonly acknowledgeUntracked?: string[];
  readonly reportUntrackedSurfaces?: boolean;
}

interface WireCall {
  readonly path: string;
  readonly body: unknown;
}

function wireRecorder() {
  const calls: WireCall[] = [];
  const fetch = vi.fn<FetchLike>(async (input, init) => {
    const path = new URL(input).pathname;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ path, body });
    if (path === UNTRACKED_REPORT_PATH) {
      const accepted = Array.isArray(body) ? body.length : 0;
      return new Response(JSON.stringify({ accepted }), { status: 202 });
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  });
  return { calls, fetch };
}

function recordingLogger() {
  const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return { logger, warn };
}

function operationMustNotRun(): never {
  throw new Error("provider operation must not run");
}

function fakeOpenAI() {
  const chatCreate = vi.fn(operationMustNotRun);
  const responsesCreate = vi.fn(operationMustNotRun);
  const responsesParse = vi.fn(operationMustNotRun);
  const responsesStream = vi.fn(operationMustNotRun);
  const embeddingsCreate = vi.fn(operationMustNotRun);
  const imagesGenerate = vi.fn(operationMustNotRun);
  const imagesEdit = vi.fn(operationMustNotRun);
  const transcriptionCreate = vi.fn(operationMustNotRun);
  const speechCreate = vi.fn(operationMustNotRun);
  const videosCreate = vi.fn(operationMustNotRun);
  const retrieve = vi.fn(() => "retrieved");
  const futureSibling = vi.fn(() => "future");
  const responses = {
    create: responsesCreate,
    parse: responsesParse,
    stream: responsesStream,
    retrieve,
    futureSibling,
    removeMe: "remove",
  };
  const client = {
    chat: { completions: { create: chatCreate } },
    responses,
    embeddings: { create: embeddingsCreate },
    images: { generate: imagesGenerate, edit: imagesEdit },
    audio: {
      transcriptions: { create: transcriptionCreate },
      speech: { create: speechCreate },
    },
    videos: { create: videosCreate },
  };
  return {
    client,
    operations: {
      chatCreate,
      responsesCreate,
      responsesParse,
      responsesStream,
      embeddingsCreate,
      imagesGenerate,
      imagesEdit,
      transcriptionCreate,
      speechCreate,
      videosCreate,
      retrieve,
      futureSibling,
    },
    responses,
  };
}

const clientsToClose: Array<{ close(): Promise<void> }> = [];

function wrap<C>(
  client: C,
  fetch: FetchLike,
  logger: Logger,
  overrides: SurfaceOptionOverrides = {},
) {
  const wrapped = new Solwyn(client, {
    ...PUBLIC_SURFACE_OPTIONS,
    fetch,
    logger,
    ...overrides,
  });
  clientsToClose.push(wrapped);
  return wrapped;
}

afterEach(async () => {
  const clients = clientsToClose.splice(0);
  await Promise.allSettled(clients.map((client) => client.close()));
  __resetUnmeteredSurfaceWarnings();
});

describe("public surface controls", () => {
  it("meters a strict synthetic chat call through Anthropic budget, provider, and metadata flow", async () => {
    const calls: WireCall[] = [];
    const order: string[] = [];
    const result = { id: "msg_synthetic", usage: { input_tokens: 3, output_tokens: 4 } };
    const providerCalls: Record<string, unknown>[] = [];
    const raw = {
      messages: {
        create(params: Record<string, unknown>) {
          order.push("provider");
          providerCalls.push(params);
          return result;
        },
      },
    };
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ path, body });
      order.push(path);
      if (path === "/api/v1/budgets/check") {
        return Response.json({
          allowed: true,
          remaining_budget: 100,
          reservation_id: "res_synthetic",
          mode: "alert_only",
          budget_limit: 100,
          current_usage: 0,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: null,
        });
      }
      if (path === "/api/v1/budgets/confirm") return new Response(null, { status: 204 });
      return Response.json({ ingested: 1, rejected: [] }, { status: 202 });
    };
    const log = recordingLogger();
    const wrapped = new Solwyn(raw, {
      apiKey: API_KEY,
      fetch,
      logger: log.logger,
      onUnmetered: "raise",
      model: "claude-3-5-sonnet",
    });
    clientsToClose.push(wrapped);
    const facade = wrapped as unknown as {
      chat: { completions: { create(params: Record<string, unknown>): Promise<unknown> } };
    };

    const create = facade.chat.completions.create;
    expect(calls).toEqual([]);
    expect(await create({ model: "claude-3-5-sonnet", messages: [] })).toBe(result);
    await wrapped.close();

    expect(order.slice(0, 2)).toEqual(["/api/v1/budgets/check", "provider"]);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({ model: "claude-3-5-sonnet", messages: [] });
    expect(calls.find((call) => call.path === "/api/v1/budgets/check")?.body).toMatchObject({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
    expect(calls.find((call) => call.path === "/api/v1/budgets/confirm")?.body).toMatchObject({
      reservation_id: "res_synthetic",
    });
    expect(calls.find((call) => call.path === "/api/v1/metadata/ingest")?.body).toEqual([
      expect.objectContaining({ provider: "anthropic", input_tokens: 3, output_tokens: 4 }),
    ]);
    expect(calls.some((call) => call.path === UNTRACKED_REPORT_PATH)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    "openai",
    "azure_openai",
  ])("accepts native %s conditional TTS acknowledgment without metering", async (provider) => {
    const wire = wireRecorder();
    const log = recordingLogger();
    const response = new Uint8Array([1, 2, 3]);
    const calls: unknown[] = [];
    const raw = {
      chat: { completions: { create: operationMustNotRun } },
      audio: {
        speech: {
          create(kwargs: Record<string, unknown>) {
            calls.push(kwargs);
            return response;
          },
        },
      },
    };
    const wrapped = new Solwyn(raw, {
      ...PUBLIC_SURFACE_OPTIONS,
      provider,
      fetch: wire.fetch,
      logger: log.logger,
      onUnmetered: "raise",
      acknowledgeUntracked: ["audio.speech.create:gpt-4o-mini-tts"],
    });
    clientsToClose.push(wrapped);

    expect(await wrapped.audio.speech.create({ model: "gpt-4o-mini-tts", input: "hello" })).toBe(
      response,
    );
    expect(calls).toEqual([{ model: "gpt-4o-mini-tts", input: "hello" }]);
    await wrapped.close();
    expect(log.warn).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
  });

  it("rejects the native conditional TTS acknowledgment in a compat context before I/O", () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    expect(
      () =>
        new Solwyn(raw.client, {
          ...PUBLIC_SURFACE_OPTIONS,
          provider: "groq",
          fetch: wire.fetch,
          logger: recordingLogger().logger,
          acknowledgeUntracked: ["audio.speech.create:gpt-4o-mini-tts"],
        }),
    ).toThrowError(ConfigurationError);
    expect(raw.operations.speechCreate).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
  });

  it("shares warning state across separately loaded SDK modules and resets both together", async () => {
    const wire = wireRecorder();
    const log = recordingLogger();
    const first = wrap(fakeOpenAI().client, wire.fetch, log.logger, {
      reportUntrackedSurfaces: false,
    });
    vi.resetModules();
    const secondSdk = await import("../../src/index");
    const secondClientModule = await import("../../src/client");
    const second = new secondSdk.Solwyn(fakeOpenAI().client, {
      ...PUBLIC_SURFACE_OPTIONS,
      fetch: wire.fetch,
      logger: log.logger,
      reportUntrackedSurfaces: false,
    });
    clientsToClose.push(second);

    first.responses.retrieve();
    second.responses.retrieve();
    expect(log.warn).toHaveBeenCalledTimes(1);
    secondClientModule.__resetUnmeteredSurfaceWarnings();
    first.responses.retrieve();
    second.responses.retrieve();
    expect(log.warn).toHaveBeenCalledTimes(2);
    await Promise.all([first.close(), second.close()]);
    expect(wire.calls).toEqual([]);
  });

  it("bounds advisory shutdown to ten seconds and leaves no later batches or timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const raw = fakeOpenAI();
    let providerClosed = false;
    const client = Object.assign(raw.client, {
      close: () => {
        providerClosed = true;
      },
    });
    for (let index = 0; index < 512; index += 1) {
      Reflect.set(client, `future_${index}`, () => "untracked");
    }
    const signals: AbortSignal[] = [];
    const fetch: FetchLike = (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      // A hostile transport ignores cancellation; Transport must still settle.
      return new Promise<Response>(() => {});
    };
    const wrapped = wrap(client, fetch, recordingLogger().logger, { onUnmetered: "allow" });
    for (let index = 0; index < 512; index += 1) Reflect.get(wrapped, `future_${index}`);
    const closing = wrapped.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(providerClosed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(providerClosed).toBe(true);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signals).toHaveLength(1);
      expect(wrapped.close()).toBe(closing);
    } finally {
      await vi.runAllTimersAsync();
      await closing;
      vi.useRealTimers();
    }
  });

  it("rejects an explicit undefined fallback provider identically at construction and runtime parsing", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const fallbacks = [[fakeOpenAI().client, MODEL, {}, undefined]];
    let constructionError: unknown;
    try {
      const wrapped = new Solwyn(raw.client, {
        ...PUBLIC_SURFACE_OPTIONS,
        fallback: fallbacks as unknown as NonNullable<SolwynOptions["fallback"]>,
        fetch: wire.fetch,
        logger: recordingLogger().logger,
      });
      await wrapped.close();
    } catch (error) {
      constructionError = error;
    }
    const runtimeError = await buildRuntimes(raw.client, MODEL, fallbacks).catch(
      (error: unknown) => error,
    );

    expect(runtimeError).toBeInstanceOf(ConfigurationError);
    expect(runtimeError).toMatchObject({
      field: "fallback_specs",
      message: "Fallback provider must be a string, got undefined",
    });
    expect(constructionError).toBeInstanceOf(ConfigurationError);
    expect(constructionError).toMatchObject({
      field: "fallback_specs",
      message: "Fallback provider must be a string, got undefined",
    });
    expect(wire.calls).toEqual([]);
  });

  it("closes metadata, advisory, budget, then provider in one shared lifecycle", async () => {
    const order: string[] = [];
    const metadataClose = MetadataReporter.prototype.close;
    const advisoryClose = UntrackedSurfaceReporter.prototype.close;
    const budgetClose = BudgetEnforcer.prototype.close;
    const spies = [
      vi.spyOn(MetadataReporter.prototype, "close").mockImplementation(async function (
        this: MetadataReporter,
      ) {
        await metadataClose.call(this);
        order.push("metadata");
      }),
      vi.spyOn(UntrackedSurfaceReporter.prototype, "close").mockImplementation(async function (
        this: UntrackedSurfaceReporter,
      ) {
        await advisoryClose.call(this);
        order.push("advisory");
      }),
      vi.spyOn(BudgetEnforcer.prototype, "close").mockImplementation(async function (
        this: BudgetEnforcer,
      ) {
        await budgetClose.call(this);
        order.push("budget");
      }),
    ];
    const raw = fakeOpenAI();
    const client = Object.assign(raw.client, {
      close: () => {
        order.push("provider");
      },
    });
    const wire = wireRecorder();
    const wrapped = wrap(client, wire.fetch, recordingLogger().logger);
    try {
      const first = wrapped.close();
      expect(wrapped.close()).toBe(first);
      expect(wrapped[Symbol.asyncDispose]()).toBe(first);
      await first;
      expect(wrapped.close()).toBe(first);
      expect(order).toEqual(["metadata", "advisory", "budget", "provider"]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("accepts the camelCase posture, acknowledgment, and reporting options", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, {
      onUnmetered: "allow",
      acknowledgeUntracked: ["responses.retrieve"],
      reportUntrackedSurfaces: false,
    });

    await expect(wrapped.close()).resolves.toBeUndefined();
  });

  describe.each(["raise", "warn", "allow"] as const)("%s acknowledgment validation", (posture) => {
    it.each([
      { provider: "openai", fallbackProvider: null },
      { provider: "azure_openai", fallbackProvider: "groq" },
      { provider: "groq", fallbackProvider: "openai" },
    ])("rejects $provider method-to-getter drift before accepting the exact token", ({
      provider,
      fallbackProvider,
    }) => {
      // Catches the terminal branch's blanket unevaluated-accessor shape-check bypass.
      const raw = fakeOpenAI();
      const wire = wireRecorder();
      const log = recordingLogger();
      let getterReads = 0;
      Object.defineProperty(raw.responses, "retrieve", {
        get() {
          getterReads += 1;
          return raw.operations.retrieve;
        },
      });
      let caught: unknown;
      try {
        const wrapped = new Solwyn(raw.client, {
          ...PUBLIC_SURFACE_OPTIONS,
          provider,
          fallback:
            fallbackProvider === null ? [] : [[fakeOpenAI().client, MODEL, {}, fallbackProvider]],
          onUnmetered: posture,
          acknowledgeUntracked: ["responses.retrieve"],
          fetch: wire.fetch,
          logger: log.logger,
        });
        clientsToClose.push(wrapped);
      } catch (error) {
        caught = error;
      }

      expect(getterReads).toBe(0);
      expect(raw.operations.retrieve).not.toHaveBeenCalled();
      expect(wire.fetch).not.toHaveBeenCalled();
      expect(wire.calls).toEqual([]);
      expect(log.warn).not.toHaveBeenCalled();
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect(caught).toMatchObject({ field: "acknowledge_untracked" });
    });

    it.each([
      "futureBox",
      "responses.futureBox",
    ])("rejects unknown accessor token %s without evaluating its possible resource container", (token) => {
      // Catches accepting an unknown terminal before its non-container status is known.
      const raw = fakeOpenAI();
      const wire = wireRecorder();
      const log = recordingLogger();
      const child = vi.fn(operationMustNotRun);
      let getterReads = 0;
      Object.defineProperty(token === "futureBox" ? raw.client : raw.responses, "futureBox", {
        get() {
          getterReads += 1;
          return { child };
        },
      });
      let caught: unknown;
      try {
        const wrapped = new Solwyn(raw.client, {
          ...PUBLIC_SURFACE_OPTIONS,
          fallback: [[fakeOpenAI().client, MODEL, {}, "groq"]],
          onUnmetered: posture,
          acknowledgeUntracked: [token],
          fetch: wire.fetch,
          logger: log.logger,
        });
        clientsToClose.push(wrapped);
      } catch (error) {
        caught = error;
      }

      expect(getterReads).toBe(0);
      expect(child).not.toHaveBeenCalled();
      expect(wire.fetch).not.toHaveBeenCalled();
      expect(wire.calls).toEqual([]);
      expect(log.warn).not.toHaveBeenCalled();
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect(caught).toMatchObject({ field: "acknowledge_untracked" });
    });

    it.each([
      "field",
      "getter",
    ] as const)("preserves reviewed %s and method tokens on the primary without inspecting fallback tokens", async (descriptor) => {
      // Prevents blanket accessor rejection or acknowledgment traversal of a fallback graph.
      const raw = fakeOpenAI();
      const fallback = fakeOpenAI();
      const wire = wireRecorder();
      const log = recordingLogger();
      const translations = new (class Translations {
        create = operationMustNotRun;
      })();
      let getterReads = 0;
      let fallbackGetterReads = 0;
      Object.defineProperty(
        raw.client.audio,
        "translations",
        descriptor === "field"
          ? { value: translations }
          : {
              get() {
                getterReads += 1;
                return translations;
              },
            },
      );
      Object.defineProperty(fallback.responses, "retrieve", {
        get() {
          fallbackGetterReads += 1;
          return fallback.operations.retrieve;
        },
      });
      const wrapped = new Solwyn(raw.client, {
        ...PUBLIC_SURFACE_OPTIONS,
        onUnmetered: posture,
        acknowledgeUntracked: ["responses.retrieve", "audio.translations"],
        fallback: [[fallback.client, MODEL, {}, "groq"]],
        fetch: wire.fetch,
        logger: log.logger,
      });
      clientsToClose.push(wrapped);

      expect(getterReads).toBe(descriptor === "getter" ? 1 : 0);
      expect(fallbackGetterReads).toBe(0);
      expect(wrapped.responses.retrieve()).toBe("retrieved");
      expect(raw.operations.retrieve).toHaveBeenCalledOnce();
      await wrapped.close();
      expect(getterReads).toBe(descriptor === "getter" ? 1 : 0);
      expect(fallbackGetterReads).toBe(0);
      expect(wire.fetch).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });
  });
});

describe.each([
  "raise",
  "warn",
  "allow",
] as const)("%s live acknowledgment terminals", (posture) => {
  it.each(
    ["post", "responses.retrieve", "futureTerminal", "responses.futureTerminal"].flatMap((path) =>
      [
        { shape: "scalar", value: 3, resource: false },
        { shape: "mapping", value: { child: operationMustNotRun }, resource: true },
        {
          shape: "resource",
          value: new (class Resource {
            child = operationMustNotRun;
          })(),
          resource: true,
        },
        { shape: "array", value: [], resource: false },
        { shape: "opaque", value: new Date(0), resource: false },
        { shape: "class", value: class Capability {}, resource: false },
        { shape: "function", value: operationMustNotRun, resource: false },
      ].map((shape) => ({ path, ...shape })),
    ),
  )("validates $path evaluated $shape without invoking it", async ({
    path,
    value,
    resource,
    shape,
  }) => {
    const raw = fakeOpenAI();
    const nested = path.startsWith("responses.");
    const property = path.split(".").at(-1) as string;
    const owner = nested ? raw.responses : raw.client;
    Object.assign(owner, { [property]: operationMustNotRun });
    let reads = 0;
    const dynamic = new Proxy(owner, {
      get(target, key, receiver) {
        if (key === property) {
          reads += 1;
          return value;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const wire = wireRecorder();
    const log = recordingLogger();
    let caught: unknown;
    try {
      const wrapped = wrap(
        nested ? { ...raw.client, responses: dynamic } : dynamic,
        wire.fetch,
        log.logger,
        {
          onUnmetered: posture,
          acknowledgeUntracked: [path],
        },
      );
      await wrapped.close();
    } catch (error) {
      caught = error;
    }
    const known = path === "post" || path === "responses.retrieve";
    if ((known && shape !== "function") || resource) {
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect(caught).toMatchObject({ field: "acknowledge_untracked" });
    } else expect(caught).toBeUndefined();
    expect(reads).toBe(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
  });
});

describe("raw evaluated values precede presentation binding", () => {
  describe.each([
    { provider: "openai", path: "post" },
    { provider: "openai", path: "responses.retrieve" },
    { provider: "groq", path: "responses.retrieve" },
  ])("$provider $path", ({ provider, path }) => {
    describe.each(["get", "descriptor"] as const)("%s reads", (access) => {
      describe.each(["raise", "warn", "allow"] as const)("%s posture", (posture) => {
        it.each([
          "function",
          "resource",
          "class",
          "command-class",
        ])("validates raw $0 after a valid acknowledgment", async (shape) => {
          const raw = fakeOpenAI();
          const nested = path.startsWith("responses.");
          const property = nested ? "retrieve" : "post";
          const owner = nested ? raw.responses : raw.client;
          let operations = 0;
          function native(this: unknown) {
            operations += 1;
            return this;
          }
          Object.assign(owner, { [property]: native });
          let returned: unknown = native;
          const dynamic = new Proxy(owner, {
            get(target, key, receiver) {
              return key === property ? returned : Reflect.get(target, key, receiver);
            },
          });
          const wire = wireRecorder();
          const log = recordingLogger();
          const wrapped = new Solwyn(nested ? { ...raw.client, responses: dynamic } : dynamic, {
            ...PUBLIC_SURFACE_OPTIONS,
            provider,
            onUnmetered: posture,
            acknowledgeUntracked: [path],
            reportUntrackedSurfaces: true,
            fetch: wire.fetch,
            logger: log.logger,
          });
          clientsToClose.push(wrapped);
          const target = nested ? Reflect.get(wrapped, "responses") : wrapped;
          const read = (): unknown => {
            if (access === "get") return Reflect.get(target, property);
            const descriptor = Object.getOwnPropertyDescriptor(target, property);
            return descriptor && "value" in descriptor
              ? descriptor.value
              : descriptor?.get?.call(target);
          };
          const initial = read();
          expect(read()).toBe(initial);
          expect(operations).toBe(0);
          returned =
            shape === "function"
              ? native
              : shape === "resource"
                ? { child: operationMustNotRun }
                : shape === "class"
                  ? class Capability {
                      constructor() {
                        operations += 1;
                      }
                    }
                  : class CapabilityCommand {
                      constructor() {
                        operations += 1;
                      }
                    };
          let exposed: unknown;
          let caught: unknown;
          try {
            exposed = read();
            if (shape === "class" || shape === "command-class") {
              if (typeof exposed !== "function") throw new TypeError("Expected a constructor");
              Reflect.construct(exposed, []);
            }
          } catch (error) {
            caught = error;
          }
          if (posture === "raise" && shape !== "function") {
            expect(caught).toBeInstanceOf(UntrackedSpendSurfaceError);
            expect(caught).toMatchObject({ surface: path, kind: "unknown" });
            expect(operations).toBe(0);
          } else {
            expect(caught).toBeUndefined();
            if (shape === "class" || shape === "command-class") {
              expect(Object.is(exposed, returned)).toBe(true);
              expect(operations).toBe(1);
            } else if (shape === "function") {
              expect(exposed).toBe(initial);
              if (typeof exposed !== "function") throw new TypeError("Expected a method");
              expect(exposed()).toBe(dynamic);
            } else expect(Object.is(exposed, returned)).toBe(false);
          }
          await wrapped.close();
          const driftReported = posture !== "raise" && shape !== "function";
          expect(log.warn).toHaveBeenCalledTimes(driftReported && posture === "warn" ? 1 : 0);
          if (driftReported) {
            const reports = wire.calls.flatMap(({ body }) => body as Record<string, unknown>[]);
            expect(reports).toEqual([
              expect.objectContaining({ surface: path, rule_kind: "unknown", occurrences: 1 }),
            ]);
          } else expect(wire.calls).toEqual([]);
        });
      });
    });
  });
});

describe("acknowledgment prefix ordering", () => {
  const knownPrefixes = [
    "responses",
    "chat.completions",
    "beta.skills.versions",
    "audio.translations",
  ];
  const invalidShapes = [
    { name: "scalar", value: 7 },
    { name: "function", value: () => undefined },
    { name: "class", value: class Future {} },
    { name: "array", value: [] },
    { name: "opaque", value: new Date(0) },
  ];

  function graph(prefix: string, staticValue: unknown, returned: unknown, getter = false) {
    const provider = prefix.startsWith("beta.") ? "anthropic" : "openai";
    let client: Record<string, unknown> =
      provider === "anthropic"
        ? { messages: { create: operationMustNotRun } }
        : fakeOpenAI().client;
    const segments = prefix.split(".");
    let owner = client;
    for (const segment of segments.slice(0, -1)) {
      owner[segment] ??= {};
      owner = owner[segment] as Record<string, unknown>;
    }
    const property = segments[segments.length - 1] as string;
    let reads = 0;
    owner[property] = staticValue;
    if (getter)
      Object.defineProperty(owner, property, {
        configurable: true,
        get() {
          reads += 1;
          return returned;
        },
      });
    const dynamic = new Proxy(owner, {
      get(target, key, receiver) {
        if (key === property && !getter) {
          reads += 1;
          return returned;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    if (segments.length === 1) client = dynamic;
    else {
      let parent = client;
      for (const segment of segments.slice(0, -2))
        parent = parent[segment] as Record<string, unknown>;
      parent[segments[segments.length - 2] as string] = dynamic;
    }
    return { client, provider, reads: () => reads };
  }

  describe.each(["raise", "warn", "allow"] as const)("%s posture", (posture) => {
    it.each(
      knownPrefixes.flatMap((prefix) =>
        ["mapping", "resource"].flatMap((staticShape) =>
          ["mapping", "resource"].map((actualShape) => ({ prefix, staticShape, actualShape })),
        ),
      ),
    )("accepts $prefix static $staticShape evaluated $actualShape", async ({
      prefix,
      staticShape,
      actualShape,
    }) => {
      class Resource {
        child = operationMustNotRun;
      }
      const raw = graph(
        prefix,
        staticShape === "resource" ? new Resource() : { child: operationMustNotRun },
        actualShape === "resource" ? new Resource() : { child: operationMustNotRun },
      );
      const wire = wireRecorder();
      const wrapped = new Solwyn(raw.client, {
        apiKey: API_KEY,
        provider: raw.provider,
        onUnmetered: posture,
        acknowledgeUntracked: [`${prefix}.child`],
        fetch: wire.fetch,
      });
      clientsToClose.push(wrapped);
      expect(raw.reads()).toBe(1);
      await wrapped.close();
      expect(wire.calls).toEqual([]);
    });

    it.each(
      knownPrefixes.flatMap((prefix) => invalidShapes.map((shape) => ({ prefix, ...shape }))),
    )("rejects $prefix static $name before a Proxy can repair its shape", ({ prefix, value }) => {
      let deeperReads = 0;
      const repaired = new Proxy(
        { child: operationMustNotRun },
        {
          get(target, key, receiver) {
            deeperReads += 1;
            return Reflect.get(target, key, receiver);
          },
        },
      );
      const raw = graph(prefix, value, repaired);
      const wire = wireRecorder();
      let caught: unknown;
      try {
        const wrapped = new Solwyn(raw.client, {
          apiKey: API_KEY,
          provider: raw.provider,
          onUnmetered: posture,
          acknowledgeUntracked: [`${prefix}.child`],
          fetch: wire.fetch,
        });
        clientsToClose.push(wrapped);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect(caught).toMatchObject({ field: "acknowledge_untracked" });
      expect(raw.reads()).toBe(0);
      expect(deeperReads).toBe(0);
      expect(wire.calls).toEqual([]);
    });

    it.each([
      "apiKey",
      "chat.completions.create",
    ])("rejects known nonnamespace %s without reading", (prefix) => {
      const raw = graph(prefix, prefix === "apiKey" ? "key" : operationMustNotRun, {
        child: operationMustNotRun,
      });
      const wire = wireRecorder();
      expect(
        () =>
          new Solwyn(raw.client, {
            apiKey: API_KEY,
            provider: raw.provider,
            onUnmetered: posture,
            acknowledgeUntracked: [`${prefix}.child`],
            fetch: wire.fetch,
          }),
      ).toThrow(ConfigurationError);
      expect(raw.reads()).toBe(0);
      expect(wire.calls).toEqual([]);
    });

    it.each(
      knownPrefixes,
    )("accepts reviewed %s getter resources without traversing fallback", async (prefix) => {
      const returned = new (class Resource {
        child() {
          return "allowed";
        }
      })();
      const raw = graph(prefix, undefined, returned, true);
      const fallback = graph(prefix, undefined, returned, true);
      const wire = wireRecorder();
      const wrapped = new Solwyn(raw.client, {
        apiKey: API_KEY,
        provider: raw.provider,
        onUnmetered: posture,
        acknowledgeUntracked: [`${prefix}.child`],
        fetch: wire.fetch,
        fallback: [[fallback.client, MODEL, {}, fallback.provider]],
      });
      clientsToClose.push(wrapped);
      expect(raw.reads()).toBe(1);
      expect(fallback.reads()).toBe(0);
      await wrapped.close();
      expect(wire.calls).toEqual([]);
    });

    it.each(
      knownPrefixes.flatMap((prefix) => invalidShapes.map((shape) => ({ prefix, ...shape }))),
    )("rejects $prefix evaluated $name after its valid static resource", ({ prefix, value }) => {
      const raw = graph(prefix, { child: operationMustNotRun }, value);
      const wire = wireRecorder();
      expect(
        () =>
          new Solwyn(raw.client, {
            apiKey: API_KEY,
            provider: raw.provider,
            onUnmetered: posture,
            acknowledgeUntracked: [`${prefix}.child`],
            fetch: wire.fetch,
          }),
      ).toThrow(ConfigurationError);
      expect(raw.reads()).toBe(1);
      expect(wire.calls).toEqual([]);
    });
  });

  describe.each([1, 2, 3, 4, 5, 6, 7])("unknown prefix at depth %i", (depth) => {
    const prefix = Array.from({ length: depth }, (_, index) => `future${index}`).join(".");
    it.each([
      { name: "mapping", returned: { child: operationMustNotRun }, accepted: true },
      {
        name: "resource",
        returned: new (class Resource {
          child = operationMustNotRun;
        })(),
        accepted: true,
      },
      ...invalidShapes.map(({ name, value }) => ({ name, returned: value, accepted: false })),
    ])("uses evaluated guardability for dynamic $name data values", async ({
      returned,
      accepted,
    }) => {
      const raw = graph(prefix, 7, returned);
      const wire = wireRecorder();
      let caught: unknown;
      try {
        const wrapped = new Solwyn(raw.client, {
          apiKey: API_KEY,
          provider: raw.provider,
          onUnmetered: "raise",
          acknowledgeUntracked: [`${prefix}.child`],
          fetch: wire.fetch,
        });
        clientsToClose.push(wrapped);
      } catch (error) {
        caught = error;
      }
      if (accepted) expect(caught).toBeUndefined();
      else expect(caught).toBeInstanceOf(ConfigurationError);
      expect(raw.reads()).toBe(1);
      expect(wire.calls).toEqual([]);
    });

    it("does not authorize an arbitrary unknown getter prefix", () => {
      const raw = graph(prefix, undefined, { child: operationMustNotRun }, true);
      expect(
        () =>
          new Solwyn(raw.client, {
            apiKey: API_KEY,
            provider: raw.provider,
            onUnmetered: "allow",
            acknowledgeUntracked: [`${prefix}.child`],
          }),
      ).toThrow(ConfigurationError);
      expect(raw.reads()).toBe(0);
    });
  });
});

describe("runtime surface guard", () => {
  describe.each(["warn", "allow"] as const)("%s exact static-drift accounting", (posture) => {
    function count(provider: string, clientShape: string, surface: string): number {
      const state = Reflect.get(globalThis, Symbol.for("@solwyn/sdk.surfacePosture.v1")) as
        | {
            observations: {
              get(
                provider: string,
                clientShape: string,
                surface: string,
              ): { count: number } | undefined;
            };
          }
        | undefined;
      return state?.observations.get(provider, clientShape, surface)?.count ?? 0;
    }

    function reportTotal(wire: ReturnType<typeof wireRecorder>, surface: string): number {
      return wire.calls
        .flatMap(({ body }) => body as { surface: string; occurrences: number }[])
        .filter((entry) => entry.surface === surface)
        .reduce((total, entry) => total + entry.occurrences, 0);
    }

    async function flushAfterInterval(wrapped: { close(): Promise<void> }): Promise<void> {
      // Close respects the reporter cadence; advance its monotonic clock so the
      // final cycle includes the delta hidden by the immediate first batch.
      const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 900_001);
      try {
        await wrapped.close();
      } finally {
        clock.mockRestore();
      }
    }

    describe.each(["get", "descriptor"] as const)("%s reads", (access) => {
      it.each(
        ["embedContent", "generateImages", "generateVideos"].flatMap((method) =>
          ["resource", "getter-resource", "getter-function", "proxy-resource"].map((shape) => ({
            method,
            shape,
          })),
        ),
      )("counts each $method $shape access once in ledger and eventual reports", async ({
        method,
        shape,
      }) => {
        const wire = wireRecorder();
        const log = recordingLogger();
        const resource = { child: operationMustNotRun };
        const models: Record<string, unknown> = {
          generateContent: operationMustNotRun,
          generateContentStream: operationMustNotRun,
          [method]: shape === "proxy-resource" ? operationMustNotRun : resource,
        };
        if (shape.startsWith("getter"))
          Object.defineProperty(models, method, {
            get: () => (shape === "getter-function" ? operationMustNotRun : resource),
          });
        const dynamic = new Proxy(models, {
          get(target, property, receiver) {
            return property === method && shape === "proxy-resource"
              ? resource
              : Reflect.get(target, property, receiver);
          },
        });
        const wrapped = new Solwyn(
          { models: dynamic },
          {
            apiKey: API_KEY,
            provider: "google",
            onUnmetered: posture,
            fetch: wire.fetch,
            logger: log.logger,
          },
        );
        clientsToClose.push(wrapped);
        for (let reads = 1; reads <= 3; reads += 1) {
          if (access === "get") Reflect.get(wrapped.models, method);
          else {
            const descriptor = Object.getOwnPropertyDescriptor(wrapped.models, method);
            if (descriptor && !("value" in descriptor)) descriptor.get?.call(wrapped.models);
          }
          expect.soft(count("google", "google_genai", `models.${method}`)).toBe(reads);
        }
        await flushAfterInterval(wrapped);
        expect(reportTotal(wire, `models.${method}`)).toBe(3);
        expect(log.warn).toHaveBeenCalledTimes(posture === "warn" ? 1 : 0);
        expect(wire.calls.every(({ path }) => path === UNTRACKED_REPORT_PATH)).toBe(true);
      });
    });

    it.each([
      "maxRetries",
      "responses",
      "post",
      "future",
    ])("counts generic %s resource drift once and guards descendants", async (property) => {
      const raw = fakeOpenAI();
      const returned = new (class Resource {
        child() {
          return "allowed";
        }
      })();
      Object.assign(raw.client, {
        [property]: property === "responses" ? operationMustNotRun : returned,
      });
      const dynamic = new Proxy(raw.client, {
        get(target, key, receiver) {
          return key === property ? returned : Reflect.get(target, key, receiver);
        },
      });
      const wire = wireRecorder();
      const log = recordingLogger();
      const wrapped = wrap(dynamic, wire.fetch, log.logger, { onUnmetered: posture });
      for (let reads = 1; reads <= 3; reads += 1) {
        const resource = Reflect.get(wrapped, property) as { child(): string };
        expect(resource.child()).toBe("allowed");
        expect.soft(count("openai", "openai_sdk", property)).toBe(reads);
        expect.soft(count("openai", "openai_sdk", `${property}.child`)).toBe(reads);
      }
      await flushAfterInterval(wrapped);
      expect(reportTotal(wire, property)).toBe(3);
      expect(reportTotal(wire, `${property}.child`)).toBe(3);
    });

    it.each([
      "maxRetries",
      "responses",
      "post",
      "future",
    ])("preserves pre-read accounting when the %s getter throws", async (property) => {
      const raw = fakeOpenAI();
      const failure = new Error("getter failed");
      let reads = 0;
      // Unreviewed method and unknown accessors enter posture before evaluation.
      Object.defineProperty(raw.client, property, {
        configurable: true,
        get() {
          reads += 1;
          throw failure;
        },
      });
      const wire = wireRecorder();
      const log = recordingLogger();
      const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: posture });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let caught: unknown;
        try {
          Reflect.get(wrapped, property);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(reads).toBe(attempt);
        // Reviewed metadata/namespace getters are evaluated before any drift exists.
        expect(count("openai", "openai_sdk", property)).toBe(
          property === "post" || property === "future" ? attempt : 0,
        );
      }
      await flushAfterInterval(wrapped);
      expect(reportTotal(wire, property)).toBe(
        property === "post" || property === "future" ? 3 : 0,
      );
    });

    it("preserves Python's two decisions when a valid unmetered descriptor drifts only after evaluation", async () => {
      const raw = fakeOpenAI();
      Object.assign(raw.client, { post: operationMustNotRun });
      const dynamic = new Proxy(raw.client, {
        get(target, property, receiver) {
          return property === "post"
            ? { child: operationMustNotRun }
            : Reflect.get(target, property, receiver);
        },
      });
      const wire = wireRecorder();
      const wrapped = wrap(dynamic, wire.fetch, recordingLogger().logger, { onUnmetered: posture });
      Reflect.get(wrapped, "post");
      expect(count("openai", "openai_sdk", "post")).toBe(2);
      await flushAfterInterval(wrapped);
      expect(reportTotal(wire, "post")).toBe(2);
    });
  });

  describe.each([
    "raise",
    "warn",
    "allow",
  ] as const)("%s optional Google method reads", (posture) => {
    describe.each(["get", "descriptor"] as const)("%s access", (access) => {
      it.each(
        ["embedContent", "generateImages", "generateVideos"].flatMap((method) =>
          ["resource", "getter", "proxy"].map((shape) => ({ method, shape })),
        ),
      )("guards $method $shape drift before child execution", async ({ method, shape }) => {
        // A metered path alone must not authorize an evaluated raw resource.
        const wire = wireRecorder();
        const log = recordingLogger();
        let reads = 0;
        let operations = 0;
        const resource = {
          child() {
            operations += 1;
            return "paid";
          },
        };
        const models: Record<string, unknown> = {
          generateContent: operationMustNotRun,
          generateContentStream: operationMustNotRun,
          [method]: shape === "proxy" ? operationMustNotRun : resource,
        };
        if (shape === "getter") {
          Object.defineProperty(models, method, {
            configurable: true,
            get() {
              reads += 1;
              return resource;
            },
          });
        }
        const dynamic = new Proxy(models, {
          get(target, property, receiver) {
            if (property === method && shape !== "getter") {
              reads += 1;
              return resource;
            }
            return Reflect.get(target, property, receiver);
          },
        });
        const wrapped = new Solwyn(
          { models: dynamic },
          {
            apiKey: API_KEY,
            provider: "google",
            onUnmetered: posture,
            reportUntrackedSurfaces: true,
            fetch: wire.fetch,
            logger: log.logger,
          },
        );
        clientsToClose.push(wrapped);
        let caught: unknown;
        let value: unknown;
        try {
          if (access === "get") value = Reflect.get(wrapped.models, method);
          else {
            const descriptor = Object.getOwnPropertyDescriptor(wrapped.models, method);
            value =
              descriptor && "value" in descriptor
                ? descriptor.value
                : descriptor?.get?.call(wrapped.models);
          }
          (value as typeof resource).child();
        } catch (error) {
          caught = error;
        }

        if (posture === "raise") {
          expect(caught).toBeInstanceOf(UntrackedSpendSurfaceError);
          expect(caught).toMatchObject({
            surface: `models.${method}`,
            kind: "unknown",
            driftedFromRuleId: expect.stringContaining("metered"),
          });
          expect(reads).toBe(shape === "proxy" ? 1 : 0);
          expect(operations).toBe(0);
          expect(log.warn).not.toHaveBeenCalled();
        } else {
          expect(caught).toBeUndefined();
          expect(Object.is(value, resource)).toBe(false);
          expect(reads).toBe(1);
          expect(operations).toBe(1);
          expect(log.warn).toHaveBeenCalledTimes(posture === "warn" ? 2 : 0);
        }
        await wrapped.close();
        if (posture === "raise") expect(wire.calls).toEqual([]);
        else {
          expect(wire.calls.every(({ path }) => path === UNTRACKED_REPORT_PATH)).toBe(true);
          const reports = wire.calls.flatMap(({ body }) => body as Record<string, unknown>[]);
          expect(reports).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                surface: `models.${method}`,
                rule_kind: "unknown",
                posture,
              }),
              expect.objectContaining({
                surface: `models.${method}.child`,
                rule_kind: "unknown",
                posture,
              }),
            ]),
          );
        }
      });
    });
  });

  describe.each(["get", "descriptor"] as const)("evaluated %s values", (access) => {
    function read(target: object, property: string): unknown {
      if (access === "get") return Reflect.get(target, property);
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      return descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : descriptor?.get?.call(target);
    }

    it.each([
      "maxRetries",
      "baseURL",
      "timeout",
    ])("refuses %s data-property drift before its evaluated operation can run", async (property) => {
      // A data descriptor is not evidence that Proxy.get returns the same value.
      const raw = fakeOpenAI();
      Object.assign(raw.client, { [property]: property === "baseURL" ? "local" : 2 });
      let reads = 0;
      let operations = 0;
      const dynamic = new Proxy(raw.client, {
        get(target, key, receiver) {
          if (key !== property) return Reflect.get(target, key, receiver);
          reads += 1;
          return () => {
            operations += 1;
            return "paid";
          };
        },
      });
      const wire = wireRecorder();
      const wrapped = wrap(dynamic, wire.fetch, recordingLogger().logger, {
        onUnmetered: "raise",
      });
      let caught: unknown;
      try {
        const operation = read(wrapped, property) as () => unknown;
        operation();
      } catch (error) {
        caught = error;
      }

      expect(operations).toBe(0);
      expect(reads).toBe(1);
      expect(caught).toBeInstanceOf(UntrackedSpendSurfaceError);
      expect(caught).toMatchObject({
        surface: property,
        kind: "unknown",
        capabilityScope: null,
        driftedFromRuleId: expect.stringContaining("surface."),
      });
      await wrapped.close();
      expect(wire.calls).toEqual([]);
    });

    it.each([
      "future",
      "post",
      "responses.retrieve",
    ])("keeps an acknowledged %s method's evaluated resource from escaping strict posture", async (path) => {
      // Known shape drift invalidates the token; an unknown terminal still guards children.
      const raw = fakeOpenAI();
      const property = path === "responses.retrieve" ? "retrieve" : path;
      const owner = path === "responses.retrieve" ? raw.responses : raw.client;
      Object.assign(owner, { [property]: () => "original" });
      let reads = 0;
      let drifted = false;
      let operations = 0;
      const resource = {
        child() {
          operations += 1;
          return "paid";
        },
      };
      const dynamic = new Proxy(owner, {
        get(target, key, receiver) {
          if (key !== property) return Reflect.get(target, key, receiver);
          reads += 1;
          return drifted ? resource : Reflect.get(target, key, receiver);
        },
      });
      const wire = wireRecorder();
      const wrapped = wrap(
        path === "responses.retrieve" ? { ...raw.client, responses: dynamic } : dynamic,
        wire.fetch,
        recordingLogger().logger,
        { onUnmetered: "raise", acknowledgeUntracked: [path] },
      );
      expect(reads).toBe(1);
      drifted = true;
      const wrappedOwner =
        path === "responses.retrieve" ? Reflect.get(wrapped, "responses") : wrapped;
      let caught: unknown;
      let exposed: unknown;
      try {
        exposed = read(wrappedOwner, property);
        const operation = read(exposed as object, "child") as () => unknown;
        operation();
      } catch (error) {
        caught = error;
      }

      expect(operations).toBe(0);
      expect(reads).toBe(2);
      expect(caught).toBeInstanceOf(UntrackedSpendSurfaceError);
      expect(caught).toMatchObject({
        surface: path === "future" ? "future.child" : path,
        kind: "unknown",
        driftedFromRuleId: path === "future" ? null : expect.stringContaining("unmetered_spend"),
      });
      if (path === "future") expect(Object.is(exposed, resource)).toBe(false);
      await wrapped.close();
      expect(wire.calls).toEqual([]);
    });

    it.each([
      "raise",
      "warn",
      "allow",
    ] as const)("preserves matching data/getter metadata and bound acknowledged methods under %s", async (posture) => {
      const raw = fakeOpenAI();
      const metadata = { retries: 2 };
      Object.assign(raw.client, { maxRetries: metadata, baseURL: "local" });
      Object.defineProperty(raw.client, "timeout", {
        configurable: true,
        get: () => 1000,
      });
      let operations = 0;
      Object.assign(raw.client, {
        post(this: unknown) {
          operations += 1;
          return this;
        },
      });
      const wire = wireRecorder();
      const log = recordingLogger();
      const wrapped = wrap(raw.client, wire.fetch, log.logger, {
        onUnmetered: posture,
        acknowledgeUntracked: ["post"],
      });

      expect(read(wrapped, "maxRetries")).toBe(metadata);
      expect(read(wrapped, "baseURL")).toBe("local");
      expect(read(wrapped, "timeout")).toBe(1000);
      const operation = read(wrapped, "post") as () => unknown;
      expect(read(wrapped, "post")).toBe(operation);
      expect(operation()).toBe(raw.client);
      expect(operations).toBe(1);
      await wrapped.close();
      expect(log.warn).not.toHaveBeenCalled();
      expect(wire.calls).toEqual([]);
    });
  });

  describe.each(["warn", "allow"] as const)("%s evaluated resource drift", (posture) => {
    it.each([
      "maxRetries",
      "post",
      "future",
      "responses.retrieve",
    ])("guards %s children and observes their own surface without metering", async (path) => {
      const raw = fakeOpenAI();
      const property = path === "responses.retrieve" ? "retrieve" : path;
      const owner = path === "responses.retrieve" ? raw.responses : raw.client;
      Object.assign(owner, { [property]: property === "maxRetries" ? 2 : () => "original" });
      let operations = 0;
      class Resource {
        child() {
          operations += 1;
          return this;
        }
      }
      const resource = new Resource();
      let drifted = false;
      const dynamic = new Proxy(owner, {
        get(target, key, receiver) {
          return key === property && drifted ? resource : Reflect.get(target, key, receiver);
        },
      });
      const wire = wireRecorder();
      const log = recordingLogger();
      const wrapped = wrap(
        path === "responses.retrieve" ? { ...raw.client, responses: dynamic } : dynamic,
        wire.fetch,
        log.logger,
        {
          onUnmetered: posture,
          acknowledgeUntracked: property === "maxRetries" ? [] : [path],
          reportUntrackedSurfaces: false,
        },
      );
      drifted = true;
      const wrappedOwner =
        path === "responses.retrieve" ? Reflect.get(wrapped, "responses") : wrapped;
      const guarded = Reflect.get(wrappedOwner, property) as Resource;
      expect(Object.is(guarded, resource)).toBe(false);
      expect(guarded.child()).toBe(resource);
      expect(operations).toBe(1);
      await wrapped.close();
      expect(wire.calls).toEqual([]);
      if (posture === "warn") {
        expect(log.warn.mock.calls.some((call) => call.includes(`${path}.child`))).toBe(true);
        expect(log.warn.mock.calls.some((call) => call.includes(path))).toBe(path !== "future");
      } else {
        expect(log.warn).not.toHaveBeenCalled();
      }
    });
  });

  it.each([
    "raise",
    "warn",
  ] as const)("%s permits inert evaluated metadata getters silently", async (posture) => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    const metadataValues = [1000, { retries: 2 }, new Date(0)];
    let current: unknown = metadataValues[0];
    Object.defineProperty(raw.client, "maxRetries", { get: () => current });
    Object.defineProperty(raw.client, "timeout", { get: () => 1000 });
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: posture });

    expect(Reflect.get(wrapped, "timeout")).toBe(1000);
    for (const value of metadataValues) {
      current = value;
      expect(Object.is(Reflect.get(wrapped, "maxRetries"), value)).toBe(true);
    }
    await wrapped.close();
    expect(log.warn).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
  });

  it.each([
    ["maxRetries", () => "paid-result"],
    [
      "maxRetries",
      new (class Resource {
        create() {}
      })(),
    ],
    ["timeout", { retries: 2 }],
  ])("refuses unsafe evaluated getter drift for %s", async (property, value) => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    let evaluations = 0;
    Object.defineProperty(raw.client, property, {
      get() {
        evaluations += 1;
        return value;
      },
    });
    const wrapped = wrap(raw.client, wire.fetch, recordingLogger().logger, {
      onUnmetered: "raise",
    });

    expect(() => Reflect.get(wrapped, property)).toThrowError(UntrackedSpendSurfaceError);
    expect(evaluations).toBe(1);
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("refuses descriptor-absent properties but preserves inert thenable probes under strict posture", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: "raise" });

    // JS cannot distinguish an absent field from a get-only Proxy capability. The
    // strict pre-evaluation contract takes precedence over ordinary missing reads.
    expect(() => Reflect.get(wrapped, "missingFeatureProbe")).toThrowError(
      UntrackedSpendSurfaceError,
    );
    expect(Reflect.get(wrapped, "then")).toBeUndefined();
    await expect(Promise.resolve(wrapped)).resolves.toBe(wrapped);

    expect(log.warn).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it.each([
    ["futureOperation", undefined],
    ["futureOperation", () => "paid-result"],
    ["files", { create: () => "paid-result" }],
  ])("refuses a get-only Proxy lookup for %s without evaluating it", async (property, value) => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    let evaluations = 0;
    const dynamic = new Proxy(raw.client, {
      get(target, name, receiver) {
        if (name === property) {
          evaluations += 1;
          return value;
        }
        return Reflect.get(target, name, receiver);
      },
    });
    const wrapped = wrap(dynamic, wire.fetch, log.logger, { onUnmetered: "raise" });

    expect(() => Reflect.get(wrapped, property)).toThrowError(UntrackedSpendSurfaceError);
    expect(evaluations).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("never evaluates a descriptor-absent provider then lookup", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    let evaluations = 0;
    const dynamic = new Proxy(raw.client, {
      get(target, name, receiver) {
        if (name === "then") {
          evaluations += 1;
          return () => "paid-result";
        }
        return Reflect.get(target, name, receiver);
      },
    });
    const wrapped = wrap(dynamic, wire.fetch, log.logger, { onUnmetered: "raise" });

    expect(Reflect.get(wrapped, "then")).toBeUndefined();
    await expect(Promise.resolve(wrapped)).resolves.toBe(wrapped);
    expect(evaluations).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("raises before evaluating an unknown getter or doing provider/control-plane I/O", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    let getterEvaluations = 0;
    const providerOperation = vi.fn(() => "paid-result");
    Object.defineProperty(raw.client, "futureOperation", {
      configurable: true,
      enumerable: true,
      get() {
        getterEvaluations += 1;
        return providerOperation;
      },
    });
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: "raise" });

    let caught: unknown;
    try {
      Reflect.get(wrapped, "futureOperation");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UntrackedSpendSurfaceError);
    expect(caught).toMatchObject({
      surface: "futureOperation",
      provider: "openai",
      clientShape: "openai_sdk",
      kind: "unknown",
    });
    expect(getterEvaluations).toBe(0);
    expect(providerOperation).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("classifies static reviewed-shape drift before strict refusal", async () => {
    const raw = fakeOpenAI();
    Object.assign(raw.client, { post: "not-callable" });
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: "raise" });

    let caught: unknown;
    try {
      Reflect.get(wrapped, "post");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UntrackedSpendSurfaceError);
    expect(caught).toMatchObject({
      surface: "post",
      kind: "unknown",
      capabilityScope: null,
      driftedFromRuleId: expect.stringContaining("surface.post.unmetered_spend"),
    });
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("returns one stable guard for a known Responses namespace and applies posture to its descendant", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: "raise" });

    const first = wrapped.responses;
    const second = wrapped.responses;
    expect(Object.is(first, second)).toBe(true);
    expect(Object.is(first, raw.responses)).toBe(false);
    expect(() => Reflect.get(first, "retrieve")).toThrowError(UntrackedSpendSurfaceError);
    expect(raw.operations.retrieve).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("does not let descriptor reflection expose raw top-level, guarded, or metered operations", async () => {
    const raw = fakeOpenAI();
    const post = vi.fn(() => "posted");
    Object.assign(raw.client, { post });
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: "raise" });

    expect(() => Object.getOwnPropertyDescriptor(wrapped, "post")).toThrowError(
      UntrackedSpendSurfaceError,
    );
    const responses = wrapped.responses;
    expect(() => Object.getOwnPropertyDescriptor(responses, "retrieve")).toThrowError(
      UntrackedSpendSurfaceError,
    );
    const createDescriptor = Object.getOwnPropertyDescriptor(responses, "create");
    expect(createDescriptor).toMatchObject({ value: responses.create });
    expect(createDescriptor?.value).not.toBe(raw.operations.responsesCreate);

    expect(post).not.toHaveBeenCalled();
    expect(raw.operations.retrieve).not.toHaveBeenCalled();
    expect(raw.operations.responsesCreate).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it.each([
    ["openai", "files"],
    ["openai", "models"],
    ["groq", "responses"],
  ] as const)("forwards reflected %s %s setters to the raw resource without strict read effects", async (provider, namespace) => {
    let getterReads = 0;
    class ProviderResource {
      #value = "before";

      constructor() {
        Object.defineProperty(this, "setting", {
          configurable: true,
          get(this: ProviderResource) {
            getterReads += 1;
            return this.#value;
          },
          set(this: ProviderResource, value: string) {
            this.#value = value;
          },
        });
      }

      value() {
        return this.#value;
      }
    }
    const resource = new ProviderResource();
    const raw = { ...fakeOpenAI().client, [namespace]: resource };
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = new Solwyn(raw, {
      ...PUBLIC_SURFACE_OPTIONS,
      provider,
      onUnmetered: "raise",
      acknowledgeUntracked: namespace === "responses" ? [] : [`${namespace}.value`],
      fetch: wire.fetch,
      logger: log.logger,
    });
    clientsToClose.push(wrapped);
    const guarded = Reflect.get(wrapped, namespace);
    const descriptor = Object.getOwnPropertyDescriptor(guarded, "setting");

    expect(descriptor?.set?.call(guarded, "after")).toBeUndefined();
    expect(resource.value()).toBe("after");
    expect(descriptor?.set?.call({}, "foreign receiver")).toBeUndefined();
    expect(resource.value()).toBe("foreign receiver");
    expect(Reflect.get(wrapped, namespace)).toBe(guarded);
    expect(() => descriptor?.get?.call({})).toThrowError(UntrackedSpendSurfaceError);
    expect(getterReads).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("returns the provider constructor as intrinsic metadata under strict posture", async () => {
    class FakeOpenAI {
      readonly chat = { completions: { create: operationMustNotRun } };
      readonly responses = { create: operationMustNotRun };
    }
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(new FakeOpenAI(), wire.fetch, log.logger, { onUnmetered: "raise" });

    expect(wrapped.constructor).toBe(FakeOpenAI);
    expect(wrapped.constructor.name).toBe("FakeOpenAI");
    expect(log.warn).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("evaluates a getter-backed Responses namespace once before reusing its cached proxy", async () => {
    const raw = fakeOpenAI();
    let evaluations = 0;
    class ResponsesResource {
      readonly create = raw.operations.responsesCreate;
      readonly parse = raw.operations.responsesParse;
      readonly stream = raw.operations.responsesStream;
      readonly retrieve = raw.operations.retrieve;
    }
    Object.defineProperty(raw.client, "responses", {
      configurable: true,
      enumerable: true,
      get() {
        evaluations += 1;
        return new ResponsesResource();
      },
    });
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: "raise" });

    const first = wrapped.responses;
    const second = wrapped.responses;

    expect(first).toBe(second);
    expect(evaluations).toBe(1);
    expect(() => Reflect.get(first, "retrieve")).toThrowError(UntrackedSpendSurfaceError);
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("guards a namespace exposed only by a dynamic get trap", async () => {
    const base = fakeOpenAI();
    const dynamicResponses = {
      create: base.operations.responsesCreate,
      retrieve: base.operations.retrieve,
      sibling: base.operations.futureSibling,
    };
    const dynamicClient = new Proxy(
      { chat: base.client.chat },
      {
        get(target, property, receiver) {
          return property === "responses"
            ? dynamicResponses
            : Reflect.get(target, property, receiver);
        },
      },
    );
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(dynamicClient, wire.fetch, log.logger, { onUnmetered: "warn" });

    const guarded = (wrapped as unknown as { responses: typeof dynamicResponses }).responses;
    expect(guarded).not.toBe(dynamicResponses);
    expect(guarded.retrieve()).toBe("retrieved");
    expect(guarded.sibling()).toBe("future");
    expect(log.warn).toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls.some((call) => call.path === UNTRACKED_REPORT_PATH)).toBe(true);
  });

  it("refuses a statically invisible dynamic namespace despite a matching has trap", async () => {
    const base = fakeOpenAI();
    let getCalls = 0;
    const dynamicClient = new Proxy(
      { chat: base.client.chat },
      {
        has(target, property) {
          return property === "responses" || Reflect.has(target, property);
        },
        get(target, property, receiver) {
          if (property === "responses") {
            getCalls += 1;
            return base.responses;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(dynamicClient, wire.fetch, log.logger, { onUnmetered: "raise" });

    // A positive has trap cannot establish a safe static namespace shape.
    expect(() => Reflect.get(wrapped, "responses")).toThrowError(UntrackedSpendSurfaceError);
    expect(getCalls).toBe(0);
    expect(base.operations.retrieve).not.toHaveBeenCalled();
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it.each([
    { posture: "warn" as const, hits: 2, warnings: 1 },
    { posture: "allow" as const, hits: 3, warnings: 0 },
  ])("$posture passes through and reports the immediate occurrence delta without metering I/O", async ({
    posture,
    hits,
    warnings,
  }) => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: posture });

    for (let index = 0; index < hits; index += 1) {
      expect(wrapped.responses.retrieve()).toBe("retrieved");
    }
    await wrapped.close();

    expect(raw.operations.retrieve).toHaveBeenCalledTimes(hits);
    expect(log.warn).toHaveBeenCalledTimes(warnings);
    expect(wire.calls.map((call) => call.path)).toEqual([UNTRACKED_REPORT_PATH]);
    expect(wire.calls[0]?.body).toEqual([
      expect.objectContaining({
        provider: "openai",
        client_shape: "openai_sdk",
        mode: "async",
        surface: "responses.retrieve",
        rule_kind: "unmetered_spend",
        capability_scope: "operation",
        posture,
        occurrences: 1,
      }),
    ]);
  });

  it("allows an exact responses.retrieve acknowledgment while keeping the namespace and sibling guarded", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, {
      onUnmetered: "raise",
      acknowledgeUntracked: ["responses.retrieve"],
    });

    const responses = wrapped.responses;
    expect(Object.is(responses, wrapped.responses)).toBe(true);
    expect(Object.is(responses, raw.responses)).toBe(false);
    expect(responses.retrieve()).toBe("retrieved");
    expect(() => Reflect.get(responses, "futureSibling")).toThrowError(UntrackedSpendSurfaceError);

    expect(raw.operations.retrieve).toHaveBeenCalledOnce();
    expect(raw.operations.futureSibling).not.toHaveBeenCalled();
    await wrapped.close();
    expect(log.warn).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
  });

  it("allows an exact live unknown terminal while keeping its unknown parent and sibling guarded", async () => {
    const raw = fakeOpenAI();
    const create = vi.fn(() => "uploaded");
    const sibling = vi.fn(() => "untracked");
    const files = { create, sibling };
    Object.assign(raw.client, { files });
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, {
      onUnmetered: "raise",
      acknowledgeUntracked: ["files.create"],
      reportUntrackedSurfaces: false,
    }) as unknown as {
      readonly files: typeof files;
      close(): Promise<void>;
    };

    const guardedFiles = wrapped.files;
    expect(Object.is(guardedFiles, wrapped.files)).toBe(true);
    expect(Object.is(guardedFiles, files)).toBe(false);
    expect(guardedFiles.create()).toBe("uploaded");
    expect(() => Reflect.get(guardedFiles, "sibling")).toThrowError(UntrackedSpendSurfaceError);

    expect(create).toHaveBeenCalledOnce();
    expect(sibling).not.toHaveBeenCalled();
    await wrapped.close();
    expect(log.warn).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
  });

  it.each([
    {
      token: "opaque.allowed",
      extend(client: Record<string, unknown>) {
        const opaque = Object.assign(new Date(0), { allowed: vi.fn() });
        Object.assign(client, { opaque });
      },
      message: "unknown prefix 'opaque' is not guardable",
    },
    {
      token: "files",
      extend(client: Record<string, unknown>) {
        Object.assign(client, { files: { create: vi.fn() } });
      },
      message: "names a resource container",
    },
  ])("rejects unguardable/resource acknowledgment token $token", ({ token, extend, message }) => {
    const raw = fakeOpenAI();
    extend(raw.client as unknown as Record<string, unknown>);
    const wire = wireRecorder();
    const log = recordingLogger();

    expect(
      () =>
        new Solwyn(raw.client, {
          ...PUBLIC_SURFACE_OPTIONS,
          fetch: wire.fetch,
          logger: log.logger,
          acknowledgeUntracked: [token],
        }),
    ).toThrowError(ConfigurationError);
    expect(
      () =>
        new Solwyn(raw.client, {
          ...PUBLIC_SURFACE_OPTIONS,
          fetch: wire.fetch,
          logger: log.logger,
          acknowledgeUntracked: [token],
        }),
    ).toThrowError(message);
    expect(wire.calls).toEqual([]);
  });

  it("keeps local warn posture when advisory reporting is disabled", async () => {
    const raw = fakeOpenAI();
    const futureExport = vi.fn(() => "exported");
    Object.assign(raw.client, { futureExport });
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, {
      onUnmetered: "warn",
      reportUntrackedSurfaces: false,
    });

    const exposed = Reflect.get(wrapped, "futureExport");
    expect(typeof exposed).toBe("function");
    expect(Reflect.apply(exposed as (...args: unknown[]) => unknown, raw.client, [])).toBe(
      "exported",
    );
    await wrapped.close();

    expect(futureExport).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(wire.calls).toEqual([]);
  });

  it("forwards set, delete, and defineProperty on a guarded namespace without read posture", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger, { onUnmetered: "raise" });
    const responses = wrapped.responses;

    expect(Reflect.set(responses, "futureSetting", "enabled")).toBe(true);
    expect(
      Reflect.defineProperty(responses, "futureDefined", {
        configurable: true,
        enumerable: true,
        value: "defined",
        writable: true,
      }),
    ).toBe(true);
    expect(Reflect.deleteProperty(responses, "removeMe")).toBe(true);

    expect(Reflect.get(raw.responses, "futureSetting")).toBe("enabled");
    expect(Reflect.get(raw.responses, "futureDefined")).toBe("defined");
    expect(Reflect.has(raw.responses, "removeMe")).toBe(false);
    await wrapped.close();
    expect(log.warn).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
  });
});

describe("public coverage integration", () => {
  it("works immediately on a new wrapper without invoking a provider operation", async () => {
    const raw = fakeOpenAI();
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = wrap(raw.client, wire.fetch, log.logger);

    const first = coverage(wrapped);
    const second = coverage(wrapped);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first).toMatchObject({
      provider: "openai",
      dialect: "openai",
      clientShape: "openai_sdk",
      posture: "warn",
      acknowledgments: [],
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(() => coverage(raw.client)).toThrowError(TypeError);
    for (const operation of Object.values(raw.operations)) {
      expect(operation).not.toHaveBeenCalled();
    }
    await wrapped.close();
    expect(wire.calls).toEqual([]);
  });

  it("refreshes lazy compat attribution in coverage and posture before first dispatch", async () => {
    const raw = fakeOpenAI();
    const client = raw.client as typeof raw.client & { baseURL?: string };
    const wire = wireRecorder();
    const log = recordingLogger();
    const wrapped = new Solwyn(client, {
      apiKey: API_KEY,
      fetch: wire.fetch,
      logger: log.logger,
      model: MODEL,
      onUnmetered: "raise",
      reportUntrackedSurfaces: false,
    });
    clientsToClose.push(wrapped);

    expect(coverage(wrapped).provider).toBe("openai");
    client.baseURL = "https://api.groq.com/openai/v1";

    expect(coverage(wrapped)).toMatchObject({
      provider: "groq",
      providerChain: [{ provider: "groq", dialect: "openai", clientShape: "openai_sdk" }],
    });
    const responses = (wrapped as unknown as { responses: object }).responses;
    expect(() => Reflect.get(responses, "create")).toThrowError(UntrackedSpendSurfaceError);
    expect(raw.operations.responsesCreate).not.toHaveBeenCalled();
    expect(wire.calls).toEqual([]);
  });
});
