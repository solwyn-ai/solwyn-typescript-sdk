import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import type { Logger } from "../../src/logging";
import { MetadataReporter } from "../../src/reporter";
import {
  BUDGET_CONFIRM_PATH,
  type FetchLike,
  isRetryableTransportError,
  METADATA_INGEST_PATH,
  Transport,
  TransportHttpError,
  TransportTimeoutError,
} from "../../src/transport";
import type { BudgetConfirmRequest, LeaseGrantResponse } from "../../src/types";
import { UntrackedSurfaceReporter } from "../../src/untracked-reporter";
import { BudgetConfirmRequestSchema } from "../../src/validation";

// 2026-09-22 performance audit: Dispose unfinished HTTP response bodies the SDK discards.
// Every body the SDK does not use is released off the result path: small complete
// bodies are read to the end (connection reuse), everything else is cancelled and the
// request aborted within min(remaining attempt deadline, 1 s). Outcomes never wait.

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const PROJECT_ID = `proj_${"0".repeat(24)}`;
const SDK_INSTANCE_ID = "00000000-0000-0000-0000-000000000001";
/** A synthetic sentinel that must never surface in any diagnostic. */
const BODY_SENTINEL = "synthetic-body-sentinel";
const DRAIN_BOUND_MS = 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface BodyProbe {
  /** Bytes the source handed to the stream. */
  delivered: number;
  /** Underlying-source cancel calls. */
  cancels: number;
  /** True once the source closed the stream (a complete body read to the end). */
  finished: boolean;
}

interface BodyPlan {
  /** Chunks delivered one per pull. */
  chunks?: readonly Uint8Array[];
  /** Close after the last chunk (complete) or stall forever (unfinished). */
  complete: boolean;
  /** Replaces the default counting cancel. */
  cancel?: () => void | PromiseLike<void>;
}

function chunk(size: number): Uint8Array {
  return new TextEncoder()
    .encode(BODY_SENTINEL.repeat(Math.ceil(size / BODY_SENTINEL.length)))
    .subarray(0, size);
}

function trackedBody(plan: BodyPlan): { body: ReadableStream<Uint8Array>; probe: BodyProbe } {
  const probe: BodyProbe = { delivered: 0, cancels: 0, finished: false };
  const chunks = [...(plan.chunks ?? [chunk(24)])];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks.shift();
        if (next !== undefined) {
          probe.delivered += next.byteLength;
          controller.enqueue(next);
          return;
        }
        if (plan.complete) {
          probe.finished = true;
          controller.close();
          return;
        }
        return new Promise<void>(() => {});
      },
      cancel() {
        probe.cancels += 1;
        return plan.cancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, probe };
}

function capturingLogger(): { logger: Logger; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args);
  };
  return { lines, logger: { debug: capture, info: capture, warn: capture, error: capture } };
}

async function settle(promise: Promise<unknown>): Promise<{ value: unknown }> {
  const box: { value: unknown } = { value: undefined };
  let done = false;
  void promise.then(
    (value) => {
      box.value = value;
      done = true;
    },
    (error: unknown) => {
      box.value = error;
      done = true;
    },
  );
  for (let turn = 0; turn < 50 && !done; turn += 1) {
    await Promise.resolve();
  }
  expect(done).toBe(true);
  return box;
}

async function turns(count = 50): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await Promise.resolve();
  }
}

function transportFor(
  response: () => Response,
  signals: AbortSignal[],
  options: { maxRetries?: number; retryBaseDelayMs?: number } = {},
): Transport {
  return new Transport(API_URL, API_KEY, {
    fetch: async (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      return response();
    },
    ...options,
  });
}

