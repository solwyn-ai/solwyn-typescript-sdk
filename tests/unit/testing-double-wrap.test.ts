import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SolwynOptions } from "../../src/client";
import * as configModule from "../../src/config";
import { BudgetExceededError, ConfigurationError, RunStoppedError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { run } from "../../src/node";
import * as fakeModule from "../../src/testing/fake-control-plane";
import * as testingModule from "../../src/testing/index";
import type { FetchLike } from "../../src/transport";

interface OpenAIShape {
  chat: {
    completions: {
      create(kwargs: Record<string, unknown>): Promise<unknown> | unknown;
    };
  };
}

interface WrappedOpenAI extends OpenAIShape {
  close(): Promise<void>;
}

interface WrappablePlane {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly checks: readonly { model?: string }[];
  readonly leaseGrants: readonly { model?: string }[];
  readonly breakerReports: ReadonlyArray<Record<string, unknown>>;
  wrap<C extends object>(client: C, options?: SolwynOptions): C & { close(): Promise<void> };
}

type FakeControlPlaneConstructor = new (
  options?: Record<string, unknown>,
) => WrappablePlane & {
  denyNext(n?: number): void;
};

function plane(options?: Record<string, unknown>): WrappablePlane {
  const Constructor = testingModule.FakeControlPlane as unknown as FakeControlPlaneConstructor;
  return new Constructor(options);
}

function successClient() {
  const create = vi.fn((_kwargs: Record<string, unknown>) => ({
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  }));
  return { client: { chat: { completions: { create } } }, create };
}

function denialOnlyClient(): OpenAIShape {
  const factory = (testingModule as unknown as { denialOnlyOpenAIClient?: () => OpenAIShape })
    .denialOnlyOpenAIClient;
  if (factory === undefined) {
    throw new Error("denialOnlyOpenAIClient is missing");
  }
  return factory();
}

async function call(client: WrappedOpenAI, model: string): Promise<unknown> {
  return client.chat.completions.create({ model });
}

describe("FakeControlPlane.wrap wiring", () => {
  it("surrenders the live lease on wrapped close through the injected control-plane fetch", async () => {
    const controlPlane = new testingModule.FakeControlPlane({ grantedTokens: 100 });
    const provider = successClient();
    const wrapped = controlPlane.wrap(provider.client, { leaseEnabled: true });
    try {
      await run("testing-close-surrender", async () => {
        await wrapped.chat.completions.create({ model: "gpt-4o", max_tokens: 10 });
        expect(controlPlane.leaseGrants).toHaveLength(1);
        expect(controlPlane.checks).toEqual([]);
        await wrapped.close();
      });
      expect(controlPlane.unmatchedRequests).toEqual([]);
      expect(controlPlane.leaseSurrenders).toEqual([
        {
          lease_id: "lse_fake1",
          holder_id: controlPlane.leaseGrants[0]?.holder_id,
          generation: 1,
          spent_tokens: 3,
        },
      ]);
      expect(
        controlPlane.handle(
          "POST",
          "/api/v1/budgets/lease/surrender",
          controlPlane.leaseSurrenders[0],
        ),
      ).toMatchObject({ status: 200, body: { released_tokens: 0 } });
    } finally {
      await wrapped.close();
    }
  });

  it.each([
    "apiKey",
    "apiUrl",
    "fetch",
  ] as const)("rejects an own %s key even when its value is undefined", (key) => {
    const controlPlane = plane();
    const { client } = successClient();
    expect(() => controlPlane.wrap(client, { [key]: undefined })).toThrow(
      new TypeError(`reserved control-plane wiring cannot be overridden: ${key}`),
    );
  });

  it("builds hermetic wrap options from an injected snapshot without reading its values", () => {
    const controlPlane = plane();
    const snapshot = Object.fromEntries(
      Object.values(
        (configModule as unknown as { ENV_FIELD_MAP?: Record<string, string> }).ENV_FIELD_MAP ?? {},
      ).map((name) => [name, "poisoned ambient value"]),
    );
    const build = (
      fakeModule as unknown as {
        buildHermeticWrapOptions?: (
          wiring: Pick<WrappablePlane, "apiKey" | "apiUrl" | "fetch">,
          env: Readonly<Record<string, string | undefined>>,
          options?: SolwynOptions,
        ) => SolwynOptions;
      }
    ).buildHermeticWrapOptions;

    expect(typeof build).toBe("function");
    expect(build?.(controlPlane, snapshot)).toMatchObject({
      apiKey: controlPlane.apiKey,
      apiUrl: controlPlane.apiUrl,
      fetch: controlPlane.fetch,
      failOpen: true,
      budgetMode: "alert_only",
      budgetCheckTimeout: 1,
      controlPlaneFailureThreshold: 3,
      controlPlaneRecoveryTimeout: 30,
      breakerReportingEnabled: true,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerRecoveryTimeout: 60,
      circuitBreakerSuccessThreshold: 2,
      budgetCheckCacheTtl: 0,
      reporterBatchSize: 50,
      reporterFlushInterval: 5,
      reporterMaxQueueSize: 10_000,
      reporterMaxInFlight: 3,
      reporterMaxSendAttempts: 5,
      reporterRetryBackoffBase: 1,
      reporterRetryBackoffCap: 60,
      reporterShutdownDeadline: 5,
      breakerReportHeartbeat: 60,
      velocityMode: "warn",
      velocityRepeatCount: 5,
      velocityRepeatWindowS: 60,
      velocityGrowthStreak: 8,
      velocityGrowthFactor: 3,
      velocityAccelFloorPerMin: 30,
      velocityAccelFactor: 3,
    });
    expect(
      build?.(controlPlane, snapshot, { budgetCheckCacheTtl: 19, failOpen: false }),
    ).toMatchObject({
      budgetCheckCacheTtl: 19,
      failOpen: false,
    });
    expect(
      build?.(controlPlane, snapshot, {
        budgetCheckCacheTtl: undefined,
        failOpen: undefined,
      }),
    ).toMatchObject({ budgetCheckCacheTtl: 0, failOpen: true });
  });

  it("neutralizes ambient SOLWYN_TAGS while preserving explicit caller tags", () => {
    const controlPlane = plane();
    const build = fakeModule.buildHermeticWrapOptions;
    expect(build(controlPlane, { SOLWYN_TAGS: "ambient=poison" })).toMatchObject({ tags: {} });
    expect(
      build(controlPlane, { SOLWYN_TAGS: "ambient=poison" }, { tags: { explicit: "wins" } }),
    ).toMatchObject({ tags: { explicit: "wins" } });
  });

  it("preserves unknown undefined keys so normal option validation still rejects them", () => {
    const controlPlane = plane();
    const { client } = successClient();
    expect(() =>
      controlPlane.wrap(client, { unexpected: undefined } as unknown as SolwynOptions),
    ).toThrow(new ConfigurationError("unexpected option 'unexpected'", { field: "unexpected" }));
  });

  it("keeps direct config resolution environment-aware through an injected snapshot", () => {
    const apiKey = `sk_proj_${"a".repeat(64)}`;
    const direct = configModule.resolveConfigFromEnvSnapshot(
      { api_key: apiKey },
      {
        SOLWYN_API_URL: "https://ambient.invalid",
        SOLWYN_FAIL_OPEN: "false",
        SOLWYN_BUDGET_CHECK_CACHE_TTL: "77",
      },
    );
    expect(direct.api_url).toBe("https://ambient.invalid");
    expect(direct.fail_open).toBe(false);
    expect(direct.budget_check_cache_ttl).toBe(77);
    expect(typeof (configModule as unknown as { getEnvSnapshot?: unknown }).getEnvSnapshot).toBe(
      "function",
    );
  });

  it("disables budget caching by default but lets caller TTL win", async () => {
    const uncachedPlane = plane();
    const uncachedProvider = successClient();
    const uncached = uncachedPlane.wrap(uncachedProvider.client) as WrappedOpenAI;
    await call(uncached, "gpt-4o");
    await call(uncached, "gpt-4o");
    await uncached.close();
    expect(uncachedPlane.checks).toHaveLength(2);
    expect(uncachedProvider.create).toHaveBeenCalledTimes(2);

    const cachedPlane = plane();
    const cachedProvider = successClient();
    const cached = cachedPlane.wrap(cachedProvider.client, {
      budgetCheckCacheTtl: 60,
    } as SolwynOptions) as WrappedOpenAI;
    await call(cached, "gpt-4o");
    await call(cached, "gpt-4o");
    await cached.close();
    expect(cachedPlane.checks).toHaveLength(1);
    expect(cachedProvider.create).toHaveBeenCalledTimes(2);
  });

  it("reports provider breaker state on close without including the control-plane breaker", async () => {
    const controlPlane = plane();
    const provider = successClient();
    const wrapped = controlPlane.wrap(provider.client) as WrappedOpenAI;
    await call(wrapped, "gpt-4o");
    await wrapped.close();

    expect(controlPlane.breakerReports).toHaveLength(1);
    expect(controlPlane.breakerReports[0]).toMatchObject({
      provider: "openai",
      state: "closed",
      failure_count: 0,
      success_count: 0,
    });
    expect(Object.keys(controlPlane.breakerReports[0] ?? {}).sort()).toEqual([
      "failure_count",
      "provider",
      "reported_at",
      "sdk_instance_id",
      "state",
      "success_count",
    ]);
  });

  it("preserves W1a proxy branding, provider instanceof, and double-wrap rejection", async () => {
    class FakeOpenAI {
      readonly chat = successClient().client.chat;
    }
    const controlPlane = plane();
    const raw = new FakeOpenAI();
    const wrapped = controlPlane.wrap(raw);
    expect(wrapped).toBeInstanceOf(FakeOpenAI);
    expect(wrapped).toBeInstanceOf(Solwyn);
    expect(() => controlPlane.wrap(wrapped)).toThrow(
      new ConfigurationError("client is already wrapped by Solwyn — pass the raw provider client", {
        field: "client",
      }),
    );
    await wrapped.close();
  });

  it("preserves image-edit and tracked-speech internal markers through the testing wrapper", async () => {
    const generate = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const edit = vi.fn((_kwargs: Record<string, unknown>) => ({ data: [] }));
    const speech = vi.fn((_kwargs: Record<string, unknown>) => ({ id: "speech" }));
    const transcriptions = vi.fn((_kwargs: Record<string, unknown>) => ({ id: "transcription" }));
    const provider = {
      chat: { completions: { create: vi.fn() } },
      images: { generate, edit },
      audio: {
        speech: { create: speech },
        transcriptions: { create: transcriptions },
      },
    };
    const wrapped = plane().wrap(provider) as typeof provider & { close(): Promise<void> };

    await wrapped.images.edit({ model: "gpt-image-1", _solwyn_image_op: "generate" });
    await wrapped.audio.speech.create({
      model: "gpt-4o-tts",
      _solwyn_audio_op: "transcriptions",
    });
    await wrapped.close();

    expect(edit).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    expect(speech).toHaveBeenCalledOnce();
    expect(transcriptions).not.toHaveBeenCalled();
  });

  it("keeps W1a's plain-Promise intercepted return type", () => {
    interface RichPromise<T> extends Promise<T> {
      withResponse(): Promise<{ data: T }>;
    }
    interface RichClient {
      chat: {
        completions: {
          create(kwargs: { model: string }): RichPromise<{ id: string }>;
        };
      };
    }
    const _typeAssertions = (
      controlPlane: InstanceType<typeof fakeModule.FakeControlPlane>,
      raw: RichClient,
    ): void => {
      const wrapped = controlPlane.wrap(raw);
      expectTypeOf<ReturnType<typeof wrapped.chat.completions.create>>().not.toHaveProperty(
        "withResponse",
      );
      expectTypeOf<ReturnType<typeof raw.chat.completions.create>>().toHaveProperty("withResponse");
    };
    void _typeAssertions;
    expect(typeof Solwyn).toBe("function");
  });
});

describe("testing model guard", () => {
  it("rejects an unknown per-call magic model before plane traffic or provider dispatch", async () => {
    const controlPlane = plane();
    const provider = successClient();
    const wrapped = controlPlane.wrap(provider.client) as WrappedOpenAI;
    await expect(call(wrapped, "solwyn-test/not-reserved")).rejects.toThrow(
      /^solwyn\.testing: unknown magic model 'solwyn-test\/not-reserved'$/,
    );
    expect(controlPlane.checks).toEqual([]);
    expect(provider.create).not.toHaveBeenCalled();
    await wrapped.close();
  });

  it("prevalidates the entire primary/fallback chain before choosing the first magic", async () => {
    const controlPlane = plane();
    const primary = successClient();
    const fallback = successClient();
    const wrapped = controlPlane.wrap(primary.client, {
      fallback: [[fallback.client, "solwyn-test/not-reserved"]],
    }) as WrappedOpenAI;
    await expect(call(wrapped, "solwyn-test/deny")).rejects.toThrow(
      /^solwyn\.testing: unknown magic model 'solwyn-test\/not-reserved'$/,
    );
    expect(controlPlane.checks).toEqual([]);
    expect(primary.create).not.toHaveBeenCalled();
    expect(fallback.create).not.toHaveBeenCalled();
    await wrapped.close();
  });

  it.each([
    "solwyn-test/deny-stopped",
    "solwyn-test/runaway",
    "solwyn-test/kill",
  ])("requires an open run for %s before any plane/provider work", async (model) => {
    const controlPlane = plane();
    const provider = successClient();
    const wrapped = controlPlane.wrap(provider.client) as WrappedOpenAI;
    await expect(call(wrapped, model)).rejects.toThrow(
      new RegExp(`^solwyn\\.testing: run-scoped magic model '${model}' requires an open run$`),
    );
    expect(controlPlane.checks).toEqual([]);
    expect(provider.create).not.toHaveBeenCalled();
    await wrapped.close();
  });

  it("guards fallback and media model names before dispatch", async () => {
    const controlPlane = plane();
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 1 },
    }));
    const provider = {
      chat: { completions: { create: vi.fn() } },
      embeddings: { create },
    };
    const fallback = successClient();
    const wrapped = controlPlane.wrap(provider, {
      fallback: [[fallback.client, "solwyn-test/runaway"]],
    }) as typeof provider & { close(): Promise<void> };
    await expect(wrapped.embeddings.create({ model: "embedding-model" })).rejects.toThrow(
      /^solwyn\.testing: run-scoped magic model 'solwyn-test\/runaway' requires an open run$/,
    );
    expect(controlPlane.checks).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    await wrapped.close();
  });

  it("mirrors defaultParams and explicit nullish model precedence before super", async () => {
    const defaultMagicPlane = plane();
    const defaultMagicProvider = successClient();
    const defaultMagic = defaultMagicPlane.wrap(defaultMagicProvider.client, {
      model: "constructor-model",
      defaultParams: { model: "solwyn-test/not-reserved" },
    }) as WrappedOpenAI;
    await expect(defaultMagic.chat.completions.create({})).rejects.toThrow(
      /^solwyn\.testing: unknown magic model 'solwyn-test\/not-reserved'$/,
    );
    expect(defaultMagicPlane.checks).toEqual([]);
    expect(defaultMagicProvider.create).not.toHaveBeenCalled();
    await defaultMagic.close();

    const maskedPlane = plane();
    const maskedProvider = successClient();
    const masked = maskedPlane.wrap(maskedProvider.client, {
      model: "solwyn-test/runaway",
      defaultParams: { model: "gpt-4o" },
    }) as WrappedOpenAI;
    await masked.chat.completions.create({});
    expect(maskedPlane.checks).toHaveLength(1);
    expect(maskedProvider.create).toHaveBeenCalledTimes(1);
    await expect(masked.chat.completions.create({ model: null })).rejects.toThrow(
      /^solwyn\.testing: run-scoped magic model 'solwyn-test\/runaway' requires an open run$/,
    );
    await masked.close();
  });

  it.each([
    "solwyn-test/not-reserved",
    "solwyn-test/runaway",
  ])("guards speech native bypass fallback %s before provider dispatch", async (fallbackModel) => {
    const controlPlane = plane();
    const nativeCreate = vi.fn((_kwargs: Record<string, unknown>) => ({ id: "audio" }));
    const provider = {
      chat: { completions: { create: vi.fn() } },
      audio: { speech: { create: nativeCreate } },
    };
    const fallback = successClient();
    const wrapped = controlPlane.wrap(provider, {
      fallback: [[fallback.client, fallbackModel]],
    }) as typeof provider & { close(): Promise<void> };
    await expect(wrapped.audio.speech.create({ model: "gpt-4o-mini-tts" })).rejects.toThrow(
      /^solwyn\.testing:/,
    );
    expect(controlPlane.checks).toEqual([]);
    expect(nativeCreate).not.toHaveBeenCalled();
    await wrapped.close();
  });

  it("lets a magic fallback hard-deny a denial-only client before dispatch", async () => {
    const controlPlane = plane();
    const wrapped = controlPlane.wrap(denialOnlyClient(), {
      fallback: [[denialOnlyClient(), "solwyn-test/deny"]],
    }) as WrappedOpenAI;
    await expect(call(wrapped, "gpt-4o")).rejects.toBeInstanceOf(BudgetExceededError);
    expect(controlPlane.checks).toHaveLength(1);
    await wrapped.close();
  });

  it("forces deny-stopped to hard deny inside a run even on an alert-only plane", async () => {
    const controlPlane = plane({ mode: "alert_only" });
    const wrapped = controlPlane.wrap(denialOnlyClient()) as WrappedOpenAI;
    await run("testing-deny-stopped", async () => {
      await expect(call(wrapped, "solwyn-test/deny-stopped")).rejects.toBeInstanceOf(
        RunStoppedError,
      );
    });
    await wrapped.close();
  });

  it("keeps runaway's two-call denial on the explicit check-only path", async () => {
    const controlPlane = plane();
    const provider = successClient();
    const wrapped = controlPlane.wrap(provider.client, { leaseEnabled: false }) as WrappedOpenAI;
    await run("testing-runaway", async () => {
      await call(wrapped, "solwyn-test/runaway");
      await expect(call(wrapped, "solwyn-test/runaway")).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
    await wrapped.close();
  });

  it("keeps lease-ineligible transparent but kills an open run after its first dispatched call", async () => {
    const controlPlane = plane();
    const wrapped = controlPlane.wrap(denialOnlyClient(), {
      circuitBreakerFailureThreshold: 99,
      leaseEnabled: false,
    }) as WrappedOpenAI;
    const sentinel = /^solwyn\.testing: denial-only client reached provider dispatch$/;
    await expect(call(wrapped, "solwyn-test/lease-ineligible")).rejects.toThrow(sentinel);
    await expect(call(wrapped, "solwyn-test/lease-ineligible")).rejects.toThrow(sentinel);
    await run("testing-kill", async () => {
      await expect(call(wrapped, "solwyn-test/kill")).rejects.toThrow(sentinel);
      await expect(call(wrapped, "solwyn-test/kill")).rejects.toBeInstanceOf(RunStoppedError);
    });
    expect(controlPlane.leaseGrants).toEqual([]);
    expect(controlPlane.checks.map((request) => request.model)).toEqual(
      expect.arrayContaining(["solwyn-test/lease-ineligible"]),
    );
    await wrapped.close();
  });

  it("keeps lease-ineligible transparent for a run without granting it lease authority", async () => {
    const controlPlane = plane();
    const wrapped = controlPlane.wrap(denialOnlyClient(), {
      circuitBreakerFailureThreshold: 99,
    }) as WrappedOpenAI;
    const sentinel = /^solwyn\.testing: denial-only client reached provider dispatch$/;

    await run("testing-lease-ineligible", async () => {
      await expect(call(wrapped, "solwyn-test/lease-ineligible")).rejects.toThrow(sentinel);
      await expect(call(wrapped, "solwyn-test/lease-ineligible")).rejects.toThrow(sentinel);
    });

    expect(controlPlane.leaseGrants.map((request) => request.model)).toEqual([
      "solwyn-test/lease-ineligible",
    ]);
    expect(controlPlane.checks).toHaveLength(2);
    await wrapped.close();
  });
});
