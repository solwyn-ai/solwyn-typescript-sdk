import { beforeEach, describe, expect, it } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import type { Logger } from "../../src/logging";
import { handleReadOnlyKeyError, resetReadOnlyKeyDiagnosticForTest } from "../../src/read-only-key";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import { Transport, TransportHttpError } from "../../src/transport";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const SECRET = "secret-response-sentinel";
const DIAGNOSTIC =
  "solwyn.configuration_error.read_only_key: the configured API key is read-only; use a full-scope project key for SDK budget enforcement and metadata reporting";

interface CapturedLogger {
  logger: Logger;
  debug: string[];
  info: string[];
  warn: string[];
  error: string[];
}

function capturingLogger(): CapturedLogger {
  const captured: CapturedLogger = {
    debug: [],
    info: [],
    warn: [],
    error: [],
    logger: {
      debug: (message) => captured.debug.push(message),
      info: (message) => captured.info.push(message),
      warn: (message) => captured.warn.push(message),
      error: (message) => captured.error.push(message),
    },
  };
  return captured;
}

function throwingErrorLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {
      throw new Error("logger sink failed");
    },
  };
}

function readOnlyResponse(status = 403, body: unknown = { detail: { code: "read_only_key" } }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeConfirm(): BudgetConfirmRequest {
  return BudgetConfirmRequestSchema.parse({
    reservation_id: "reservation-1",
    model: "gpt-4o",
    provider: "openai",
    call_id: "00000000-0000-0000-0000-000000000001",
    token_details: zeroTokenDetails(),
  });
}

function makeEvent(): MetadataEvent {
  return MetadataEventSchema.parse({
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 1,
    output_tokens: 1,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: "00000000-0000-0000-0000-000000000001",
    sdk_instance_id: "sdk-1",
    timestamp: "2026-08-14T00:00:00Z",
  });
}

beforeEach(() => resetReadOnlyKeyDiagnosticForTest());

describe("privacy-safe read-only-key recognition", () => {
  it.each([
    [403, { detail: { code: "read_only_key", message: SECRET } }, true],
    [401, { detail: { code: "read_only_key" } }, false],
    [403, { code: "read_only_key" }, false],
    [403, { detail: { code: "permission_denied" } }, false],
    [403, { detail: "read_only_key" }, false],
  ])("recognizes only the exact sanitized contract: status=%i body=%j", async (status, body, expected) => {
    const transport = new Transport(API_URL, API_KEY, {
      fetch: async () => readOnlyResponse(status, body),
    });

    const error = await transport
      .postJson("/write", {}, { timeoutMs: 100 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransportHttpError);
    expect(handleReadOnlyKeyError(error, capturingLogger().logger)).toBe(expected);
    expect(String(error)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect((error as Record<string, unknown>)["response"]).toBeUndefined();
    expect((error as Record<string, unknown>)["body"]).toBeUndefined();
    expect((error as Record<string, unknown>)["detail"]).toBeUndefined();
  });

  it.each(["not-json", "null", "[]"])("rejects malformed or non-object JSON: %s", async (body) => {
    const transport = new Transport(API_URL, API_KEY, {
      fetch: async () => new Response(body, { status: 403 }),
    });
    const error = await transport
      .postJson("/write", {}, { timeoutMs: 100 })
      .catch((caught: unknown) => caught);
    expect(handleReadOnlyKeyError(error, capturingLogger().logger)).toBe(false);
  });

  it("logs exactly once per process while returning true for every match", () => {
    const log = capturingLogger();
    const error = new TransportHttpError(403, "read_only_key");

    expect(handleReadOnlyKeyError(error, log.logger)).toBe(true);
    expect(handleReadOnlyKeyError(error, log.logger)).toBe(true);
    expect(log.error).toEqual([DIAGNOSTIC]);
  });
});

describe("read-only-key behavior across control-plane writes", () => {
  it("keeps budget-check read-only handling terminal when the diagnostic logger throws", async () => {
    const budget = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: async () => readOnlyResponse(),
      logger: throwingErrorLogger(),
    });

    await expect(
      budget.checkBudget({
        estimatedInputTokens: 1,
        model: "gpt-4o",
        provider: "openai",
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("drains reportConfirm read-only work when the diagnostic logger throws", async () => {
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: async () => readOnlyResponse(),
      logger: throwingErrorLogger(),
    });
    reporter.reportConfirm(makeConfirm());

    await expect(reporter._flushRemaining()).resolves.toBe(false);
    expect(reporter.confirmQueueSize).toBe(0);
  });

  it("continues a read-only settlement to metadata when the diagnostic logger throws", async () => {
    const urls: string[] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: async (url) => {
        urls.push(url);
        if (url.endsWith("/budgets/confirm")) {
          return readOnlyResponse();
        }
        return new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 });
      },
      logger: throwingErrorLogger(),
    });
    reporter.reportSettlement(makeConfirm(), makeEvent());

    await expect(reporter._flushRemaining()).resolves.toBe(true);
    expect(urls).toEqual([
      `${API_URL}/api/v1/budgets/confirm`,
      `${API_URL}/api/v1/metadata/ingest`,
    ]);
    expect(reporter.settlementQueueSize).toBe(0);
  });

  it("ends a breaker-report cycle on read-only when the diagnostic logger throws", async () => {
    let sends = 0;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch: async () => {
        sends += 1;
        return readOnlyResponse();
      },
      logger: throwingErrorLogger(),
      sdkInstanceId: "sdk-1",
      breakerSnapshots: () => [
        [
          "openai",
          {
            state: "closed",
            failureCount: 0,
            successCount: 0,
            lastFailureTime: null,
            lastStateChange: 0,
            recoveryEligible: false,
          },
        ],
        [
          "anthropic",
          {
            state: "closed",
            failureCount: 0,
            successCount: 0,
            lastFailureTime: null,
            lastStateChange: 0,
            recoveryEligible: false,
          },
        ],
      ],
    });
    reporter.observeProjectId(`proj_${"0".repeat(24)}`);

    await expect(reporter._startBreakerCycle()).resolves.toBeUndefined();
    expect(sends).toBe(1);
  });

  it("shares the once-only diagnostic across check, confirm, metadata, and breaker writes", async () => {
    const log = capturingLogger();
    const fetch = async () =>
      readOnlyResponse(403, { detail: { code: "read_only_key", message: SECRET } });
    const budget = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch,
      logger: log.logger,
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      fetch,
      logger: log.logger,
      sdkInstanceId: "sdk-1",
      breakerSnapshots: () => [
        [
          "openai",
          {
            state: "closed",
            failureCount: 0,
            successCount: 0,
            lastFailureTime: null,
            lastStateChange: 0,
            recoveryEligible: false,
          },
        ],
      ],
    });

    const result = await budget.checkBudget({
      estimatedInputTokens: 1,
      model: "gpt-4o",
      provider: "openai",
    });
    await reporter._sendConfirm(makeConfirm());
    await reporter._sendBatch([makeEvent()]);
    reporter.observeProjectId(`proj_${"0".repeat(24)}`);
    await reporter._startBreakerCycle();

    expect(result.allowed).toBe(true);
    expect(log.error).toEqual([DIAGNOSTIC]);
    expect(log.warn).toEqual([]);
    expect([...log.debug, ...log.info, ...log.warn, ...log.error].join("\n")).not.toContain(SECRET);
  });

  it("does not advance the reporter confirm-failure counter", async () => {
    const log = capturingLogger();
    let request = 0;
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      logger: log.logger,
      fetch: async () => {
        request += 1;
        if (request === 10) {
          return readOnlyResponse();
        }
        return new Response("", { status: 500 });
      },
    });

    for (let index = 0; index < 11; index += 1) {
      await reporter._sendConfirm(makeConfirm());
    }

    expect(log.warn).toHaveLength(9);
    expect(log.error).toEqual([
      DIAGNOSTIC,
      "reporter.confirm_send_persistent_failure: exc_type=TransportHttpError consecutive_failures=10",
    ]);
  });
});
