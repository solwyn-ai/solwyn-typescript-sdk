import { expect, it } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { MetadataReporter } from "../../src/reporter";
import { zeroTokenDetails } from "../../src/token-details";

for (const operation of ["check", "confirm"] as const) {
  it(`fences a stale ${operation} success away from a live control-plane recovery probe`, async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      recoveryTimeout: 1,
      recoveryTimeoutJitter: 0,
      now: () => now,
    });
    let releaseOld!: () => void;
    let releaseProbe!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let requests = 0;
    const options = {
      apiKey: `sk_proj_${"a".repeat(64)}`,
      apiUrl: "https://accounting-breaker.invalid",
      controlPlaneBreaker: breaker,
      fetch: async () => {
        requests++;
        if (requests === 1) await oldGate;
        else if (requests === 2) throw new TypeError("synthetic network failure");
        else await probeGate;
        return operation === "confirm"
          ? new Response(null, { status: 204 })
          : Response.json({
              allowed: true,
              mode: "hard_deny",
              reservation_id: null,
              remaining_budget: 100,
              budget_limit: 100,
              current_usage: 0,
              denied_by_period: null,
              project_id: `proj_${"0".repeat(24)}`,
              price_hints: null,
            });
      },
    };
    const budget = new BudgetEnforcer({ ...options, cacheTtl: 0, leaseEnabled: false });
    const reporter = new MetadataReporter(options.apiUrl, options.apiKey, options);
    const send = () =>
      operation === "check"
        ? budget.checkBudget({ model: "gpt-4o", provider: "openai", estimatedInputTokens: 0 })
        : reporter._sendConfirm({
            model: "gpt-4o",
            provider: "openai",
            is_provider_fallback: false,
            reservation_id: "res-test",
            call_id: crypto.randomUUID(),
            token_details: zeroTokenDetails(),
            provider_region: null,
            service_tier: null,
          });
    const old = send();
    while (requests < 1) await Promise.resolve();
    await send();
    now = 1001;
    const probe = send();
    while (requests < 3) await Promise.resolve();
    releaseOld();
    await old;
    expect(breaker.admit().allowed).toBe(false);
    releaseProbe();
    await probe;
    expect(breaker.getState().successCount).toBe(1);
    await reporter.close();
    await budget.close();
  });
}
