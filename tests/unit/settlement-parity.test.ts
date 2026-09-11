import { describe, expect, it } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

describe("settlement architecture parity", () => {
  it("keeps confirm construction sans-I/O and removes the blocking public send method", () => {
    const enforcer = new BudgetEnforcer({ apiUrl: "https://api.solwyn.test", apiKey: API_KEY });
    const confirm = enforcer.buildConfirmRequest({
      reservationId: "reservation-1",
      model: "gpt-4o",
      tokenDetails: zeroTokenDetails(),
      provider: "openai",
      callId: "00000000-0000-0000-0000-000000000001",
    });

    expect(confirm.reservation_id).toBe("reservation-1");
    expect("confirmCost" in BudgetEnforcer.prototype).toBe(false);
  });

  it("drains exactly one confirm before its matching ingest event", async () => {
    const paths: string[] = [];
    const confirms: BudgetConfirmRequest[] = [];
    const events: MetadataEvent[] = [];
    const reporter = new MetadataReporter("https://api.solwyn.test", API_KEY, {
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        paths.push(path);
        const body = JSON.parse(String(init?.body));
        if (path.endsWith("/budgets/confirm")) {
          confirms.push(body as BudgetConfirmRequest);
          return new Response(null, { status: 204 });
        }
        events.push(...(body as MetadataEvent[]));
        return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
      },
    });
    const callId = "00000000-0000-0000-0000-000000000002";
    const confirm = BudgetConfirmRequestSchema.parse({
      reservation_id: "reservation-2",
      model: "gpt-4o",
      provider: "openai",
      call_id: callId,
      token_details: zeroTokenDetails(),
    });
    const event = MetadataEventSchema.parse({
      model: "gpt-4o",
      provider: "openai",
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 1,
      status: "success",
      is_model_fallback: false,
      call_id: callId,
      sdk_instance_id: "sdk-1",
      timestamp: "2026-08-14T00:00:00Z",
    });

    reporter.reportSettlement(confirm, event);
    expect(paths).toEqual([]);
    await reporter.close();

    expect(paths).toEqual(["/api/v1/budgets/confirm", "/api/v1/metadata/ingest"]);
    expect(confirms).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(confirms[0]?.call_id).toBe(events[0]?.call_id);
  });
});