describe("Transport body disposal — outcomes are decided at headers", () => {
  it("rejects a 503 whose body never ends before any timer advances, then releases it", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { body, probe } = trackedBody({ complete: false });
    const transport = transportFor(() => new Response(body, { status: 503 }), signals);

    const { value: error } = await settle(
      transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 30_000 }),
    );

    expect(error).toBeInstanceOf(TransportHttpError);
    expect((error as TransportHttpError).status).toBe(503);
    expect(isRetryableTransportError(error)).toBe(true);

    await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS);
    expect(probe.cancels).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a stalled budget-check error body at headers on the read-JSON path too", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { body, probe } = trackedBody({ complete: false });
    const transport = transportFor(() => new Response(body, { status: 502 }), signals);

    const { value: error } = await settle(
      transport.postJsonAndReadJson("/api/v1/budgets/check", {}, { timeoutMs: 30_000 }),
    );

    expect((error as TransportHttpError).status).toBe(502);
    await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS);
    expect(probe.cancels).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it.each([
    [400, false],
    [429, true],
    [500, true],
    [503, true],
  ])("cancels an incomplete %i body within the drain bound, classification unchanged", async (status, retryable) => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { body, probe } = trackedBody({ complete: false });
    const transport = transportFor(() => new Response(body, { status }), signals);

    const { value: error } = await settle(
      transport.postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 30_000 }),
    );
    expect(error).toBeInstanceOf(TransportHttpError);
    expect((error as TransportHttpError).status).toBe(status);
    expect(isRetryableTransportError(error)).toBe(retryable);

    await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS - 1);
    expect(probe.cancels).toBe(0);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.cancels).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the drain by the remaining attempt deadline when it is under one second", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { body, probe } = trackedBody({ complete: false });
    const transport = transportFor(() => new Response(body, { status: 503 }), signals);

    await settle(transport.postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 200 }));
    await vi.advanceTimersByTimeAsync(199);
    expect(probe.cancels).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.cancels).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("keeps retry counts unchanged when retried error bodies stall", async () => {
    vi.useFakeTimers();
    for (const [status, expectedAttempts] of [
      [503, 3],
      [400, 1],
    ] as const) {
      const signals: AbortSignal[] = [];
      const probes: BodyProbe[] = [];
      const transport = transportFor(
        () => {
          const { body, probe } = trackedBody({ complete: false });
          probes.push(probe);
          return new Response(body, { status });
        },
        signals,
        { maxRetries: 2, retryBaseDelayMs: 10 },
      );
      const outcome = transport
        .postJson(METADATA_INGEST_PATH, [], { timeoutMs: 5_000 })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(100);
      const error = await outcome;
      expect((error as TransportHttpError).status).toBe(status);
      expect(signals).toHaveLength(expectedAttempts);
      await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS);
      expect(probes.map((probe) => probe.cancels)).toEqual(Array(expectedAttempts).fill(1));
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    }
  });
});

