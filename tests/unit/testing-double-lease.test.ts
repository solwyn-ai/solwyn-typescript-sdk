import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors";
import { FakeControlPlane } from "../../src/testing/index";

const GRANT_PATH = "/api/v1/budgets/lease";
const RENEW_PATH = "/api/v1/budgets/lease/renew";
const SURRENDER_PATH = "/api/v1/budgets/lease/surrender";

function surrender(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { lease_id: "lse_fake1", holder_id: "holder-1", generation: 1, ...overrides };
}

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_run_id: "run-1",
    holder_id: "holder-1",
    model: "gpt-4o",
    provider: "openai",
    fail_open: true,
    ...overrides,
  };
}

function renew(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lease_id: "lse_fake1",
    holder_id: "holder-1",
    generation: 1,
    spent_tokens: 0,
    reserved_tokens: 0,
    uncounted_calls: 0,
    uncounted_tokens: 0,
    ...overrides,
  };
}

function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { estimated_input_tokens: 1, model: "gpt-4o", provider: "openai", ...overrides };
}

async function post(plane: FakeControlPlane, path: string, body: unknown, signal?: AbortSignal) {
  return plane.fetch(`${plane.apiUrl}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

describe("FakeControlPlane lease surrender", () => {
  it("records parsed surrender requests and releases once without subtracting reported spend", () => {
    const plane = new FakeControlPlane({ grantedTokens: 100 });
    plane.handle("POST", GRANT_PATH, grant());
    expect(plane.handle("POST", SURRENDER_PATH, surrender({ spent_tokens: 23 }))).toEqual({
      status: 200,
      body: { released_tokens: 100 },
      headers: {},
    });
    expect(plane.handle("POST", SURRENDER_PATH, surrender())).toEqual({
      status: 200,
      body: { released_tokens: 0 },
      headers: {},
    });
    expect(plane.leaseSurrenders).toEqual([
      surrender({ spent_tokens: 23 }),
      surrender({ spent_tokens: 0 }),
    ]);
    expect(plane.handle("POST", RENEW_PATH, renew())).toMatchObject({
      status: 404,
      body: { detail: { code: "lease_not_found" } },
    });
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      status: 200,
      body: { lease_id: "lse_fake2", generation: 1 },
    });
    expect(plane.handle("POST", SURRENDER_PATH, surrender())).toMatchObject({
      status: 200,
      body: { released_tokens: 0 },
    });
    expect(plane.handle("POST", RENEW_PATH, renew({ lease_id: "lse_fake2" }))).toMatchObject({
      status: 200,
      body: { generation: 2 },
    });
  });

  it("records unknown leases and wrong holders without releasing another holder's lease", () => {
    const plane = new FakeControlPlane({ grantedTokens: 40 });
    plane.handle("POST", GRANT_PATH, grant());
    for (const body of [surrender({ lease_id: "missing" }), surrender({ holder_id: "other" })]) {
      expect(plane.handle("POST", SURRENDER_PATH, body)).toEqual({
        status: 404,
        body: { detail: { code: "lease_not_found", message: "Budget lease not found" } },
        headers: {},
      });
    }
    expect(plane.leaseSurrenders).toHaveLength(2);
    expect(plane.handle("POST", SURRENDER_PATH, surrender())).toMatchObject({
      body: { released_tokens: 40 },
    });
  });

  it.each([
    false,
    true,
  ])("fences stale surrender before checking expiry (expired=%s)", (expired) => {
    const plane = new FakeControlPlane({ grantedTokens: 40 });
    plane.handle("POST", GRANT_PATH, grant());
    plane.handle("POST", RENEW_PATH, renew());
    if (expired) plane.expireLeases();
    expect(plane.handle("POST", SURRENDER_PATH, surrender())).toEqual({
      status: 409,
      body: {
        detail: { code: "lease_generation_conflict", message: "Budget lease generation conflict" },
      },
      headers: {},
    });
    expect(plane.handle("POST", SURRENDER_PATH, surrender({ generation: 2 }))).toMatchObject({
      status: 200,
      body: { released_tokens: expired ? 0 : 40 },
    });
    expect(plane.leaseSurrenders).toHaveLength(2);
  });

  it.each([
    "solwyn-test/deny",
    "solwyn-test/deny-tag",
    "solwyn-test/lease-ineligible",
  ])("accepts the held generation's surrender after a terminal %s renewal", (model) => {
    const plane = new FakeControlPlane({ grantedTokens: 40 });
    plane.handle("POST", GRANT_PATH, grant());
    const terminal = plane.handle("POST", RENEW_PATH, renew({ model, provider: "openai" }));
    expect(terminal.status).toBe(200);
    expect(terminal.body).not.toHaveProperty("lease_id");
    // The successor carries no lease block, so the generation the SDK still holds is released.
    expect(plane.handle("POST", SURRENDER_PATH, surrender({ spent_tokens: 7 }))).toMatchObject({
      status: 200,
      body: { released_tokens: 40 },
    });
    expect(plane.handle("POST", SURRENDER_PATH, surrender({ generation: 2 }))).toMatchObject({
      status: 200,
      body: { released_tokens: 0 },
    });
    expect(plane.handle("POST", SURRENDER_PATH, surrender({ generation: 3 }))).toMatchObject({
      status: 409,
      body: { detail: { code: "lease_generation_conflict" } },
    });
    expect(plane.handle("POST", RENEW_PATH, renew())).toMatchObject({ status: 404 });
    // After that release, a grant for the same holder is a new lease, not a conflict.
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      status: 200,
      body: { lease_id: "lse_fake2", generation: 1 },
    });
  });

  it("rejects invalid surrender atomically without echoing or recording private fields", () => {
    const plane = new FakeControlPlane({ grantedTokens: 40 });
    plane.handle("POST", GRANT_PATH, grant());
    for (const invalid of [
      surrender({ private_prompt: "do not disclose this value" }),
      surrender({ generation: "private-generation-value" }),
      surrender({ spent_tokens: -1 }),
    ]) {
      const response = plane.handle("POST", SURRENDER_PATH, invalid);
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain("private_prompt");
      expect(JSON.stringify(response.body)).not.toContain("do not disclose this value");
      expect(JSON.stringify(response.body)).not.toContain("private-generation-value");
      expect(plane.leaseSurrenders).toEqual([]);
    }
    expect(plane.handle("POST", SURRENDER_PATH, surrender())).toMatchObject({
      status: 200,
      body: { released_tokens: 40 },
    });
  });

  it("clears surrender recordings while retaining active and released state and denial queues", () => {
    const plane = new FakeControlPlane({ grantedTokens: 40 });
    plane.handle("POST", GRANT_PATH, grant());
    plane.handle("POST", GRANT_PATH, grant({ holder_id: "holder-2" }));
    plane.denyNext(1, { scope: "check", period: "tag" });
    plane.denyNext(1, { scope: "lease", period: "agent_run" });
    expect(plane.handle("POST", SURRENDER_PATH, surrender())).toMatchObject({
      status: 200,
      body: { released_tokens: 40 },
    });
    plane.resetRecording();
    expect(plane.leaseSurrenders).toEqual([]);
    expect(plane.handle("POST", SURRENDER_PATH, surrender())).toMatchObject({
      body: { released_tokens: 0 },
    });
    expect(
      plane.handle(
        "POST",
        SURRENDER_PATH,
        surrender({ lease_id: "lse_fake2", holder_id: "holder-2" }),
      ),
    ).toMatchObject({ body: { released_tokens: 40 } });
    expect(plane.handle("POST", "/api/v1/budgets/check", check())).toMatchObject({
      body: { allowed: false, denied_by_period: "tag" },
    });
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      body: { allowed: false, denied_by_period: "agent_run" },
    });
  });

  it("refuses surrender before recording or mutation and recovers after exhaustion or end", async () => {
    const plane = new FakeControlPlane({ grantedTokens: 40 });
    plane.handle("POST", GRANT_PATH, grant());
    plane.refuseLeases({ requests: 2 });
    for (const body of [surrender(), { private_prompt: "secret" }]) {
      const response = await post(plane, SURRENDER_PATH, body);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        detail: {
          code: "lease_unavailable",
          message: "Budget lease service temporarily unavailable; retry",
        },
      });
      expect(plane.leaseSurrenders).toEqual([]);
    }
    const unbounded = plane.refuseLeases();
    expect(plane.handle("POST", SURRENDER_PATH, surrender()).status).toBe(503);
    unbounded.end();
    expect(plane.handle("POST", SURRENDER_PATH, surrender())).toMatchObject({
      status: 200,
      body: { released_tokens: 40 },
    });
  });

  it("leaves a grant-only holder-cap refusal unconsumed by surrender", async () => {
    const plane = new FakeControlPlane({ grantedTokens: 40 });
    plane.handle("POST", GRANT_PATH, grant());
    plane.refuseLeases({ status: 409, code: "lease_holder_cap_exceeded", requests: 1 });
    const released = await post(plane, SURRENDER_PATH, surrender());
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released_tokens: 40 });
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      status: 409,
      body: { detail: { code: "lease_holder_cap_exceeded" } },
    });
    expect(plane.leaseGrants).toHaveLength(1);
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      status: 200,
      body: { lease_id: "lse_fake2", generation: 1 },
    });
  });
});

describe("FakeControlPlane lease grant and renewal", () => {
  it("grants the complete configured lease population and records the parsed request", () => {
    const plane = new FakeControlPlane({
      mode: "alert_only",
      budgetLimit: 50,
      currentUsage: 4,
      finalGrant: true,
      grantedTokens: 0,
      projectId: "proj-test",
    });

    expect(plane.handle("POST", GRANT_PATH, grant({ fail_open: false }))).toEqual({
      status: 200,
      body: {
        eligible: true,
        allowed: true,
        lease_id: "lse_fake1",
        generation: 1,
        granted_tokens: 0,
        refresh_interval_s: 30,
        lease_length_s: 90,
        headroom_share_tokens: 0,
        posture: { mode: "alert_only", on_unreachable: "local_enforce" },
        final_grant: true,
        project_id: "proj-test",
        mode: "alert_only",
        budget_limit: 50,
        current_usage: 4,
        remaining_budget: 46,
      },
      headers: {},
    });
    expect(plane.leaseGrants).toEqual([expect.objectContaining(grant({ fail_open: false }))]);
  });

  it("replays identical active grants immutably but fences declaration or posture drift", () => {
    const plane = new FakeControlPlane();
    const first = plane.handle("POST", GRANT_PATH, grant());
    expect(first.status).toBe(200);
    (first.body as { granted_tokens: number }).granted_tokens = 999;

    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      status: 200,
      body: { lease_id: "lse_fake1", granted_tokens: 200_000 },
    });
    for (const drift of [grant({ model: "gpt-4.1" }), grant({ fail_open: false })]) {
      expect(plane.handle("POST", GRANT_PATH, drift)).toEqual({
        status: 409,
        body: {
          detail: {
            code: "lease_holder_cap_exceeded",
            message: "Active lease holder limit exceeded",
          },
        },
        headers: {},
      });
    }
    expect(plane.leaseGrants).toHaveLength(4);
  });

  it("renews exact holder leases, replays a lost predecessor response, and fences other generations", () => {
    const plane = new FakeControlPlane();
    plane.handle("POST", GRANT_PATH, grant());
    const successor = plane.handle("POST", RENEW_PATH, renew({ spent_tokens: 5 }));
    expect(successor).toMatchObject({
      status: 200,
      body: { lease_id: "lse_fake1", generation: 2 },
    });
    (successor.body as { generation: number }).generation = 400;

    expect(plane.handle("POST", RENEW_PATH, renew({ spent_tokens: 99 }))).toMatchObject({
      status: 200,
      body: { generation: 2 },
    });
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 2 }))).toMatchObject({
      status: 200,
      body: { generation: 3 },
    });
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 7 }))).toEqual({
      status: 409,
      body: {
        detail: { code: "lease_generation_conflict", message: "Budget lease generation conflict" },
      },
      headers: {},
    });
    expect(plane.handle("POST", RENEW_PATH, renew({ holder_id: "other", generation: 3 }))).toEqual({
      status: 404,
      body: { detail: { code: "lease_not_found", message: "Budget lease not found" } },
      headers: {},
    });
  });

  it("unions complete renewal declarations in order and ignores incomplete redeclarations", () => {
    const plane = new FakeControlPlane();
    plane.handle(
      "POST",
      GRANT_PATH,
      grant({
        fallback_providers: ["anthropic", "openai"],
        fallback_models: ["claude-3", "gpt-4o"],
      }),
    );
    expect(
      plane.handle("POST", RENEW_PATH, renew({ provider: "google", model: "gemini-2" })),
    ).toMatchObject({
      status: 200,
      body: { generation: 2 },
    });
    expect(
      plane.handle("POST", RENEW_PATH, renew({ generation: 2, model: "gpt-4.1" })),
    ).toMatchObject({
      status: 200,
      body: { generation: 3 },
    });
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({ status: 409 });
  });

  it("expires leases for renewal, regrants with a new identity, and only clears lease recordings on reset", () => {
    const plane = new FakeControlPlane();
    plane.handle("POST", GRANT_PATH, grant());
    plane.resetRecording();
    expect(plane.leaseGrants).toEqual([]);
    expect(plane.handle("POST", RENEW_PATH, renew())).toMatchObject({
      status: 200,
      body: { generation: 2 },
    });
    plane.expireLeases();
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 2 }))).toMatchObject({
      status: 404,
    });
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      status: 200,
      body: { lease_id: "lse_fake2", generation: 1 },
    });
    expect(plane.leaseRenewals).toHaveLength(2);
  });

  it("validates atomically and rejects unknown lease magic with typed errors before recording", () => {
    const plane = new FakeControlPlane();
    const invalid = plane.handle("POST", GRANT_PATH, grant({ private_prompt: "do not echo" }));
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(invalid.body)).not.toContain("do not echo");
    expect(plane.leaseGrants).toEqual([]);
    expect(() =>
      plane.handle("POST", GRANT_PATH, grant({ model: "solwyn-test/not-real" })),
    ).toThrow(ConfigurationError);
    expect(plane.leaseGrants).toEqual([]);
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      status: 200,
      body: { lease_id: "lse_fake1" },
    });
    expect(() =>
      plane.handle(
        "POST",
        RENEW_PATH,
        renew({ model: "solwyn-test/not-real", provider: "openai" }),
      ),
    ).toThrow(ConfigurationError);
    expect(plane.leaseRenewals).toEqual([]);

    plane.denyNext(1, { scope: "lease" });
    const invalidRenewal = plane.handle(
      "POST",
      RENEW_PATH,
      renew({ private_prompt: "never return this sensitive value" }),
    );
    expect(invalidRenewal.status).toBe(422);
    expect(JSON.stringify(invalidRenewal.body)).not.toContain("private_prompt");
    expect(JSON.stringify(invalidRenewal.body)).not.toContain("never return this sensitive value");
    expect(plane.leaseRenewals).toEqual([]);
    const malformedGeneration = plane.handle(
      "POST",
      RENEW_PATH,
      renew({ generation: "not-an-integer" as never }),
    );
    expect(malformedGeneration.status).toBe(422);
    expect(plane.leaseRenewals).toEqual([]);
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      body: { lease_id: "lse_fake1", generation: 1 },
    });

    const firstSuccessor = plane.handle("POST", RENEW_PATH, renew());
    expect(firstSuccessor).toMatchObject({
      status: 200,
      body: { eligible: true, allowed: false, denied_by_period: "monthly" },
    });
    expect(firstSuccessor.body).not.toHaveProperty("generation");
    expect(plane.leaseRenewals).toEqual([expect.objectContaining(renew())]);
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 2 }))).toMatchObject({
      status: 200,
      body: { allowed: true, generation: 3 },
    });
  });

  it("freezes lease effects before a slow abort and applies generic scenarios to both routes", async () => {
    vi.useFakeTimers();
    try {
      const plane = new FakeControlPlane();
      const slow = plane.slow(60, { path: GRANT_PATH, requests: 1 });
      const controller = new AbortController();
      const request = post(plane, GRANT_PATH, grant(), controller.signal);
      controller.abort();
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(plane.leaseGrants).toHaveLength(1);
      slow.end();

      const readOnly = plane.readOnly({ path: RENEW_PATH, requests: 1 });
      expect((await post(plane, RENEW_PATH, renew())).status).toBe(403);
      readOnly.end();
      const outage = plane.outage({ path: RENEW_PATH, requests: 1 });
      await expect(post(plane, RENEW_PATH, renew())).rejects.toThrow("fetch failed");
      outage.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns authority-free hard denials and lease ineligibility without consuming check scripts", () => {
    const plane = new FakeControlPlane({ remainingBudget: -4 });
    plane.denyNext();
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      status: 200,
      body: { eligible: true, allowed: true, lease_id: "lse_fake1" },
    });
    expect(plane.handle("POST", "/api/v1/budgets/check", check())).toMatchObject({
      status: 200,
      body: { allowed: false, denied_by_period: "monthly" },
    });
    expect(
      plane.handle("POST", GRANT_PATH, grant({ agent_run_id: "run-2", model: "solwyn-test/deny" })),
    ).toEqual({
      status: 200,
      body: {
        eligible: true,
        allowed: false,
        denied_by_period: "monthly",
        project_id: "proj_fake",
        mode: "hard_deny",
        budget_limit: 100,
        current_usage: 0,
        remaining_budget: 0,
      },
      headers: {},
    });
    expect(
      plane.handle(
        "POST",
        GRANT_PATH,
        grant({ agent_run_id: "run-3", model: "solwyn-test/lease-ineligible" }),
      ),
    ).toMatchObject({
      status: 200,
      body: { eligible: false, allowed: true, ineligible_reason: "zero_rate_model" },
    });
  });

  it("keeps check and lease denial scripts isolated, FIFO, and reset-safe", () => {
    const plane = new FakeControlPlane();
    plane.denyNext(1, { scope: "lease", period: "monthly" });
    plane.denyNext(1, { scope: "lease", period: "agent_run" });
    plane.denyNext(1, { scope: "check", period: "tag" });

    expect(plane.handle("POST", "/api/v1/budgets/check", check())).toMatchObject({
      body: { allowed: false, denied_by_period: "tag" },
    });
    plane.resetRecording();
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      body: { eligible: true, allowed: false, denied_by_period: "monthly", mode: "hard_deny" },
    });
    expect(plane.handle("POST", GRANT_PATH, grant({ holder_id: "holder-2" }))).toMatchObject({
      body: { eligible: true, allowed: false, denied_by_period: "agent_run" },
    });
    expect(plane.leaseGrants).toHaveLength(2);
    expect(plane.handle("POST", "/api/v1/budgets/check", check())).toMatchObject({
      body: { allowed: true },
    });

    plane.denyNext(1, { scope: "lease" });
    plane.denyNext(1, { scope: "check" });
    plane.clearDenials();
    expect(plane.handle("POST", GRANT_PATH, grant({ holder_id: "holder-3" }))).toMatchObject({
      body: { allowed: true, lease_id: "lse_fake1" },
    });
    expect(plane.handle("POST", "/api/v1/budgets/check", check())).toMatchObject({
      body: { allowed: true },
    });
  });

  it("does not spend a lease denial on grant replay or renewal replay", () => {
    const plane = new FakeControlPlane();
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({ body: { allowed: true } });
    plane.denyNext(1, { scope: "lease" });
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({ body: { allowed: true } });

    expect(plane.handle("POST", RENEW_PATH, renew())).toMatchObject({
      body: { allowed: false, denied_by_period: "monthly" },
    });
    plane.denyNext(1, { scope: "lease" });
    expect(plane.handle("POST", RENEW_PATH, renew())).toMatchObject({
      body: { allowed: false, denied_by_period: "monthly" },
    });
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 2 }))).toMatchObject({
      body: { allowed: false, denied_by_period: "monthly" },
    });
  });

  it("rejects invalid lease denial scripts atomically", () => {
    const plane = new FakeControlPlane();
    for (const script of [
      () => plane.denyNext(-1, { scope: "lease" }),
      () => plane.denyNext(0, { scope: "unknown" as never }),
      () => plane.denyNext(0, { period: "unknown" as never }),
      () => plane.denyNext(0, { scope: "lease", period: "tag" }),
    ]) {
      expect(script).toThrow(ConfigurationError);
      expect(script).toThrow(/^solwyn\.testing:/);
    }
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({ body: { allowed: true } });
  });

  it("refuses direct and schema-invalid lease requests without recording or mutating scripts", async () => {
    const plane = new FakeControlPlane();
    plane.denyNext(1, { scope: "lease" });
    const unavailable = plane.refuseLeases({ requests: 2 });
    expect(plane.handle("POST", GRANT_PATH, grant())).toEqual({
      status: 503,
      body: {
        detail: {
          code: "lease_unavailable",
          message: "Budget lease service temporarily unavailable; retry",
        },
      },
      headers: {},
    });
    const malformed = await plane.fetch(`${plane.apiUrl}${GRANT_PATH}`, {
      method: "POST",
      body: '{"private_prompt":"secret"',
    });
    expect(malformed.status).toBe(422);
    const refused = await post(plane, GRANT_PATH, { private_prompt: "secret" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      detail: {
        code: "lease_unavailable",
        message: "Budget lease service temporarily unavailable; retry",
      },
    });
    expect(plane.leaseGrants).toEqual([]);
    unavailable.end();
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
      body: { allowed: false, denied_by_period: "monthly" },
    });
  });

  it("limits holder-cap refusals to grants and preserves lease renewal", async () => {
    const plane = new FakeControlPlane();
    expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({ body: { generation: 1 } });
    const unavailable = plane.refuseLeases({ requests: 1 });
    expect((await post(plane, RENEW_PATH, renew())).status).toBe(503);
    unavailable.end();
    const cap = plane.refuseLeases({ status: 409, code: "lease_holder_cap_exceeded", requests: 1 });
    expect((await post(plane, RENEW_PATH, renew())).status).toBe(200);
    const refused = await post(plane, GRANT_PATH, grant({ holder_id: "holder-2" }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      detail: { code: "lease_holder_cap_exceeded", message: "Active lease holder limit exceeded" },
    });
    cap.end();
  });

  it("validates lease refusal inputs before creating a usable window", async () => {
    const plane = new FakeControlPlane();
    for (const [options, field] of [
      [{ status: 503, code: "lease_holder_cap_exceeded" }, "code"],
      [{ status: 409, code: "lease_unavailable" }, "code"],
      [{ status: 500, code: "lease_unavailable" }, "status"],
      [{ code: "not-real" }, "code"],
      [{ requests: -1 }, "requests"],
      [{ requests: 0.5 }, "requests"],
    ]) {
      let thrown: unknown;
      try {
        plane.refuseLeases(options as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigurationError);
      expect((thrown as ConfigurationError).field).toBe(field);
      expect((thrown as Error).message).toMatch(/^solwyn\.testing:/);
    }
    const empty = plane.refuseLeases({ requests: 0 });
    expect((await post(plane, GRANT_PATH, grant())).status).toBe(200);
    empty.end();
  });

  it("freezes a lease refusal before delay and lets the bounded window recover", async () => {
    vi.useFakeTimers();
    try {
      const plane = new FakeControlPlane();
      const slow = plane.slow(0.01, { path: GRANT_PATH, requests: 1 });
      const refusal = plane.refuseLeases({ requests: 1 });
      const pending = post(plane, GRANT_PATH, grant());
      slow.end();
      refusal.end();
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ status: 503 });
      expect((await post(plane, GRANT_PATH, grant())).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a lease outage win without spending a lease refusal", async () => {
    const plane = new FakeControlPlane();
    const refusal = plane.refuseLeases({ requests: 1 });
    const outage = plane.outage({ path: GRANT_PATH, requests: 1 });
    await expect(post(plane, GRANT_PATH, grant())).rejects.toThrow("fetch failed");
    expect((await post(plane, GRANT_PATH, grant())).status).toBe(503);
    refusal.end();
    outage.end();
  });

  it("does not spend a lease refusal on non-lease endpoints", async () => {
    const plane = new FakeControlPlane();
    const refusal = plane.refuseLeases({ requests: 1 });
    expect((await post(plane, "/api/v1/budgets/check", check())).status).toBe(200);
    expect(
      (
        await post(plane, "/api/v1/budgets/confirm", {
          reservation_id: "res_fake_unknown",
          model: "gpt-4o",
          provider: "openai",
          call_id: "00000000-0000-0000-0000-000000000000",
          token_details: {
            input_tokens: 1,
            output_tokens: 1,
            cached_input_tokens: 0,
            reasoning_tokens: 0,
            audio_input_tokens: 0,
            audio_output_tokens: 0,
          },
        })
      ).status,
    ).toBe(404);
    expect((await post(plane, "/api/v1/metadata/ingest", [])).status).toBe(202);
    expect((await post(plane, GRANT_PATH, grant())).status).toBe(503);
    refusal.end();
  });

  it("gives denyRun and first magic precedence over lease eligibility and tag ineligibility", () => {
    const plane = new FakeControlPlane({ leaseEligible: false });
    plane.denyRun("run-1");
    expect(
      plane.handle("POST", GRANT_PATH, grant({ model: "solwyn-test/deny-tag" })),
    ).toMatchObject({
      status: 200,
      body: { eligible: true, allowed: false, denied_by_period: "agent_run", mode: "hard_deny" },
    });
    expect(
      plane.handle(
        "POST",
        GRANT_PATH,
        grant({ agent_run_id: "run-2", model: "solwyn-test/deny-tag" }),
      ),
    ).toMatchObject({
      status: 200,
      body: { eligible: false, allowed: true, ineligible_reason: "scoped_rules_present" },
    });
  });

  it("keeps ordinary and directive terminal successors frozen, fences grant replay, and recovers", () => {
    for (const scenario of [
      {
        renewRequest: renew({ model: "solwyn-test/deny", provider: "openai" }),
        expectedBody: { allowed: false },
        prepare: (_plane: FakeControlPlane) => {},
        recover: (_plane: FakeControlPlane) => {},
      },
      {
        renewRequest: renew({ run_directive_version: "1" }),
        expectedBody: {
          allowed: false,
          run_control: { agent_run_id: "run-1", reason: "manual_kill" },
        },
        prepare: (plane: FakeControlPlane) => plane.stopRun("run-1"),
        recover: (plane: FakeControlPlane) => plane.clearStop("run-1"),
      },
    ]) {
      const plane = new FakeControlPlane();
      plane.handle("POST", GRANT_PATH, grant());
      scenario.prepare(plane);
      const terminal = plane.handle("POST", RENEW_PATH, scenario.renewRequest);
      expect(terminal).toMatchObject({ status: 200, body: scenario.expectedBody });
      expect(terminal.body).not.toHaveProperty("generation");
      const frozenTerminalBody = structuredClone(terminal.body);
      const mutableTerminalBody = terminal.body as {
        allowed: boolean;
        run_control?: { agent_run_id: string; reason: string };
      };
      mutableTerminalBody.allowed = true;
      if (mutableTerminalBody.run_control !== undefined) {
        mutableTerminalBody.run_control.reason = "mutated-by-caller";
      }
      expect(
        plane.handle("POST", RENEW_PATH, { ...scenario.renewRequest, spent_tokens: 99 }),
      ).toEqual({ status: 200, body: frozenTerminalBody, headers: {} });
      expect(plane.handle("POST", GRANT_PATH, grant())).toMatchObject({
        status: 409,
        body: { detail: { code: "lease_generation_conflict" } },
      });
      scenario.recover(plane);
      expect(plane.handle("POST", RENEW_PATH, renew({ generation: 2 }))).toMatchObject({
        status: 200,
        body: { allowed: true, generation: 3 },
      });
    }
  });

  it("evaluates renewals over the declared union and honors runaway across grant and renewal", () => {
    const plane = new FakeControlPlane();
    plane.handle("POST", GRANT_PATH, grant({ model: "solwyn-test/runaway" }));
    expect(plane.handle("POST", RENEW_PATH, renew())).toMatchObject({
      status: 200,
      body: { allowed: false, denied_by_period: "agent_run" },
    });
    expect(plane.handle("POST", RENEW_PATH, renew({ generation: 2 }))).toMatchObject({
      status: 200,
      body: { allowed: false, denied_by_period: "agent_run" },
    });
  });
});
