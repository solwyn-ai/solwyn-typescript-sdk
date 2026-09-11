import { describe, expect, it } from "vitest";

async function makePlane(options: Record<string, unknown> = {}) {
  const { FakeControlPlane } = await import("../../src/testing/index");
  return new FakeControlPlane(options);
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 10,
    output_tokens: 5,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: "11111111-1111-1111-1111-111111111111",
    sdk_instance_id: "sdk-1",
    timestamp: "2026-08-31T01:00:00Z",
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openai",
    client_shape: "openai_sdk",
    mode: "sync",
    surface: "chat.completions.create",
    rule_kind: "unmetered_spend",
    posture: "warn",
    occurrences: 1,
    first_seen_at: "2026-08-31T01:00:00Z",
    last_seen_at: "2026-08-31T01:00:01Z",
    sdk_instance_id: "sdk-1",
    report_id: "11111111-1111-1111-1111-111111111111",
    ...overrides,
  };
}

describe("FakeControlPlane metadata ingest", () => {
  it("atomically parses, records, and deduplicates event identities", async () => {
    const plane = await makePlane();
    const first = event();
    const second = event({
      call_id: "22222222-2222-2222-2222-222222222222",
      timestamp: "2026-08-31T01:00:01Z",
    });
    expect(plane.handle("POST", "/api/v1/metadata/ingest", [first, second])).toEqual({
      status: 202,
      body: { ingested: 2, rejected: [] },
      headers: {},
    });
    expect(plane.ingested).toHaveLength(2);
    expect(plane.handle("POST", "/api/v1/metadata/ingest", [first, second]).body).toEqual({
      ingested: 0,
      rejected: [],
    });
    expect(plane.ingested).toHaveLength(2);
  });

  it("preserves own reserved-looking tag keys in direct ingest", async () => {
    const plane = await makePlane();
    const tags = Object.fromEntries([
      ["__proto__", "admin"],
      ["constructor", "safe"],
    ]);

    const response = plane.handle("POST", "/api/v1/metadata/ingest", [event({ tags })]);

    expect(response).toMatchObject({ status: 202, body: { ingested: 1, rejected: [] } });
    expect(plane.ingested).toHaveLength(1);
    const recordedTags = plane.ingested[0]?.tags;
    expect(recordedTags).toBeDefined();
    expect(Object.getPrototypeOf(recordedTags)).toBe(Object.prototype);
    expect(Object.hasOwn(recordedTags as object, "__proto__")).toBe(true);
    expect(Reflect.get(recordedTags as object, "__proto__")).toBe("admin");
    expect(Object.hasOwn(recordedTags as object, "constructor")).toBe(true);
    expect(Reflect.get(recordedTags as object, "constructor")).toBe("safe");
  });

  it("uses the legacy timestamp/sdk identity and keeps invalid batches atomic", async () => {
    const plane = await makePlane();
    const first = event();
    const legacyReplay = event({ call_id: "22222222-2222-2222-2222-222222222222" });
    plane.handle("POST", "/api/v1/metadata/ingest", [first]);
    expect(plane.handle("POST", "/api/v1/metadata/ingest", [legacyReplay]).body).toEqual({
      ingested: 0,
      rejected: [],
    });

    const fresh = event({
      call_id: "33333333-3333-3333-3333-333333333333",
      timestamp: "2026-08-31T01:00:02Z",
    });
    const invalid = event({ call_id: "not-a-uuid", private_prompt: "secret-sentinel" });
    const response = plane.handle("POST", "/api/v1/metadata/ingest", [fresh, invalid]);
    expect(response.status).toBe(422);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("private_prompt");
    expect(serialized).not.toContain("secret-sentinel");
    expect(plane.ingested).toHaveLength(1);
  });

  it("handles attempt indices, partial overlaps, and offset-normalized legacy identities", async () => {
    const plane = await makePlane();
    const attemptZero = event();
    const attemptOne = event({ attempt_index: 1, timestamp: "2026-08-31T01:00:01Z" });
    expect(plane.handle("POST", "/api/v1/metadata/ingest", [attemptZero, attemptOne]).body).toEqual(
      {
        ingested: 2,
        rejected: [],
      },
    );

    const fresh = event({
      call_id: "33333333-3333-3333-3333-333333333333",
      timestamp: "2026-08-31T01:00:02Z",
    });
    expect(plane.handle("POST", "/api/v1/metadata/ingest", [attemptZero, fresh]).body).toEqual({
      ingested: 1,
      rejected: [],
    });

    const offset = event({
      call_id: "44444444-4444-4444-4444-444444444444",
      sdk_instance_id: "sdk-offset",
      timestamp: "2026-08-30T21:00:03-04:00",
    });
    const sameInstant = event({
      call_id: "55555555-5555-5555-5555-555555555555",
      sdk_instance_id: "sdk-offset",
      timestamp: "2026-08-31T01:00:03Z",
    });
    expect(plane.handle("POST", "/api/v1/metadata/ingest", [offset]).body).toMatchObject({
      ingested: 1,
    });
    expect(plane.handle("POST", "/api/v1/metadata/ingest", [sameInstant]).body).toEqual({
      ingested: 0,
      rejected: [],
    });
    expect(plane.ingested).toHaveLength(4);
  });

  it("preserves sub-millisecond precision in the legacy timestamp identity", async () => {
    const plane = await makePlane();
    const first = event({
      call_id: "66666666-6666-6666-6666-666666666666",
      sdk_instance_id: "sdk-fractional",
      timestamp: "2026-08-31T01:00:03.0001Z",
    });
    const later = event({
      call_id: "77777777-7777-7777-7777-777777777777",
      sdk_instance_id: "sdk-fractional",
      timestamp: "2026-08-31T01:00:03.0002Z",
    });

    expect(plane.handle("POST", "/api/v1/metadata/ingest", [first, later]).body).toEqual({
      ingested: 2,
      rejected: [],
    });
    expect(plane.ingested).toHaveLength(2);
  });

  it("resetRecording preserves ingest replay memory", async () => {
    const plane = await makePlane();
    const first = event();
    plane.handle("POST", "/api/v1/metadata/ingest", [first]);
    plane.resetRecording();
    expect(plane.ingested).toEqual([]);
    expect(plane.handle("POST", "/api/v1/metadata/ingest", [first]).body).toEqual({
      ingested: 0,
      rejected: [],
    });
    expect(plane.ingested).toEqual([]);
  });

  it("sanitizes fetch JSON-decode and schema errors without recording rejected input", async () => {
    const plane = await makePlane();
    const jsonError = await plane.fetch(`${plane.apiUrl}/api/v1/metadata/ingest`, {
      method: "POST",
      body: '{"private_prompt":"secret-sentinel"',
    });
    expect(jsonError.status).toBe(422);
    const jsonBytes = await jsonError.text();
    expect(jsonBytes).not.toContain("private_prompt");
    expect(jsonBytes).not.toContain("secret-sentinel");
    expect(jsonBytes).toContain("json_invalid");
    expect(plane.ingested).toEqual([]);
  });
});

