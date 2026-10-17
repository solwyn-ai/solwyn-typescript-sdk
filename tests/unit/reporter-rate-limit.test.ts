import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import type { MetadataEvent } from "../../src/types";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
function enqueue(
  reporter: MetadataReporter,
  kind: "confirm" | "settlement" | "event",
  index = 1,
): void {
  const callId = `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
  const confirm = BudgetConfirmRequestSchema.parse({
    reservation_id: "synthetic",
    call_id: callId,
    model: "synthetic",
    provider: "openai",
    token_details: zeroTokenDetails(),
  });
  const event = MetadataEventSchema.parse({
    model: "synthetic",
    provider: "openai",
    call_id: callId,
    input_tokens: 1,
    output_tokens: 1,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    sdk_instance_id: "rate-limit-test",
    timestamp: "2026-01-01T00:00:00Z",
  });
  if (kind === "confirm") reporter.reportConfirm(confirm);
  else if (kind === "settlement") reporter.reportSettlement(confirm, event);
  else reporter.report(event);
}

afterEach(() => vi.useRealTimers());

describe("reporter rate limiting", () => {
  it.each([
    "confirm",
    "settlement",
    "event",
  ] as const)("honors Retry-After for %s without exhausting ordinary attempts", async (kind) => {
    let now = 0;
    let attempts = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      maxSendAttempts: 1,
      monotonicClock: () => now,
      fetch: async (url) => {
        if (kind === "settlement" && url.endsWith("/ingest")) {
          return new Response(JSON.stringify({ ingested: 1, rejected: [], duplicates: [] }), {
            status: 202,
          });
        }
        attempts += 1;
        return attempts < 3
          ? new Response(null, { status: 429, headers: { "Retry-After": "60" } })
          : url.endsWith("/ingest")
            ? new Response(JSON.stringify({ ingested: 1, rejected: [], duplicates: [] }), {
                status: 202,
              })
            : new Response(null, { status: 204 });
      },
    });
    enqueue(reporter, kind);
    try {
      await reporter._flushRemaining();
      now = 59_999;
      await reporter._flushRemaining();
      expect(attempts).toBe(1);
      expect(reporter.droppedCounts).toEqual({});
      now = 60_000;
      await reporter._flushRemaining();
      expect(attempts).toBe(2);
      expect(reporter.droppedCounts).toEqual({});
      now = 120_000;
      await reporter._flushRemaining();
      expect(attempts).toBe(3);
      expect(
        reporter.metadataQueueSize + reporter.confirmQueueSize + reporter.settlementQueueSize,
      ).toBe(0);
      expect(reporter.droppedCounts).toEqual({});
    } finally {
      await reporter.close(0);
    }
  });

  it.each([
    "confirm",
    "settlement",
    "event",
  ] as const)("eventually disposes a permanently rate-limited %s", async (kind) => {
    let now = 0;
    let attempts = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      maxSendAttempts: 1,
      monotonicClock: () => now,
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
      },
    });
    enqueue(reporter, kind);
    try {
      for (let index = 0; index < 45; index += 1) {
        await reporter._flushRemaining();
        now += 60_000;
      }
      expect(attempts).toBeLessThanOrEqual(kind === "settlement" ? 40 : 20);
      expect(attempts).toBeGreaterThan(1);
      expect(
        reporter.metadataQueueSize + reporter.confirmQueueSize + reporter.settlementQueueSize,
      ).toBe(0);
      expect(reporter.droppedCounts).toHaveProperty(
        kind === "confirm" ? "confirm.retry_exhausted" : "event.retry_exhausted",
        1,
      );
    } finally {
      await reporter.close(0);
    }
  });

  it("does not bypass an ingest Retry-After during the final flush", async () => {
    let attempts = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
      },
    });
    enqueue(reporter, "event");
    await reporter._flushRemaining();
    await reporter.close();
    expect(attempts).toBe(1);
    expect(reporter.droppedCounts).toEqual({ "event.rate_limited": 1 });
  });

  it.each([
    429, 503,
  ])("waits for a short ingest Retry-After on HTTP %s at close", async (status) => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const ingested: string[] = [];
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      batchSize: 3,
      monotonicClock: Date.now,
      fetch: async (_url, init) => {
        const ids = (JSON.parse(String(init?.body)) as MetadataEvent[]).map((item) => item.call_id);
        batches.push(ids);
        if (batches.length === 1) {
          return new Response(null, { status, headers: { "Retry-After": "1" } });
        }
        ingested.push(...ids);
        return new Response(
          JSON.stringify({ ingested: ids.length, rejected: [], duplicates: [] }),
          {
            status: 202,
          },
        );
      },
    });
    for (let index = 1; index <= 3; index += 1) enqueue(reporter, "event", index);
    await reporter._flushRemaining();
    for (let index = 4; index <= 6; index += 1) enqueue(reporter, "event", index);

    let closed = false;
    const closing = reporter.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(batches).toHaveLength(1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(batches).toHaveLength(3);
    expect(batches[1]).toEqual(batches[0]);
    expect(ingested).toHaveLength(6);
    expect(new Set(ingested).size).toBe(6);
    expect(reporter.droppedCounts).toEqual({});
  });

  it.each([
    "confirm",
    "settlement",
    "event",
  ] as const)("waits for a short Retry-After first received during the final %s flush", async (kind) => {
    vi.useFakeTimers();
    let attempts = 0;
    let ingested = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      monotonicClock: Date.now,
      fetch: async (url, init) => {
        if (kind !== "settlement" || !url.endsWith("/ingest")) {
          attempts += 1;
          if (attempts === 1) {
            return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
          }
        }
        if (url.endsWith("/ingest")) {
          ingested += (JSON.parse(String(init?.body)) as MetadataEvent[]).length;
          return new Response(JSON.stringify({ ingested: 1, rejected: [], duplicates: [] }), {
            status: 202,
          });
        }
        return new Response(null, { status: 204 });
      },
    });
    enqueue(reporter, kind);
    const closing = reporter.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(attempts).toBe(2);
    expect(ingested).toBe(kind === "confirm" ? 0 : 1);
    expect(reporter.droppedCounts).toEqual({});
  });

  it("salvages metadata when a settlement Retry-After exceeds the close budget", async () => {
    let confirms = 0;
    const ingested: string[] = [];
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      fetch: async (url, init) => {
        if (url.endsWith("/confirm")) {
          confirms += 1;
          return confirms === 1
            ? new Response(null, { status: 429, headers: { "Retry-After": "30" } })
            : new Response(null, { status: 204 });
        }
        const ids = (JSON.parse(String(init?.body)) as MetadataEvent[]).map((item) => item.call_id);
        ingested.push(...ids);
        return new Response(
          JSON.stringify({ ingested: ids.length, rejected: [], duplicates: [] }),
          {
            status: 202,
          },
        );
      },
    });
    for (let index = 1; index <= 3; index += 1) enqueue(reporter, "settlement", index);
    await reporter._flushRemaining();
    expect(ingested).toHaveLength(2);
    await reporter.close();

    expect(confirms).toBe(3);
    expect(ingested).toHaveLength(3);
    expect(new Set(ingested).size).toBe(3);
    expect(reporter.droppedCounts).toEqual({ "settlement_confirm.rate_limited": 1 });
    expect(reporter.metadataQueueSize + reporter.settlementQueueSize).toBe(0);
  });

  it("keeps retry waits and the subsequent send within one close deadline", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      monotonicClock: Date.now,
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
        }
        return new Promise<Response>(() => {});
      },
    });
    enqueue(reporter, "event");
    await reporter._flushRemaining();
    let closed = false;
    const closing = reporter.close(1200).then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(2);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await closing;
    expect(reporter.droppedCounts).toEqual({ "event.shutdown_deadline": 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves salvaged settlement events while restoring a final ingest retry", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const ingested: string[] = [];
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      maxQueueSize: 1,
      batchSize: 1,
      monotonicClock: Date.now,
      fetch: async (url, init) => {
        if (url.endsWith("/confirm")) return new Response(null, { status: 204 });
        attempts += 1;
        if (attempts === 1) {
          return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
        }
        const ids = (JSON.parse(String(init?.body)) as MetadataEvent[]).map(
          (event) => event.call_id,
        );
        ingested.push(...ids);
        return new Response(
          JSON.stringify({ ingested: ids.length, rejected: [], duplicates: [] }),
          {
            status: 202,
          },
        );
      },
    });
    enqueue(reporter, "event", 1);
    enqueue(reporter, "settlement", 2);
    enqueue(reporter, "settlement", 3);
    const closing = reporter.close();
    await vi.advanceTimersByTimeAsync(1000);
    await closing;

    expect(ingested).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
    ]);
    expect(reporter.droppedCounts).toEqual({});
  });

  it("waits again when an active breaker report extends the shared hold during close", async () => {
    vi.useFakeTimers();
    let finishBreaker!: (response: Response) => void;
    const firstBreaker = new Promise<Response>((resolve) => {
      finishBreaker = resolve;
    });
    const breaker = new CircuitBreaker();
    let breakerAttempts = 0;
    let ingestAttempts = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      monotonicClock: Date.now,
      sdkInstanceId: "rate-limit-test",
      breakerSnapshots: () => [["openai", breaker.getState()]],
      fetch: async (url) => {
        if (url.endsWith("/breaker-reports")) {
          breakerAttempts += 1;
          return breakerAttempts === 1 ? firstBreaker : new Response(null, { status: 204 });
        }
        ingestAttempts += 1;
        return ingestAttempts === 1
          ? new Response(null, { status: 503, headers: { "Retry-After": "1" } })
          : new Response(JSON.stringify({ ingested: 1, rejected: [], duplicates: [] }), {
              status: 202,
            });
      },
    });
    reporter.observeProjectId(`proj_${"0".repeat(24)}`);
    const active = reporter._startBreakerCycle();
    enqueue(reporter, "event");
    await reporter._flushRemaining();
    let closed = false;
    const closing = reporter.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    finishBreaker(new Response(null, { status: 429, headers: { "Retry-After": "2" } }));
    await active;
    await vi.advanceTimersByTimeAsync(500);
    expect(ingestAttempts).toBe(1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1499);
    expect(ingestAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(ingestAttempts).toBe(2);
    expect(reporter.droppedCounts).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
});
