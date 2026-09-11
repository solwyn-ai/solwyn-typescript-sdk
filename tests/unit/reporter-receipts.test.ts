import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logging";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";
import {
  BudgetConfirmRequestSchema,
  MetadataEventSchema,
  serializeMetadataEvent,
} from "../../src/validation";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;

function callId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function event(index: number, overrides: Partial<MetadataEvent> = {}): MetadataEvent {
  return MetadataEventSchema.parse({
    model: "gpt-5.5",
    provider: "openai",
    modality: "text",
    input_tokens: 3,
    output_tokens: 2,
    latency_ms: 11,
    status: "success",
    is_model_fallback: false,
    is_provider_fallback: false,
    attempt_index: 0,
    call_id: callId(index),
    sdk_instance_id: "sdk-reporter-receipts",
    timestamp: "2026-08-28T12:00:00.000Z",
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
    estimated_output_bound: 7,
    receipt_aggregate_count: 1,
    ...overrides,
  });
}

function confirm(index: number): BudgetConfirmRequest {
  return BudgetConfirmRequestSchema.parse({
    reservation_id: `res-${index}`,
    model: "gpt-5.5",
    provider: "openai",
    call_id: callId(index),
    token_details: zeroTokenDetails(),
  });
}

function ingest(rejected: unknown[] = [], ingested = 0): Response {
  return new Response(JSON.stringify({ ingested, rejected }), { status: 202 });
}

function scriptedReporter(
  responses: Response[],
  options: ConstructorParameters<typeof MetadataReporter>[2] = {},
): { reporter: MetadataReporter; payloads: MetadataEvent[][]; fetch: ReturnType<typeof vi.fn> } {
  const payloads: MetadataEvent[][] = [];
  const fetch = vi.fn<FetchLike>(async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)) as MetadataEvent[]);
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected metadata send");
    return response;
  });
  return {
    reporter: new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 1_000_000,
      fetch,
      ...options,
    }),
    payloads,
    fetch,
  };
}

