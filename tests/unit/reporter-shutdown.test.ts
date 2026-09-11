import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { SolwynError } from "../../src/errors";
import type { Logger } from "../../src/logging";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;

function callId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function event(index = 1): MetadataEvent {
  return MetadataEventSchema.parse({
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 1,
    output_tokens: 1,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: callId(index),
    sdk_instance_id: "sdk-shutdown",
    timestamp: "2026-08-31T00:00:00Z",
  });
}

function confirm(index = 1): BudgetConfirmRequest {
  return BudgetConfirmRequestSchema.parse({
    reservation_id: `res-${index}`,
    model: "gpt-4o",
    provider: "openai",
    call_id: callId(index),
    token_details: zeroTokenDetails(),
  });
}

function ingest(count: number): Response {
  return new Response(JSON.stringify({ ingested: count, rejected: [] }), { status: 202 });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loggerSpies(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MetadataReporter bounded shutdown", () => {
  it("zero-deadline close seals queued work and counts both settlement halves", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, { shutdownDeadline: 0 });
    reporter.reportConfirm(confirm(1));
    reporter.reportSettlement(confirm(2), event(2));
    reporter.report(event(3));

    await reporter.close();

    expect(reporter.droppedCounts).toEqual({
      "confirm.shutdown_deadline": 1,
      "settlement_confirm.shutdown_deadline": 1,
      "event.shutdown_deadline": 2,
    });
    expect(reporter.confirmQueueSize).toBe(0);
    expect(reporter.settlementQueueSize).toBe(0);
    expect(reporter.metadataQueueSize).toBe(0);
  });

  // Mutation caught: the synchronous close-setup failure path seals ordinary
  // queues without consuming terminal receipt-fold ownership first.
  it("close setup failure seals residual receipt folds without retention", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 1_000_000,
      maxQueueSize: 1,
      monotonicClock: () => {
        throw new Error("clock unavailable");
      },
    });
    const folded = MetadataEventSchema.parse({
      ...event(4),
      status: "budget_denied",
      deny_source: "server",
      deny_reason: "monthly",
      denied_by_period: "monthly",
      receipt_aggregate_count: 6,
    });
    reporter.report(folded);
    reporter.report(event(5));

    await expect(reporter.close()).resolves.toBeUndefined();

    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "event.shutdown_deadline": 7 });
  });

  it("installs one exact close promise and the first caller's deadline before reentry", async () => {
    let reporter!: MetadataReporter;
    let nested: Promise<void> | undefined;
    const fetch = vi.fn<FetchLike>(async (url) => {
      nested = reporter.close(1000);
      return url.endsWith("/metadata/ingest") ? ingest(1) : new Response(null, { status: 204 });
    });
    reporter = new MetadataReporter(API_URL, API_KEY, { fetch, shutdownDeadline: 100 });
    reporter.report(event());

    const first = reporter.close(100);
    const second = reporter.close(10_000);
    expect(second).toBe(first);
    await first;

    expect(nested).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("hard outer deadline seals an in-hand send even when injected fetch ignores abort", async () => {
    vi.useFakeTimers();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: () => new Promise<Response>(() => {}),
      flushInterval: 1_000_000,
      shutdownDeadline: 10,
    });
    reporter.reportConfirm(confirm());

    const closing = reporter.close();
    await vi.advanceTimersByTimeAsync(10);
    await closing;

    expect(reporter.droppedCounts).toEqual({ "confirm.shutdown_deadline": 1 });
  });

  it("aborts an already-active breaker transport when close starts with no time remaining", async () => {
    const providerBreaker = new CircuitBreaker({ name: "openai" });
    let transportSignal: AbortSignal | null | undefined;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      sdkInstanceId: "sdk-shutdown",
      breakerSnapshots: () => [["openai", providerBreaker.getState()]],
      fetch: (_url, init) => {
        transportSignal = init?.signal;
        return new Promise<Response>(() => {});
      },
    });
    reporter.observeProjectId(`proj_${"0".repeat(24)}`);

    const activeCycle = reporter._startBreakerCycle();
    for (let turn = 0; turn < 10 && transportSignal === undefined; turn += 1) {
      await Promise.resolve();
    }
    expect(transportSignal?.aborted).toBe(false);

    await reporter.close(0);

    expect(transportSignal?.aborted).toBe(true);
    await activeCycle;
  });

  it("late in-hand completion after seal cannot requeue, recount, or mutate", async () => {
    const gate = deferred<Response>();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: () => gate.promise,
      shutdownDeadline: 0,
    });
    reporter.reportConfirm(confirm());
    const flushing = reporter._flushRemaining();
    await Promise.resolve();

    await reporter.close();
    expect(reporter.droppedCounts).toEqual({ "confirm.shutdown_deadline": 1 });

    gate.resolve(new Response(null, { status: 204 }));
    await flushing;
    expect(reporter.droppedCounts).toEqual({ "confirm.shutdown_deadline": 1 });
    expect(reporter.confirmQueueSize).toBe(0);
  });

  it("late in-hand event completion after seal cannot publish a disposition", async () => {
    const gate = deferred<Response>();
    const fetch = vi.fn(() => gate.promise);
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch,
      shutdownDeadline: 0,
    });
    reporter.report(event());
    const flushing = reporter._flushRemaining();
    for (let turn = 0; turn < 10 && fetch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }

    await reporter.close();
    expect(reporter.droppedCounts).toEqual({ "event.shutdown_deadline": 1 });

    gate.resolve(
      new Response(
        JSON.stringify({
          ingested: 0,
          rejected: [{ index: 0, code: "x", model: "m", message: "x" }],
        }),
        { status: 202 },
      ),
    );
    await flushing;
    expect(reporter.droppedCounts).toEqual({ "event.shutdown_deadline": 1 });
  });

  // Mutation caught: removing the stale-ownership guard from the metadata send
  // catch path logs a late transport failure after close already owns the event.
  it("late in-hand metadata rejection after seal stays silent and singly disposed", async () => {
    const gate = deferred<Response>();
    const started = deferred<void>();
    const logger = loggerSpies();
    const payloads: string[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      shutdownDeadline: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(body.map((item) => item.call_id));
        started.resolve(undefined);
        return gate.promise;
      },
    });
    reporter.report(event(1));
    const flushing = reporter._flushRemaining();
    await started.promise;

    await reporter.close();
    expect(reporter.droppedCounts).toEqual({ "event.shutdown_deadline": 1 });

    gate.reject(new TypeError("late metadata failure"));
    await flushing;

    expect(payloads).toEqual([[callId(1)]]);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "event.shutdown_deadline": 1 });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to send metadata batch"),
    );
  });

  it("late in-hand settlement verdict after seal counts both halves exactly once", async () => {
    const gate = deferred<Response>();
    const fetch = vi.fn(() => gate.promise);
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch,
      shutdownDeadline: 0,
    });
    reporter.reportSettlement(confirm(), event());
    const flushing = reporter._flushRemaining();
    for (let turn = 0; turn < 10 && fetch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }

    await reporter.close();
    expect(reporter.droppedCounts).toEqual({
      "settlement_confirm.shutdown_deadline": 1,
      "event.shutdown_deadline": 1,
    });

    gate.resolve(new Response(null, { status: 404 }));
    await flushing;
    expect(reporter.droppedCounts).toEqual({
      "settlement_confirm.shutdown_deadline": 1,
      "event.shutdown_deadline": 1,
    });
  });

  // Characterizes the retry-exhaustion tie-break: continuing after the final retryable
  // event failure would incorrectly make an HTTP attempt for event 2.
  it("final retry exhaustion ends the event cycle and seal owns the untouched tail", async () => {
    const now = 0;
    const ingestPayloads: string[][] = [];
    const ingestResponses = [new Response(null, { status: 503 }), ingest(1)];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 1,
      monotonicClock: () => now,
      fetch: async (url, init) => {
        if (url.endsWith("/budgets/confirm")) return new Response(null, { status: 204 });
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        ingestPayloads.push(body.map((item) => item.call_id));
        const response = ingestResponses.shift();
        if (response === undefined) throw new Error("unexpected extra ingest attempt");
        return response;
      },
    });
    reporter.report(event(1));
    reporter.reportSettlement(confirm(2), event(2));

    await reporter.close(1000);

    expect(ingestPayloads).toEqual([[callId(1)]]);
    expect(ingestResponses).toHaveLength(1);
    expect(reporter.droppedCounts).toEqual({
      "event.retry_exhausted": 1,
      "event.shutdown_deadline": 1,
    });
    expect(reporter.confirmQueueSize).toBe(0);
    expect(reporter.settlementQueueSize).toBe(0);
    expect(reporter.metadataQueueSize).toBe(0);
  });

  it("final settlement salvage bypasses a full event queue and preserves earlier FIFO order", async () => {
    const ingestBodies: MetadataEvent[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      maxQueueSize: 1,
      fetch: async (url, init) => {
        if (url.endsWith("/budgets/confirm")) return new Response(null, { status: 404 });
        ingestBodies.push(JSON.parse(String(init?.body)) as MetadataEvent[]);
        return ingest(2);
      },
    });
    reporter.report(event(1));
    reporter.reportSettlement(confirm(2), event(2));

    await reporter.close();

    expect(ingestBodies.flat().map((item) => item.call_id)).toEqual([callId(1), callId(2)]);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.terminal_status": 1 });
  });

  it("final HELD settlement still ships its event through breaker-unguarded ingest", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: "control-plane" });
    breaker.recordFailure();
    const urls: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      fetch: async (url) => {
        urls.push(url);
        return ingest(1);
      },
    });
    reporter.reportSettlement(confirm(), event());

    await reporter.close();

    expect(urls.map((url) => url.split("/").at(-1))).toEqual(["ingest"]);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.exit_breaker_open": 1 });
  });

  it("post-close enqueue counts event, confirm, and both settlement halves synchronously", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, { shutdownDeadline: 0 });
    await reporter.close();

    reporter.report(event(1));
    reporter.reportConfirm(confirm(2));
    reporter.reportSettlement(confirm(3), event(3));

    expect(reporter.droppedCounts).toEqual({
      "event.closed_enqueue": 2,
      "confirm.closed_enqueue": 1,
      "settlement_confirm.closed_enqueue": 1,
    });
  });

  it("auto-start scheduling failure warns once, keeps items, and start after close is typed", async () => {
    const logger = loggerSpies();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("scheduler unavailable");
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, { logger });

    expect(() => reporter.report(event(1))).not.toThrow();
    expect(() => reporter.report(event(2))).not.toThrow();
    await Promise.resolve();
    expect(reporter.metadataQueueSize).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.flush_schedule_failed: exc_type=%s",
      "Error",
    );

    vi.restoreAllMocks();
    await reporter.close(0);
    expect(() => reporter.start()).toThrow(SolwynError);
  });

  it("labels a cadence flush failure separately and continues the next cycle", async () => {
    vi.useFakeTimers();
    const logger = loggerSpies();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      flushInterval: 1,
    });
    const flush = vi
      .spyOn(reporter, "_flushRemaining")
      .mockRejectedValueOnce(new TypeError("cycle failed"))
      .mockResolvedValue(false);
    reporter.start();

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.flush_cycle_failed: exc_type=%s",
      "TypeError",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      "reporter.flush_schedule_failed: exc_type=%s",
      expect.anything(),
    );
    await reporter.close(0);
  });
});
