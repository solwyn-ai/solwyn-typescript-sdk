import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors";
import { FakeControlPlane } from "../../src/testing/index";

const CHECK = "/api/v1/budgets/check";
const LEASE = "/api/v1/budgets/lease";
const INGEST = "/api/v1/metadata/ingest";

function check(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "synthetic", provider: "openai", estimated_input_tokens: 10, ...extra };
}
function grant(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "synthetic",
    provider: "openai",
    agent_run_id: "synthetic-run",
    holder_id: "synthetic-holder",
    ...extra,
  };
}
function event(index = 1): Record<string, unknown> {
  return {
    model: "synthetic",
    provider: "openai",
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`,
    sdk_instance_id: "fidelity-test",
    timestamp: `2026-01-01T00:00:00.${index.toString().padStart(6, "0")}Z`,
  };
}
function advisory(index = 1): Record<string, unknown> {
  return {
    provider: "openai",
    client_shape: "openai_sdk",
    mode: "async",
    surface: "responses.create",
    rule_kind: "unmetered_spend",
    capability_scope: null,
    posture: "warn",
    occurrences: 1,
    first_seen_at: "2026-01-01T00:00:00Z",
    last_seen_at: "2026-01-01T00:00:00Z",
    sdk_instance_id: "fidelity-test",
    report_id: `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`,
  };
}

describe("FakeControlPlane server behavior", () => {
  it.each([
    "scripted",
    "magic",
  ])("allows an alert-only project overrun with a reservation (%s)", (kind) => {
    const plane = new FakeControlPlane({ mode: "alert_only", budgetLimit: 100 });
    if (kind === "scripted") plane.denyNext();
    const response = plane.handle(
      "POST",
      CHECK,
      check(kind === "magic" ? { model: "solwyn-test/deny-alert" } : {}),
    );
    expect(response.body).toMatchObject({ allowed: true, mode: "alert_only" });
    const body = response.body as Record<string, unknown>;
    expect(body["remaining_budget"]).toBeLessThan(0);
    expect(body["current_usage"]).toBeGreaterThan(body["budget_limit"] as number);
    expect(body["reservation_id"]).toEqual(expect.any(String));
  });

  it.each([
    "tag",
    "agent_run",
  ] as const)("enforces %s counters with hard_deny even on an alert-only project", (period) => {
    const plane = new FakeControlPlane({ mode: "alert_only" });
    plane.denyNext(1, { period });
    expect(
      plane.handle("POST", CHECK, check({ agent_run_id: "synthetic-run" })).body,
    ).toMatchObject({ allowed: false, mode: "hard_deny", denied_by_period: period });
  });

  it("grants an alert-only overrun lease without a final hard-deny grant", () => {
    const plane = new FakeControlPlane({ finalGrant: true });
    expect(
      plane.handle("POST", LEASE, grant({ model: "solwyn-test/deny-alert" })).body,
    ).toMatchObject({
      allowed: true,
      lease_id: expect.any(String),
      mode: "alert_only",
      remaining_budget: -1,
      posture: { mode: "alert_only" },
      final_grant: false,
      lease_length_s: 120,
      refresh_interval_s: 15,
    });
  });

  it("can model an enforcing lease posture on an alert-only project", () => {
    const plane = new FakeControlPlane({
      mode: "alert_only",
      postureMode: "hard_deny",
      finalGrant: true,
    });
    expect(plane.handle("POST", LEASE, grant()).body).toMatchObject({
      allowed: true,
      mode: "alert_only",
      posture: { mode: "hard_deny" },
      final_grant: true,
    });
  });

  it("keeps a hard-deny project's lease posture enforcing", () => {
    const plane = new FakeControlPlane({ mode: "hard_deny", postureMode: "alert_only" });
    expect(plane.handle("POST", LEASE, grant()).body).toMatchObject({
      mode: "hard_deny",
      posture: { mode: "hard_deny" },
    });
  });

  it.each(["magic", "scripted"])("includes the opted-in stop directive for a %s stop", (kind) => {
    const plane = new FakeControlPlane();
    if (kind === "scripted") plane.denyNext(1, { period: "run_stopped" });
    expect(
      plane.handle(
        "POST",
        CHECK,
        check({
          agent_run_id: "synthetic-run",
          run_directive_version: "1",
          ...(kind === "magic" ? { model: "solwyn-test/deny-stopped" } : {}),
        }),
      ).body,
    ).toMatchObject({
      allowed: false,
      mode: "hard_deny",
      run_control: { agent_run_id: "synthetic-run", reason: "manual_kill" },
    });
  });

  it("omits both directive keys from legacy responses", () => {
    const plane = new FakeControlPlane();
    plane.stopRun("synthetic-run");
    const body = plane.handle("POST", CHECK, check({ agent_run_id: "synthetic-run" }))
      .body as object;
    expect(Object.hasOwn(body, "run_control")).toBe(false);
    expect(Object.hasOwn(body, "failover_directive")).toBe(false);
  });

  it("limits stop reasons to the server's manual_kill value", () => {
    const plane = new FakeControlPlane();
    expect(() => plane.stopRun("synthetic-run", { reason: "unsupported" } as never)).toThrow(
      ConfigurationError,
    );
    plane.stopRun("synthetic-run", { reason: "manual_kill" });
    expect(plane.stoppedRuns).toEqual({ "synthetic-run": "manual_kill" });
  });

  it.each(["text", "image"])("emits opted-in price hints for %s", (modality) => {
    const plane = new FakeControlPlane();
    expect(
      plane.handle(
        "POST",
        CHECK,
        check({ provider: "anthropic", modality, price_hints_version: "1" }),
      ).body,
    ).toHaveProperty("price_hints", modality === "text" ? { anthropic: 1 } : {});
  });

  it("checks stopped runs before replaying a holder's lease", () => {
    const plane = new FakeControlPlane();
    const body = grant({ run_directive_version: "1" });
    expect(plane.handle("POST", LEASE, body).body).toHaveProperty("allowed", true);
    plane.stopRun("synthetic-run");
    expect(plane.handle("POST", LEASE, body).body).toMatchObject({
      allowed: false,
      denied_by_period: "run_stopped",
      run_control: { reason: "manual_kill" },
    });
  });

  it("reports stopped-run usage independently of project usage", () => {
    const plane = new FakeControlPlane({ currentUsage: 50, runUsage: { "synthetic-run": 7.5 } });
    plane.stopRun("synthetic-run");
    expect(
      plane.handle("POST", CHECK, check({ agent_run_id: "synthetic-run" })).body,
    ).toHaveProperty("current_usage", 7.5);
  });

  it("rejects ingest batches larger than 1000 without recording events", () => {
    const plane = new FakeControlPlane();
    expect(
      plane.handle(
        "POST",
        INGEST,
        Array.from({ length: 1001 }, (_, index) => event(index)),
      ).status,
    ).toBe(400);
    expect(plane.ingested).toHaveLength(0);
  });

  it.each([
    "indices",
    "count",
  ] as const)("keeps %s rejections out of storage and dedup sets", (kind) => {
    const plane = new FakeControlPlane();
    plane.rejectIngest(kind === "indices" ? { indices: [0] } : { count: 1 });
    const response = plane.handle("POST", INGEST, [event()]);
    expect(response.body).toMatchObject({ ingested: 0, rejected: [{ index: 0 }], duplicates: [] });
    expect(plane.ingested).toHaveLength(0);
    expect(plane.handle("POST", INGEST, [event()]).body).toEqual({
      ingested: 1,
      rejected: [],
      duplicates: [],
    });
  });

  it("returns independent legacy and call-id duplicate dispositions with submitted indexes", () => {
    const plane = new FakeControlPlane();
    plane.handle("POST", INGEST, [event()]);
    const duplicateByCall = { ...event(), timestamp: "2026-01-02T00:00:00Z" };
    const duplicateByLegacy = { ...event(2), timestamp: event()["timestamp"] };
    expect(
      plane.handle("POST", INGEST, [duplicateByCall, duplicateByLegacy, event(3)]).body,
    ).toEqual({
      ingested: 1,
      rejected: [],
      duplicates: [
        { index: 0, reason: "call_id", call_id: event()["call_id"] },
        { index: 1, reason: "legacy_key", call_id: event(2)["call_id"] },
      ],
    });
  });

  it("rejects repeated untracked keys within one batch before storing either", () => {
    const plane = new FakeControlPlane();
    expect(
      plane.handle("POST", "/api/v1/untracked-surfaces", [advisory(1), advisory(2)]).status,
    ).toBe(400);
    expect(plane.untrackedReports).toHaveLength(0);
  });

  it("rejects untracked payloads larger than 256 KiB", async () => {
    const plane = new FakeControlPlane();
    const response = await plane.fetch(`${plane.apiUrl}/api/v1/untracked-surfaces`, {
      method: "POST",
      body: `${" ".repeat(256 * 1024)}${JSON.stringify([advisory()])}`,
    });
    expect(response.status).toBe(413);
    expect(plane.untrackedReports).toHaveLength(0);
  });

  it("rejects breaker reports for a project outside the key's project", () => {
    const plane = new FakeControlPlane({ projectId: "proj_synthetic" });
    const response = plane.handle("POST", "/api/v1/projects/proj_other/providers/breaker-reports", {
      provider: "openai",
      state: "open",
      failure_count: 3,
      success_count: 0,
      reported_at: "2026-01-01T00:00:00Z",
      sdk_instance_id: "fidelity-test",
    });
    expect(response.status).toBe(403);
    expect(plane.breakerReports).toHaveLength(0);
  });
});