describe("Transport body disposal — drain versus cancel", () => {
  it("drains a small complete error body to the end without a cancel or abort", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { body, probe } = trackedBody({ complete: true, chunks: [chunk(512), chunk(512)] });
    const transport = transportFor(() => new Response(body, { status: 429 }), signals);

    const { value: error } = await settle(
      transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 5_000 }),
    );
    expect((error as TransportHttpError).status).toBe(429);
    await turns();

    expect(probe.finished).toBe(true);
    expect(probe.cancels).toBe(0);
    expect(signals[0]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains a small complete 200 body to the end without a cancel or abort", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { body, probe } = trackedBody({ complete: true, chunks: [chunk(64)] });
    const transport = transportFor(() => new Response(body, { status: 200 }), signals);

    await expect(
      transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
    await turns();

    expect(probe.finished).toBe(true);
    expect(probe.cancels).toBe(0);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("cancels a complete body larger than the byte cap without waiting for a timer", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { body, probe } = trackedBody({
      complete: true,
      chunks: Array.from({ length: 256 }, () => chunk(4096)),
    });
    const transport = transportFor(() => new Response(body, { status: 503 }), signals);

    await settle(transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 5_000 }));
    await turns(200);

    expect(probe.cancels).toBe(1);
    expect(probe.finished).toBe(false);
    expect(probe.delivered).toBeLessThanOrEqual(16 * 1024 + 4096);
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the request when the body read fails", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(BODY_SENTINEL));
      },
    });
    const transport = transportFor(() => new Response(body, { status: 500 }), signals);

    const { value: error } = await settle(
      transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 5_000 }),
    );
    expect((error as TransportHttpError).status).toBe(500);
    await turns();
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a bodiless 204 as a no-op: no drain timer, no abort", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const transport = transportFor(() => new Response(null, { status: 204 }), signals);

    await expect(
      transport.postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("still detects the read-only-key marker on a 403", async () => {
    const transport = transportFor(
      () =>
        new Response(JSON.stringify({ detail: { code: "read_only_key", message: "x" } }), {
          status: 403,
        }),
      [],
    );
    const error = await transport
      .postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    expect((error as TransportHttpError).status).toBe(403);
    expect((error as TransportHttpError).marker).toBe("read_only_key");

    const plain = await transportFor(
      () => new Response(JSON.stringify({ detail: BODY_SENTINEL }), { status: 403 }),
      [],
    )
      .postJson(BUDGET_CONFIRM_PATH, {}, { timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    expect((plain as TransportHttpError).marker).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain(BODY_SENTINEL);
    expect((plain as Error).message).toBe("HTTP 403");
  });
});

describe("Transport body disposal — hostile cancel and late responses", () => {
  it.each([
    ["hangs", (): PromiseLike<void> => new Promise<void>(() => {})],
    ["rejects", (): PromiseLike<void> => Promise.reject(new Error(BODY_SENTINEL))],
    [
      "throws",
      (): PromiseLike<void> => {
        throw new Error(BODY_SENTINEL);
      },
    ],
  ])("holds nothing past the drain bound when cancel %s", async (_label, cancel) => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const signals: AbortSignal[] = [];
      const { body, probe } = trackedBody({ complete: false, cancel });
      const transport = transportFor(() => new Response(body, { status: 503 }), signals);

      await settle(transport.postJson(METADATA_INGEST_PATH, [], { timeoutMs: 5_000 }));
      await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS);
      await turns();

      expect(probe.cancels).toBe(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("disposes of a Response an abort-ignoring fetch delivers after the timeout", async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const transport = new Transport(API_URL, API_KEY, {
      fetch: (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          deliver = resolve;
        });
      },
    });
    const outcome = transport
      .postJson(METADATA_INGEST_PATH, [], { timeoutMs: 50 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toBeInstanceOf(TransportTimeoutError);

    const { body, probe } = trackedBody({ complete: false });
    deliver(new Response(body, { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    await turns();

    expect(probe.cancels).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes of a Response an abort-ignoring fetch delivers after an external abort", async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const transport = new Transport(API_URL, API_KEY, {
      fetch: () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    });
    const owner = new AbortController();
    const outcome = transport
      .postJson(METADATA_INGEST_PATH, [], { timeoutMs: 5_000, signal: owner.signal })
      .catch((e: unknown) => e);
    owner.abort();
    await settle(outcome);

    const { body, probe } = trackedBody({ complete: false });
    deliver(new Response(body, { status: 503 }));
    await vi.advanceTimersByTimeAsync(0);
    await turns();

    expect(probe.cancels).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The four postJson call sites: unfinished and completed success bodies are
// released and still count as success.
// ---------------------------------------------------------------------------

type BodyKind = "unfinished" | "completed";

function successResponse(kind: BodyKind, status: number, probes: BodyProbe[]): Response {
  const { body, probe } = trackedBody(
    kind === "unfinished"
      ? { complete: false, chunks: [chunk(8)] }
      : { complete: true, chunks: [chunk(32)] },
  );
  probes.push(probe);
  return new Response(body, { status });
}

function expectReleased(kind: BodyKind, probes: BodyProbe[], signals: AbortSignal[]): void {
  expect(probes.length).toBeGreaterThan(0);
  if (kind === "unfinished") {
    expect(probes.every((probe) => probe.cancels === 1)).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  } else {
    expect(probes.every((probe) => probe.finished && probe.cancels === 0)).toBe(true);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  }
}

function leaseGrant(): LeaseGrantResponse {
  return {
    eligible: true,
    allowed: true,
    lease_id: "lease-1",
    generation: 1,
    granted_tokens: 15_000,
    refresh_interval_s: 300,
    lease_length_s: 600,
    headroom_share_tokens: 5_000,
    posture: { mode: "alert_only", on_unreachable: "fail_open" },
    final_grant: false,
    project_id: PROJECT_ID,
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 20,
    remaining_budget: 80,
  };
}

function confirmRequest(): BudgetConfirmRequest {
  return BudgetConfirmRequestSchema.parse({
    reservation_id: "res-1",
    model: "gpt-5.5",
    provider: "openai",
    call_id: "00000000-0000-0000-0000-000000000001",
    token_details: {
      input_tokens: 1,
      output_tokens: 1,
    },
  });
}

describe.each([
  ["unfinished", 200],
  ["completed", 200],
  ["unfinished", 202],
  ["completed", 202],
] as const)("postJson call sites release %s %i bodies", (kind, status) => {
  it("lease surrender (close) succeeds and releases the body", async () => {
    vi.useFakeTimers();
    const { logger, lines } = capturingLogger();
    const probes: BodyProbe[] = [];
    const signals: AbortSignal[] = [];
    const budget = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      leaseEnabled: true,
      holderId: "sdk-instance-1",
      logger,
      fetch: async (url, init) => {
        if (url.endsWith("/api/v1/budgets/lease")) {
          return new Response(JSON.stringify(leaseGrant()), { status: 200 });
        }
        if (url.endsWith("/api/v1/budgets/lease/surrender")) {
          if (init?.signal) signals.push(init.signal);
          return successResponse(kind, status, probes);
        }
        throw new Error("unexpected test URL");
      },
    });
    await budget.checkBudget({
      callId: "00000000-0000-0000-0000-000000000011",
      estimatedInputTokens: 100,
      estimatedOutputBound: 500,
      model: "gpt-5.5",
      provider: "openai",
      agentRunId: "run_lease",
    });

    await expect(budget.close()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS);
    await turns();

    expect(signals).toHaveLength(1);
    expectReleased(kind, probes, signals);
    expect(lines.map((line) => line[0])).not.toContain("lease.surrender_failed");
    expect(JSON.stringify(lines)).not.toContain(BODY_SENTINEL);
  });

  it("confirm counts as sent and releases the body", async () => {
    vi.useFakeTimers();
    const { logger, lines } = capturingLogger();
    const probes: BodyProbe[] = [];
    const signals: AbortSignal[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      flushInterval: 3_600,
      fetch: async (url, init) => {
        expect(url.endsWith(BUDGET_CONFIRM_PATH)).toBe(true);
        if (init?.signal) signals.push(init.signal);
        return successResponse(kind, status, probes);
      },
    });

    await expect(reporter._sendConfirm(confirmRequest())).resolves.toBe("sent");
    await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS);
    await turns();

    expectReleased(kind, probes, signals);
    expect(JSON.stringify(lines)).not.toContain(BODY_SENTINEL);
    await reporter.close(0);
  });

  it("breaker report counts as sent and releases the body", async () => {
    vi.useFakeTimers();
    const { logger, lines } = capturingLogger();
    const probes: BodyProbe[] = [];
    const signals: AbortSignal[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      flushInterval: 3_600,
      sdkInstanceId: SDK_INSTANCE_ID,
      breakerSnapshots: () => [
        [
          "openai",
          {
            state: "open",
            failureCount: 3,
            successCount: 0,
            lastFailureTime: null,
            lastStateChange: 0,
            recoveryEligible: false,
          },
        ],
      ],
      fetch: async (url, init) => {
        expect(url).toContain("/providers/breaker-reports");
        if (init?.signal) signals.push(init.signal);
        return successResponse(kind, status, probes);
      },
    });
    reporter.observeProjectId(PROJECT_ID);

    await reporter._startBreakerCycle(true);
    await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS);
    await turns();

    expect(signals).toHaveLength(1);
    expectReleased(kind, probes, signals);
    // Success is recorded: an unchanged snapshot is not re-sent on the next cycle.
    await reporter._startBreakerCycle();
    expect(signals).toHaveLength(1);
    expect(lines.map((line) => line[0])).not.toContain(
      "reporter.breaker_send_failed: provider=%s exc_type=%s",
    );
    expect(JSON.stringify(lines)).not.toContain(BODY_SENTINEL);
    await reporter.close(0);
  });

  it("untracked-surface report counts as sent and releases the body", async () => {
    vi.useFakeTimers();
    const probes: BodyProbe[] = [];
    const signals: AbortSignal[] = [];
    const fetch: FetchLike = async (url, init) => {
      expect(url.endsWith("/api/v1/untracked-surfaces")).toBe(true);
      if (init?.signal) signals.push(init.signal);
      return successResponse(kind, status, probes);
    };
    const reporter = new UntrackedSurfaceReporter(API_URL, API_KEY, {
      sdkInstanceId: SDK_INSTANCE_ID,
      fetch,
      monotonicClock: () => 0,
    });

    reporter.observe({
      provider: "openai",
      clientShape: "openai_sdk",
      surface: "responses.create",
      ruleKind: "unmetered_spend",
      capabilityScope: null,
      posture: "warn",
    });
    await reporter.flushDue();
    await vi.advanceTimersByTimeAsync(DRAIN_BOUND_MS);
    await turns();

    expect(signals).toHaveLength(1);
    expectReleased(kind, probes, signals);
    // Success is recorded: the same surface is not re-reported while it is fresh.
    reporter.observe({
      provider: "openai",
      clientShape: "openai_sdk",
      surface: "responses.create",
      ruleKind: "unmetered_spend",
      capabilityScope: null,
      posture: "warn",
    });
    await reporter.flushDue();
    expect(signals).toHaveLength(1);
    await reporter.close();
  });
});
