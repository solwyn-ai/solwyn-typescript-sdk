import { describe, expect, it } from "vitest";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const callId = "00000000-0000-0000-0000-000000000001";

function enqueue(reporter: MetadataReporter, kind: "confirm" | "settlement" | "event"): void {
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
  });
});
