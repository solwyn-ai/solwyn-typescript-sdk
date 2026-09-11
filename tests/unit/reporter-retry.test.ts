import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
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

function event(index = 1, overrides: Partial<MetadataEvent> = {}): MetadataEvent {
  return MetadataEventSchema.parse({
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 100,
    status: "success",
    is_model_fallback: false,
    call_id: callId(index),
    sdk_instance_id: "sdk-a3",
    timestamp: "2026-08-31T00:00:00Z",
    ...overrides,
  });
}

function deniedEvent(index: number, overrides: Partial<MetadataEvent> = {}): MetadataEvent {
  return event(index, {
    status: "budget_denied",
    agent_run_id: `run-${index}`,
    deny_source: "server",
    deny_reason: "monthly",
    denied_by_period: "monthly",
    receipt_aggregate_count: 1,
    ...overrides,
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

function invalidConfirm(index = 1): BudgetConfirmRequest {
  return {
    ...confirm(index),
    call_id: `bad-${"x".repeat(40)}`,
  } as BudgetConfirmRequest;
}

function response202(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 202 });
}

function loggerSpies(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

interface CapturedLogCall {
  level: keyof Logger;
  args: readonly unknown[];
}

function argumentCapturingLogger(): { logger: Logger; calls: CapturedLogCall[] } {
  const calls: CapturedLogCall[] = [];
  const capture = (level: keyof Logger, args: readonly unknown[]): void => {
    calls.push({ level, args });
  };
  return {
    calls,
    logger: {
      debug: (...args) => capture("debug", args),
      info: (...args) => capture("info", args),
      warn: (...args) => capture("warn", args),
      error: (...args) => capture("error", args),
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("MetadataReporter retry outcomes and ingest parser", () => {
  it("returns discriminated confirm outcomes and classifies 408 as retryable", async () => {
    const statuses = [204, 408, 400];
    const logger = loggerSpies();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      fetch: vi.fn<FetchLike>(async () => new Response(null, { status: statuses.shift() })),
    });

    await expect(reporter._sendConfirm(confirm(1))).resolves.toBe("sent");
    await expect(reporter._sendConfirm(confirm(2))).resolves.toBe("retry");
    await expect(reporter._sendConfirm(confirm(3))).resolves.toBe("dropped");
    expect(logger.warn).toHaveBeenCalledWith("reporter.confirm_terminal_status: status=%d", 400);
  });

  it("counts direct invalid confirms to persistent escalation without duplicate failure warnings", async () => {
    const logger = loggerSpies();
    const fetch = vi.fn<FetchLike>();
    const reporter = new MetadataReporter(API_URL, API_KEY, { logger, fetch });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await expect(reporter._sendConfirm(invalidConfirm(cycle))).resolves.toBe("dropped");
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(10);
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.confirm_unserializable: fields=call_id exc_type=ZodError",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("reporter.confirm_send_failed"),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "reporter.confirm_send_persistent_failure: exc_type=ZodError consecutive_failures=10",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("xxxx"));
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining("xxxx"));
  });

  it("returns held without an attempt or verdict when the shared breaker refuses admission", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: "control-plane" });
    breaker.recordFailure();
    const before = breaker.getState();
    const fetch = vi.fn<FetchLike>();
    const logger = loggerSpies();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      fetch,
      logger,
    });

    await expect(reporter._sendConfirm(confirm())).resolves.toBe("held");
    expect(fetch).not.toHaveBeenCalled();
    expect(breaker.getState()).toEqual(before);
    expect(logger.debug).toHaveBeenCalledWith("reporter.confirm_held_breaker_open");
  });

  it.each([
    ["clean", { ingested: 2, rejected: [] }, "clean", [], 0],
    [
      "exact",
      {
        ingested: 0,
        rejected: [
          { index: 1, code: "future_code", model: "m", message: "x" },
          { index: 0, code: "future_code", model: "m", message: "y" },
        ],
      },
      "exact",
      [0, 1],
      2,
    ],
    [
      "supported legacy missing indexes",
      { ingested: 1, rejected: [{ code: "future_code", model: "m", message: "x" }] },
      "legacy",
      [],
      1,
    ],
    ["malformed missing rejected", { ingested: 1 }, "malformed", [], 0],
    ["malformed null rejected", { ingested: 1, rejected: null }, "malformed", [], 0],
    ["malformed non-array rejected", { ingested: 1, rejected: {} }, "malformed", [], 0],
    [
      "malformed too-long rejected",
      {
        ingested: 0,
        rejected: [
          { index: 0, code: "x", model: "m", message: "x" },
          { index: 1, code: "x", model: "m", message: "x" },
          { index: 2, code: "x", model: "m", message: "x" },
        ],
      },
      "malformed",
      [],
      0,
    ],
    ["malformed non-object entry", { ingested: 1, rejected: ["bad"] }, "malformed", [], 0],
  ] as const)("parses %s response bodies", async (_label, body, kind, indexes, count) => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: async () => response202(body),
    });

    const result = await reporter._sendBatch([event(1), event(2)]);

    expect(result).toEqual({
      outcome: "sent",
      rejections: { kind, indexes, count },
    });
  });

  it.each([
    ["boolean", true],
    ["float", 0.5],
    ["negative", -1],
    ["out of range", 2],
  ])("degrades a %s rejection index to legacy and records contract drift", async (_label, index) => {
    const logger = loggerSpies();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      fetch: async () =>
        response202({
          ingested: 1,
          rejected: [{ index, code: "x", model: "m", message: "x" }],
        }),
    });

    const result = await reporter._sendBatch([event(1), event(2)]);

    expect(result.rejections).toEqual({ kind: "legacy", indexes: [], count: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.ingest_response_unparseable: exc_type=RejectionContractError",
    );
  });

  it("degrades duplicate indexes to legacy while missing log identity leaves exact disposition intact", async () => {
    const logger = loggerSpies();
    const bodies = [
      {
        ingested: 0,
        rejected: [
          { index: 0, code: "x", model: "m", message: "x" },
          { index: 0, code: "x", model: "m", message: "x" },
        ],
      },
      { ingested: 1, rejected: [{ index: 1 }] },
    ];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      fetch: async () => response202(bodies.shift()),
    });

    expect((await reporter._sendBatch([event(1), event(2)])).rejections).toEqual({
      kind: "legacy",
      indexes: [],
      count: 2,
    });
    expect((await reporter._sendBatch([event(1), event(2)])).rejections).toEqual({
      kind: "exact",
      indexes: [1],
      count: 1,
    });
  });

  it("treats mixed indexed and index-less rejections as supported partial legacy", async () => {
    const logger = loggerSpies();
    const body = {
      ingested: 1,
      rejected: [
        { index: 1, code: "x", model: "m", message: "indexed" },
        { code: "x", model: "m", message: "legacy" },
      ],
    };
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      fetch: async () => response202(body),
    });
    const submitted = [
      deniedEvent(1, { receipt_aggregate_count: 5 }),
      deniedEvent(2, { receipt_aggregate_count: 1 }),
      deniedEvent(3, { receipt_aggregate_count: 5 }),
    ];

    const result = await reporter._sendBatch(submitted);

    expect(result).toEqual({
      outcome: "sent",
      rejections: { kind: "legacy", indexes: [], count: 2 },
    });
    expect(reporter._dispositionIndexes(submitted, result.rejections)).toEqual([0, 2]);
    expect(logger.warn).not.toHaveBeenCalledWith(
      "reporter.ingest_response_unparseable: exc_type=RejectionContractError",
    );

    for (const item of submitted) reporter.report(item);
    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(reporter.droppedCounts).toEqual({ "event.ingest_rejected": 10 });
    expect(logger.warn).not.toHaveBeenCalledWith(
      "reporter.ingest_response_unparseable: exc_type=RejectionContractError",
    );
  });

  it("treats an exact read-only response as sent plus malformed without disposition", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: async () =>
        new Response(JSON.stringify({ detail: { code: "read_only_key" } }), { status: 403 }),
    });

    await expect(reporter._sendBatch([event()])).resolves.toEqual({
      outcome: "sent",
      rejections: { kind: "malformed", indexes: [], count: 0 },
    });
    expect(reporter.droppedCounts).toEqual({});
  });

  it("classifies reporter-boundary 408/body I/O as retry but completed invalid JSON as malformed sent", async () => {
    vi.useFakeTimers();
    let now = 0;
    const stalled = new Response("ignored", { status: 202 });
    Object.defineProperty(stalled, "text", {
      value: () => new Promise<string>(() => {}),
    });
    const errored = new Response("ignored", { status: 202 });
    Object.defineProperty(errored, "text", {
      value: () => Promise.reject(new TypeError("body stream failed")),
    });
    const responses = [
      new Response(null, { status: 408 }),
      stalled,
      errored,
      new Response("not-json", { status: 202 }),
    ];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      monotonicClock: () => now,
      fetch: async () => responses.shift() as Response,
    });

    await expect(reporter._sendBatch([event(1)])).resolves.toMatchObject({ outcome: "retry" });
    const stalledSend = reporter._sendBatch([event(2)], 10);
    now = 50;
    await vi.advanceTimersByTimeAsync(50);
    await expect(stalledSend).resolves.toMatchObject({ outcome: "retry" });
    await expect(reporter._sendBatch([event(3)])).resolves.toMatchObject({ outcome: "retry" });
    await expect(reporter._sendBatch([event(4)])).resolves.toEqual({
      outcome: "sent",
      rejections: { kind: "malformed", indexes: [], count: 0 },
    });
    vi.useRealTimers();
  });

  it("resets malformed-response escalation on supported missing-index legacy", async () => {
    const logger = loggerSpies();
    const invalid = {
      ingested: 0,
      rejected: [{ index: false, code: "x", model: "m", message: "x" }],
    };
    const supportedLegacy = {
      ingested: 0,
      rejected: [{ code: "x", model: "m", message: "x" }],
    };
    const bodies = [...Array.from({ length: 9 }, () => invalid), supportedLegacy, invalid];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      fetch: async () => response202(bodies.shift()),
    });

    for (let index = 0; index < 11; index += 1) await reporter._sendBatch([event(index)]);

    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("reporter.ingest_response_unparseable_persistent"),
    );
  });

  it("escalates persistent invalid-index legacy on the tenth response", async () => {
    const logger = loggerSpies();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      fetch: async () =>
        response202({
          ingested: 0,
          rejected: [{ index: -1, code: "x", model: "m", message: "x" }],
        }),
    });

    for (let index = 0; index < 10; index += 1) await reporter._sendBatch([event(index)]);

    expect(logger.error).toHaveBeenCalledWith(
      "reporter.ingest_response_unparseable_persistent: exc_type=RejectionContractError consecutive_failures=10",
    );
  });
});

