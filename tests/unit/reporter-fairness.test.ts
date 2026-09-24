/**
 * Bounded serial delivery rounds: each reporter delivery class gets a turn.
 *
 * Arrivals are synchronized to successful sends through an injected fetch, so
 * every assertion is structural (send order, counts, queue positions), never
 * timing. Offline only.
 */

import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker";
import type { Logger } from "../../src/logging";
import { type FlushRound, MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;

function callId(index: number): string {
  return `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, "0")}`;
}

function event(index: number): MetadataEvent {
  return MetadataEventSchema.parse({
    model: "synthetic-model",
    provider: "openai",
    input_tokens: 1,
    output_tokens: 1,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: callId(index),
    sdk_instance_id: "fairness-test",
    timestamp: "2026-09-22T00:00:00Z",
  });
}

function confirm(index: number): BudgetConfirmRequest {
  return BudgetConfirmRequestSchema.parse({
    reservation_id: "synthetic",
    model: "synthetic-model",
    provider: "openai",
    call_id: callId(index),
    token_details: zeroTokenDetails(),
  });
}

function isConfirm(url: string): boolean {
  return url.endsWith("/budgets/confirm");
}

function bodyOf(init: RequestInit | undefined): unknown {
  return JSON.parse(String(init?.body));
}

function ingested(count: number): Response {
  return new Response(JSON.stringify({ ingested: count, rejected: [] }), { status: 202 });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function loggerSpies(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** One explicit ordinary round; returns its more-work flag. */
async function round(reporter: MetadataReporter): Promise<boolean> {
  // Seed true so an implementation that ignores the flag cannot pass by default.
  const flag: FlushRound = { more: true };
  await reporter._flushRemaining(undefined, false, flag);
  return flag.more;
}

function queuesEmpty(reporter: MetadataReporter): boolean {
  return (
    reporter.metadataQueueSize === 0 &&
    reporter.settlementQueueSize === 0 &&
    reporter.confirmQueueSize === 0
  );
}

describe("MetadataReporter bounded delivery rounds", () => {
  describe.each(["settlement", "confirm"] as const)("%s producer", (kind) => {
    it.each([
      [4, 0],
      [4, 1],
      [4, 2],
      [10_000, 0],
      [10_000, 1],
      [10_000, 2],
    ])("ready metadata gets a turn at capacity %d with %d arrivals per confirm", async (capacity, arrivalsPerSend) => {
      const generated: string[] = [];
      const confirmed: string[] = [];
      const ingestedIds: string[] = [];
      let firstIngestAt: number | null = null;
      let firstGenerated: number | null = null;
      let peakEventQueue = 0;
      let peakControlQueue = 0;
      const limit = arrivalsPerSend > 0 ? 80 : 4;
      let reporter!: MetadataReporter;

      const produce = (): void => {
        const index = generated.length;
        generated.push(callId(index));
        if (kind === "settlement") reporter.reportSettlement(confirm(index), event(index));
        else reporter.reportConfirm(confirm(index));
        peakEventQueue = Math.max(peakEventQueue, reporter.metadataQueueSize);
        peakControlQueue = Math.max(
          peakControlQueue,
          reporter.settlementQueueSize,
          reporter.confirmQueueSize,
        );
      };

      const fetch: FetchLike = async (url, init) => {
        if (isConfirm(url)) {
          confirmed.push((bodyOf(init) as BudgetConfirmRequest).call_id);
          for (let arrival = 0; arrival < arrivalsPerSend; arrival += 1) {
            if (generated.length < limit) produce();
          }
          return new Response(null, { status: 204 });
        }
        const batch = (bodyOf(init) as MetadataEvent[]).map((item) => item.call_id);
        if (firstIngestAt === null) {
          firstIngestAt = confirmed.length;
          firstGenerated = generated.length;
        }
        ingestedIds.push(...batch);
        if (kind === "settlement" && arrivalsPerSend < 2) {
          // Confirm-before-event order holds for every delivered settlement.
          for (const id of batch) expect(confirmed).toContain(id);
        }
        return ingested(batch.length);
      };

      reporter = new MetadataReporter(API_URL, API_KEY, {
        batchSize: 4,
        maxQueueSize: capacity,
        controlQueueMaxSize: 8,
        flushInterval: 3_600_000,
        breakerReportingEnabled: false,
        fetch,
      });
      const independent = event(999);
      if (kind === "confirm") reporter.report(independent);
      for (let index = 0; index < 4; index += 1) produce();

      try {
        await round(reporter);
        expect(firstIngestAt).toBe(4);
        if (arrivalsPerSend > 0) {
          // Ingest did not wait for the producer to stop.
          expect(firstGenerated).toBeLessThan(limit);
        }
        for (let rounds = 0; rounds < limit && !queuesEmpty(reporter); rounds += 1) {
          await round(reporter);
        }
        expect(queuesEmpty(reporter)).toBe(true);
        expect(confirmed).toEqual([...confirmed].sort());
        expect(new Set(confirmed).size).toBe(confirmed.length);
        expect(new Set(ingestedIds).size).toBe(ingestedIds.length);
        const controlKind = kind === "settlement" ? "settlement_confirm" : "confirm";
        const drops = reporter.droppedCounts;
        expect(confirmed.length + (drops[`${controlKind}.overflow`] ?? 0)).toBe(limit);
        if (kind === "settlement") {
          expect(ingestedIds.length + (drops["event.overflow"] ?? 0)).toBe(limit);
          if (arrivalsPerSend < 2) {
            expect(ingestedIds).toEqual(generated);
            expect(drops).toEqual({});
          }
        } else {
          expect(ingestedIds).toEqual([independent.call_id]);
        }
        expect(peakEventQueue).toBeLessThanOrEqual(capacity);
        expect(peakControlQueue).toBeLessThanOrEqual(8);
      } finally {
        await reporter.close(0);
      }
    });
  });

  it("event arrivals cannot extend a round", async () => {
    const ingestedIds: string[] = [];
    let generated = 0;
    let reporter!: MetadataReporter;
    const produce = (): void => {
      reporter.report(event(generated));
      generated += 1;
    };
    reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 4,
      flushInterval: 3_600_000,
      breakerReportingEnabled: false,
      fetch: async (_url, init) => {
        const batch = bodyOf(init) as MetadataEvent[];
        ingestedIds.push(...batch.map((item) => item.call_id));
        for (let arrival = 0; arrival < 4; arrival += 1) {
          if (generated < 40) produce();
        }
        return ingested(batch.length);
      },
    });
    for (let index = 0; index < 4; index += 1) produce();

    try {
      await expect(round(reporter)).resolves.toBe(true);
      expect(ingestedIds).toHaveLength(4);
      expect(generated).toBe(8);
      expect(reporter.metadataQueueSize).toBe(4);
    } finally {
      // Stop the producer before the finite final drain.
      generated = 40;
      await reporter.close(0);
    }
  });

  it("a finite default-capacity backlog finishes in serial bounded rounds", async () => {
    const confirmed: string[] = [];
    const ingestedIds: string[] = [];
    let firstIngestAt: number | null = null;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 3_600_000,
      breakerReportingEnabled: false,
      fetch: async (url, init) => {
        if (isConfirm(url)) {
          confirmed.push((bodyOf(init) as BudgetConfirmRequest).call_id);
          return new Response(null, { status: 204 });
        }
        if (firstIngestAt === null) firstIngestAt = confirmed.length;
        const batch = bodyOf(init) as MetadataEvent[];
        ingestedIds.push(...batch.map((item) => item.call_id));
        return ingested(batch.length);
      },
    });
    for (let index = 0; index < 200; index += 1) {
      reporter.reportSettlement(confirm(index), event(index));
    }

    try {
      const flags: boolean[] = [];
      for (let rounds = 0; rounds < 4; rounds += 1) flags.push(await round(reporter));
      expect(flags).toEqual([true, true, true, false]);
      expect(firstIngestAt).toBe(50);
      const expected = Array.from({ length: 200 }, (_value, index) => callId(index));
      expect(confirmed).toEqual(expected);
      expect(ingestedIds).toEqual(expected);
      expect(reporter.droppedCounts).toEqual({});
    } finally {
      await reporter.close(0);
    }
  });

  it("standalone and paired confirm stages each get a bounded turn", async () => {
    const confirmations: string[] = [];
    const ingests: string[] = [];
    let firstIngestAt: number | null = null;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 4,
      flushInterval: 3_600_000,
      breakerReportingEnabled: false,
      fetch: async (url, init) => {
        if (isConfirm(url)) {
          confirmations.push((bodyOf(init) as BudgetConfirmRequest).call_id);
          return new Response(null, { status: 204 });
        }
        if (firstIngestAt === null) firstIngestAt = confirmations.length;
        const batch = (bodyOf(init) as MetadataEvent[]).map((item) => item.call_id);
        for (const id of batch) expect(confirmations).toContain(id);
        ingests.push(...batch);
        return ingested(batch.length);
      },
    });
    for (let index = 0; index < 16; index += 1) {
      reporter.reportConfirm(confirm(index + 100));
      reporter.reportSettlement(confirm(index), event(index));
    }

    try {
      await expect(round(reporter)).resolves.toBe(true);
      expect(firstIngestAt).toBe(8);
      expect(confirmations).toEqual([
        ...[0, 1, 2, 3].map((index) => callId(index + 100)),
        ...[0, 1, 2, 3].map((index) => callId(index)),
      ]);
      expect(ingests).toHaveLength(4);
      for (let rounds = 0; rounds < 3; rounds += 1) await round(reporter);
      expect(confirmations).toHaveLength(32);
      expect(ingests).toEqual(Array.from({ length: 16 }, (_value, index) => callId(index)));
      expect(reporter.droppedCounts).toEqual({});
    } finally {
      await reporter.close(0);
    }
  });

  it("a single-event batch size delivers every settlement", async () => {
    const confirmed: string[] = [];
    const ingestedIds: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 1,
      flushInterval: 3_600_000,
      breakerReportingEnabled: false,
      fetch: async (url, init) => {
        if (isConfirm(url)) {
          confirmed.push((bodyOf(init) as BudgetConfirmRequest).call_id);
          return new Response(null, { status: 204 });
        }
        const batch = bodyOf(init) as MetadataEvent[];
        expect(batch).toHaveLength(1);
        const id = batch[0]?.call_id ?? "";
        expect(confirmed).toContain(id);
        ingestedIds.push(id);
        return ingested(1);
      },
    });

    try {
      for (let index = 0; index < 3; index += 1) {
        reporter.reportSettlement(confirm(index), event(index));
      }
      const flags: boolean[] = [];
      for (let rounds = 0; rounds < 3; rounds += 1) flags.push(await round(reporter));
      expect(flags).toEqual([true, true, false]);
      const expected = [0, 1, 2].map((index) => callId(index));
      expect(confirmed).toEqual(expected);
      expect(ingestedIds).toEqual(expected);
      expect(queuesEmpty(reporter)).toBe(true);
      expect(reporter.droppedCounts).toEqual({});
    } finally {
      await reporter.close(0);
    }
  });

  it.each([
    "idle",
    "retry",
    "held",
    "event_retry",
  ] as const)("a %s head sends nothing on a second round and never requests immediate polling", async (disposition) => {
    const requests: string[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 3600,
      successThreshold: 1,
      name: "control-plane",
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 1,
      flushInterval: 3_600_000,
      breakerReportingEnabled: false,
      controlPlaneBreaker: breaker,
      fetch: async (url) => {
        requests.push(url);
        return new Response("{}", { status: 503 });
      },
    });
    if (disposition === "held") breaker.recordFailure();
    if (disposition === "held" || disposition === "retry") {
      reporter.reportSettlement(confirm(0), event(0));
      reporter.reportSettlement(confirm(1), event(1));
    } else if (disposition === "event_retry") {
      reporter.report(event(0));
    }

    try {
      await expect(round(reporter)).resolves.toBe(false);
      const attempted = requests.length;
      await expect(round(reporter)).resolves.toBe(false);
      expect(requests).toHaveLength(attempted);
      if (disposition !== "idle") {
        expect(reporter.metadataQueueSize + reporter.settlementQueueSize).toBeGreaterThan(0);
      }
    } finally {
      await reporter.close(0);
    }
  });

  it("with at most one arrival per confirm, ingest starts before the producer stops and nothing is evicted", async () => {
    const limit = 400;
    let generated = 0;
    let confirms = 0;
    let generatedAtFirstIngest: number | null = null;
    let reporter!: MetadataReporter;
    const produce = (): void => {
      reporter.reportSettlement(confirm(generated), event(generated));
      generated += 1;
    };
    reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 5,
      maxQueueSize: 8,
      flushInterval: 3_600_000,
      breakerReportingEnabled: false,
      fetch: async (url, init) => {
        if (isConfirm(url)) {
          confirms += 1;
          if (generated < limit) produce();
          return new Response(null, { status: 204 });
        }
        generatedAtFirstIngest ??= generated;
        return ingested((bodyOf(init) as MetadataEvent[]).length);
      },
    });
    produce();

    try {
      for (let rounds = 0; rounds < 2 * limit && !queuesEmpty(reporter); rounds += 1) {
        await round(reporter);
      }
      expect(generatedAtFirstIngest).not.toBeNull();
      expect(generatedAtFirstIngest).toBeLessThan(limit);
      expect(confirms).toBe(limit);
      expect(reporter.droppedCounts).toEqual({});
    } finally {
      await reporter.close(0);
    }
  });

  it("a zero-delay round is a timer turn: a setTimeout(0) sentinel runs while more work is set", async () => {
    const limit = 2000;
    let generated = 0;
    let confirms = 0;
    let rounds = 0;
    let reporter!: MetadataReporter;
    const produce = (): void => {
      reporter.reportSettlement(confirm(generated), event(generated));
      generated += 1;
    };
    reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 1,
      maxQueueSize: 10_000,
      flushInterval: 1,
      breakerReportingEnabled: false,
      // An immediately-resolving transport never yields a macrotask on its own.
      fetch: async (url, init) => {
        if (isConfirm(url)) {
          confirms += 1;
          if (generated < limit) produce();
          return new Response(null, { status: 204 });
        }
        return ingested((bodyOf(init) as MetadataEvent[]).length);
      },
    });
    const flush = reporter._flushRemaining.bind(reporter);
    vi.spyOn(reporter, "_flushRemaining").mockImplementation(async (...args) => {
      const clean = await flush(...args);
      rounds += 1;
      return clean;
    });
    produce(); // starts the loop

    try {
      // Wait for the first ordinary round, then give the host one timer turn.
      while (rounds === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const roundsBefore = rounds;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(generated).toBeLessThan(limit); // the producer is still active
      expect(confirms).toBeLessThan(limit);
      expect(reporter.settlementQueueSize).toBeGreaterThan(0); // more is still set
      expect(roundsBefore).toBeGreaterThan(0);
    } finally {
      generated = limit;
      await reporter.close(5000);
    }
  });

  it("close during an in-flight round preserves ready events in a full metadata queue", async () => {
    const confirmEntered = deferred();
    const resume = deferred();
    const ingestedIds: string[] = [];
    const confirms: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 50,
      maxQueueSize: 2,
      flushInterval: 1,
      breakerReportingEnabled: false,
      fetch: async (url, init) => {
        if (isConfirm(url)) {
          if (confirms.length === 0) {
            confirmEntered.resolve();
            await resume.promise;
          }
          confirms.push((bodyOf(init) as BudgetConfirmRequest).call_id);
          return new Response(null, { status: 204 });
        }
        const batch = bodyOf(init) as MetadataEvent[];
        ingestedIds.push(...batch.map((item) => item.call_id));
        return ingested(batch.length);
      },
    });
    reporter.report(event(100));
    reporter.report(event(101)); // the metadata queue is now full
    for (let index = 0; index < 8; index += 1) {
      reporter.reportSettlement(confirm(index), event(index));
    }

    await confirmEntered.promise;
    // The deadline is not binding: every item can be delivered well within it.
    const closing = reporter.close(5000);
    resume.resolve();
    await closing;

    const expected = [...Array.from({ length: 8 }, (_value, index) => index), 100, 101].map(
      (index) => callId(index),
    );
    expect(new Set(ingestedIds)).toEqual(new Set(expected));
    expect(ingestedIds).toHaveLength(10);
    expect(confirms).toHaveLength(8);
    expect(reporter.droppedCounts).toEqual({});
  });

  it("ten consecutive failing rounds escalate the confirm failure to ERROR", async () => {
    const logger = loggerSpies();
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 4,
      flushInterval: 3_600_000,
      breakerReportingEnabled: false,
      logger,
      fetch: async (url, init) => {
        if (isConfirm(url)) return new Response('{"detail":"synthetic"}', { status: 422 });
        return ingested((bodyOf(init) as MetadataEvent[]).length);
      },
    });
    for (let index = 0; index < 60; index += 1) {
      reporter.reportSettlement(confirm(index), event(index));
    }
    const persistent = expect.stringContaining("reporter.confirm_send_persistent_failure");

    try {
      for (let rounds = 0; rounds < 9; rounds += 1) await round(reporter);
      expect(logger.error).not.toHaveBeenCalledWith(persistent);
      await round(reporter);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("consecutive_failures=10"));
    } finally {
      await reporter.close(0);
    }
  });

  it("a terminal-422 confirm stream with interleaved breaker successes still completes rounds and ingests", async () => {
    const limit = 500;
    const logger = loggerSpies();
    let generated = 0;
    let confirms = 0;
    let ingestedEvents = 0;
    let reporter!: MetadataReporter;
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeout: 30,
      successThreshold: 1,
      name: "control-plane",
    });
    const produce = (): void => {
      reporter.reportSettlement(confirm(generated), event(generated));
      generated += 1;
    };
    reporter = new MetadataReporter(API_URL, API_KEY, {
      batchSize: 5,
      flushInterval: 3_600_000,
      breakerReportingEnabled: false,
      controlPlaneBreaker: breaker,
      logger,
      fetch: async (url, init) => {
        if (isConfirm(url)) {
          confirms += 1;
          // Healthy budget-check traffic shares the control-plane breaker.
          breaker.recordSuccess();
          if (generated < limit) {
            produce();
            produce();
          }
          return new Response('{"detail":"synthetic"}', { status: 422 });
        }
        const count = (bodyOf(init) as MetadataEvent[]).length;
        ingestedEvents += count;
        return ingested(count);
      },
    });
    produce();

    try {
      let completed = 0;
      for (; completed < 12; completed += 1) await round(reporter);
      expect(completed).toBe(12);
      expect(generated).toBeLessThan(limit); // rounds complete while the producer runs
      expect(confirms).toBe(60);
      expect(ingestedEvents).toBeGreaterThan(0);
      expect(breaker.getState().state).toBe("closed");
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("reporter.confirm_send_persistent_failure"),
      );
    } finally {
      generated = limit;
      await reporter.close(0);
    }
  });
});
