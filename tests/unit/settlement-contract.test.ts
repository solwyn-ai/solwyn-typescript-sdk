import { describe, expect, it, vi } from "vitest";
import { MetadataReporter } from "../../src/reporter";
import {
  buildReportedTokenDetails,
  buildTokenDetails,
  TokenDetailsSchema,
  zeroTokenDetails,
} from "../../src/token-details";
import { IngestResponseSchema, LeaseRenewRequestSchema } from "../../src/validation";
import { allowIngestContractDrift } from "../helpers/ingest-contract";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

describe("settlement wire contract", () => {
  it("requires duplicates and validates every duplicate as a strict disposition", () => {
    const response = {
      ingested: 0,
      rejected: [],
      duplicates: [{ index: 0, reason: "call_id", call_id: "synthetic" }],
    };
    expect(IngestResponseSchema.safeParse(response).success).toBe(true);
    expect(IngestResponseSchema.safeParse({ ingested: 0, rejected: [] }).success).toBe(false);
    for (const duplicate of [
      { index: -1, reason: "call_id", call_id: "synthetic" },
      { index: 0, reason: "unknown", call_id: "synthetic" },
      { index: 0, reason: "call_id", call_id: "synthetic", extra: true },
      { reason: "legacy_key", call_id: "synthetic" },
    ])
      expect(IngestResponseSchema.safeParse({ ...response, duplicates: [duplicate] }).success).toBe(
        false,
      );
  });

  it.each([
    buildTokenDetails,
    buildReportedTokenDetails,
  ])("raises an inconsistent input total without discarding cache buckets during %s normalization", (build) => {
    expect(
      build({
        input_tokens: 100,
        output_tokens: 5,
        cached_input_tokens: 60,
        cache_creation_5m_tokens: 60,
        cache_creation_1h_tokens: 60,
      }),
    ).toMatchObject({
      input_tokens: 180,
      output_tokens: 5,
      cached_input_tokens: 60,
      cache_creation_5m_tokens: 60,
      cache_creation_1h_tokens: 60,
      is_estimated: true,
    });
    expect(
      build({
        input_tokens: 100,
        output_tokens: 5,
        cached_input_tokens: 60,
        cache_creation_5m_tokens: 30,
        cache_creation_1h_tokens: 10,
      }).is_estimated,
    ).toBe(false);
  });

  it("rejects unnormalized cache buckets at the wire boundary", () => {
    expect(
      TokenDetailsSchema.safeParse({
        input_tokens: 10,
        cached_input_tokens: 8,
        cache_creation_5m_tokens: 3,
      }).success,
    ).toBe(false);
    expect(
      TokenDetailsSchema.safeParse({
        input_tokens: 10,
        image_input_tokens: 10,
        cached_input_tokens: 10,
      }).success,
    ).toBe(true);
  });

  it.each([
    { model: "synthetic" },
    { provider: "openai" },
    { model: "synthetic", provider: null },
    { fallback_models: ["synthetic"], fallback_providers: ["openai"] },
  ])("rejects an incomplete lease renewal chain: %j", (chain) => {
    expect(
      LeaseRenewRequestSchema.safeParse({
        lease_id: "synthetic",
        holder_id: "synthetic",
        generation: 1,
        ...chain,
      }).success,
    ).toBe(false);
  });

  it("includes the funding lease on metadata even when its confirmation is refused", async () => {
    const events: Array<Record<string, unknown>> = [];
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      fetch: async (url, init) => {
        if (url.endsWith("/confirm")) return new Response(null, { status: 422 });
        events.push(...JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ingested: 1, rejected: [], duplicates: [] }), {
          status: 202,
        });
      },
    });
    reporter.reportSettlement(
      {
        is_provider_fallback: false,
        lease_id: "lease-synthetic",
        model: "synthetic",
        provider: "openai",
        call_id: "00000000-0000-0000-0000-000000000001",
        token_details: zeroTokenDetails(),
      },
      {
        model: "synthetic",
        provider: "openai",
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 1,
        status: "success",
        is_model_fallback: false,
        is_provider_fallback: false,
        attempt_index: 0,
        call_id: "00000000-0000-0000-0000-000000000001",
        sdk_instance_id: "contract-test",
        timestamp: "2026-01-01T00:00:00Z",
      },
    );
    try {
      await reporter._flushRemaining();
      expect(events).toHaveLength(1);
      expect(events[0]?.["lease_id"]).toBe("lease-synthetic");
    } finally {
      await reporter.close(0);
    }
  });

  it.each([
    { rejected: [], duplicates: [] },
    { ingested: 1, rejected: [] },
    { ingested: 1, rejected: [], duplicates: [], extra: true },
    {
      ingested: 0,
      rejected: [{ code: "unknown", model: "synthetic", message: "synthetic" }],
      duplicates: [],
    },
  ])("escalates malformed ingest contracts even when fallback disposition is possible: %j", (body) => {
    allowIngestContractDrift();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, { logger });
    for (let count = 0; count < 10; count += 1) reporter._parseIngestRejections(body, 1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("consecutive_failures=10"));
    if (Array.isArray(body.rejected) && body.rejected.length > 0) {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("reporter.ingest_events_rejected"),
      );
    }
  });

  it.each([
    [null, false, 2],
    [null, true, 2],
    ["malformed", false, 2],
    ["malformed", true, 2],
    [null, false, 1],
  ] as const)("logs a usable rejection beside a malformed sibling: %j, first=%s, batch=%s", (malformed, first, batchSize) => {
    allowIngestContractDrift();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, { logger });
    const rejection = {
      index: 0,
      code: "unknown_model",
      model: "synthetic",
      message: "Unknown synthetic model",
    };
    const rejected = first ? [malformed, rejection] : [rejection, malformed];
    const result = reporter._parseIngestRejections(
      { ingested: 0, rejected, duplicates: [] },
      batchSize,
    );
    expect(result).toEqual(
      batchSize === 2
        ? { kind: "exact", indexes: [0], count: 1 }
        : { kind: "malformed", indexes: [], count: 0 },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reporter.ingest_events_rejected: code=unknown_model"),
    );
    expect(logger.warn.mock.calls.filter(([line]) => line.includes("unparseable"))).toHaveLength(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("reporter.ingest_response_fallback"),
    );
  });
});
