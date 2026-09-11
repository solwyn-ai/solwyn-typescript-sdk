import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, budgetCheckResult } from "../../src/budget";
import { CircuitBreakerManager } from "../../src/circuit-breaker";
import { SolwynCore } from "../../src/client";
import * as errors from "../../src/errors";
import { currentRun, run } from "../../src/node";
import { __resetAdapterRegistry, __setAdapterLoadersForTesting } from "../../src/providers/index";
import type {
  CreateStreamAccumulatorOptions,
  Dialect,
  EstimateMissingUsageOptions,
  PrepareCallOptions,
  PreparedDispatch,
  ProviderAdapter,
  StreamUsageAccumulator,
} from "../../src/providers/protocol";
import { MetadataReporter } from "../../src/reporter";
import { Deadline, type SelectionPolicy } from "../../src/routing";
import { markTerminated, resetRunControlForTest } from "../../src/run-control";
import { createTokenDetails, type TokenDetails, zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { MediaUsage, Modality } from "../../src/types";
import { VelocityMonitor } from "../../src/velocity";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

/** Media-only adapter fixture carried by a declared OpenAI-shaped SDK client. */
function declaredMediaClient<T>(create: T) {
  return {
    chat: { completions: { create: vi.fn() } },
    media: { create },
  };
}

interface TestMediaSpec {
  surface: string;
  modality: Modality;
  extractUsage(response: unknown): TokenDetails | null;
  measureRequest(kwargs: Record<string, unknown>): TokenDetails | null;
  measureMedia(kwargs: Record<string, unknown>, response: unknown): MediaUsage | null;
  estimateMedia(kwargs: Record<string, unknown>): MediaUsage | null;
}

interface MediaCallableCore {
  mediaCall(
    spec: TestMediaSpec,
    kwargs: Record<string, unknown>,
    passthroughArgs?: readonly unknown[],
  ): Promise<unknown>;
}

interface CapturedWire {
  checks: Array<Record<string, unknown>>;
  confirms: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

function makeFetch(
  allowed = true,
  reservationId = "res_media",
  deniedByPeriod = "monthly",
  priceHints: Record<string, number> | null = null,
): {
  fetch: ReturnType<typeof vi.fn<FetchLike>>;
  wire: CapturedWire;
} {
  const wire: CapturedWire = { checks: [], confirms: [], events: [] };
  const impl: FetchLike = async (url, init) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown> | Array<Record<string, unknown>>)
        : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      wire.checks.push(body as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          allowed,
          remaining_budget: allowed ? 100 : 0,
          reservation_id: allowed ? reservationId : null,
          mode: allowed ? "alert_only" : "hard_deny",
          budget_limit: 100,
          current_usage: allowed ? 0 : 100,
          denied_by_period: allowed ? null : deniedByPeriod,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: priceHints,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      wire.confirms.push(body as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest")) {
      wire.events.push(...(body as Array<Record<string, unknown>>));
      return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
    }
    throw new Error(`unexpected test URL: ${url}`);
  };
  return { fetch: vi.fn(impl), wire };
}

function accumulator(): StreamUsageAccumulator {
  return {
    observe: () => {},
    finalize: () => zeroTokenDetails(),
    getServiceTier: () => null,
  };
}

class MediaAdapter implements ProviderAdapter {
  readonly name = "openai";
  readonly dialect: Dialect = "openai";
  readonly prepareMediaCalls: Array<Record<string, unknown>> = [];

  constructor(private readonly supportsMedia = true) {}

  detectClient(client: unknown): boolean {
    return typeof (client as { media?: { create?: unknown } })?.media?.create === "function";
  }
  detectModel(): boolean {
    return true;
  }
  extractUsage(): TokenDetails {
    return zeroTokenDetails();
  }
  estimateMissingUsage(
    _response: unknown,
    _options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    return null;
  }
  extractServiceTier(): string | null {
    return null;
  }
  extractRegion(): string | null {
    return "us-east-1";
  }
  prepareStreaming(kwargs: Record<string, unknown>): Record<string, unknown> {
    return { ...kwargs };
  }
  createStreamAccumulator(_options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    return accumulator();
  }
  prepareCall(
    _client: unknown,
    _kwargs: Record<string, unknown>,
    _options: PrepareCallOptions,
  ): PreparedDispatch {
    throw new Error("chat dispatch must not be used by mediaCall");
  }
  prepareMediaCall(
    surface: string,
    client: unknown,
    kwargs: Record<string, unknown>,
    options: { timeout: number; maxRetries: number },
  ): { method: (...args: unknown[]) => unknown; kwargs: Record<string, unknown> } {
    if (!this.supportsMedia) {
      throw new (
        errors as unknown as { UnsupportedSurfaceError: new (o: object) => Error }
      ).UnsupportedSurfaceError({ surface, provider: this.name });
    }
    this.prepareMediaCalls.push({ surface, ...options });
    const method = (client as { media: { create: (...args: unknown[]) => unknown } }).media.create;
    return { method: method.bind((client as { media: object }).media), kwargs: { ...kwargs } };
  }
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }
  wrapStreamResult(wrapper: unknown): unknown {
    return wrapper;
  }
}

class NoMediaAdapter implements ProviderAdapter {
  readonly name = "openai";
  readonly dialect: Dialect = "openai";

