import { describe, expect, it } from "vitest";
import { FakeControlPlane } from "../../src/testing/index";

const INGEST_PATH = "/api/v1/metadata/ingest";

function event(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = String(index).padStart(8, "0");
  return {
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: `${id}-1111-1111-1111-111111111111`,
    sdk_instance_id: "sdk-receipts",
    timestamp: `2026-09-01T01:00:${String(index).padStart(2, "0")}Z`,
    ...overrides,
  };
}

async function post(plane: FakeControlPlane, body: unknown): Promise<Response> {
  return plane.fetch(`${plane.apiUrl}${INGEST_PATH}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("FakeControlPlane receipt projections", () => {
  it("projects denial receipts and aggregate replays in ingest arrival order", () => {
    const plane = new FakeControlPlane();
    const ordinary = event(1);
    const denial = event(2, { deny_source: "server" });
    const aggregate = event(3, {
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 4,
      receipt_pricing_input_tokens: null,
    });
    const nullSource = event(4, { deny_source: null });

    expect(
      plane.handle("POST", INGEST_PATH, [ordinary, denial, aggregate, nullSource]),
    ).toMatchObject({ status: 202, body: { ingested: 4 } });
    expect(plane.denialReceipts.map((receipt) => receipt.call_id)).toEqual([
      denial["call_id"],
      aggregate["call_id"],
    ]);
    expect(plane.aggregateReplays.map((receipt) => receipt.call_id)).toEqual([
      aggregate["call_id"],
    ]);
  });

  it("returns fresh receipt projection containers", () => {
    const plane = new FakeControlPlane();
    const receipt = event(1, {
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 2,
    });
    plane.handle("POST", INGEST_PATH, [receipt]);

    const denials = plane.denialReceipts;
    const replays = plane.aggregateReplays;
    denials.pop();
    replays.pop();

    expect(plane.denialReceipts.map((entry) => entry.call_id)).toEqual([receipt["call_id"]]);
    expect(plane.aggregateReplays.map((entry) => entry.call_id)).toEqual([receipt["call_id"]]);
  });

  it("records scripted rejected aggregate receipts through fetch even without a pricing basis", async () => {
    const plane = new FakeControlPlane();
    const rejected = event(1, {
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 2,
      receipt_pricing_input_tokens: null,
    });
    const window = plane.rejectIngest({ indices: [0] });

    const response = await post(plane, [rejected]);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ingested: 0, rejected: [{ index: 0 }] });
    expect(plane.denialReceipts.map((entry) => entry.call_id)).toEqual([rejected["call_id"]]);
    expect(plane.aggregateReplays.map((entry) => entry.call_id)).toEqual([rejected["call_id"]]);
    window.end();
  });

  it("clears receipt projections without forgetting their ingest identities", () => {
    const plane = new FakeControlPlane();
    const receipt = event(1, {
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 2,
    });
    plane.handle("POST", INGEST_PATH, [receipt]);
    plane.resetRecording();

    expect(plane.denialReceipts).toEqual([]);
    expect(plane.aggregateReplays).toEqual([]);
    expect(plane.handle("POST", INGEST_PATH, [receipt]).body).toEqual({
      ingested: 0,
      rejected: [],
    });
  });

  it("rejects invalid receipt batches atomically without claiming valid sibling identities", () => {
    const plane = new FakeControlPlane();
    const valid = event(1, { deny_source: "server" });
    const invalid = event(2, { receipt_pricing_input_tokens: 10 });

    expect(plane.handle("POST", INGEST_PATH, [valid, invalid]).status).toBe(422);
    expect(plane.ingested).toEqual([]);
    expect(plane.denialReceipts).toEqual([]);
    expect(plane.handle("POST", INGEST_PATH, [valid]).body).toEqual({ ingested: 1, rejected: [] });
    expect(plane.denialReceipts.map((entry) => entry.call_id)).toEqual([valid["call_id"]]);
  });
});
