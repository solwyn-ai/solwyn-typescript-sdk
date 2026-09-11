import { describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, type BudgetEnforcerOptions } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import type { Logger } from "../../src/logging";
import { MetadataReporter, type MetadataReporterOptions } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";
import type { BudgetConfirmRequest } from "../../src/types";
import { BudgetConfirmRequestSchema } from "../../src/validation";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;

function loggerSpies(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function transitionThrowingLogger(enabled: () => boolean = () => true): Logger {
  const maybeThrow = (message: string): void => {
    if (enabled() && message.startsWith("Circuit breaker [")) {
      throw new Error("transition logger failed");
    }
  };
  return {
    debug: () => {},
    info: maybeThrow,
    warn: maybeThrow,
    error: () => {},
  };
}

function diagnosticThrowingLogger(level: "debug" | "warn" | "error"): Logger {
  const throwSink = (): never => {
    throw new Error(`${level} logger failed`);
  };
  return {
    debug: level === "debug" ? throwSink : vi.fn(),
    info: vi.fn(),
    warn: level === "warn" ? throwSink : vi.fn(),
    error: level === "error" ? throwSink : vi.fn(),
  };
}

function allowResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      allowed: true,
      remaining_budget: 100,
      reservation_id: "reservation-1",
      mode: "alert_only",
      budget_limit: 100,
      current_usage: 0,
      project_id: `proj_${"0".repeat(24)}`,
      price_hints: null,
      ...overrides,
    }),
    { status: 200 },
  );
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

function budgetWithBreaker(
  breaker: CircuitBreaker | null,
  options: Omit<BudgetEnforcerOptions, "apiUrl" | "apiKey"> = {},
): BudgetEnforcer {
  const withBreaker = {
    apiUrl: API_URL,
    apiKey: API_KEY,
    ...options,
    controlPlaneBreaker: breaker,
  } as BudgetEnforcerOptions & { controlPlaneBreaker: CircuitBreaker | null };
  return new BudgetEnforcer(withBreaker);
}

function reporterWithBreaker(
  breaker: CircuitBreaker | null,
  options: MetadataReporterOptions = {},
): MetadataReporter {
  const withBreaker = {
    ...options,
    controlPlaneBreaker: breaker,
  } as MetadataReporterOptions & { controlPlaneBreaker: CircuitBreaker | null };
  return new MetadataReporter(API_URL, API_KEY, withBreaker);
}

