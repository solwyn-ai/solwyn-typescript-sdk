import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

function settlement(index: number): [BudgetConfirmRequest, MetadataEvent] {
  const call_id = `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
  return [
    {
      reservation_id: "synthetic",
      model: "synthetic-model",
      provider: "openai",
      call_id,
      modality: "text",
      is_provider_fallback: false,
      token_details: zeroTokenDetails(),
    },
    {
      model: "synthetic-model",
      provider: "openai",
      call_id,
      modality: "text",
      input_tokens: 1,
      output_tokens: 1,
      latency_ms: 1,
      status: "success",
      is_model_fallback: false,
      is_provider_fallback: false,
      attempt_index: 0,
      sdk_instance_id: "concurrency-test",
      timestamp: "2026-01-01T00:00:00Z",
    },
  ];
}

afterEach(() => vi.useRealTimers());

describe("confirmation concurrency", () => {
  it("counts consecutive failing rounds in dispatch order when completions arrive out of order", async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let lastFails = true;
    let posted = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      logger,
      flushInterval: 3_600_000,
      fetch: async () => {
        const first = ++posted % 2 === 1;
        if (first) await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(null, { status: first === lastFails ? 204 : 422 });
      },
    });
    const round = async (index: number): Promise<void> => {
      reporter.reportConfirm(settlement(index * 2 + 1)[0]);
      reporter.reportConfirm(settlement(index * 2 + 2)[0]);
      const flushing = reporter._flushRemaining();
      await vi.advanceTimersByTimeAsync(10);
      await flushing;
    };
    try {
      for (let index = 0; index < 9; index += 1) await round(index);
      expect(logger.error).not.toHaveBeenCalled();
      await round(9);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("consecutive_failures=10"));
      lastFails = false;
      await round(10);
      lastFails = true;
      for (let index = 11; index < 20; index += 1) await round(index);
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      await reporter.close(0);
    }
  });

  it("counts a retry awaiting restoration when close seals another active confirmation", async () => {
    vi.useFakeTimers();
    let completeSlow!: (response: Response) => void;
    const slow = new Promise<Response>((resolve) => {
      completeSlow = resolve;
    });
    let started = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      flushInterval: 3_600_000,
      fetch: async () => {
        started += 1;
        return started === 1
          ? new Response(null, { status: 500 })
          : started === 2
            ? slow
            : new Response(null, { status: 204 });
      },
    });
    for (let index = 1; index <= 3; index += 1) reporter.reportConfirm(settlement(index)[0]);
    const flushing = reporter._flushRemaining();
    try {
      await vi.advanceTimersByTimeAsync(10);
      await reporter.close(0);
      expect(reporter.droppedCounts).toEqual({ "confirm.shutdown_deadline": 2 });
    } finally {
      completeSlow(new Response(null, { status: 204 }));
      await reporter.close(0);
      await flushing;
    }
  });

  it.each([
    "confirm",
    "settlement",
  ] as const)("lets completed %ss release slots while an earlier confirmation stalls", async (kind) => {
    vi.useFakeTimers();
    let completeFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      completeFirst = resolve;
    });
    let confirmed = 0;
    let started = 0;
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      maxInFlight: 3,
      flushInterval: 3_600_000,
      fetch: async () => {
        started += 1;
        if (started === 1) return first;
        await new Promise((resolve) => setTimeout(resolve, 10));
        confirmed += 1;
        return new Response(null, { status: 204 });
      },
    });
    for (let index = 1; index <= 10; index += 1) {
      const pair = settlement(index);
      if (kind === "confirm") reporter.reportConfirm(pair[0]);
      else reporter.reportSettlement(...pair);
    }
    const flushing = reporter._flushRemaining();
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(confirmed).toBe(9);
      await reporter.close(0);
      expect(
        reporter.droppedCounts[
          `${kind === "confirm" ? "confirm" : "settlement_confirm"}.shutdown_deadline`
        ],
      ).toBe(1);
    } finally {
      completeFirst(new Response(null, { status: 204 }));
      await reporter.close(0);
      await flushing;
    }
  });

  it.each([
    "confirm",
    "settlement",
  ] as const)("delivers sustained %s traffic without overflow at 100ms RTT", async (kind) => {
    vi.useFakeTimers();
    let produced = 0;
    let confirmed = 0;
    let ingested = 0;
    let active = 0;
    let peak = 0;
    const seen = new Set<string>();
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      monotonicClock: Date.now,
      maxInFlight: 3,
      fetch: async (url, init) => {
        if (url.endsWith("/confirm")) {
          active += 1;
          peak = Math.max(peak, active);
          const body = JSON.parse(String(init?.body)) as BudgetConfirmRequest;
          await new Promise((resolve) => setTimeout(resolve, 100));
          active -= 1;
          confirmed += 1;
          expect(seen.has(body.call_id)).toBe(false);
          seen.add(body.call_id);
          return new Response(null, { status: 204 });
        }
        const events = JSON.parse(String(init?.body)) as MetadataEvent[];
        for (const event of events) expect(seen.has(event.call_id)).toBe(true);
        ingested += events.length;
        return new Response(
          JSON.stringify({ ingested: events.length, rejected: [], duplicates: [] }),
          { status: 202 },
        );
      },
    });
    const producer = setInterval(() => {
      const pair = settlement(++produced);
      if (kind === "confirm") reporter.reportConfirm(pair[0]);
      else reporter.reportSettlement(...pair);
    }, 50);
    try {
      await vi.advanceTimersByTimeAsync(150_000);
      clearInterval(producer);
      expect(produced).toBe(3000);
      expect(peak).toBe(3);
      expect(reporter.droppedCounts).toEqual({});
      const closing = reporter.close();
      await vi.advanceTimersByTimeAsync(5000);
      await closing;
      expect(confirmed).toBe(produced);
      expect(ingested).toBe(kind === "settlement" ? produced : 0);
      expect(reporter.inFlightCount).toBe(0);
      expect(reporter.droppedCounts).toEqual({});
    } finally {
      clearInterval(producer);
      await reporter.close(0);
    }
  });
});