describe("MetadataReporter denial receipt routing", () => {
  it("repairs a direct projection failure when replay replaces the invalid call id", async () => {
    const { reporter, payloads } = scriptedReporter([ingest([], 1), ingest([], 1)]);
    const repairable = deniedEvent(90, { receipt_aggregate_count: 4 });
    repairable.call_id = "invalid-original-call-id";

    await expect(reporter._sendBatch([repairable])).resolves.toMatchObject({
      outcome: "dropped",
    });
    reporter.report(event(91));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await expect(reporter._flushRemaining()).resolves.toBe(true);

    const replay = payloads[1]?.[0];
    expect(payloads[0]?.map((item) => item.call_id)).toEqual([callId(91)]);
    expect(replay).toMatchObject({
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 4,
    });
    expect(replay?.call_id).not.toBe("invalid-original-call-id");
    expect(MetadataEventSchema.safeParse(replay).success).toBe(true);
    expect(reporter.droppedCounts).toEqual({});
    await reporter.close(0);
  });

  it("repairs a queued projection failure when replay replaces the invalid call id", async () => {
    const { reporter, payloads } = scriptedReporter([ingest([], 1), ingest([], 1)]);
    const repairable = deniedEvent(92, { receipt_aggregate_count: 5 });
    repairable.call_id = "invalid-queued-call-id";
    reporter.report(repairable);

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    reporter.report(event(93));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await expect(reporter._flushRemaining()).resolves.toBe(true);

    const replay = payloads[1]?.[0];
    expect(payloads[0]?.map((item) => item.call_id)).toEqual([callId(93)]);
    expect(replay).toMatchObject({
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 5,
    });
    expect(replay?.call_id).not.toBe("invalid-queued-call-id");
    expect(MetadataEventSchema.safeParse(replay).success).toBe(true);
    expect(reporter.droppedCounts).toEqual({});
    await reporter.close(0);
  });

  it("treats direct schema-invalid denial projection as terminal at receipt weight", async () => {
    const { reporter, fetch } = scriptedReporter([]);
    const invalid = deniedEvent(0, { receipt_aggregate_count: 5 });
    invalid.deny_reason = "x".repeat(65);

    await expect(reporter._sendBatch([invalid])).resolves.toMatchObject({ outcome: "dropped" });

    expect(fetch).not.toHaveBeenCalled();
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 5 });
    await reporter.close(0);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 5 });
  });

  it("never refolds a schema-invalid denial after a later clean-cycle proof", async () => {
    const { reporter, payloads } = scriptedReporter([ingest([], 1), ingest([], 1)]);
    const invalid = deniedEvent(80, { receipt_aggregate_count: 7 });
    invalid.denied_by_period = "x".repeat(33);
    reporter.report(invalid);
    reporter.report(event(81));

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 7 });

    reporter.report(event(82));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await expect(reporter._flushRemaining()).resolves.toBe(false);
    await reporter.close(0);

    expect(payloads.map((batch) => batch.map((item) => item.call_id))).toEqual([
      [callId(81)],
      [callId(82)],
    ]);
    expect(reporter.droppedCounts).toEqual({ "event.terminal_status": 7 });
  });

  it("folds an evicted denial silently and replays it only after the next clean-cycle opening", async () => {
    const { reporter, payloads } = scriptedReporter([ingest([], 1), ingest([], 1)], {
      maxQueueSize: 1,
    });
    reporter.report(deniedEvent(1, { receipt_aggregate_count: 4 }));
    reporter.report(event(2));

    expect(reporter.droppedCounts).toEqual({});
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    expect(payloads.map((batch) => batch.map((item) => item.status))).toEqual([["success"]]);

    await expect(reporter._flushRemaining()).resolves.toBe(true);
    expect(payloads.map((batch) => batch.map((item) => item.status))).toEqual([
      ["success"],
      ["budget_denied"],
    ]);
    expect(payloads[1]?.[0]).toMatchObject({
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 4,
    });
    expect(reporter.droppedCounts).toEqual({});
  });

  it("counts a fold-table overflow at the denied receipt weight", () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 1_000_000,
      maxQueueSize: 1,
    });
    for (let index = 0; index <= 256; index += 1) {
      reporter.report(
        deniedEvent(index + 1, {
          agent_run_id: `capacity-${index}`,
          receipt_aggregate_count: index === 256 ? 7 : 1,
        }),
      );
    }

    reporter.report(event(1000));

    expect(reporter.droppedCounts).toEqual({ "event.receipt_fold_overflow": 7 });
  });

  it("terminally counts an invalid evicted receipt and closes without replaying it", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 1_000_000,
      maxQueueSize: 1,
    });
    const invalid = deniedEvent(1001, { receipt_aggregate_count: 7 });
    invalid.input_tokens = Infinity;
    reporter.report(invalid);
    reporter.report(event(1002));

    await expect(reporter.close(0)).resolves.toBeUndefined();

    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({
      "event.overflow": 7,
      "event.shutdown_deadline": 1,
    });
  });

  it.each([
    ["retry exhaustion", 503],
    ["terminal status", 400],
  ])("folds a denial on %s and requires an ordinary clean proof before replay", async (_label, status) => {
    const { reporter, payloads } = scriptedReporter(
      [new Response(null, { status }), ingest([], 1), ingest([], 1)],
      { maxSendAttempts: 1 },
    );
    reporter.report(deniedEvent(10, { receipt_aggregate_count: 3 }));

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(payloads).toHaveLength(1);
    expect(reporter.droppedCounts).toEqual({});

    reporter.report(event(11));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    expect(payloads).toHaveLength(2);

    await expect(reporter._flushRemaining()).resolves.toBe(true);
    expect(payloads[2]?.[0]).toMatchObject({
      status: "budget_denied",
      receipt_aggregate_count: 3,
      deny_source: "aggregate_replay",
    });
    expect(reporter.droppedCounts).toEqual({});
  });

  it("refolds an exactly rejected replay and waits for a later clean proof", async () => {
    const exactRejection = ingest([{ index: 0, code: "x", model: "m", message: "x" }], 0);
    const { reporter, payloads } = scriptedReporter([
      new Response(null, { status: 400 }),
      ingest([], 1),
      exactRejection,
      ingest([], 1),
      ingest([], 1),
    ]);
    reporter.report(deniedEvent(20, { receipt_aggregate_count: 4 }));
    await expect(reporter._flushRemaining()).resolves.toBe(false);

    reporter.report(event(21));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(payloads).toHaveLength(3);

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(payloads).toHaveLength(3);

    reporter.report(event(22));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await expect(reporter._flushRemaining()).resolves.toBe(true);

    expect(payloads).toHaveLength(5);
    expect(payloads[2]?.[0]?.receipt_aggregate_count).toBe(4);
    expect(payloads[4]?.[0]?.receipt_aggregate_count).toBe(4);
    expect(reporter.droppedCounts).toEqual({});
  });

  it("folds full legacy rejections but counts their non-denied neighbors once", async () => {
    const fullLegacy = ingest([
      { code: "x", model: "m", message: "x" },
      { code: "x", model: "m", message: "x" },
    ]);
    const { reporter, payloads } = scriptedReporter([fullLegacy, ingest([], 1), ingest([], 1)], {
      batchSize: 2,
    });
    reporter.report(deniedEvent(30, { receipt_aggregate_count: 5 }));
    reporter.report(event(31));

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(reporter.droppedCounts).toEqual({ "event.ingest_rejected": 1 });

    reporter.report(event(32));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    expect(payloads[2]?.[0]).toMatchObject({
      status: "budget_denied",
      receipt_aggregate_count: 5,
    });
    expect(reporter.droppedCounts).toEqual({ "event.ingest_rejected": 1 });
  });

  it("counts a partial legacy rejection by the heaviest receipt weights and never folds it", async () => {
    const partialLegacy = ingest([{ code: "x", model: "m", message: "x" }], 1);
    const { reporter, payloads } = scriptedReporter([partialLegacy, ingest([], 1)], {
      batchSize: 2,
    });
    reporter.report(deniedEvent(40, { receipt_aggregate_count: 100 }));
    reporter.report(deniedEvent(41, { receipt_aggregate_count: 3 }));

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(reporter.droppedCounts).toEqual({ "event.ingest_rejected": 100 });

    reporter.report(event(42));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(payloads).toHaveLength(2);
    expect(reporter.droppedCounts).toEqual({ "event.ingest_rejected": 100 });
  });

  it("does not treat a partly clean, partly rejected event cycle as recovery proof", async () => {
    const { reporter, payloads } = scriptedReporter(
      [
        ingest([], 1),
        ingest([{ index: 0, code: "x", model: "m", message: "x" }], 0),
        ingest([], 1),
        ingest([], 1),
        ingest([], 1),
      ],
      { batchSize: 1, maxQueueSize: 3 },
    );
    reporter.report(deniedEvent(50, { receipt_aggregate_count: 2 }));
    reporter.report(event(51));
    reporter.report(event(52));
    reporter.report(event(53));

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(payloads).toHaveLength(3);
    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(payloads).toHaveLength(3);

    reporter.report(event(54));
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    await expect(reporter._flushRemaining()).resolves.toBe(true);
    expect(payloads[4]?.[0]).toMatchObject({
      status: "budget_denied",
      receipt_aggregate_count: 2,
    });
  });

  it("counts a final-cycle denied loss at receipt weight without taking retained folds", async () => {
    const { reporter } = scriptedReporter([new Response(null, { status: 503 })]);
    reporter.report(deniedEvent(60, { receipt_aggregate_count: 4 }));

    await expect(reporter._flushRemaining(undefined, true)).resolves.toBe(false);

    expect(reporter.droppedCounts).toEqual({ "event.retry_exhausted": 4 });
  });

  it("counts stranded and post-close denied events at receipt weight", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 1_000_000,
      shutdownDeadline: 0,
    });
    reporter.reportSettlement(confirm(61), deniedEvent(61, { receipt_aggregate_count: 5 }));

    await reporter.close();
    reporter.report(deniedEvent(62, { receipt_aggregate_count: 7 }));

    expect(reporter.droppedCounts).toEqual({
      "settlement_confirm.shutdown_deadline": 1,
      "event.shutdown_deadline": 5,
      "event.closed_enqueue": 7,
    });
  });

  // Mutations caught: leaving the final-take seam empty, using the ordinary
  // bounded enqueue for replay, or prepending replay ahead of retained live work.
  it("close appends one terminal replay after live events and bypasses queue capacity", async () => {
    const { reporter, payloads, fetch } = scriptedReporter(
      [new Response(null, { status: 503 }), ingest([], 2)],
      { maxQueueSize: 1, maxSendAttempts: 1 },
    );
    reporter.report(deniedEvent(63, { receipt_aggregate_count: 4 }));
    await expect(reporter._flushRemaining()).resolves.toBe(false);
    const live = event(64);
    reporter.report(live);

    const firstClose = reporter.close(1_000);
    const secondClose = reporter.close(0);
    expect(secondClose).toBe(firstClose);
    await firstClose;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(payloads[1]?.map((item) => item.status)).toEqual(["success", "budget_denied"]);
    expect(JSON.stringify(payloads[1]?.[0])).toBe(JSON.stringify(serializeMetadataEvent(live)));
    expect(payloads[1]?.[1]).toMatchObject({
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 4,
    });
    expect(payloads[1]?.[1]?.call_id).not.toBe(callId(63));
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({});
  });

  // Mutations caught: refolding a failed final replay, charging it as one event,
  // or allowing a later close to attempt terminal ownership again.
  it("failed terminal replay counts exact receipt weight once and retains nothing", async () => {
    const { reporter, payloads, fetch } = scriptedReporter(
      [new Response(null, { status: 503 }), new Response(null, { status: 503 })],
      { maxSendAttempts: 1 },
    );
    reporter.report(deniedEvent(65, { receipt_aggregate_count: 5 }));
    await expect(reporter._flushRemaining()).resolves.toBe(false);

    const firstClose = reporter.close(1_000);
    await firstClose;
    const secondClose = reporter.close(1_000);
    expect(secondClose).toBe(firstClose);
    await secondClose;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(payloads[1]?.[0]).toMatchObject({
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 5,
    });
    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "event.retry_exhausted": 5 });
  });

  // Mutation caught: checking the expired deadline before terminally taking
  // folds leaves the aggregate retained with no future sender.
  it("zero-deadline close seals folded and queued receipts at represented weight", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 1_000_000,
      maxQueueSize: 1,
    });
    reporter.report(deniedEvent(66, { receipt_aggregate_count: 4 }));
    reporter.report(deniedEvent(67, { receipt_aggregate_count: 5 }));

    await reporter.close(0);

    expect(reporter.metadataQueueSize).toBe(0);
    expect(reporter.droppedCounts).toEqual({ "event.shutdown_deadline": 9 });
  });

  it("contains hostile event access and publishes count mutations before drop logging re-enters", () => {
    let reporter!: MetadataReporter;
    let reentered = false;
    const snapshots: Array<Readonly<Record<string, number>>> = [];
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (message) => {
        if (message !== "reporter.spend_events_dropped: new=%d totals=%s" || reentered) return;
        snapshots.push(reporter.droppedCounts);
        reentered = true;
        reporter.report(event(71));
      },
      error: vi.fn(),
    };
    reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 1_000_000,
      logger,
      maxQueueSize: 1,
    });

    const hostile = new Proxy({} as MetadataEvent, {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(() => {
      reporter.report(hostile);
      reporter.report(event(70));
    }).not.toThrow();
    expect(snapshots).toEqual([{ "event.overflow": 1 }]);
    expect(reporter.droppedCounts).toEqual({ "event.overflow": 2 });
  });
});