describe("FakeControlPlane advisory endpoints", () => {
  it("accepts up to 100 untracked reports, atomically validates, and deduplicates replay ids", async () => {
    const plane = await makePlane();
    const valid = report();
    expect(plane.handle("POST", "/api/v1/untracked-surfaces", [valid])).toEqual({
      status: 202,
      body: { accepted: 1 },
      headers: {},
    });
    expect(plane.handle("POST", "/api/v1/untracked-surfaces", [valid]).body).toEqual({
      accepted: 1,
    });
    expect(plane.untrackedReports).toHaveLength(1);

    const fresh = report({
      surface: "responses.create",
      report_id: "22222222-2222-2222-2222-222222222222",
    });
    const invalid = report({ last_seen_at: "2026-08-31T00:59:59Z" });
    expect(plane.handle("POST", "/api/v1/untracked-surfaces", [fresh, invalid]).status).toBe(422);
    expect(plane.untrackedReports).toHaveLength(1);

    const oversized = Array.from({ length: 101 }, (_, index) =>
      report({ report_id: `${index.toString(16).padStart(8, "0")}-1111-1111-1111-111111111111` }),
    );
    expect(plane.handle("POST", "/api/v1/untracked-surfaces", oversized)).toMatchObject({
      status: 400,
      body: { detail: "untracked surface batches may contain at most 100 reports" },
    });

    const fetchOversized = await plane.fetch(`${plane.apiUrl}/api/v1/untracked-surfaces`, {
      method: "POST",
      body: JSON.stringify([{ private_prompt: "secret" }, ...oversized.slice(0, 100)]),
    });
    expect(fetchOversized.status).toBe(400);
    expect(await fetchOversized.json()).toEqual({
      detail: "untracked surface batches may contain at most 100 reports",
    });

    const boundaryPlane = await makePlane();
    const boundary = Array.from({ length: 100 }, (_, index) =>
      report({
        surface: `surface_${index}`,
        report_id: `${index.toString(16).padStart(8, "0")}-1111-1111-1111-111111111111`,
      }),
    );
    expect(boundaryPlane.handle("POST", "/api/v1/untracked-surfaces", boundary)).toMatchObject({
      status: 202,
      body: { accepted: 100 },
    });
    expect(boundaryPlane.untrackedReports).toHaveLength(100);
  });

  it("resetRecording preserves untracked replay memory", async () => {
    const plane = await makePlane();
    const first = report();
    plane.handle("POST", "/api/v1/untracked-surfaces", [first]);
    plane.resetRecording();
    expect(plane.untrackedReports).toEqual([]);
    expect(plane.handle("POST", "/api/v1/untracked-surfaces", [first]).body).toEqual({
      accepted: 1,
    });
    expect(plane.untrackedReports).toEqual([]);
  });

  it("emits the spec-authoritative breaker 202 accepted body and records the strict model", async () => {
    const plane = await makePlane();
    const response = plane.handle("POST", "/api/v1/projects/proj_fake/providers/breaker-reports", {
      provider: "openai",
      state: "closed",
      failure_count: 0,
      success_count: 1,
      reported_at: "2026-08-31T01:00:00Z",
      sdk_instance_id: "sdk-1",
    });
    expect(response).toEqual({ status: 202, body: { accepted: true }, headers: {} });
    expect(plane.breakerReports).toHaveLength(1);
    expect(plane.breakerReports[0]).toMatchObject({ state: "closed", success_count: 1 });

    const fetchResponse = await plane.fetch(
      `${plane.apiUrl}/api/v1/projects/proj_fake/providers/breaker-reports`,
      {
        method: "POST",
        body: JSON.stringify({
          provider: "openai",
          state: "closed",
          failure_count: 0,
          success_count: 2,
          reported_at: "2026-08-31T01:00:01Z",
          sdk_instance_id: "sdk-1",
        }),
      },
    );
    expect(fetchResponse.status).toBe(202);
    expect(await fetchResponse.text()).toBe('{"accepted":true}');

    const sentinel = "private_breaker_key";
    const invalid = plane.handle("POST", "/api/v1/projects/proj_fake/providers/breaker-reports", {
      provider: "openai",
      state: "closed",
      failure_count: 0,
      success_count: 0,
      reported_at: "2026-08-31T01:00:02Z",
      sdk_instance_id: "sdk-1",
      [sentinel]: "secret",
    });
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(invalid.body)).not.toContain(sentinel);
    expect(JSON.stringify(invalid.body)).not.toContain("secret");
    expect(plane.breakerReports).toHaveLength(2);
  });

  it("serves health and records unknown routes before returning 404", async () => {
    const plane = await makePlane();
    expect(plane.handle("GET", "/health", undefined)).toEqual({
      status: 200,
      body: { status: "ok" },
      headers: {},
    });
    expect(plane.handle("POST", "/api/v1/not-real", {})).toEqual({
      status: 404,
      body: { detail: "not found" },
      headers: {},
    });
    expect(plane.unmatchedRequests).toEqual([{ method: "POST", path: "/api/v1/not-real" }]);

    expect(plane.handle("POST", "/api/v1/budgets/check/", {})).toMatchObject({ status: 404 });
    expect(plane.handle("GET", "/api/v1/budgets/check", {})).toMatchObject({ status: 404 });
    expect(plane.unmatchedRequests).toEqual([
      { method: "POST", path: "/api/v1/not-real" },
      { method: "POST", path: "/api/v1/budgets/check/" },
      { method: "GET", path: "/api/v1/budgets/check" },
    ]);
  });
});
