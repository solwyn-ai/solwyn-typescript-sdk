/**
 * Refusal classification (status first, body second) and fixtures F6 and F6b: a 401 that does
 * not say exactly `alert_only` always blocks, and no 401 ever reaches the outage ladder.
 */
import { describe, expect, it, vi } from "vitest";
import { classify, refusalMessage } from "../../src/api-key-errors";
import { BudgetEnforcer } from "../../src/budget";
import { ApiKeyRefusedError } from "../../src/errors";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import { Transport, TransportHttpError } from "../../src/transport";
import { BudgetConfirmRequestSchema } from "../../src/validation";
import {
  authKeyResponse,
  TEST_API_KEY,
  TEST_API_URL,
  TEST_PROJECT,
  testBinding,
  unauthorized,
} from "../helpers/project-binding";

const SECRET = "secret-response-sentinel";
const AUTH_KEY_PATH = "/api/v1/auth/key";

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("classify", () => {
  it.each([
    [
      {
        code: "api_key_expired",
        project_budget_mode: "hard_deny",
        expired_at: "2026-11-01T09:00:00Z",
      },
      "api_key_expired",
      "hard_deny",
      "2026-11-01",
    ],
    [
      { code: "api_key_expired", project_budget_mode: "alert_only" },
      "api_key_expired",
      "alert_only",
      null,
    ],
    [
      { code: "api_key_invalid", project_budget_mode: "alert_only" },
      "api_key_invalid",
      "alert_only",
      null,
    ],
    [
      { code: "api_key_invalid", project_budget_mode: "ALERT_ONLY" },
      "api_key_invalid",
      "unknown",
      null,
    ],
    [{ code: "read_only_key" }, "api_key_invalid", "unknown", null],
  ] as const)("401 %j -> %s / %s", (detail, code, posture, expiredOn) => {
    expect(classify(401, json({ detail }))).toEqual({ code, posture, expiredOn });
  });

  it.each([
    [400, "project_selector_required"],
    [400, "project_selector_conflict"],
    [404, "project_not_found"],
    [403, "key_not_dedicated"],
    [403, "read_only_key"],
  ])("%i %s is a blocking refusal", (status, code) => {
    expect(classify(status, json({ detail: { code, message: SECRET } }))).toEqual({
      code,
      posture: "unknown",
      expiredOn: null,
    });
  });

  it.each([
    [403, json({ detail: { code: "api_key_not_allowed" } })],
    [403, json({ detail: { code: "permission_denied" } })],
    [404, json({ detail: "Not Found" })],
    [400, "not json"],
    [403, null],
    [409, json({ detail: { code: "project_not_found" } })],
    [500, json({ detail: { code: "api_key_invalid" } })],
  ])("%i without a recognised project code is not a refusal", (status, text) => {
    expect(classify(status, text)).toBeUndefined();
  });

  it("messages name the selector and never the body", () => {
    expect(
      refusalMessage({ code: "key_not_dedicated", posture: "unknown", expiredOn: null }, "billing"),
    ).toEqual({
      message:
        "Solwyn project 'billing' only accepts API keys dedicated to it, and this key also reaches other projects. Use a key that holds only this project.",
      field: "project",
    });
    expect(
      refusalMessage(
        { code: "project_selector_conflict", posture: "unknown", expiredOn: null },
        "x",
      ).message,
    ).toBe(
      "Solwyn refused the project header (project_selector_conflict). This is an SDK bug; please report it.",
    );
    expect(
      refusalMessage({ code: "api_key_invalid", posture: "unknown", expiredOn: null }, "x"),
    ).toEqual({
      message: "The Solwyn API key was not recognised or has been revoked.",
      field: "api_key",
    });
  });

  it("the transport keeps only the classified refusal, never the body", async () => {
    const transport = new Transport(TEST_API_URL, TEST_API_KEY, {
      fetch: async () =>
        new Response(json({ detail: { code: "read_only_key", message: SECRET } }), { status: 403 }),
    });
    const error = await transport
      .postJson("/write", {}, { timeoutMs: 100 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportHttpError);
    expect((error as TransportHttpError).refusal?.code).toBe("read_only_key");
    expect(String(error)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });
});

/** An enforcer that validated once, then sees `answer` on its next check. */
async function validatedThen(answer: () => Response | Promise<Response>) {
  let checks = 0;
  let auths = 0;
  const fetch = vi.fn(async (url: string) => {
    // The first validation succeeds; afterwards /auth/key reflects the refused key, as a real
    // server would, so the revalidation started at the 401 confirms the refusal.
    if (new URL(url).pathname === AUTH_KEY_PATH) {
      auths += 1;
      return auths === 1 ? authKeyResponse() : answer();
    }
    checks += 1;
    return checks === 1 ? answer() : new Response("unexpected", { status: 500 });
  });
  const budget = new BudgetEnforcer({
    apiUrl: TEST_API_URL,
    apiKey: TEST_API_KEY,
    project: TEST_PROJECT,
    fetch,
    failOpen: true,
    cacheTtl: 0,
    leaseEnabled: false,
  });
  await budget.binding.validate();
  expect(budget.binding.everValid).toBe(true);
  return { budget, checks: () => checks };
}

const CHECK = { estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" as const };

describe("F6 and F6b: a 401 without an exact alert_only posture blocks", () => {
  it.each([
    ["project_budget_mode null", { code: "api_key_expired", project_budget_mode: null }],
    ["project_budget_mode missing", { code: "api_key_expired" }],
    [
      "project_budget_mode unknown value",
      { code: "api_key_invalid", project_budget_mode: "soft_cap" },
    ],
  ])("F6: 401 with %s is blocked even after validating once", async (_label, detail) => {
    const { budget, checks } = await validatedThen(() => unauthorized(detail));
    await expect(budget.checkBudget(CHECK)).rejects.toBeInstanceOf(ApiKeyRefusedError);
    await expect(budget.checkBudget(CHECK)).rejects.toBeInstanceOf(ApiKeyRefusedError);
    expect(budget.binding.refusal).toMatchObject({ posture: "unknown", effect: "block" });
    expect(checks()).toBe(1);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["an empty body", ""],
    ["a string detail", json({ detail: "Invalid or revoked API key" })],
    ["a detail without code", json({ detail: { message: "x" } })],
    ["an unknown code", json({ detail: { code: "something_new" } })],
  ])("F6b: 401 with %s is api_key_invalid, posture unknown, blocked, never the outage ladder", async (_label, body) => {
    const { budget } = await validatedThen(() => new Response(body, { status: 401 }));
    const error = await budget.checkBudget(CHECK).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiKeyRefusedError);
    expect((error as ApiKeyRefusedError).code).toBe("api_key_invalid");
    expect(budget.binding.refusal).toMatchObject({
      code: "api_key_invalid",
      posture: "unknown",
      effect: "block",
    });
    // failOpen is on: an outage would have allowed. A local fail-open spend bucket stays empty.
    expect(budget.getLocalCurrentSpend()).toBe(0);
  });

  it("F6b: a 401 whose body cannot be read at all still refuses", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(SECRET));
      },
    });
    const { budget } = await validatedThen(() => new Response(broken, { status: 401 }));
    await expect(budget.checkBudget(CHECK)).rejects.toBeInstanceOf(ApiKeyRefusedError);
  });
});

describe("background writes treat a refusal as terminal", () => {
  it("drops a refused confirm without retry and without advancing the failure counter", async () => {
    let sends = 0;
    const binding = testBinding({
      fetch: async () => unauthorized({ code: "api_key_invalid", project_budget_mode: null }),
    });
    const reporter = new MetadataReporter(TEST_API_URL, TEST_API_KEY, {
      binding,
      fetch: async () => {
        sends += 1;
        return unauthorized({ code: "api_key_invalid", project_budget_mode: null });
      },
    });
    reporter.reportConfirm(
      BudgetConfirmRequestSchema.parse({
        reservation_id: "reservation-1",
        model: "gpt-4o",
        provider: "openai",
        call_id: "00000000-0000-0000-0000-000000000001",
        token_details: zeroTokenDetails(),
      }),
    );
    await reporter._flushRemaining();
    await reporter._flushRemaining();
    expect(sends).toBe(1);
    expect(reporter.confirmQueueSize).toBe(0);
    expect(binding.state).toBe("refused");
    await reporter.close(0);
  });
});
