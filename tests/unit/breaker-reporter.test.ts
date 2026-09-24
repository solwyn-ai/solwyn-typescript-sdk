import { describe, expect, it, vi } from "vitest";
import type { CircuitBreakerState } from "../../src/circuit-breaker";
import type { Logger } from "../../src/logging";
import { resetReadOnlyKeyDiagnosticForTest } from "../../src/read-only-key";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;
const SDK_INSTANCE_ID = "00000000-0000-0000-0000-000000000001";
const BREAKER_URL = `${API_URL}/api/v1/projects/${PROJECT_ID}/providers/breaker-reports`;

function state(overrides: Partial<CircuitBreakerState> = {}): CircuitBreakerState {
  return {
    state: "closed",
    failureCount: 0,
    successCount: 0,
    lastFailureTime: null,
    lastStateChange: 0,
    recoveryEligible: false,
    ...overrides,
  };
}

function loggerSpies(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function warningThrowingLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {
      throw new Error("warn logger failed");
    },
    error: () => {},
  };
}

function reporter(
  options: ConstructorParameters<typeof MetadataReporter>[2] = {},
): MetadataReporter {
  return new MetadataReporter(API_URL, API_KEY, options);
}

function metadataEvent(): MetadataEvent {
  return MetadataEventSchema.parse({
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 1,
    output_tokens: 1,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: "00000000-0000-0000-0000-000000000002",
    sdk_instance_id: SDK_INSTANCE_ID,
    timestamp: "2026-08-14T00:00:00Z",
  });
}

function syntheticCallId(index: number): string {
  return `00000000-0000-0000-0001-${(index + 1).toString(16).padStart(12, "0")}`;
}

function settlementPair(index: number): [BudgetConfirmRequest, MetadataEvent] {
  const callId = syntheticCallId(index);
  return [
    BudgetConfirmRequestSchema.parse({
      reservation_id: "synthetic",
      model: "gpt-4o",
      provider: "openai",
      call_id: callId,
      token_details: zeroTokenDetails(),
    }),
    MetadataEventSchema.parse({ ...metadataEvent(), call_id: callId }),
  ];
}

