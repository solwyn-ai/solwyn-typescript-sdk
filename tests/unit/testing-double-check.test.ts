import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors";
import { MAGIC_MODELS } from "../../src/testing/index";

async function makePlane(options: Record<string, unknown> = {}) {
  const { FakeControlPlane } = await import("../../src/testing/index");
  return new FakeControlPlane(options);
}

function checkBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    estimated_input_tokens: 10,
    model: "gpt-4o",
    provider: "openai",
    ...overrides,
  };
}

function confirmBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reservation_id: "res_fake_00000001",
    model: "gpt-4o",
    provider: "openai",
    call_id: "11111111-1111-1111-1111-111111111111",
    token_details: {
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      audio_input_tokens: 0,
      audio_output_tokens: 0,
    },
    ...overrides,
  };
}

describe("FakeControlPlane checks", () => {
  it("reserves exactly the seven documented magic model names", () => {
    expect(MAGIC_MODELS).toEqual([
      "solwyn-test/deny",
      "solwyn-test/deny-alert",
      "solwyn-test/deny-tag",
      "solwyn-test/deny-stopped",
      "solwyn-test/runaway",
      "solwyn-test/kill",
      "solwyn-test/lease-ineligible",
    ]);
  });

  it("preserves own reserved-looking tag keys in direct checks", async () => {
    const plane = await makePlane();
    const tags = Object.fromEntries([
      ["__proto__", "admin"],
      ["constructor", "safe"],
    ]);

    const response = plane.handle("POST", "/api/v1/budgets/check", checkBody({ tags }));

    expect(response.status).toBe(200);
    expect(plane.checks).toHaveLength(1);
    const recordedTags = plane.checks[0]?.tags;
    expect(recordedTags).toBeDefined();
    expect(Object.getPrototypeOf(recordedTags)).toBe(Object.prototype);
    expect(Object.hasOwn(recordedTags as object, "__proto__")).toBe(true);
    expect(Reflect.get(recordedTags as object, "__proto__")).toBe("admin");
    expect(Object.hasOwn(recordedTags as object, "constructor")).toBe(true);
    expect(Reflect.get(recordedTags as object, "constructor")).toBe("safe");
  });

  it("exposes deterministic fixed wiring and validates every constructor knob", async () => {
    const plane = await makePlane();
    expect(plane.apiKey).toBe(`sk_proj_${"0".repeat(64)}`);
    expect(plane.apiUrl).toBe("http://control-plane.invalid");
    expect(typeof plane.fetch).toBe("function");

    for (const [field, value] of [
      ["mode", "warn"],
      ["budgetLimit", Number.NaN],
      ["currentUsage", Number.POSITIVE_INFINITY],
      ["projectId", ""],
      ["failoverTuningAllowed", "yes"],
      ["priceHints", { openai: Number.NaN }],
      ["leaseEligible", 1],
      ["grantedTokens", -1],
      ["headroomShareTokens", -1],
      ["finalGrant", 1],
      ["refreshIntervalS", 0],
      ["leaseLengthS", 0],
    ] as const) {
      await expect(makePlane({ [field]: value })).rejects.toMatchObject({
        name: "ConfigurationError",
        field,
      });
    }
    await expect(makePlane({ refreshIntervalS: 90, leaseLengthS: 90 })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("allows with monotonic reservations and conditionally emits v1 directives and hints", async () => {
    const plane = await makePlane({ priceHints: { openai: 0.25, future: 1.5 } });
    const legacy = plane.handle("POST", "/api/v1/budgets/check", checkBody());
    expect(legacy).toEqual({
      status: 200,
      body: {
        allowed: true,
        remaining_budget: 100,
        reservation_id: "res_fake_00000001",
        mode: "hard_deny",
        budget_limit: 100,
        current_usage: 0,
        denied_by_period: null,
        project_id: "proj_fake",
        price_hints: null,
        failover_directive: null,
        run_control: null,
      },
      headers: {},
    });

    const failoverOnly = plane.handle(
      "POST",
      "/api/v1/budgets/check",
      checkBody({ failover_directive_version: "1" }),
    );
    expect(failoverOnly.body).toMatchObject({
      reservation_id: "res_fake_00000002",
      failover_directive: { version: "1", failover_tuning_allowed: true },
    });
    expect(failoverOnly.body).not.toHaveProperty("denied_by_period");
    expect(failoverOnly.body).not.toHaveProperty("price_hints");

    const optedIn = plane.handle(
      "POST",
      "/api/v1/budgets/check",
      checkBody({ failover_directive_version: "1", price_hints_version: "1" }),
    );
    expect(optedIn.body).toMatchObject({
      reservation_id: "res_fake_00000003",
      price_hints: { openai: 0.25, future: 1.5 },
      failover_directive: { version: "1", failover_tuning_allowed: true },
    });
    expect(optedIn.body).not.toHaveProperty("denied_by_period");

    const priceOnly = plane.handle(
      "POST",
      "/api/v1/budgets/check",
      checkBody({ price_hints_version: "1" }),
    );
    expect(priceOnly.body).toEqual({
      allowed: true,
      remaining_budget: 100,
      reservation_id: "res_fake_00000004",
      mode: "hard_deny",
      budget_limit: 100,
      current_usage: 0,
      denied_by_period: null,
      project_id: "proj_fake",
      price_hints: { openai: 0.25, future: 1.5 },
      failover_directive: null,
      run_control: null,
    });

    const runV1 = plane.handle(
      "POST",
      "/api/v1/budgets/check",
      checkBody({ run_directive_version: "1" }),
    );
    expect(runV1.body).toEqual({
      allowed: true,
      remaining_budget: 100,
      reservation_id: "res_fake_00000005",
      mode: "hard_deny",
      budget_limit: 100,
      current_usage: 0,
      project_id: "proj_fake",
    });
    expect(plane.checks).toHaveLength(5);

    const bytesPlane = await makePlane();
    const legacyFetch = await bytesPlane.fetch(`${bytesPlane.apiUrl}/api/v1/budgets/check`, {
      method: "POST",
      body: JSON.stringify(checkBody()),
    });
    expect(await legacyFetch.text()).toBe(
      JSON.stringify({
        allowed: true,
        remaining_budget: 100,
        reservation_id: "res_fake_00000001",
        mode: "hard_deny",
        budget_limit: 100,
        current_usage: 0,
        denied_by_period: null,
        project_id: "proj_fake",
        price_hints: null,
        failover_directive: null,
        run_control: null,
      }),
    );
  });

  it("returns configured hard and alert-only denials without reservations", async () => {
    const plane = await makePlane({ mode: "hard_deny", budgetLimit: 10, currentUsage: 20 });
    plane.denyNext();
    const hard = plane.handle("POST", "/api/v1/budgets/check", checkBody());
    expect(hard.body).toMatchObject({
      allowed: false,
      mode: "hard_deny",
      denied_by_period: "monthly",
      remaining_budget: 0,
    });
    expect(hard.body).toHaveProperty("reservation_id", null);
    expect(hard.body).toMatchObject({
      price_hints: null,
      failover_directive: null,
      run_control: null,
    });

    plane.denyNext();
    const modernHard = plane.handle(
      "POST",
      "/api/v1/budgets/check",
      checkBody({ failover_directive_version: "1" }),
    );
    expect(modernHard.body).toMatchObject({
      allowed: false,
      denied_by_period: "monthly",
      failover_directive: { version: "1", failover_tuning_allowed: true },
    });
    expect(modernHard.body).not.toHaveProperty("reservation_id");
    expect(modernHard.body).not.toHaveProperty("price_hints");
    expect(modernHard.body).not.toHaveProperty("run_control");

    const alert = await makePlane({ mode: "alert_only" });
    alert.denyNext();
    expect(alert.handle("POST", "/api/v1/budgets/check", checkBody()).body).toMatchObject({
      allowed: false,
      mode: "alert_only",
      denied_by_period: "monthly",
    });
  });

  it("supports queued/run denials, clearDenials, and validates scripts", async () => {
    const plane = await makePlane();
    expect(() => plane.denyNext(-1)).toThrow(/solwyn\.testing:/);
    expect(() => plane.denyNext(1, { period: "daily" as never })).toThrow(/solwyn\.testing:/);
    plane.denyRun("run-a");
    expect(
      plane.handle("POST", "/api/v1/budgets/check", checkBody({ agent_run_id: "run-a" })).body,
    ).toMatchObject({ allowed: false, denied_by_period: "agent_run" });
    plane.clearDenials();
    expect(
      plane.handle("POST", "/api/v1/budgets/check", checkBody({ agent_run_id: "run-a" })).body,
    ).toMatchObject({ allowed: true });
  });

  it.each([
    ["solwyn-test/deny", "monthly", "hard_deny"],
    ["solwyn-test/deny-alert", "monthly", "alert_only"],
    ["solwyn-test/deny-tag", "tag", "hard_deny"],
    ["solwyn-test/deny-stopped", "run_stopped", "hard_deny"],
  ] as const)("implements check magic model %s", async (model, period, mode) => {
    const plane = await makePlane();
    const body = checkBody({ model, agent_run_id: "run-a" });
    expect(plane.handle("POST", "/api/v1/budgets/check", body).body).toMatchObject({
      allowed: false,
      denied_by_period: period,
      mode,
    });
  });

  it("requires a run for run-scoped magic and remembers runaway sightings per run", async () => {
    const plane = await makePlane();
    for (const model of ["solwyn-test/deny-stopped", "solwyn-test/runaway"]) {
      expect(() => plane.handle("POST", "/api/v1/budgets/check", checkBody({ model }))).toThrow(
        /^solwyn\.testing:/,
      );
    }
    const runaway = checkBody({ model: "solwyn-test/runaway", agent_run_id: "run-a" });
    expect(plane.handle("POST", "/api/v1/budgets/check", runaway).body).toMatchObject({
      allowed: true,
    });
    expect(plane.handle("POST", "/api/v1/budgets/check", runaway).body).toMatchObject({
      allowed: false,
      denied_by_period: "agent_run",
    });
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/check",
        checkBody({ model: "solwyn-test/runaway", agent_run_id: "run-b" }),
      ).body,
    ).toMatchObject({ allowed: true });
  });

  it("keeps lease-ineligible check-transparent but stops a killed run on its second sighting", async () => {
    const plane = await makePlane();
    for (const model of ["solwyn-test/lease-ineligible", "solwyn-test/lease-ineligible"]) {
      expect(
        plane.handle("POST", "/api/v1/budgets/check", checkBody({ model })).body,
      ).toMatchObject({ allowed: true });
    }
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/check",
        checkBody({ model: "solwyn-test/kill", agent_run_id: "run-a" }),
      ).body,
    ).toMatchObject({ allowed: true });
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/check",
        checkBody({ model: "solwyn-test/kill", agent_run_id: "run-a" }),
      ).body,
    ).toMatchObject({ allowed: false, denied_by_period: "run_stopped", remaining_budget: 0 });
  });

  it("rejects unknown magic and applies programmatic denial before the first chain magic", async () => {
    const plane = await makePlane();
    expect(() =>
      plane.handle(
        "POST",
        "/api/v1/budgets/check",
        checkBody({ fallback_providers: ["openai"], fallback_models: ["solwyn-test/typo"] }),
      ),
    ).toThrow(/^solwyn\.testing:/);

    plane.denyNext(1, { period: "tag" });
    const result = plane.handle(
      "POST",
      "/api/v1/budgets/check",
      checkBody({
        model: "solwyn-test/deny-alert",
        fallback_providers: ["openai"],
        fallback_models: ["solwyn-test/deny"],
      }),
    );
    expect(result.body).toMatchObject({ denied_by_period: "tag", mode: "hard_deny" });
  });

  it("prevalidates the whole chain and does not mark runaway behind a queued denial", async () => {
    const plane = await makePlane();
    expect(() =>
      plane.handle(
        "POST",
        "/api/v1/budgets/check",
        checkBody({
          model: "solwyn-test/deny",
          fallback_providers: ["openai"],
          fallback_models: ["solwyn-test/not-reserved"],
        }),
      ),
    ).toThrow(/^solwyn\.testing:/);

    const runaway = checkBody({ model: "solwyn-test/runaway", agent_run_id: "run-a" });
    plane.denyNext();
    expect(plane.handle("POST", "/api/v1/budgets/check", runaway).body).toMatchObject({
      allowed: false,
      denied_by_period: "monthly",
    });
    expect(plane.handle("POST", "/api/v1/budgets/check", runaway).body).toMatchObject({
      allowed: true,
    });
    expect(plane.handle("POST", "/api/v1/budgets/check", runaway).body).toMatchObject({
      allowed: false,
      denied_by_period: "agent_run",
    });
  });

  it("uses the first fallback magic and forces stopped denials hard with zero remaining", async () => {
    const plane = await makePlane({ mode: "alert_only", remainingBudget: 44 });
    const firstFallback = plane.handle(
      "POST",
      "/api/v1/budgets/check",
      checkBody({
        fallback_providers: ["openai", "openai"],
        fallback_models: ["solwyn-test/deny-alert", "solwyn-test/deny-tag"],
      }),
    );
    expect(firstFallback.body).toMatchObject({
      allowed: false,
      mode: "alert_only",
      denied_by_period: "monthly",
    });

    const stopped = plane.handle(
      "POST",
      "/api/v1/budgets/check",
      checkBody({ model: "solwyn-test/deny-stopped", agent_run_id: "run-a" }),
    );
    expect(stopped.body).toMatchObject({
      allowed: false,
      mode: "hard_deny",
      remaining_budget: 0,
      denied_by_period: "run_stopped",
    });
  });
});