describe("MetadataReporter pending queues, FIFO retry, and dispositions", () => {
  it("retries a settlement 503 → 503 → 204 with exact backoff before shipping its event", async () => {
    let now = 0;
    const urls: string[] = [];
    const confirmStatuses = [503, 503, 204];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      retryBackoffCap: 60_000,
      fetch: async (url) => {
        urls.push(url);
        if (url.endsWith("/budgets/confirm")) {
          return new Response(null, { status: confirmStatuses.shift() });
        }
        return response202({ ingested: 1, rejected: [] });
      },
    });
    reporter.reportSettlement(confirm(1), event(1));

    await reporter._flushRemaining();
    await reporter._flushRemaining();
    expect(urls).toHaveLength(1);
    now = 1000;
    await reporter._flushRemaining();
    now = 2999;
    await reporter._flushRemaining();
    expect(urls).toHaveLength(2);
    now = 3000;
    await reporter._flushRemaining();

    expect(urls.map((url) => url.split("/").at(-1))).toEqual([
      "confirm",
      "confirm",
      "confirm",
      "ingest",
    ]);
    expect(reporter.droppedCounts).toEqual({});
  });

  // Mutation caught: generic settlement retry prepend can exceed the control cap
  // and silently retain the concurrent refill instead of salvaging its newest event.
  it("settlement retry restoration preserves its head and salvages the newest refill event", async () => {
    let now = 0;
    const firstAttempt = deferred<Response>();
    const started = deferred<void>();
    const confirmPayloads: string[] = [];
    const ingestPayloads: string[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      maxQueueSize: 2001,
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      fetch: async (url, init) => {
        if (url.endsWith("/budgets/confirm")) {
          const body = JSON.parse(String(init?.body)) as BudgetConfirmRequest;
          confirmPayloads.push(body.call_id);
          if (confirmPayloads.length === 1) {
            started.resolve(undefined);
            return firstAttempt.promise;
          }
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        ingestPayloads.push(body.map((item) => item.call_id));
        return response202({ ingested: body.length, rejected: [] });
      },
    });
    reporter.reportSettlement(confirm(1), event(1));
    const flushing = reporter._flushRemaining();
    await started.promise;
    for (let index = 2; index <= 1001; index += 1) {
      reporter.reportSettlement(confirm(index), event(index));
    }

    firstAttempt.resolve(new Response(null, { status: 503 }));
    await flushing;

    expect(reporter.settlementQueueSize).toBe(1000);
    expect(ingestPayloads).toEqual([[callId(1001)]]);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.overflow": 1 });
    now = 1000;
    await reporter._flushRemaining();
    expect(confirmPayloads.slice(0, 3)).toEqual([callId(1), callId(1), callId(2)]);
    expect(confirmPayloads.at(-1)).toBe(callId(1000));
    expect(confirmPayloads).not.toContain(callId(1001));
    expect(ingestPayloads.flat().slice(0, 3)).toEqual([callId(1001), callId(1), callId(2)]);
    expect(ingestPayloads.flat()).toHaveLength(1001);
    expect(ingestPayloads.flat().at(-1)).toBe(callId(1000));
    expect(reporter.settlementQueueSize).toBe(0);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.overflow": 1 });
  });

  it("uses the exact 1/2/4/8 second no-jitter schedule and caps attempt 1,000,000", () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      retryBackoffBase: 1000,
      retryBackoffCap: 60_000,
    });

    expect([1, 2, 3, 4].map((attempt) => reporter._backoffDelay(attempt))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
    expect(reporter._backoffDelay(1_000_000)).toBe(60_000);
  });

  it("parks a retrying confirm head so later confirms cannot jump it", async () => {
    let now = 0;
    const sent: string[] = [];
    const statuses = [503, 204, 204];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as BudgetConfirmRequest;
        sent.push(body.call_id);
        return new Response(null, { status: statuses.shift() });
      },
    });
    reporter.reportConfirm(confirm(1));
    reporter.reportConfirm(confirm(2));

    await reporter._flushRemaining();
    expect(sent).toEqual([callId(1)]);
    now = 1000;
    await reporter._flushRemaining();
    expect(sent).toEqual([callId(1), callId(1), callId(2)]);
  });

  // Mutation caught: generic confirm retry prepend can retain 1001 items after
  // an awaited oldest send lets a concurrent refill reach the 1000-item cap.
  it("confirm retry restoration preserves the oldest head and evicts the newest refill", async () => {
    let now = 0;
    const firstAttempt = deferred<Response>();
    const started = deferred<void>();
    const sent: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as BudgetConfirmRequest;
        sent.push(body.call_id);
        if (sent.length === 1) {
          started.resolve(undefined);
          return firstAttempt.promise;
        }
        return new Response(null, { status: 204 });
      },
    });
    reporter.reportConfirm(confirm(1));
    const flushing = reporter._flushRemaining();
    await started.promise;
    for (let index = 2; index <= 1001; index += 1) reporter.reportConfirm(confirm(index));

    firstAttempt.resolve(new Response(null, { status: 503 }));
    await flushing;

    expect(reporter.confirmQueueSize).toBe(1000);
    expect(reporter.droppedCounts).toEqual({ "confirm.overflow": 1 });
    now = 1000;
    await reporter._flushRemaining();
    expect(sent.slice(0, 3)).toEqual([callId(1), callId(1), callId(2)]);
    expect(sent.at(-1)).toBe(callId(1000));
    expect(sent).not.toContain(callId(1001));
    expect(reporter.confirmQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "confirm.overflow": 1 });
  });

  // Mutation caught: generic confirm HELD prepend can exceed the hard control
  // cap after the oldest admission is claimed and 1000 newer confirms refill it.
  it("confirm HELD restoration stays capped without consuming an attempt", async () => {
    let breakerNow = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      now: () => breakerNow,
    });
    breaker.recordFailure();
    const sent: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as BudgetConfirmRequest;
        sent.push(body.call_id);
        return new Response(null, { status: 204 });
      },
    });
    reporter.reportConfirm(confirm(1));
    const flushing = reporter._flushRemaining();
    expect(reporter.confirmQueueSize).toBe(0);
    for (let index = 2; index <= 1001; index += 1) reporter.reportConfirm(confirm(index));

    await flushing;

    expect(sent).toEqual([]);
    expect(reporter.confirmQueueSize).toBe(1000);
    expect(reporter.droppedCounts).toEqual({ "confirm.overflow": 1 });
    breakerNow = 1000;
    await reporter._flushRemaining();
    expect(sent.slice(0, 2)).toEqual([callId(1), callId(2)]);
    expect(sent.at(-1)).toBe(callId(1000));
    expect(sent).not.toContain(callId(1001));
    expect(reporter.confirmQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "confirm.overflow": 1 });
  });

  it("drops on attempt five and increments the confirm failure escalation once per cycle", async () => {
    let now = 0;
    const logger = loggerSpies();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      maxSendAttempts: 5,
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      fetch: async () => new Response(null, { status: 503 }),
    });
    reporter.reportConfirm(confirm());

    for (const next of [0, 1000, 3000, 7000, 15_000]) {
      now = next;
      await reporter._flushRemaining();
    }

    expect(reporter.droppedCounts).toEqual({ "confirm.retry_exhausted": 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      "reporter.spend_events_dropped: new=%d totals=%s",
      1,
      JSON.stringify({ "confirm.retry_exhausted": 1 }),
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("reporter.confirm_send_persistent_failure"),
    );
  });

  // Mutation caught: letting the ordinary event-claim predicate accept a backing-off
  // head (or scan past it) sends metadata before its retry deadline and breaks FIFO.
  it("ordinary metadata drain parks a backing-off head and every later due event", async () => {
    let now = 0;
    const payloads: string[][] = [];
    const statuses = [503];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(body.map((item) => item.call_id));
        return new Response(null, { status: statuses.shift() });
      },
    });
    reporter.report(event(1));
    await reporter._flushRemaining();
    reporter.report(event(2));

    now = 999;
    await reporter._flushRemaining();

    expect(payloads).toEqual([[callId(1)]]);
    expect(reporter.metadataQueueSize).toBe(2);
    expect(reporter.droppedCounts).toEqual({});
  });

  // Mutation caught: removing `final` from the event-claim predicate leaves a
  // backing-off FIFO prefix unsent during close and seals it as deadline loss.
  it("final metadata drain ignores head backoff and sends the full FIFO prefix", async () => {
    const now = 0;
    const payloads: string[][] = [];
    const statuses = [503, 202];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(body.map((item) => item.call_id));
        const status = statuses.shift();
        return status === 202
          ? response202({ ingested: body.length, rejected: [] })
          : new Response(null, { status });
      },
    });
    reporter.report(event(1));
    await reporter._flushRemaining();
    reporter.report(event(2));

    await reporter.close(100);

    expect(payloads).toEqual([[callId(1)], [callId(1), callId(2)]]);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({});
  });

  // Mutation caught: generic prepend after an awaited event retry can persist
  // the claimed prefix plus a concurrent refill beyond maxQueueSize without drops.
  it("event retry restoration keeps its owned prefix and evicts the newest refill suffix", async () => {
    let now = 0;
    const firstAttempt = deferred<Response>();
    const started = deferred<void>();
    const payloads: string[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 2,
      maxQueueSize: 3,
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(body.map((item) => item.call_id));
        if (payloads.length === 1) {
          started.resolve(undefined);
          return firstAttempt.promise;
        }
        return response202({ ingested: body.length, rejected: [] });
      },
    });
    reporter.report(event(1));
    reporter.report(event(2));
    reporter.report(event(3));
    const flushing = reporter._flushRemaining();
    await started.promise;
    reporter.report(event(4));
    reporter.report(event(5));

    firstAttempt.resolve(new Response(null, { status: 503 }));
    await flushing;

    expect(reporter.metadataQueueSize).toBe(3);
    expect(reporter.droppedCounts).toEqual({ "event.overflow": 2 });
    now = 1000;
    await reporter._flushRemaining();
    expect(payloads).toEqual([[callId(1), callId(2)], [callId(1), callId(2)], [callId(3)]]);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "event.overflow": 2 });
  });

  it("keeps mixed-attempt event members independent when the older member exhausts", async () => {
    let now = 0;
    const payloads: string[][] = [];
    const statuses = [503, 503, 202];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      maxSendAttempts: 2,
      retryBackoffBase: 1000,
      monotonicClock: () => now,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(body.map((item) => item.call_id));
        const status = statuses.shift();
        return status === 202
          ? response202({ ingested: body.length, rejected: [] })
          : new Response(null, { status });
      },
    });
    reporter.report(event(1));
    await reporter._flushRemaining();
    reporter.report(event(2));
    now = 1000;
    await reporter._flushRemaining();
    now = 2000;
    await reporter._flushRemaining();

    expect(payloads).toEqual([[callId(1)], [callId(1), callId(2)], [callId(2)]]);
    expect(reporter.droppedCounts).toEqual({ "event.retry_exhausted": 1 });
  });

  it("uses the last confirm verdict in a cycle for failure-reset accounting", async () => {
    const logger = loggerSpies();
    const statuses = [503, 204, ...Array.from({ length: 9 }, () => 503)];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger,
      maxSendAttempts: 1,
      fetch: async () => new Response(null, { status: statuses.shift() }),
    });
    reporter.reportConfirm(confirm(1));
    reporter.reportConfirm(confirm(2));
    await reporter._flushRemaining();
    for (let index = 0; index < 9; index += 1) {
      reporter.reportConfirm(confirm(10 + index));
      await reporter._flushRemaining();
    }
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining("reporter.confirm_send_persistent_failure"),
    );

    reporter.reportConfirm(confirm(30));
    statuses.push(503);
    await reporter._flushRemaining();
    expect(logger.error).toHaveBeenCalledWith(
      "reporter.confirm_send_persistent_failure: exc_type=TransportHttpError consecutive_failures=10",
    );
  });

  it("counts diagnosed invalid-confirm flush cycles and resets escalation after a sent confirm", async () => {
    const warn = vi.fn<Logger["warn"]>();
    const error = vi.fn<Logger["error"]>();
    const fetch = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error },
    });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      reporter.reportConfirm(invalidConfirm(cycle));
      await reporter._flushRemaining();
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenLastCalledWith(
      "reporter.confirm_send_persistent_failure: exc_type=ZodError consecutive_failures=10",
    );

    reporter.reportConfirm(confirm(100));
    await reporter._flushRemaining();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      reporter.reportConfirm(invalidConfirm(200 + cycle));
      await reporter._flushRemaining();
    }
    expect(error).toHaveBeenCalledTimes(1);

    reporter.reportConfirm(invalidConfirm(300));
    await reporter._flushRemaining();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error.mock.calls).toEqual([
      ["reporter.confirm_send_persistent_failure: exc_type=ZodError consecutive_failures=10"],
      ["reporter.confirm_send_persistent_failure: exc_type=ZodError consecutive_failures=10"],
    ]);
    expect(
      warn.mock.calls.filter(([message]) =>
        message.startsWith("reporter.confirm_unserializable: fields=call_id"),
      ),
    ).toHaveLength(20);
    expect(
      warn.mock.calls.filter(([message]) => message.startsWith("reporter.confirm_send_failed")),
    ).toHaveLength(0);
    expect([...warn.mock.calls, ...error.mock.calls].flat().join("\n")).not.toContain("xxxx");
  });

  it("increments at most once for multiple failures and preserves success-then-failure", async () => {
    const readFailures = (reporter: MetadataReporter): number =>
      (reporter as unknown as { consecutiveConfirmFailures: number }).consecutiveConfirmFailures;

    const allFail = new MetadataReporter(API_URL, API_KEY, {
      maxSendAttempts: 1,
      fetch: async () => new Response(null, { status: 503 }),
    });
    allFail.reportConfirm(confirm(1));
    allFail.reportConfirm(confirm(2));
    await allFail._flushRemaining();
    expect(readFailures(allFail)).toBe(1);

    const statuses = [204, 503];
    const successThenFailure = new MetadataReporter(API_URL, API_KEY, {
      maxSendAttempts: 1,
      fetch: async () => new Response(null, { status: statuses.shift() }),
    });
    successThenFailure.reportConfirm(confirm(3));
    successThenFailure.reportConfirm(confirm(4));
    await successThenFailure._flushRemaining();
    expect(readFailures(successThenFailure)).toBe(1);
  });

  it("counts drop-oldest event overflow while retaining the newest items in FIFO order", () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, { maxQueueSize: 3 });
    for (let index = 0; index < 5; index += 1) reporter.report(event(index));

    expect(reporter.droppedCounts).toEqual({ "event.overflow": 2 });
    expect(reporter._drainBatch().map((item) => item.call_id)).toEqual([
      callId(2),
      callId(3),
      callId(4),
    ]);
  });

  it("counts control overflow and salvages an evicted settlement event", () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, { maxQueueSize: 2000 });
    for (let index = 0; index < 1001; index += 1) {
      reporter.reportConfirm(confirm(index));
      reporter.reportSettlement(
        confirm(2000 + index),
        event(
          4000 + index,
          index === 0
            ? {
                agent_run_id: "run-salvaged",
                agent_run_name: "salvaged-run",
                parent_agent_run_id: "run-parent",
                tags: { phase: "settlement", source: "overflow" },
              }
            : {},
        ),
      );
    }

    expect(reporter.confirmQueueSize).toBe(1000);
    expect(reporter.settlementQueueSize).toBe(1000);
    expect(reporter.metadataQueueSize).toBe(1);
    expect(
      reporter
        ._drainBatch()
        .map(({ call_id, agent_run_id, agent_run_name, parent_agent_run_id, tags }) => ({
          call_id,
          agent_run_id,
          agent_run_name,
          parent_agent_run_id,
          tags,
        })),
    ).toEqual([
      {
        call_id: callId(4000),
        agent_run_id: "run-salvaged",
        agent_run_name: "salvaged-run",
        parent_agent_run_id: "run-parent",
        tags: { phase: "settlement", source: "overflow" },
      },
    ]);
    expect(reporter.droppedCounts).toEqual({
      "confirm.overflow": 1,
      "settlement_confirm.overflow": 1,
    });
  });

  it("ships a settlement event after a terminal confirm and counts only the confirm half", async () => {
    const urls: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: async (url) => {
        urls.push(url);
        return url.endsWith("/budgets/confirm")
          ? new Response(null, { status: 404 })
          : response202({ ingested: 1, rejected: [] });
      },
    });
    reporter.reportSettlement(confirm(), event());

    await reporter._flushRemaining();

    expect(urls.map((url) => url.split("/").at(-1))).toEqual(["confirm", "ingest"]);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.terminal_status": 1 });
  });

  it("ships a settlement event after retry exhaustion and counts only the confirm half", async () => {
    const urls: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      maxSendAttempts: 1,
      fetch: async (url) => {
        urls.push(url);
        return url.endsWith("/budgets/confirm")
          ? new Response(null, { status: 503 })
          : response202({ ingested: 1, rejected: [] });
      },
    });
    reporter.reportSettlement(confirm(), event());

    await reporter._flushRemaining();

    expect(urls.map((url) => url.split("/").at(-1))).toEqual(["confirm", "ingest"]);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.retry_exhausted": 1 });
  });

  it("holds a settlement behind an open breaker and delivers both halves after recovery", async () => {
    let breakerNow = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      now: () => breakerNow,
    });
    breaker.recordFailure();
    const urls: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      fetch: async (url) => {
        urls.push(url);
        return url.endsWith("/budgets/confirm")
          ? new Response(null, { status: 204 })
          : response202({ ingested: 1, rejected: [] });
      },
    });
    reporter.reportSettlement(confirm(), event());

    await reporter._flushRemaining();
    expect(urls).toEqual([]);
    expect(reporter.settlementQueueSize).toBe(1);
    expect(reporter.droppedCounts).toEqual({});

    breakerNow = 1000;
    await reporter._flushRemaining();
    expect(urls.map((url) => url.split("/").at(-1))).toEqual(["confirm", "ingest"]);
  });

  // Mutation caught: generic settlement HELD prepend can exceed the control cap
  // and strand the refill's newest event instead of salvaging it through ingest.
  it("settlement HELD restoration stays capped and salvages the newest refill event", async () => {
    let breakerNow = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      now: () => breakerNow,
    });
    breaker.recordFailure();
    const confirmPayloads: string[] = [];
    const ingestPayloads: string[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      maxQueueSize: 2001,
      fetch: async (url, init) => {
        if (url.endsWith("/budgets/confirm")) {
          const body = JSON.parse(String(init?.body)) as BudgetConfirmRequest;
          confirmPayloads.push(body.call_id);
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        ingestPayloads.push(body.map((item) => item.call_id));
        return response202({ ingested: body.length, rejected: [] });
      },
    });
    reporter.reportSettlement(confirm(1), event(1));
    const flushing = reporter._flushRemaining();
    await Promise.resolve();
    expect(reporter.settlementQueueSize).toBe(0);
    for (let index = 2; index <= 1001; index += 1) {
      reporter.reportSettlement(confirm(index), event(index));
    }

    await flushing;

    expect(confirmPayloads).toEqual([]);
    expect(reporter.settlementQueueSize).toBe(1000);
    expect(ingestPayloads).toEqual([[callId(1001)]]);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.overflow": 1 });
    breakerNow = 1000;
    await reporter._flushRemaining();
    expect(confirmPayloads.slice(0, 2)).toEqual([callId(1), callId(2)]);
    expect(confirmPayloads.at(-1)).toBe(callId(1000));
    expect(confirmPayloads).not.toContain(callId(1001));
    expect(ingestPayloads.flat().slice(0, 3)).toEqual([callId(1001), callId(1), callId(2)]);
    expect(ingestPayloads.flat()).toHaveLength(1001);
    expect(ingestPayloads.flat().at(-1)).toBe(callId(1000));
    expect(reporter.settlementQueueSize).toBe(0);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.overflow": 1 });
  });

  it.each([
    ["exact", { ingested: 2, rejected: [{ index: 1, code: "x", model: "m", message: "x" }] }, 1],
    [
      "full legacy",
      {
        ingested: 0,
        rejected: [
          { code: "x", model: "m", message: "x" },
          { code: "x", model: "m", message: "x" },
          { code: "x", model: "m", message: "x" },
        ],
      },
      3,
    ],
    ["malformed", { ingested: 3 }, 0],
  ] as const)("publishes %s ingest dispositions synchronously", async (_label, body, count) => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 3,
      fetch: async () => response202(body),
    });
    reporter.report(event(1));
    reporter.report(event(2));
    reporter.report(event(3));

    await reporter._flushRemaining();

    expect(reporter.droppedCounts["event.ingest_rejected"] ?? 0).toBe(count);
  });

  it("selects the heaviest events for partial legacy disposition with stable tie order", () => {
    const reporter = new MetadataReporter(API_URL, API_KEY);
    const events = [
      deniedEvent(1, { receipt_aggregate_count: 5 }),
      deniedEvent(2, { receipt_aggregate_count: 100 }),
      deniedEvent(3, { receipt_aggregate_count: 100 }),
    ];

    expect(reporter._dispositionIndexes(events, { kind: "legacy", indexes: [], count: 2 })).toEqual(
      [1, 2],
    );
  });

  it("drops locally invalid events as terminal while sending the valid one with aligned indexes", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: async (_url, init) => {
        posted.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
        return response202({ ingested: 1, rejected: [] });
      },
    });
    reporter.report({ ...event(1), model: "x".repeat(2049) } as MetadataEvent);
    reporter.report(event(2));

    await reporter._flushRemaining();

    expect(posted.map((item) => item["call_id"])).toEqual([callId(2)]);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 1 });
  });

  it("projects response indexes onto the exact validated wire batch", async () => {
    const posted: string[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        posted.push(body.map((item) => item.call_id));
        return response202({
          ingested: 1,
          rejected: [{ index: 1, code: "x", model: "m", message: "x" }],
        });
      },
    });
    reporter.report({ ...event(1), model: "x".repeat(2049) } as MetadataEvent);
    reporter.report(event(2));
    reporter.report(event(3));

    await reporter._flushRemaining();

    expect(posted).toEqual([[callId(2), callId(3)]]);
    expect(reporter.droppedCounts).toEqual({
      "event.terminal_status": 1,
      "event.ingest_rejected": 1,
    });
  });

  // Mutation caught: allowing one receipt dependency poison to reach the batch
  // map aborts the whole POST and loses the valid neighbor's clean-cycle result.
  it("isolates a schema-level receipt poison while sending its valid neighbor", async () => {
    const payloads: string[][] = [];
    const log = argumentCapturingLogger();
    const sentinelValue = 88_888_888;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 2,
      logger: log.logger,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(body.map((item) => item.call_id));
        return response202({ ingested: body.length, rejected: [] });
      },
    });
    reporter.report({
      ...event(11),
      receipt_pricing_input_tokens: sentinelValue,
    } as MetadataEvent);
    reporter.report(event(12));

    await expect(reporter._flushRemaining()).resolves.toBe(false);

    expect(payloads).toEqual([[callId(12)]]);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 1 });
    expect(log.calls).toContainEqual({
      level: "warn",
      args: [
        "reporter.ingest_event_unserializable: fields=receipt_pricing_input_tokens exc_type=ZodError",
      ],
    });
    const args = log.calls.flatMap((call) => call.args);
    expect(args).not.toContain(sentinelValue);
    expect(args.some((arg) => typeof arg === "object" && arg !== null)).toBe(false);
    expect(args.filter((arg): arg is string => typeof arg === "string").join("\n")).not.toContain(
      "receipt_pricing_input_tokens requires receipt_aggregate_count",
    );
  });

  // Mutation caught: treating a mixed local Zod poison + clean send as a clean
  // flush hides local loss from the cadence's clean-cycle proof.
  it("returns an unclean cycle for a Zod-invalid event beside a sent neighbor", async () => {
    const payloads: string[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 2,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(body.map((item) => item.call_id));
        return response202({ ingested: body.length, rejected: [] });
      },
    });
    reporter.report({ ...event(13), model: "x".repeat(2049) } as MetadataEvent);
    reporter.report(event(14));

    await expect(reporter._flushRemaining()).resolves.toBe(false);

    expect(payloads).toEqual([[callId(14)]]);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 1 });
  });

  // Mutation caught: restoring the caller-owned event after a retry lets a
  // mutation between attempts alter the second wire payload.
  it("retries the canonical normalized event instead of the mutated caller object", async () => {
    let now = 0;
    const firstAttempt = deferred<Response>();
    const started = deferred<void>();
    const payloads: Array<
      Array<
        Pick<
          MetadataEvent,
          "call_id" | "model" | "agent_run_id" | "agent_run_name" | "parent_agent_run_id" | "tags"
        >
      >
    > = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      monotonicClock: () => now,
      retryBackoffBase: 1000,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(
          body.map(
            ({ call_id, model, agent_run_id, agent_run_name, parent_agent_run_id, tags }) => ({
              call_id,
              model,
              agent_run_id,
              agent_run_name,
              parent_agent_run_id,
              tags,
            }),
          ),
        );
        if (payloads.length === 1) {
          started.resolve(undefined);
          return firstAttempt.promise;
        }
        return response202({ ingested: body.length, rejected: [] });
      },
    });
    const raw = event(15, {
      model: "gpt-first",
      agent_run_id: "run-first",
      agent_run_name: "first-run",
      parent_agent_run_id: "run-parent-first",
      tags: { phase: "first", source: "caller" },
    });
    reporter.report(raw);
    reporter.report(
      event(16, {
        model: "gpt-second",
        agent_run_id: "run-second",
        agent_run_name: "second-run",
        parent_agent_run_id: "run-parent-second",
        tags: { phase: "second", source: "queued" },
      }),
    );
    const flushing = reporter._flushRemaining();
    await started.promise;
    raw.model = "gpt-mutated";
    raw.agent_run_id = "run-mutated";
    raw.agent_run_name = "mutated-run";
    raw.parent_agent_run_id = "run-parent-mutated";
    const rawTags = raw.tags;
    if (rawTags === null || rawTags === undefined) {
      throw new Error("test fixture must include tags");
    }
    rawTags["phase"] = "mutated";
    rawTags["source"] = "caller-mutated";
    firstAttempt.resolve(new Response(null, { status: 503 }));
    await flushing;

    now = 1000;
    await reporter._flushRemaining();

    expect(payloads).toEqual([
      [
        {
          call_id: callId(15),
          model: "gpt-first",
          agent_run_id: "run-first",
          agent_run_name: "first-run",
          parent_agent_run_id: "run-parent-first",
          tags: { phase: "first", source: "caller" },
        },
        {
          call_id: callId(16),
          model: "gpt-second",
          agent_run_id: "run-second",
          agent_run_name: "second-run",
          parent_agent_run_id: "run-parent-second",
          tags: { phase: "second", source: "queued" },
        },
      ],
      [
        {
          call_id: callId(15),
          model: "gpt-first",
          agent_run_id: "run-first",
          agent_run_name: "first-run",
          parent_agent_run_id: "run-parent-first",
          tags: { phase: "first", source: "caller" },
        },
        {
          call_id: callId(16),
          model: "gpt-second",
          agent_run_id: "run-second",
          agent_run_name: "second-run",
          parent_agent_run_id: "run-parent-second",
          tags: { phase: "second", source: "queued" },
        },
      ],
    ]);
    expect(reporter.droppedCounts).toEqual({});
  });

  // Mutation caught: applying an exact response index to caller-owned events
  // after the await can disposition a post-submit mutation instead of wire index 1.
  it("maps exact rejection indexes onto the canonical filtered submitted batch", async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    const payloads: string[][] = [];
    const seen: Array<{ callIds: string[]; indexes: number[] }> = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 3,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloads.push(body.map((item) => item.call_id));
        started.resolve(undefined);
        return response.promise;
      },
    });
    const originalDisposition = reporter._dispositionIndexes.bind(reporter);
    reporter._dispositionIndexes = (events, rejections) => {
      const indexes = originalDisposition(events, rejections);
      seen.push({ callIds: events.map((item) => item.call_id), indexes });
      return indexes;
    };
    const mutable = event(18);
    reporter.report({ ...event(16), model: "x".repeat(2049) } as MetadataEvent);
    reporter.report(event(17));
    reporter.report(mutable);
    const flushing = reporter._flushRemaining();
    await started.promise;
    mutable.call_id = callId(19);
    response.resolve(
      response202({
        ingested: 1,
        rejected: [{ index: 1, code: "x", model: "m", message: "x" }],
      }),
    );
    await flushing;

    expect(payloads).toEqual([[callId(17), callId(18)]]);
    expect(seen).toEqual([{ callIds: [callId(17), callId(18)], indexes: [1] }]);
    expect(reporter.droppedCounts).toEqual({
      "event.terminal_status": 1,
      "event.ingest_rejected": 1,
    });
  });

  // Mutation caught: computing partial-legacy weights from caller-owned events
  // after the await can reverse stable-heaviest disposition after submission.
  it("uses canonical submitted weights for partial legacy disposition", async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    const payloadWeights: number[][] = [];
    const seen: Array<{ weights: number[]; indexes: number[] }> = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 2,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        payloadWeights.push(body.map((item) => item.receipt_aggregate_count ?? 1));
        started.resolve(undefined);
        return response.promise;
      },
    });
    const originalDisposition = reporter._dispositionIndexes.bind(reporter);
    reporter._dispositionIndexes = (events, rejections) => {
      const indexes = originalDisposition(events, rejections);
      seen.push({
        weights: events.map((item) => item.receipt_aggregate_count ?? 1),
        indexes,
      });
      return indexes;
    };
    const heavy = deniedEvent(20, { receipt_aggregate_count: 100 });
    const light = deniedEvent(21, { receipt_aggregate_count: 1 });
    reporter.report(heavy);
    reporter.report(light);
    const flushing = reporter._flushRemaining();
    await started.promise;
    heavy.receipt_aggregate_count = 1;
    light.receipt_aggregate_count = 100;
    response.resolve(
      response202({
        ingested: 1,
        rejected: [{ code: "x", model: "m", message: "x" }],
      }),
    );
    await flushing;

    expect(payloadWeights).toEqual([[100, 1]]);
    expect(seen).toEqual([{ weights: [100, 1], indexes: [0] }]);
    expect(reporter.droppedCounts).toEqual({ "event.ingest_rejected": 100 });
  });

  // Mutation caught: counting breaker HELD as an attempt (or projecting only
  // after recovery) exhausts at the first real 503 and sends a mutated confirm.
  it("keeps a held confirm canonical and attempt-neutral through its first real failure", async () => {
    let breakerNow = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      now: () => breakerNow,
    });
    breaker.recordFailure();
    const payloads: Array<{ call_id: string; model: string }> = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      maxSendAttempts: 2,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { call_id: string; model: string };
        payloads.push({ call_id: body.call_id, model: body.model });
        return new Response(null, { status: 503 });
      },
    });
    const raw = confirm(22);
    raw.model = "gpt-first";
    reporter.reportConfirm(raw);

    await reporter._flushRemaining();
    raw.model = "gpt-mutated";
    breakerNow = 1000;
    await reporter._flushRemaining();

    expect(payloads).toEqual([{ call_id: callId(22), model: "gpt-first" }]);
    expect(reporter.confirmQueueSize).toBe(1);
    expect(reporter.droppedCounts).toEqual({});
  });

  // Mutation caught: counting settlement HELD as an attempt (or re-projecting
  // its caller confirm after recovery) can exhaust before two real failures.
  it("keeps a held settlement confirm canonical and attempt-neutral through one real failure", async () => {
    let breakerNow = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      now: () => breakerNow,
    });
    breaker.recordFailure();
    const confirmPayloads: Array<{ call_id: string; model: string }> = [];
    const ingestPayloads: string[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      controlPlaneBreaker: breaker,
      maxSendAttempts: 2,
      fetch: async (url, init) => {
        if (url.endsWith("/budgets/confirm")) {
          const body = JSON.parse(String(init?.body)) as { call_id: string; model: string };
          confirmPayloads.push({ call_id: body.call_id, model: body.model });
          return new Response(null, { status: 503 });
        }
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        ingestPayloads.push(body.map((item) => item.call_id));
        return response202({ ingested: body.length, rejected: [] });
      },
    });
    const raw = confirm(23);
    raw.model = "gpt-first";
    reporter.reportSettlement(raw, event(23));

    await reporter._flushRemaining();
    raw.model = "gpt-mutated";
    breakerNow = 1000;
    await reporter._flushRemaining();

    expect(confirmPayloads).toEqual([{ call_id: callId(23), model: "gpt-first" }]);
    expect(ingestPayloads).toEqual([]);
    expect(reporter.settlementQueueSize).toBe(1);
    expect(reporter.droppedCounts).toEqual({});
  });

  // Mutation caught: failing to salvage the newest settlement restoration
  // eviction into an already-full event queue loses it or double-counts a half.
  it("salvages a settlement restoration eviction through a full event queue exactly once", async () => {
    const firstAttempt = deferred<Response>();
    const started = deferred<void>();
    const ingestPayloads: string[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      maxQueueSize: 1,
      fetch: async (url, init) => {
        if (url.endsWith("/budgets/confirm")) {
          started.resolve(undefined);
          return firstAttempt.promise;
        }
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        ingestPayloads.push(body.map((item) => item.call_id));
        return response202({ ingested: body.length, rejected: [] });
      },
    });
    reporter.report(event(24));
    reporter.reportSettlement(confirm(25), event(25));
    const flushing = reporter._flushRemaining();
    await started.promise;
    for (let index = 26; index <= 1025; index += 1) {
      reporter.reportSettlement(confirm(index), event(index));
    }

    firstAttempt.resolve(new Response(null, { status: 503 }));
    await flushing;

    expect(ingestPayloads).toEqual([[callId(1025)]]);
    expect(reporter.settlementQueueSize).toBe(1000);
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({
      "settlement_confirm.overflow": 1,
      "event.overflow": 1,
    });
  });

  it("counts partial legacy by receipt weight and exposes a sparse defensive drop map", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 2,
      fetch: async () =>
        response202({
          ingested: 1,
          rejected: [{ code: "x", model: "m", message: "x" }],
        }),
    });
    reporter.report(deniedEvent(1, { receipt_aggregate_count: 100 }));
    reporter.report(deniedEvent(2, { receipt_aggregate_count: 1 }));
    await reporter._flushRemaining();

    const snapshot = reporter.droppedCounts as Record<string, number>;
    expect(snapshot).toEqual({ "event.ingest_rejected": 100 });
    snapshot["event.ingest_rejected"] = 999;
    snapshot["event.receipt_fold_overflow"] = 1;
    expect(reporter.droppedCounts).toEqual({ "event.ingest_rejected": 100 });
  });

  it("contains hostile logger failures across synchronous disposition diagnostics", async () => {
    const hostile: Logger = {
      debug: () => {
        throw new Error("debug failed");
      },
      info: () => {
        throw new Error("info failed");
      },
      warn: () => {
        throw new Error("warn failed");
      },
      error: () => {
        throw new Error("error failed");
      },
    };
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: hostile,
      maxQueueSize: 1,
    });

    expect(() => {
      reporter.report(event(1));
      reporter.report(event(2));
    }).not.toThrow();
    expect(reporter.droppedCounts).toEqual({ "event.overflow": 1 });
    await reporter.close(0);
  });
});