describe("provider breaker report cycles", () => {
  it("posts exact six-key reports sequentially with one fixed timestamp and 5s timeouts", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let active = 0;
    let maxActive = 0;
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      expect(url).toBe(BREAKER_URL);
      active += 1;
      maxActive = Math.max(maxActive, active);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      await Promise.resolve();
      active -= 1;
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });
    const wallClock = vi.fn(() => new Date("2026-08-14T12:00:00.000Z"));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const instance = reporter({
      fetch,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [
        ["openai", state()],
        ["anthropic", state({ state: "open", failureCount: 3 })],
      ],
      wallClock,
    });
    instance.observeProjectId(PROJECT_ID);

    await instance._startBreakerCycle();
    const timeoutCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 5000).length;
    setTimeoutSpy.mockRestore();

    expect(maxActive).toBe(1);
    expect(wallClock).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => Object.keys(body).sort())).toEqual([
      ["failure_count", "provider", "reported_at", "sdk_instance_id", "state", "success_count"],
      ["failure_count", "provider", "reported_at", "sdk_instance_id", "state", "success_count"],
    ]);
    expect(bodies.map((body) => body["reported_at"])).toEqual([
      "2026-08-14T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z",
    ]);
    expect(bodies[1]).toMatchObject({ provider: "anthropic", state: "open", failure_count: 3 });
    expect(timeoutCalls).toBe(2);
  });

  it.each([
    ["disabled", { breakerReportingEnabled: false, sdkInstanceId: SDK_INSTANCE_ID }, true],
    ["missing supplier", { breakerReportingEnabled: true, sdkInstanceId: SDK_INSTANCE_ID }, false],
    ["missing sdk id", { breakerReportingEnabled: true }, true],
  ])("gates before snapshot collection when %s", async (_label, options, includeSupplier) => {
    const snapshots = vi.fn(() => [["openai", state()] as const]);
    const fetch = vi.fn<FetchLike>();
    const instance = reporter({
      ...options,
      fetch,
      ...(includeSupplier ? { breakerSnapshots: snapshots } : {}),
    });
    instance.observeProjectId(PROJECT_ID);

    await instance._startBreakerCycle();

    expect(snapshots).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gates before snapshot collection until a truthy project id is learned", async () => {
    const snapshots = vi.fn(() => [["openai", state()] as const]);
    const fetch = vi.fn<FetchLike>();
    const instance = reporter({
      fetch,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: snapshots,
    });
    instance.observeProjectId(null);
    instance.observeProjectId("");

    await instance._startBreakerCycle();

    expect(snapshots).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("coalesces cadence launches while one cycle is active", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots = vi.fn(() => [["openai", state()] as const]);
    const fetch = vi.fn<FetchLike>(async () => {
      await blocked;
      return new Response(null, { status: 204 });
    });
    const instance = reporter({
      fetch,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: snapshots,
    });
    instance.observeProjectId(PROJECT_ID);

    const first = instance._startBreakerCycle();
    const second = instance._startBreakerCycle();
    expect(second).toBe(first);
    expect(snapshots).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends first state, stays silent when unchanged, and sends only a changed provider", async () => {
    const snapshots = [["openai", state()] as const, ["anthropic", state()] as const];
    const sent: string[] = [];
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      sent.push((JSON.parse(String(init?.body)) as { provider: string }).provider);
      return new Response(null, { status: 204 });
    });
    const instance = reporter({
      fetch,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => snapshots,
    });
    instance.observeProjectId(PROJECT_ID);

    await instance._startBreakerCycle();
    await instance._startBreakerCycle();
    snapshots[1] = ["anthropic", state({ failureCount: 1 })];
    await instance._startBreakerCycle();

    expect(sent).toEqual(["openai", "anthropic", "anthropic"]);
  });

  it("forces a full heartbeat refresh and stamps the monotonic clock at build time", async () => {
    let now = 0;
    const sent: string[] = [];
    const snapshots = vi.fn(() => [["openai", state()] as const, ["anthropic", state()] as const]);
    const instance = reporter({
      monotonicClock: () => now,
      breakerReportHeartbeat: 60_000,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: snapshots,
      fetch: async (_url, init) => {
        sent.push((JSON.parse(String(init?.body)) as { provider: string }).provider);
        return new Response(null, { status: 204 });
      },
    });
    instance.observeProjectId(PROJECT_ID);

    await instance._startBreakerCycle();
    now = 59_999;
    expect(instance._breakerReportsDue()).toBe(false);
    now = 60_000;
    expect(instance._breakerReportsDue()).toBe(true);
    await instance._startBreakerCycle();

    expect(sent).toEqual(["openai", "anthropic", "openai", "anthropic"]);
  });

  it("retries a provider whose prior breaker report did not receive 2xx", async () => {
    const statuses = [500, 204];
    const instance = reporter({
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [["openai", state()]],
      fetch: async () => new Response(null, { status: statuses.shift() }),
    });
    instance.observeProjectId(PROJECT_ID);

    await instance._startBreakerCycle();
    expect(instance._breakerReportsDue()).toBe(true);
    await instance._startBreakerCycle();
    expect(instance._breakerReportsDue()).toBe(false);
  });

  it("isolates supplier, invalid-snapshot, and per-provider send failures", async () => {
    const logger = loggerSpies();
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { provider: string };
      if (body.provider === "openai") return new Response("", { status: 500 });
      return new Response("", { status: 204 });
    });
    const instance = reporter({
      fetch,
      logger,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [
        ["invalid-provider", state()],
        ["google", state({ failureCount: -1 })],
        ["openai", state()],
        ["anthropic", state()],
      ],
    });
    instance.observeProjectId(PROJECT_ID);

    await instance._startBreakerCycle();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.breaker_snapshot_invalid: provider=%s exc_type=%s",
      "invalid-provider",
      "ZodError",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.breaker_snapshot_invalid: provider=%s exc_type=%s",
      "google",
      "ZodError",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.breaker_send_failed: provider=%s exc_type=%s",
      "openai",
      "TransportHttpError",
    );

    const brokenSupplier = vi.fn(() => {
      throw new TypeError("private supplier detail");
    });
    const second = reporter({
      logger,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: brokenSupplier,
    });
    second.observeProjectId(PROJECT_ID);
    await second._startBreakerCycle();
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.breaker_snapshot_failed: exc_type=%s",
      "TypeError",
    );

    const longSdkId = reporter({
      fetch,
      logger,
      sdkInstanceId: "x".repeat(101),
      breakerSnapshots: () => [["openai", state()]],
    });
    longSdkId.observeProjectId(PROJECT_ID);
    await longSdkId._startBreakerCycle();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throwing reporter diagnostic: snapshot supplier warning remains terminal", async () => {
    const fetch = vi.fn<FetchLike>();
    const instance = reporter({
      fetch,
      logger: warningThrowingLogger(),
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => {
        throw new TypeError("private supplier detail");
      },
    });
    instance.observeProjectId(PROJECT_ID);

    await expect(instance._startBreakerCycle()).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throwing reporter diagnostic: invalid and send warnings preserve later providers", async () => {
    const sentProviders: string[] = [];
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { provider: string };
      sentProviders.push(body.provider);
      return body.provider === "openai"
        ? new Response("", { status: 500 })
        : new Response(null, { status: 204 });
    });
    const instance = reporter({
      fetch,
      logger: warningThrowingLogger(),
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [
        ["invalid-provider", state()],
        ["openai", state()],
        ["anthropic", state()],
      ],
    });
    instance.observeProjectId(PROJECT_ID);

    await expect(instance._startBreakerCycle()).resolves.toBeUndefined();
    expect(sentProviders).toEqual(["openai", "anthropic"]);
  });

  it("throwing reporter diagnostic: cadence warning cannot reject final close", async () => {
    vi.useFakeTimers();
    const snapshots = vi.fn(() => [["invalid-provider", state()] as const]);
    const instance = reporter({
      flushInterval: 1,
      logger: warningThrowingLogger(),
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: snapshots,
    });
    instance.observeProjectId(PROJECT_ID);
    instance.start();

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshots).toHaveBeenCalled();
      await expect(instance.close()).resolves.toBeUndefined();
    } finally {
      await instance.close().catch(() => {});
      vi.useRealTimers();
    }
  });

  it("ends the cycle after an exact read-only response", async () => {
    resetReadOnlyKeyDiagnosticForTest();
    const logger = loggerSpies();
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ detail: { code: "read_only_key" } }), { status: 403 }),
    );
    const instance = reporter({
      fetch,
      logger,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [
        ["openai", state()],
        ["anthropic", state()],
      ],
    });
    instance.observeProjectId(PROJECT_ID);

    await instance._startBreakerCycle();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "reporter.breaker_send_failed: provider=%s exc_type=%s",
      expect.anything(),
      expect.anything(),
    );
  });

  it("close waits for an active cycle then runs one distinct forced full cycle", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let snapshotCall = 0;
    const snapshots = vi.fn(() => {
      snapshotCall += 1;
      return snapshotCall === 1
        ? [["openai", state()] as const]
        : [["openai", state()] as const, ["anthropic", state()] as const];
    });
    const sent: string[] = [];
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      const provider = (JSON.parse(String(init?.body)) as { provider: string }).provider;
      sent.push(provider);
      if (sent.length === 1) await blocked;
      return new Response("", { status: 204 });
    });
    const active = reporter({ fetch, sdkInstanceId: SDK_INSTANCE_ID, breakerSnapshots: snapshots });
    active.observeProjectId(PROJECT_ID);
    const cycle = active._startBreakerCycle();
    const closing = active.close();
    await Promise.resolve();
    expect(snapshots).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([cycle, closing]);
    expect(sent).toEqual(["openai", "openai", "anthropic"]);
    expect(snapshots).toHaveBeenCalledTimes(2);
  });

  it("bounds never-resolving active and forced breaker cycles by the spend deadline", async () => {
    vi.useFakeTimers();
    const activeSignals: AbortSignal[] = [];
    const active = reporter({
      shutdownDeadline: 10,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [["openai", state()]],
      fetch: (_url, init) => {
        activeSignals.push(init?.signal as AbortSignal);
        return new Promise<Response>(() => {});
      },
    });
    active.observeProjectId(PROJECT_ID);
    active._startBreakerCycle();
    const activeClose = active.close();
    await vi.advanceTimersByTimeAsync(10);
    await activeClose;
    expect(activeSignals[0]?.aborted).toBe(true);

    const forcedSignals: AbortSignal[] = [];
    const forced = reporter({
      shutdownDeadline: 10,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [["openai", state()]],
      fetch: (_url, init) => {
        forcedSignals.push(init?.signal as AbortSignal);
        return new Promise<Response>(() => {});
      },
    });
    forced.observeProjectId(PROJECT_ID);
    const forcedClose = forced.close();
    await vi.advanceTimersByTimeAsync(10);
    await forcedClose;
    expect(forcedSignals[0]?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("an unchanged cadence tick consults due state but launches no breaker cycle", async () => {
    vi.useFakeTimers();
    const snapshots = vi.fn(() => [["openai", state()] as const]);
    const instance = reporter({
      flushInterval: 1,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: snapshots,
      fetch: async () => new Response(null, { status: 204 }),
    });
    instance.observeProjectId(PROJECT_ID);
    await instance._startBreakerCycle();
    const start = vi.spyOn(instance, "_startBreakerCycle");
    instance.start();

    await vi.advanceTimersByTimeAsync(1);

    expect(start).not.toHaveBeenCalled();
    expect(snapshots).toHaveBeenCalledTimes(2);
    await instance.close(0);
    vi.useRealTimers();
  });

  it("close prevents a cadence flush from launching a second unawaited breaker cycle", async () => {
    vi.useFakeTimers();
    let releaseIngest: (() => void) | undefined;
    let releaseSecondCycle: (() => void) | undefined;
    let markIngestStarted: (() => void) | undefined;
    const ingestBlocked = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const secondCycleBlocked = new Promise<void>((resolve) => {
      releaseSecondCycle = resolve;
    });
    const ingestStarted = new Promise<void>((resolve) => {
      markIngestStarted = resolve;
    });
    let breakerCalls = 0;
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith("/metadata/ingest")) {
        markIngestStarted?.();
        await ingestBlocked;
        return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
      }
      breakerCalls += 1;
      if (breakerCalls === 2) {
        await secondCycleBlocked;
      }
      return new Response(null, { status: 204 });
    });
    const instance = reporter({
      fetch,
      flushInterval: 1,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [["openai", state()]],
    });
    instance.observeProjectId(PROJECT_ID);
    instance.report(metadataEvent());
    instance.start();

    try {
      await vi.advanceTimersByTimeAsync(1);
      await ingestStarted;
      const closing = instance.close();
      await Promise.resolve();
      releaseIngest?.();
      await closing;
      await vi.advanceTimersByTimeAsync(100);

      expect(breakerCalls).toBe(1);
    } finally {
      releaseIngest?.();
      releaseSecondCycle?.();
      vi.useRealTimers();
    }
  });

  it("backs off failed breaker reports across zero-delay continuation rounds", async () => {
    let now = 0;
    let rounds = 0;
    let generated = 0;
    let producing = true;
    let breakerStatus = 503;
    let failureCount = 0;
    let breakerPosts = 0;
    const logger = loggerSpies();
    let instance!: MetadataReporter;
    const produce = (): void => {
      instance.reportSettlement(...settlementPair(generated));
      generated += 1;
    };
    instance = reporter({
      batchSize: 1,
      flushInterval: 1000,
      logger,
      monotonicClock: () => now,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [["openai", state({ failureCount })]],
      // Every confirm yields one new settlement, so each quota-exhausted round sets
      // more and the next round runs on a zero-delay timer turn.
      fetch: async (url, init) => {
        if (url === BREAKER_URL) {
          breakerPosts += 1;
          return new Response(null, { status: breakerStatus });
        }
        if (url.endsWith("/budgets/confirm")) {
          if (producing) produce();
          return new Response(null, { status: 204 });
        }
        const events = JSON.parse(String(init?.body)) as unknown[];
        return new Response(JSON.stringify({ ingested: events.length, rejected: [] }), {
          status: 202,
        });
      },
    });
    instance.observeProjectId(PROJECT_ID);
    const flush = instance._flushRemaining.bind(instance);
    vi.spyOn(instance, "_flushRemaining").mockImplementation(async (...args) => {
      const clean = await flush(...args);
      rounds += 1;
      return clean;
    });
    const afterRounds = async (count: number): Promise<void> => {
      const target = rounds + count;
      while (rounds < target) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const sendFailures = (): number =>
      vi
        .mocked(logger.warn)
        .mock.calls.filter(
          (call) => call[0] === "reporter.breaker_send_failed: provider=%s exc_type=%s",
        ).length;

    produce(); // starts the cadence
    try {
      // The clock is frozen, so only zero-delay continuation rounds run.
      await afterRounds(30);
      expect(instance.settlementQueueSize).toBeGreaterThan(0); // more is still set
      expect(breakerPosts).toBe(1);

      // First retry: one flush interval (>= the 1 s backoff base) after the failure.
      now = 999;
      await afterRounds(30);
      expect(breakerPosts).toBe(1);
      now = 1000;
      await afterRounds(30);
      expect(breakerPosts).toBe(2);

      // Second retry backs off to 2 s.
      now = 2999;
      await afterRounds(30);
      expect(breakerPosts).toBe(2);
      now = 3000;
      await afterRounds(30);
      expect(breakerPosts).toBe(3);
      expect(sendFailures()).toBe(3);

      // A changed snapshot waits for the pending deadline too (4 s backoff).
      failureCount = 1;
      breakerStatus = 204;
      now = 6999;
      await afterRounds(30);
      expect(breakerPosts).toBe(3);
      now = 7000;
      await afterRounds(30);
      expect(breakerPosts).toBe(4);

      // Success clears the backoff: the next changed snapshot reports at once, once.
      failureCount = 2;
      await afterRounds(30);
      expect(breakerPosts).toBe(5);
      expect(sendFailures()).toBe(3);
      expect(generated).toBeGreaterThan(200);
    } finally {
      producing = false;
      await instance.close(5000);
    }
  });
});