  detectClient(client: unknown): boolean {
    return typeof (client as { media?: { create?: unknown } })?.media?.create === "function";
  }
  detectModel(): boolean {
    return true;
  }
  extractUsage(): TokenDetails {
    return zeroTokenDetails();
  }
  estimateMissingUsage(): TokenDetails | null {
    return null;
  }
  extractServiceTier(): string | null {
    return null;
  }
  extractRegion(): string | null {
    return null;
  }
  prepareStreaming(kwargs: Record<string, unknown>): Record<string, unknown> {
    return { ...kwargs };
  }
  createStreamAccumulator(): StreamUsageAccumulator {
    return accumulator();
  }
  prepareCall(): PreparedDispatch {
    throw new Error("chat dispatch must not be used by mediaCall");
  }
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }
  wrapStreamResult(wrapper: unknown): unknown {
    return wrapper;
  }
}

class ChatAndMediaAdapter extends MediaAdapter {
  override prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    _options: PrepareCallOptions,
  ): PreparedDispatch {
    const completions = (
      client as { chat: { completions: { create: (...args: unknown[]) => unknown } } }
    ).chat.completions;
    return (...args) => completions.create({ ...kwargs }, ...args);
  }
}

function mediaSpec(overrides: Partial<TestMediaSpec> = {}): TestMediaSpec {
  return {
    surface: "embeddings",
    modality: "embedding",
    extractUsage: () => createTokenDetails({ input_tokens: 12, output_tokens: 0 }),
    measureRequest: () => createTokenDetails({ input_tokens: 3, is_estimated: true }),
    measureMedia: () => ({ image_count: 2, is_estimated: false }),
    estimateMedia: () => ({ image_count: 1, is_estimated: true }),
    ...overrides,
  };
}

afterEach(() => {
  __resetAdapterRegistry();
  resetRunControlForTest();
  vi.restoreAllMocks();
});