describe("FakeControlPlane confirms and reservation state", () => {
  it("settles once, deduplicates call/reservation replays, and 404s expired reservations", async () => {
    const plane = await makePlane();
    plane.handle("POST", "/api/v1/budgets/check", checkBody());
    expect(plane.handle("POST", "/api/v1/budgets/confirm", confirmBody())).toEqual({
      status: 204,
      body: null,
      headers: {},
    });
    expect(plane.confirms).toHaveLength(1);

    const fetchReplay = await plane.fetch(`${plane.apiUrl}/api/v1/budgets/confirm`, {
      method: "POST",
      body: JSON.stringify(confirmBody()),
    });
    expect(fetchReplay.status).toBe(204);
    expect(await fetchReplay.text()).toBe("");
    expect(plane.handle("POST", "/api/v1/budgets/confirm", confirmBody()).status).toBe(204);
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({ call_id: "22222222-2222-2222-2222-222222222222" }),
      ).status,
    ).toBe(204);
    expect(plane.confirms).toHaveLength(1);

    plane.handle("POST", "/api/v1/budgets/check", checkBody());
    plane.expireReservations();
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({
          reservation_id: "res_fake_00000002",
          call_id: "33333333-3333-3333-3333-333333333333",
        }),
      ),
    ).toMatchObject({ status: 404, body: { detail: "Reservation not found or expired" } });
    expect(plane.confirms).toHaveLength(1);
  });

  it("does not record invalid confirms or claim failed call ids", async () => {
    const plane = await makePlane();
    const callId = "44444444-4444-4444-4444-444444444444";
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({ reservation_id: "unknown", call_id: callId }),
      ).status,
    ).toBe(404);
    plane.handle("POST", "/api/v1/budgets/check", checkBody());
    expect(
      plane.handle("POST", "/api/v1/budgets/confirm", confirmBody({ call_id: callId })).status,
    ).toBe(204);
    expect(plane.confirms).toHaveLength(1);

    expect(
      plane.handle("POST", "/api/v1/budgets/confirm", { private_prompt: "do not echo me" }),
    ).toMatchObject({ status: 422 });
    const detail = (
      plane.handle("POST", "/api/v1/budgets/confirm", {
        private_prompt: "do not echo me",
      }).body as { detail: Array<Record<string, unknown>> }
    ).detail;
    expect(detail.every((issue) => Object.keys(issue).sort().join(",") === "loc,msg,type")).toBe(
      true,
    );
    expect(JSON.stringify(detail)).not.toContain("private_prompt");
    expect(JSON.stringify(detail)).not.toContain("do not echo me");
    expect(plane.confirms).toHaveLength(1);
  });

  it("isolates duplicate call ids across reservations and supports lease/XOR confirmation", async () => {
    const plane = await makePlane();
    plane.handle("POST", "/api/v1/budgets/check", checkBody());
    plane.handle("POST", "/api/v1/budgets/check", checkBody());
    const sharedCallId = "55555555-5555-5555-5555-555555555555";
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({ reservation_id: "res_fake_00000001", call_id: sharedCallId }),
      ).status,
    ).toBe(204);
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({ reservation_id: "res_fake_00000002", call_id: sharedCallId }),
      ).status,
    ).toBe(204);
    expect(plane.confirms).toHaveLength(1);
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({
          reservation_id: "res_fake_00000002",
          call_id: "66666666-6666-6666-6666-666666666666",
        }),
      ).status,
    ).toBe(204);
    expect(plane.confirms).toHaveLength(2);

    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({
          reservation_id: null,
          lease_id: "lease-1",
          call_id: "77777777-7777-7777-7777-777777777777",
        }),
      ).status,
    ).toBe(204);
    expect(plane.confirms).toHaveLength(3);
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({
          lease_id: "lease-1",
          call_id: "88888888-8888-8888-8888-888888888888",
        }),
      ).status,
    ).toBe(422);
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({
          reservation_id: null,
          call_id: "99999999-9999-9999-9999-999999999999",
        }),
      ).status,
    ).toBe(422);
    expect(plane.confirms).toHaveLength(3);
  });

  it("never copies user-controlled map keys into handle or fetch validation locations", async () => {
    const plane = await makePlane();
    const sentinel = "private_prompt_map_key";
    const invalid = checkBody({ tags: { [sentinel]: 123 } });

    const handled = plane.handle("POST", "/api/v1/budgets/check", invalid);
    expect(handled.status).toBe(422);
    expect(handled.body).toEqual({
      detail: [{ type: "invalid_type", loc: ["body"], msg: "Invalid value" }],
    });

    const fetched = await plane.fetch(`${plane.apiUrl}/api/v1/budgets/check`, {
      method: "POST",
      body: JSON.stringify(invalid),
    });
    expect(fetched.status).toBe(422);
    expect(await fetched.json()).toEqual(handled.body);
    expect(JSON.stringify(handled.body)).not.toContain(sentinel);
    expect(plane.checks).toEqual([]);
  });

  it("resetRecording preserves queues, replay state, runaway memory, and numbering", async () => {
    const plane = await makePlane();
    plane.handle("POST", "/api/v1/budgets/check", checkBody());
    expect(plane.handle("POST", "/api/v1/budgets/confirm", confirmBody()).status).toBe(204);
    const runaway = checkBody({ model: "solwyn-test/runaway", agent_run_id: "run-reset" });
    expect(plane.handle("POST", "/api/v1/budgets/check", runaway).body).toMatchObject({
      allowed: true,
      reservation_id: "res_fake_00000002",
    });
    plane.denyNext();
    plane.resetRecording();
    expect(plane.checks).toEqual([]);
    expect(plane.confirms).toEqual([]);
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({ call_id: "22222222-2222-2222-2222-222222222222" }),
      ).status,
    ).toBe(204);
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({ reservation_id: "res_fake_00000002" }),
      ).status,
    ).toBe(204);
    expect(plane.confirms).toEqual([]);
    expect(
      plane.handle(
        "POST",
        "/api/v1/budgets/confirm",
        confirmBody({
          reservation_id: "res_fake_00000002",
          call_id: "33333333-3333-3333-3333-333333333333",
        }),
      ).status,
    ).toBe(204);
    expect(plane.confirms).toHaveLength(1);
    expect(plane.handle("POST", "/api/v1/budgets/check", checkBody()).body).toMatchObject({
      allowed: false,
      denied_by_period: "monthly",
    });
    expect(plane.handle("POST", "/api/v1/budgets/check", runaway).body).toMatchObject({
      allowed: false,
      denied_by_period: "agent_run",
    });
    const next = plane.handle("POST", "/api/v1/budgets/check", checkBody());
    expect(next.body).toMatchObject({ reservation_id: "res_fake_00000003" });
  });

  it("never mutates configured usage while checks, confirms, and ingest traffic flow", async () => {
    const plane = await makePlane({ budgetLimit: 100, currentUsage: 40, remainingBudget: 60 });
    const first = plane.handle("POST", "/api/v1/budgets/check", checkBody());
    expect(first.body).toMatchObject({ current_usage: 40, remaining_budget: 60 });
    expect(plane.handle("POST", "/api/v1/budgets/confirm", confirmBody()).status).toBe(204);
    expect(
      plane.handle("POST", "/api/v1/metadata/ingest", [
        {
          model: "gpt-4o",
          provider: "openai",
          input_tokens: 1,
          output_tokens: 1,
          latency_ms: 1,
          status: "success",
          is_model_fallback: false,
          call_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          sdk_instance_id: "sdk-usage",
          timestamp: "2026-08-31T02:00:00Z",
        },
      ]).status,
    ).toBe(202);
    const second = plane.handle("POST", "/api/v1/budgets/check", checkBody());
    expect(second.body).toMatchObject({ current_usage: 40, remaining_budget: 60 });
  });
});