describe("budget-check breaker admission and taxonomy", () => {
  it("throwing budget diagnostic: breaker-open debug stays fail-open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: "control-plane" });
    breaker.recordFailure();
    const fetch = vi.fn(async () => allowResponse());
    const budget = budgetWithBreaker(breaker, {
      failOpen: true,
      fetch,
      logger: diagnosticThrowingLogger("debug"),
    });

    await expect(
      budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throwing budget diagnostic: network warning preserves fail-closed posture", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, name: "control-plane" });
    const budget = budgetWithBreaker(breaker, {
      failOpen: false,
      fetch: () => Promise.reject(new TypeError("offline private detail")),
      logger: diagnosticThrowingLogger("warn"),
    });

    await expect(
      budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" }),
    ).resolves.toMatchObject({
      allowed: false,
      warning: "Cloud unreachable and no prior budget limit known; denying request (fail-closed)",
    });
    expect(breaker.getState()).toMatchObject({ state: "closed", failureCount: 1 });
  });

  it("throwing budget diagnostic: invalid 2xx error preserves drift accounting and outage posture", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, name: "control-plane" });
    breaker.recordFailure();
    const budget = budgetWithBreaker(breaker, {
      failOpen: true,
      fetch: async () =>
        new Response(JSON.stringify({ allowed: "not-a-boolean" }), { status: 200 }),
      logger: diagnosticThrowingLogger("error"),
    });

    await expect(
      budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" }),
    ).resolves.toMatchObject({
      allowed: true,
      warning: "Cloud API unreachable; proceeding in fail-open mode",
    });
    expect(breaker.getState()).toMatchObject({ state: "closed", failureCount: 0 });
  });

  it("budget body consumption: a stalled 200 body times out into outage posture", async () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker({ failureThreshold: 1, name: "control-plane" });
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = () =>
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            if (signal?.aborted) {
              fail();
            } else {
              signal?.addEventListener("abort", fail, { once: true });
            }
          },
        });
        return new Response(body, { status: 200 });
      });
      const budget = budgetWithBreaker(breaker, { failOpen: false, fetch });
      const check = budget.checkBudget({
        estimatedInputTokens: 1,
        model: "gpt-4o",
        provider: "openai",
        timeout: 0.01,
      });
      const outcome = Promise.race([
        check.then((result) => ({ kind: "result" as const, result })),
        new Promise<{ kind: "watchdog" }>((resolve) => {
          setTimeout(() => resolve({ kind: "watchdog" }), 11);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(11);

      await expect(outcome).resolves.toMatchObject({
        kind: "result",
        result: {
          allowed: false,
          warning:
            "Cloud unreachable and no prior budget limit known; denying request (fail-closed)",
        },
      });
      expect(breaker.getState()).toMatchObject({ state: "open", failureCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("budget body consumption: an errored 200 body is a transport outage", async () => {
    const logger = loggerSpies();
    const breaker = new CircuitBreaker({ failureThreshold: 2, name: "control-plane" });
    const budget = budgetWithBreaker(breaker, {
      failOpen: true,
      logger,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError("private response body I/O detail"));
            },
          }),
          { status: 200 },
        ),
    });

    await expect(
      budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" }),
    ).resolves.toMatchObject({ allowed: true });
    expect(breaker.getState()).toMatchObject({ state: "closed", failureCount: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Cloud API budget check failed: %s",
      "TransportNetworkError",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{", "SyntaxError"],
    ["invalid schema", JSON.stringify({ allowed: "not-a-boolean" }), "ZodError"],
  ])("budget body consumption: completed 200 %s remains contract drift", async (_label, body, errorName) => {
    const logger = loggerSpies();
    const breaker = new CircuitBreaker({ failureThreshold: 2, name: "control-plane" });
    breaker.recordFailure();
    const budget = budgetWithBreaker(breaker, {
      failOpen: true,
      logger,
      fetch: async () => new Response(body, { status: 200 }),
    });

    await expect(
      budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" }),
    ).resolves.toMatchObject({ allowed: true });
    expect(breaker.getState()).toMatchObject({ state: "closed", failureCount: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      "budget.check_response_unreadable: %s — possible server contract drift; enforcement degraded (fail_open=%s)",
      errorName,
      true,
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Cloud API budget check failed: %s",
      expect.anything(),
    );
  });

  it("preserves fail-open enforcement when the threshold-open diagnostic logger throws", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      name: "control-plane",
      logger: transitionThrowingLogger(),
    });
    const fetch = vi.fn(async () => new Response("", { status: 500 }));
    const budget = budgetWithBreaker(breaker, { fetch, failOpen: true });

    await expect(
      budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" }),
    ).resolves.toMatchObject({ allowed: true });
    expect(breaker.getState().state).toBe("open");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [true, true],
    [false, false],
  ])("open breaker short-circuits with the configured outage posture (failOpen=%s)", async (failOpen, allowed) => {
    const logger = loggerSpies();
    const fetch = vi.fn(async () => allowResponse());
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: "control-plane" });
    breaker.recordFailure();
    const budget = budgetWithBreaker(breaker, { failOpen, fetch, logger });

    const result = await budget.checkBudget({
      estimatedInputTokens: 1,
      model: "gpt-4o",
      provider: "openai",
    });

    expect(result.allowed).toBe(allowed);
    expect(fetch).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith("budget.check_skipped_breaker_open");
  });

  it("preserves a sticky hard deny while the breaker is open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: "control-plane" });
    const responses = [
      allowResponse({
        allowed: false,
        remaining_budget: 0,
        reservation_id: null,
        mode: "hard_deny",
        budget_limit: 10,
        current_usage: 10,
        denied_by_period: "monthly",
      }),
    ];
    const fetch = vi.fn(async () => responses.shift() ?? allowResponse());
    const budget = budgetWithBreaker(breaker, { failOpen: true, fetch });
    expect(
      (await budget.checkBudget({ estimatedInputTokens: 1, model: "deny", provider: "openai" }))
        .allowed,
    ).toBe(false);
    breaker.recordFailure();

    const replay = await budget.checkBudget({
      estimatedInputTokens: 1,
      model: "other",
      provider: "openai",
    });

    expect(replay.allowed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("admits one recovery probe and a 2xx success closes it", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 30,
      successThreshold: 1,
      name: "control-plane",
      now: () => now,
    });
    breaker.recordFailure();
    now = 30_000;
    const fetch = vi.fn(async () => allowResponse());
    const budget = budgetWithBreaker(breaker, { fetch });

    expect(
      (await budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" }))
        .allowed,
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(breaker.getState().state).toBe("closed");
  });

  it("credits exact read-only 403 and keeps the breaker closed", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, name: "control-plane" });
    const budget = budgetWithBreaker(breaker, {
      fetch: async () =>
        new Response(JSON.stringify({ detail: { code: "read_only_key" } }), { status: 403 }),
    });

    await budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" });

    expect(breaker.getState()).toMatchObject({ state: "closed", failureCount: 0 });
  });

  it("counts transport failures but credits 2xx schema drift, with distinct log levels", async () => {
    const logger = loggerSpies();
    const breaker = new CircuitBreaker({ failureThreshold: 2, name: "control-plane" });
    let response: "outage" | "drift" = "outage";
    const budget = budgetWithBreaker(breaker, {
      logger,
      fetch: async () => {
        if (response === "outage") throw new TypeError("offline secret");
        return new Response(JSON.stringify({ allowed: "not-a-boolean" }), { status: 200 });
      },
      cacheTtl: 0,
    });

    await budget.checkBudget({ estimatedInputTokens: 1, model: "outage", provider: "openai" });
    expect(breaker.getState().failureCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Cloud API budget check failed: %s",
      "TransportNetworkError",
    );

    response = "drift";
    await budget.checkBudget({ estimatedInputTokens: 1, model: "drift", provider: "openai" });
    expect(breaker.getState()).toMatchObject({ state: "closed", failureCount: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      "budget.check_response_unreadable: %s — possible server contract drift; enforcement degraded (fail_open=%s)",
      "ZodError",
      true,
    );
  });

  it("a thrown verdict releases a half-open probe for the next recovery attempt", async () => {
    let now = 0;
    class ThrowOnceBreaker extends CircuitBreaker {
      private throwOnce = true;

      override recordSuccess(): void {
        if (this.throwOnce) {
          this.throwOnce = false;
          throw new Error("verdict failed");
        }
        super.recordSuccess();
      }
    }
    const breaker = new ThrowOnceBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      name: "control-plane",
      now: () => now,
    });
    breaker.recordFailure();
    now = 1000;
    const budget = budgetWithBreaker(breaker, {
      fetch: async () => allowResponse(),
      cacheTtl: 0,
    });

    await expect(
      budget.checkBudget({ estimatedInputTokens: 1, model: "first", provider: "openai" }),
    ).rejects.toThrow("verdict failed");
    await expect(
      budget.checkBudget({ estimatedInputTokens: 1, model: "second", provider: "openai" }),
    ).resolves.toMatchObject({ allowed: true });
    expect(breaker.getState().state).toBe("closed");
  });

  it("a null breaker never short-circuits repeated failures", async () => {
    const fetch = vi.fn(async () => Promise.reject(new TypeError("offline")));
    const budget = budgetWithBreaker(null, { fetch, cacheTtl: 0 });
    for (let index = 0; index < 4; index += 1) {
      await budget.checkBudget({
        estimatedInputTokens: 1,
        model: `m-${index}`,
        provider: "openai",
      });
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("shared budget-check and confirm breaker", () => {
  it("completes a half-open confirm recovery when transition diagnostics throw", async () => {
    let now = 0;
    let diagnosticsThrow = false;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 1,
      successThreshold: 1,
      name: "control-plane",
      logger: transitionThrowingLogger(() => diagnosticsThrow),
      now: () => now,
    });
    breaker.recordFailure();
    now = 1000;
    diagnosticsThrow = true;
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const reporter = reporterWithBreaker(breaker, { fetch });

    await expect(reporter._sendConfirm(makeConfirm())).resolves.toBe("sent");
    expect(breaker.getState().state).toBe("closed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("combines one check failure and one confirm failure into the same threshold", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, name: "control-plane" });
    const fetch = vi.fn(async () => new Response("", { status: 500 }));
    const budget = budgetWithBreaker(breaker, { fetch, cacheTtl: 0 });
    const reporter = reporterWithBreaker(breaker, { fetch });

    await budget.checkBudget({ estimatedInputTokens: 1, model: "gpt-4o", provider: "openai" });
    expect(breaker.getState().state).toBe("closed");
    await reporter._sendConfirm(makeConfirm());

    expect(breaker.getState().state).toBe("open");
    await reporter._sendConfirm(makeConfirm());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