describe("mediaCall lifecycle", () => {
  it("shares one velocity monitor across chat and media calls on the same client", async () => {
    const adapter = new ChatAndMediaAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const order: string[] = [];
    const originalObserve = VelocityMonitor.prototype.observe;
    const observe = vi.spyOn(VelocityMonitor.prototype, "observe").mockImplementation(function (
      this: VelocityMonitor,
      observation,
    ) {
      order.push("velocity");
      return originalObserve.call(this, observation);
    });
    const originalCheckBudget = BudgetEnforcer.prototype.checkBudget;
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockImplementation(function (this: BudgetEnforcer, request) {
        order.push("budget");
        return originalCheckBudget.call(this, request);
      });
    const originalReplaceTotal = Deadline.prototype.replaceTotal;
    const replaceTotal = vi.spyOn(Deadline.prototype, "replaceTotal").mockImplementation(function (
      this: Deadline,
      total,
    ) {
      order.push("tuning");
      return originalReplaceTotal.call(this, total);
    });
    const originalObserveProject = MetadataReporter.prototype.observeProjectId;
    const observeProject = vi
      .spyOn(MetadataReporter.prototype, "observeProjectId")
      .mockImplementation(function (this: MetadataReporter, projectId) {
        order.push("project");
        return originalObserveProject.call(this, projectId);
      });
    const client = {
      chat: {
        completions: {
          create: vi.fn(() => {
            order.push("dispatch-chat");
            return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
          }),
        },
      },
      media: {
        create: vi.fn(() => {
          order.push("dispatch-media");
          return { usage: { input_tokens: 1, output_tokens: 0 } };
        }),
      },
    };
    const { fetch } = makeFetch(true, "res-shared");
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: false,
      velocityMode: "warn",
    });

    let contexts: unknown[] = [];
    try {
      await run("shared-monitor", async () => {
        await core.interceptedCall("chat", { model: "gpt-4o", messages: [] });
        await (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
          model: "embed-model",
        });
      });
      contexts = [...observe.mock.contexts];
    } finally {
      observe.mockRestore();
      checkBudget.mockRestore();
      replaceTotal.mockRestore();
      observeProject.mockRestore();
      await core.close();
    }

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(order).toEqual([
      "velocity",
      "budget",
      "tuning",
      "project",
      "dispatch-chat",
      "velocity",
      "budget",
      "tuning",
      "project",
      "dispatch-media",
    ]);
  });

  it.each([
    "chat",
    "media",
  ] as const)("finishes the %s post-check before tuning, project observation, selection, preparation, or dispatch", async (surface) => {
    const adapter = new ChatAndMediaAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const phaseOrder: string[] = [];
    let runId = "";
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockImplementation(async (request) => {
        phaseOrder.push("budget");
        runId = request.agentRunId ?? "";
        markTerminated(runId, { reason: "during_budget", source: "local_velocity" });
        return budgetCheckResult({
          allowed: true,
          remainingBudget: 100,
          leaseId: "lease-postcheck-order",
          leaseClaimToken: 91,
          failoverTuningAllowed: false,
        });
      });
    const release = vi
      .spyOn(BudgetEnforcer.prototype, "releaseReservation")
      .mockImplementation(() => {
        phaseOrder.push("postcheck-release");
      });
    const report = vi.spyOn(MetadataReporter.prototype, "report").mockImplementation(() => {
      phaseOrder.push("report");
    });
    const replaceTuning = vi.spyOn(CircuitBreakerManager.prototype, "replaceTuning");
    const replaceTotal = vi.spyOn(Deadline.prototype, "replaceTotal");
    const observeProject = vi.spyOn(MetadataReporter.prototype, "observeProjectId");
    const prepareChat = vi.spyOn(adapter, "prepareCall");
    const prepareMedia = vi.spyOn(adapter, "prepareMediaCall");
    const candidateOrder = vi.fn<SelectionPolicy["order"]>(() => {
      throw new Error("candidate selection must remain behind the post-check");
    });
    const primary = {
      chat: {
        completions: {
          create: vi.fn(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } })),
        },
      },
      media: { create: vi.fn(() => ({ id: "primary-media" })) },
    };
    const fallback = {
      chat: {
        completions: {
          create: vi.fn(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } })),
        },
      },
      media: { create: vi.fn(() => ({ id: "fallback-media" })) },
    };
    const core = new SolwynCore(primary, {
      apiKey: API_KEY,
      fetch: async () => new Response(null, { status: 204 }),
      fallback: [[fallback, "fallback-model"]],
      selectionPolicy: { order: candidateOrder },
      leaseEnabled: false,
      velocityMode: "off",
      failoverTotalTimeout: 91,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    let caught: unknown;
    try {
      await run(`postcheck-order-${surface}`, async () => {
        caught = await (surface === "chat"
          ? core.interceptedCall("chat", { model: "gpt-4o", messages: [] })
          : (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
              model: "embed-model",
            })
        ).catch((error: unknown) => error);
      });
    } finally {
      await core.close();
    }

    expect(caught).toMatchObject({
      name: "RunStoppedError",
      agentRunId: runId,
      reason: "during_budget",
      source: "local_velocity",
    });
    expect(checkBudget).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(expect.any(String), 91);
    expect(report).toHaveBeenCalledOnce();
    expect(phaseOrder).toEqual(["budget", "postcheck-release", "report"]);
    expect(replaceTuning).not.toHaveBeenCalled();
    expect(replaceTotal).not.toHaveBeenCalled();
    expect(observeProject).not.toHaveBeenCalled();
    expect(candidateOrder).not.toHaveBeenCalled();
    expect(prepareChat).not.toHaveBeenCalled();
    expect(prepareMedia).not.toHaveBeenCalled();
    expect(primary.chat.completions.create).not.toHaveBeenCalled();
    expect(primary.media.create).not.toHaveBeenCalled();
    expect(fallback.chat.completions.create).not.toHaveBeenCalled();
    expect(fallback.media.create).not.toHaveBeenCalled();
  });

  it("keeps velocity observation idle for active mode-off and unscoped mode-warn calls", async () => {
    const adapter = new ChatAndMediaAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const observe = vi.spyOn(VelocityMonitor.prototype, "observe");
    const shouldWarn = vi.spyOn(VelocityMonitor.prototype, "shouldWarn");
    const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
    const logger = { debug() {}, info() {}, warn, error() {} };
    const client = {
      chat: {
        completions: {
          create: vi.fn(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } })),
        },
      },
      media: { create: vi.fn(() => ({ usage: { input_tokens: 1, output_tokens: 0 } })) },
    };
    const offFetch = makeFetch(true, "res-off");
    const warnFetch = makeFetch(true, "res-unscoped");
    const offCore = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch: offFetch.fetch,
      leaseEnabled: false,
      velocityMode: "off",
      logger,
    });
    const warnCore = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch: warnFetch.fetch,
      leaseEnabled: false,
      velocityMode: "warn",
      logger,
    });

    try {
      await run("velocity-off", async () => {
        await offCore.interceptedCall("chat", { model: "gpt-4o", messages: [] });
      });
      await (warnCore as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
        model: "embed-model",
      });
    } finally {
      observe.mockRestore();
      await offCore.close();
      await warnCore.close();
    }

    expect(observe).not.toHaveBeenCalled();
    expect(shouldWarn).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([message]) => message === "velocity.flagged: rule=%s run=%s"),
    ).toEqual([]);
  });

  it("observes the exact media velocity payload and pre-gates calls after the threshold", async () => {
    const client = declaredMediaClient(vi.fn(() => ({ id: "media-result" })));
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch(true, "res-media-velocity");
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(42_000);
    const observe = vi.spyOn(VelocityMonitor.prototype, "observe");
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: false,
      velocityMode: "deny",
      velocityRepeatCount: 2,
      velocityRepeatWindowS: 60,
    });

    let runId = "";
    const caught: unknown[] = [];
    let observations: unknown[][] = [];
    try {
      await run("media-velocity-threshold", async () => {
        runId = currentRun()?.agentRunId ?? "";
        await (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
          model: "embed-model",
        });
        for (let index = 0; index < 2; index += 1) {
          caught.push(
            await (core as unknown as MediaCallableCore)
              .mediaCall(mediaSpec(), { model: "embed-model" })
              .catch((error: unknown) => error),
          );
        }
      });
      observations = observe.mock.calls;
    } finally {
      await core.close();
      observe.mockRestore();
      monotonicNow.mockRestore();
    }

    expect(caught[0]).toMatchObject({
      name: "RunStoppedError",
      agentRunId: runId,
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    expect(caught[1]).toMatchObject({
      name: "RunStoppedError",
      agentRunId: runId,
      reason: "velocity:repeat_size",
      source: "local_velocity",
    });
    expect(wire.checks).toHaveLength(1);
    expect(client.media.create).toHaveBeenCalledOnce();
    expect(observations).toEqual([
      [{ runId, estimatedInputTokens: 3, model: "embed-model", now: 42 }],
      [{ runId, estimatedInputTokens: 3, model: "embed-model", now: 42 }],
    ]);
    const denials = wire.events.filter((event) => event["status"] === "budget_denied");
    expect(denials).toHaveLength(2);
    expect(denials).toEqual([
      expect.objectContaining({
        modality: "embedding",
        input_tokens: 3,
        output_tokens: 0,
        media_usage: { image_count: 1, is_estimated: true },
        deny_source: "local_velocity",
        deny_reason: "velocity:repeat_size",
        denied_by_period: "run_stopped",
        velocity_flags: ["repeat_size"],
      }),
      expect.objectContaining({
        modality: "embedding",
        input_tokens: 3,
        output_tokens: 0,
        media_usage: { image_count: 1, is_estimated: true },
        deny_source: "run_terminated",
        deny_reason: "velocity:repeat_size",
        denied_by_period: "run_stopped",
      }),
    ]);
    expect(denials[1]).not.toHaveProperty("velocity_flags");
    for (const denial of denials) {
      expect(denial).not.toHaveProperty("estimated_output_bound");
    }
  });

  it("keeps server-hinted media primary-only without invoking candidate selection", async () => {
    const primary = declaredMediaClient(vi.fn(() => ({ id: "primary-media" })));
    const fallback = declaredMediaClient(vi.fn(() => ({ id: "fallback-media" })));
    const order = vi.fn<SelectionPolicy["order"]>(() => {
      throw new Error("media must not select candidates");
    });
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch } = makeFetch(true, "res_media", "monthly", { openai: 9 });
    const core = new SolwynCore(primary, {
      apiKey: API_KEY,
      fetch,
      fallback: [[fallback, "fallback-media-model"]],
      selectionPolicy: { order },
    });

    const result = await (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
      model: "primary-media-model",
    });
    await core.close();

    expect(result).toEqual({ id: "primary-media" });
    expect(primary.media.create).toHaveBeenCalledOnce();
    expect(fallback.media.create).not.toHaveBeenCalled();
    expect(order).not.toHaveBeenCalled();
  });

  it("checks, dispatches, confirms, and reports the primary with modality/media and one settlement call_id", async () => {
    const response = { id: "media-result" };
    const create = vi.fn(() => response);
    const client = declaredMediaClient(create);
    const adapter = new MediaAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      fallback: [[client, "other"]],
      failoverHopReadTimeout: 42,
    });

    const result = await (core as unknown as MediaCallableCore).mediaCall(
      mediaSpec(),
      { model: "embed-model", opaque: Symbol.for("opaque") },
      [{ signal: "passthrough" }],
    );
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
    await core.close();

    expect(result).toBe(response);
    expect(create).toHaveBeenCalledTimes(1);
    expect(adapter.prepareMediaCalls).toHaveLength(1);
    expect(adapter.prepareMediaCalls[0]).toMatchObject({ timeout: 42, maxRetries: 0 });
    expect(adapter.prepareMediaCalls[0]?.["maxRetries"]).toBe(0);
    expect(wire.checks).toHaveLength(1);
    expect(wire.checks[0]).toMatchObject({
      model: "embed-model",
      provider: "openai",
      modality: "embedding",
      estimated_input_tokens: 3,
      estimated_media: { image_count: 1, is_estimated: true },
      price_hints_version: "1",
    });
    expect(wire.checks[0]).not.toHaveProperty("fallback_providers");
    expect(wire.checks[0]).not.toHaveProperty("fallback_models");
    expect(wire.checks[0]).not.toHaveProperty("call_id");
    expect(wire.confirms).toHaveLength(1);
    expect(wire.events).toHaveLength(1);
    expect(wire.confirms[0]).toMatchObject({
      modality: "embedding",
      media_usage: { image_count: 2, is_estimated: false },
      is_provider_fallback: false,
    });
    expect(wire.events[0]).toMatchObject({
      status: "success",
      modality: "embedding",
      media_usage: { image_count: 2, is_estimated: false },
      is_model_fallback: false,
      is_provider_fallback: false,
      attempt_index: 0,
    });
    expect(wire.confirms[0]?.["call_id"]).toBe(wire.events[0]?.["call_id"]);
  });

  it("captures direct media tags for budget and metadata without forwarding the reserved key", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({ id: "tagged-media" }));
    const client = declaredMediaClient(create);
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch();
    const callerTags = { caller: "call", shared: "caller" };
    const kwargs = { model: "embed-model", solwyn_tags: callerTags };
    const descriptor = Object.getOwnPropertyDescriptor(kwargs, "solwyn_tags");
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      tags: { configured: "config", shared: "config" },
      defaultParams: { retained_default: "yes", solwyn_tags: { ignored: "default" } },
    });

    await (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), kwargs);
    await core.close();

    const expectedTags = { caller: "call", shared: "caller", configured: "config" };
    expect(wire.checks[0]?.["tags"]).toEqual(expectedTags);
    expect(wire.events[0]?.["tags"]).toEqual(expectedTags);
    expect(wire.confirms[0]).not.toHaveProperty("tags");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "embed-model", retained_default: "yes" }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
    expect(kwargs.solwyn_tags).toBe(callerTags);
    expect(Object.getOwnPropertyDescriptor(kwargs, "solwyn_tags")).toEqual(descriptor);
  });

  it("captures non-enumerable direct media tags without changing the caller descriptor", async () => {
    const create = vi.fn((_kwargs: Record<string, unknown>) => ({ id: "hidden-tags" }));
    const client = declaredMediaClient(create);
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch();
    const kwargs: Record<string, unknown> = { model: "embed-model" };
    Object.defineProperty(kwargs, "solwyn_tags", {
      configurable: false,
      enumerable: false,
      value: { hidden: "tag" },
      writable: false,
    });
    const descriptor = Object.getOwnPropertyDescriptor(kwargs, "solwyn_tags");
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });

    await (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), kwargs);
    await core.close();

    expect(wire.checks[0]?.["tags"]).toEqual({ hidden: "tag" });
    expect(wire.events[0]?.["tags"]).toEqual({ hidden: "tag" });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("solwyn_tags");
    expect(Object.getOwnPropertyDescriptor(kwargs, "solwyn_tags")).toEqual(descriptor);
  });

  it("rejects invalid direct media tags before provider or control-plane I/O", async () => {
    const create = vi.fn();
    const client = declaredMediaClient(create);
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });
    const kwargs = { model: "embed-model", solwyn_tags: ["invalid"] };
    const descriptor = Object.getOwnPropertyDescriptor(kwargs, "solwyn_tags");

    await expect(
      (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), kwargs),
    ).rejects.toThrow(/solwyn_tags requires a plain record/);
    await core.close();

    expect(create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(kwargs, "solwyn_tags")).toEqual(descriptor);
  });

  it("skips confirm only when both token and media usage are unobservable", async () => {
    const response = { id: "unpriced" };
    const client = declaredMediaClient(vi.fn(() => response));
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });

    const result = await (core as unknown as MediaCallableCore).mediaCall(
      mediaSpec({
        extractUsage: () => null,
        measureRequest: () => null,
        measureMedia: () => null,
        estimateMedia: () => null,
      }),
      { model: "unpriced-model" },
    );
    await core.close();

    expect(result).toBe(response);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events[0]).toMatchObject({
      status: "success",
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
    expect(wire.events[0]).not.toHaveProperty("media_usage");
  });

  it("uses zero token details only as the media-only confirm carrier", async () => {
    const client = declaredMediaClient(vi.fn(() => ({ id: "media-only" })));
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });

    await (core as unknown as MediaCallableCore).mediaCall(
      mediaSpec({ extractUsage: () => null, measureRequest: () => null }),
      { model: "image-model" },
    );
    await core.close();

    expect(wire.confirms).toHaveLength(1);
    expect(wire.confirms[0]?.["token_details"]).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(wire.events[0]).not.toHaveProperty("token_details");
    expect(wire.events[0]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it("treats an empty reservation id as event-only even when usage is observed", async () => {
    const client = declaredMediaClient(vi.fn(() => ({ id: "empty-reservation" })));
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch(true, "");
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });

    await (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), { model: "image-model" });
    await core.close();

    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(1);
  });

  it("settles observed media usage against a spec-valid empty lease id", async () => {
    const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 900,
        projectId: `proj_${"0".repeat(24)}`,
        leaseId: "",
        leaseClaimToken: 77,
      }),
    );
    const client = declaredMediaClient(vi.fn(() => ({ id: "empty-lease-media" })));
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      breakerReportingEnabled: false,
    });

    try {
      await (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
        model: "image-model",
      });
      await core.close();

      expect(wire.confirms).toHaveLength(1);
      expect(wire.confirms[0]).toMatchObject({
        lease_id: "",
        modality: "embedding",
        token_details: { input_tokens: 12, output_tokens: 0 },
      });
      expect(wire.events).toHaveLength(1);
      expect(wire.confirms[0]?.["call_id"]).toBe(wire.events[0]?.["call_id"]);
    } finally {
      await core.close().catch(() => undefined);
      checkBudget.mockRestore();
    }
  });

  it("returns the exact paid response when extraction throws and settles through a fresh request measurement", async () => {
    const response = { id: "paid-media" };
    const client = declaredMediaClient(vi.fn(() => response));
    const adapter = new MediaAdapter();
    adapter.extractServiceTier = () => "priority";
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const measureRequest = vi.fn(() => createTokenDetails({ input_tokens: 6, is_estimated: true }));
    const buildConfirm = vi.spyOn(BudgetEnforcer.prototype, "buildConfirmRequest");
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    try {
      const result = await (core as unknown as MediaCallableCore).mediaCall(
        mediaSpec({
          extractUsage: () => {
            throw new TypeError("extract failed");
          },
          measureRequest,
        }),
        { model: "image-model" },
      );
      expect(result).toBe(response);
      await core.close();

      expect(measureRequest).toHaveBeenCalledTimes(2);
      expect(buildConfirm).toHaveBeenCalledOnce();
      expect(buildConfirm.mock.calls[0]?.[0]).not.toHaveProperty("floorAtReservation");
      expect(wire.confirms).toHaveLength(1);
      expect(wire.confirms[0]).toMatchObject({
        service_tier: "priority",
        token_details: { input_tokens: 6, is_estimated: true },
      });
      expect(wire.events).toHaveLength(1);
      expect(wire.events[0]).toMatchObject({ status: "success", service_tier: "priority" });
    } finally {
      await core.close().catch(() => undefined);
      buildConfirm.mockRestore();
    }
  });

  it("contains independent post-success request and media failures while still reading tier", async () => {
    const response = { id: "paid-media-event-only" };
    const client = declaredMediaClient(vi.fn(() => response));
    const adapter = new MediaAdapter();
    const extractTier = vi.fn(() => "flex");
    adapter.extractServiceTier = extractTier;
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    let requestCalls = 0;
    const measureRequest = vi.fn(() => {
      requestCalls += 1;
      if (requestCalls === 1) {
        return createTokenDetails({ input_tokens: 3, is_estimated: true });
      }
      throw new TypeError("post-success request failed");
    });
    const measureMedia = vi.fn(() => {
      throw new RangeError("post-success media failed");
    });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    const result = await (core as unknown as MediaCallableCore).mediaCall(
      mediaSpec({ extractUsage: () => null, measureRequest, measureMedia }),
      { model: "image-model" },
    );
    expect(result).toBe(response);
    await core.close();

    expect(measureRequest).toHaveBeenCalledTimes(2);
    expect(measureMedia).toHaveBeenCalledOnce();
    expect(extractTier).toHaveBeenCalledOnce();
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(1);
    expect(wire.events[0]).toMatchObject({ status: "success", service_tier: "flex" });
    expect(wire.events[0]).not.toHaveProperty("token_details");
    expect(wire.events[0]).not.toHaveProperty("media_usage");
  });

  it("omits hostile region and tier reads while returning and settling the exact response", async () => {
    const response = { id: "paid-media-hostile-fields" };
    const client = declaredMediaClient(vi.fn(() => response));
    const adapter = new MediaAdapter();
    adapter.extractRegion = () => {
      throw new TypeError("region failed");
    };
    adapter.extractServiceTier = () => {
      throw new RangeError("tier failed");
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await expect(
      (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), { model: "image-model" }),
    ).resolves.toBe(response);
    await core.close();

    expect(wire.confirms).toHaveLength(1);
    expect(wire.events).toHaveLength(1);
    expect(wire.confirms[0]).not.toHaveProperty("provider_region");
    expect(wire.confirms[0]).not.toHaveProperty("service_tier");
    expect(wire.events[0]).not.toHaveProperty("provider_region");
    expect(wire.events[0]).not.toHaveProperty("service_tier");
  });

  it("reports unsupported dispatch as ERROR and rethrows the same typed error", async () => {
    const client = declaredMediaClient(vi.fn());
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter(false) });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      tags: { configured: "config" },
    });
    const Unsupported = (
      errors as unknown as {
        UnsupportedSurfaceError: new (o: { surface: string; provider: string }) => Error;
      }
    ).UnsupportedSurfaceError;
    expect(Unsupported).toBeTypeOf("function");
    const error = new Unsupported({ surface: "embeddings", provider: "openai" });
    const adapter = new MediaAdapter(false);
    adapter.prepareMediaCall = () => {
      throw error;
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });

    let parentId = "";
    let childId = "";
    await run("media-error-parent", { tags: { parent: "parent" } }, async () => {
      parentId = currentRun()?.agentRunId ?? "";
      await run("media-error-child", { tags: { child: "child" } }, async () => {
        childId = currentRun()?.agentRunId ?? "";
        await expect(
          (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
            model: "embed-model",
            solwyn_tags: { caller: "call" },
          }),
        ).rejects.toBe(error);
      });
    });
    await core.close();

    expect(client.media.create).not.toHaveBeenCalled();
    expect(wire.checks).toHaveLength(1);
    expect(wire.checks[0]).toMatchObject({
      agent_run_id: childId,
      tags: { caller: "call", parent: "parent", child: "child", configured: "config" },
    });
    expect(wire.events[0]).toMatchObject({
      status: "error",
      failover_error_class: "UnsupportedSurfaceError",
      modality: "embedding",
      agent_run_id: childId,
      agent_run_name: "media-error-child",
      parent_agent_run_id: parentId,
      tags: { caller: "call", parent: "parent", child: "child", configured: "config" },
    });
  });

  it("reports and rethrows UnsupportedSurfaceError when the adapter omits prepareMediaCall", async () => {
    const client = declaredMediaClient(vi.fn());
    __setAdapterLoadersForTesting({ openai: async () => new NoMediaAdapter() });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });
    const Unsupported = (
      errors as unknown as {
        UnsupportedSurfaceError: new (o: { surface: string; provider: string }) => Error;
      }
    ).UnsupportedSurfaceError;

    let caught: unknown;
    try {
      await (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
        model: "embed-model",
      });
    } catch (error) {
      caught = error;
    }
    await core.close();

    expect(caught).toBeInstanceOf(Unsupported);
    expect(caught).toMatchObject({ surface: "embeddings", provider: "openai" });
    expect(client.media.create).not.toHaveBeenCalled();
    expect(wire.events[0]).toMatchObject({
      status: "error",
      failover_error_class: "UnsupportedSurfaceError",
    });
  });

  it("hard-denies before dispatch and reports the spec modality", async () => {
    const client = declaredMediaClient(vi.fn());
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch(false);
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      tags: { configured: "config" },
    });

    let parentId = "";
    let childId = "";
    await run("media-deny-parent", { tags: { parent: "parent" } }, async () => {
      parentId = currentRun()?.agentRunId ?? "";
      await run("media-deny-child", { tags: { child: "child" } }, async () => {
        childId = currentRun()?.agentRunId ?? "";
        await expect(
          (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
            model: "embed-model",
            solwyn_tags: { caller: "call" },
          }),
        ).rejects.toMatchObject({ name: "BudgetExceededError" });
      });
    });
    await core.close();

    expect(client.media.create).not.toHaveBeenCalled();
    expect(wire.checks).toHaveLength(1);
    expect(wire.checks[0]).toMatchObject({
      agent_run_id: childId,
      tags: { caller: "call", parent: "parent", child: "child", configured: "config" },
    });
    expect(wire.events[0]).toMatchObject({
      status: "budget_denied",
      modality: "embedding",
      is_model_fallback: false,
      media_usage: { image_count: 1, is_estimated: true },
      deny_source: "server",
      deny_reason: "monthly",
      denied_by_period: "monthly",
      agent_run_id: childId,
      agent_run_name: "media-deny-child",
      parent_agent_run_id: parentId,
      tags: { caller: "call", parent: "parent", child: "child", configured: "config" },
    });
    expect(wire.events[0]).not.toHaveProperty("estimated_output_bound");
  });

  it("reports then preserves a stopped-run error before media dispatch", async () => {
    const order: string[] = [];
    const create = vi.fn(() => {
      order.push("dispatch");
      return { usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const client = declaredMediaClient(create);
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch(false, "res_media", "run_stopped");
    const originalReport = MetadataReporter.prototype.report;
    const report = vi.spyOn(MetadataReporter.prototype, "report").mockImplementation(function (
      this: MetadataReporter,
      event,
    ) {
      order.push("report");
      originalReport.call(this, event);
      throw new Error("report failure must not mask the stop");
    });
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: false,
      tags: { configured: "config" },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    let parentId = "";
    let childId = "";
    let caught: unknown;
    try {
      await run("media-stopped-parent", { tags: { parent: "parent" } }, async () => {
        parentId = currentRun()?.agentRunId ?? "";
        await run("media-stopped-child", { tags: { child: "child" } }, async () => {
          childId = currentRun()?.agentRunId ?? "";
          caught = await (core as unknown as MediaCallableCore)
            .mediaCall(mediaSpec(), { model: "embed-model", solwyn_tags: { caller: "call" } })
            .then(
              () => null,
              (error: unknown) => {
                order.push("error");
                return error;
              },
            );
        });
      });
    } finally {
      report.mockRestore();
      await core.close();
    }

    expect(caught).toBeInstanceOf(errors.RunStoppedError);
    expect(caught).toMatchObject({ reason: "run_stopped", source: "server" });
    expect(order).toEqual(["report", "error"]);
    expect(create).not.toHaveBeenCalled();
    expect(wire.checks).toHaveLength(1);
    expect(wire.checks[0]).toMatchObject({
      agent_run_id: childId,
      tags: { caller: "call", parent: "parent", child: "child", configured: "config" },
    });
    expect(wire.events).toHaveLength(1);
    expect(wire.events[0]).toMatchObject({
      status: "budget_denied",
      agent_run_id: childId,
      agent_run_name: "media-stopped-child",
      parent_agent_run_id: parentId,
      tags: { caller: "call", parent: "parent", child: "child", configured: "config" },
    });
  });

  it("pre-gates retained local media stops with measured input/media and no output bound", async () => {
    const create = vi.fn(() => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const client = declaredMediaClient(create);
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch(true, "res_media");
    const reports: Array<Record<string, unknown>> = [];
    const report = vi
      .spyOn(MetadataReporter.prototype, "report")
      .mockImplementation((event) => reports.push(event as unknown as Record<string, unknown>));
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: false,
      velocityMode: "off",
      tags: { configured: "config" },
    });

    let parentId = "";
    let childId = "";
    let caught: unknown;
    try {
      await run("media-local-stop-parent", { tags: { parent: "parent" } }, async () => {
        parentId = currentRun()?.agentRunId ?? "";
        await run("media-local-stop-child", { tags: { child: "child" } }, async () => {
          childId = currentRun()?.agentRunId ?? "";
          markTerminated(childId, { reason: "repeat_size", source: "local_velocity" });
          caught = await (core as unknown as MediaCallableCore)
            .mediaCall(mediaSpec(), { model: "embed-model", solwyn_tags: { caller: "call" } })
            .catch((error: unknown) => error);
        });
      });
    } finally {
      report.mockRestore();
      await core.close();
    }

    expect(caught).toBeInstanceOf(errors.RunStoppedError);
    expect(caught).toMatchObject({
      agentRunId: childId,
      reason: "repeat_size",
      source: "local_velocity",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(wire.checks).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "budget_denied",
      modality: "embedding",
      input_tokens: 3,
      output_tokens: 0,
      media_usage: { image_count: 1, is_estimated: true },
      agent_run_id: childId,
      agent_run_name: "media-local-stop-child",
      parent_agent_run_id: parentId,
      tags: { caller: "call", parent: "parent", child: "child", configured: "config" },
      deny_source: "run_terminated",
      deny_reason: "repeat_size",
      denied_by_period: "run_stopped",
    });
    expect(reports[0]).not.toHaveProperty("velocity_flags");
    expect(reports[0]).not.toHaveProperty("estimated_output_bound");
  });

  it("lets a hard deny win when the same media preflight also exhausts the deadline", async () => {
    const client = declaredMediaClient(vi.fn());
    const adapter = new MediaAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const { fetch } = makeFetch(false);
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      failoverTotalTimeout: 0.25,
    });
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1_000);

    try {
      await expect(
        (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), { model: "embed-model" }),
      ).rejects.toMatchObject({ name: "BudgetExceededError" });
      expect(adapter.prepareMediaCalls).toHaveLength(0);
      expect(client.media.create).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      await core.close();
    }
  });

  it("releases one allowed media claim and raises the typed deadline error before preparation", async () => {
    const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 100,
        reservationId: "res-expired",
        leaseClaimToken: 71,
      }),
    );
    const release = vi
      .spyOn(BudgetEnforcer.prototype, "releaseReservation")
      .mockImplementation(() => {
        throw new Error("cleanup failed");
      });
    const client = declaredMediaClient(vi.fn());
    const adapter = new MediaAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const { fetch } = makeFetch();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      failoverTotalTimeout: 0.25,
    });
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1_000);

    try {
      const error = await (core as unknown as MediaCallableCore)
        .mediaCall(mediaSpec(), { model: "embed-model" })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(errors.ProviderUnavailableError);
      expect(error).toMatchObject({
        message: "failover deadline expired",
        attempted: ["openai"],
      });
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(release.mock.calls).toEqual([[callId, 71]]);
      expect(adapter.prepareMediaCalls).toHaveLength(0);
      expect(client.media.create).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      checkBudget.mockRestore();
      release.mockRestore();
      await core.close();
    }
  });

  it("pins expiry after a deferred media preflight without dispatching", async () => {
    let resolveBudget!: (result: ReturnType<typeof budgetCheckResult>) => void;
    const deferred = new Promise<ReturnType<typeof budgetCheckResult>>((resolve) => {
      resolveBudget = resolve;
    });
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockImplementation(() => deferred);
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    let current = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => current);
    const client = declaredMediaClient(vi.fn());
    const adapter = new MediaAdapter();
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const { fetch } = makeFetch();
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      failoverTotalTimeout: 0.25,
    });

    try {
      const pending = (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), {
        model: "embed-model",
      });
      await vi.waitFor(() => expect(checkBudget).toHaveBeenCalledOnce());
      current = 1_000;
      resolveBudget(
        budgetCheckResult({
          allowed: true,
          remainingBudget: 100,
          reservationId: "res-deferred-expired",
          leaseClaimToken: 72,
        }),
      );
      await expect(pending).rejects.toMatchObject({
        name: "ProviderUnavailableError",
        message: "failover deadline expired",
        attempted: ["openai"],
      });
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(release.mock.calls).toEqual([[callId, 72]]);
      expect(adapter.prepareMediaCalls).toHaveLength(0);
      expect(client.media.create).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      checkBudget.mockRestore();
      release.mockRestore();
      await core.close();
    }
  });

  it("releases funding exactly once when OpenAI media rejects invalid request options", async () => {
    const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 100,
        reservationId: "res-options",
        leaseClaimToken: 73,
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const create = vi.fn();
    const client = {
      chat: { completions: { create: vi.fn() } },
      embeddings: { create },
    };
    const { fetch } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });

    try {
      await expect(
        (core as unknown as MediaCallableCore).mediaCall(
          mediaSpec(),
          { model: "text-embedding-3-small" },
          [null],
        ),
      ).rejects.toBeInstanceOf(errors.ConfigurationError);
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(release.mock.calls).toEqual([[callId, 73]]);
      expect(create).not.toHaveBeenCalled();
    } finally {
      checkBudget.mockRestore();
      release.mockRestore();
      await core.close();
    }
  });

  it("preserves a typed media deny when region extraction throws", async () => {
    const client = declaredMediaClient(vi.fn());
    const adapter = new MediaAdapter();
    adapter.extractRegion = () => {
      throw new TypeError("region failed");
    };
    __setAdapterLoadersForTesting({ openai: async () => adapter });
    const { fetch, wire } = makeFetch(false);
    const core = new SolwynCore(client, {
      apiKey: API_KEY,
      fetch,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await expect(
      (core as unknown as MediaCallableCore).mediaCall(mediaSpec(), { model: "embed-model" }),
    ).rejects.toMatchObject({ name: "BudgetExceededError" });
    expect(client.media.create).not.toHaveBeenCalled();
    await core.close();
    expect(wire.events).toHaveLength(1);
    expect(wire.events[0]).not.toHaveProperty("provider_region");
  });

  it("keeps the paid response authoritative when media measurement fails", async () => {
    const checkBudget = vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: true,
        remainingBudget: 100,
        reservationId: "res-media-funded",
        leaseClaimToken: 51,
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const sentinel = new Error("measurement failed");
    const response = { id: "measured-later" };
    const create = vi.fn(() => response);
    const client = declaredMediaClient(create);
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });

    try {
      await expect(
        (core as unknown as MediaCallableCore).mediaCall(
          mediaSpec({
            measureMedia: () => {
              throw sentinel;
            },
          }),
          { model: "image-model" },
        ),
      ).resolves.toBe(response);

      expect(create).toHaveBeenCalledOnce();
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(callId).toMatch(/^[0-9a-f-]{36}$/);
      expect(release.mock.calls).toEqual([[callId, 51]]);
      await core.close();
      expect(wire.confirms).toHaveLength(1);
      expect(wire.events).toHaveLength(1);
      expect(wire.events[0]).toMatchObject({ status: "success", call_id: callId });
      expect(wire.events[0]).not.toHaveProperty("media_usage");
    } finally {
      await core.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
    }
  });

  it.each([
    "measureRequest",
    "estimateMedia",
  ] as const)("keeps throwing preflight %s loud before provider dispatch", async (hook) => {
    const sentinel = new Error(`${hook} preflight failed`);
    const client = declaredMediaClient(vi.fn());
    __setAdapterLoadersForTesting({ openai: async () => new MediaAdapter() });
    const { fetch, wire } = makeFetch();
    const core = new SolwynCore(client, { apiKey: API_KEY, fetch });
    const spec = mediaSpec(
      hook === "measureRequest"
        ? {
            measureRequest: () => {
              throw sentinel;
            },
          }
        : {
            estimateMedia: () => {
              throw sentinel;
            },
          },
    );

    await expect(
      (core as unknown as MediaCallableCore).mediaCall(spec, { model: "image-model" }),
    ).rejects.toBe(sentinel);
    expect(client.media.create).not.toHaveBeenCalled();
    await core.close();
    expect(wire.checks).toHaveLength(0);
    expect(wire.confirms).toHaveLength(0);
    expect(wire.events).toHaveLength(0);
  });
});

describe("media budget plumbing", () => {
  it("builds modality/media fields without changing text defaults", () => {
    const enforcer = new BudgetEnforcer({ apiUrl: "https://api.solwyn.test", apiKey: API_KEY });
    const check = enforcer.buildCheckRequest({
      estimatedInputTokens: 7,
      estimatedMedia: { audio_seconds: null, is_estimated: true },
      modality: "audio",
      model: "audio-model",
      provider: "openai",
    });
    const confirm = enforcer.buildConfirmRequest({
      reservationId: "res",
      model: "audio-model",
      tokenDetails: zeroTokenDetails(),
      provider: "openai",
      callId: crypto.randomUUID(),
      modality: "audio",
      mediaUsage: { audio_seconds: null, is_estimated: false },
    });

    expect(check).toMatchObject({
      modality: "audio",
      estimated_media: { audio_seconds: null, is_estimated: true },
      price_hints_version: "1",
    });
    expect(check).not.toHaveProperty("fallback_providers");
    expect(check).not.toHaveProperty("fallback_models");
    expect(confirm).toMatchObject({
      modality: "audio",
      media_usage: { audio_seconds: null, is_estimated: false },
    });
    expect(
      enforcer.buildCheckRequest({
        estimatedInputTokens: 1,
        model: "gpt",
        provider: "openai",
      }),
    ).not.toHaveProperty("estimated_media");
  });
});
