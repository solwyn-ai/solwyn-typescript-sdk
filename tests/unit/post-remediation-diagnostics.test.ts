import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { BudgetEnforcer } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { safeExceptionType } from "../../src/error-diagnostics";
import { BudgetExceededError, Solwyn } from "../../src/index";
import type { Logger } from "../../src/logging";
import { assertCheckContract, FakeControlPlane } from "../../src/testing/index";
import {
  type FetchLike,
  isRetryableTransportError,
  Transport,
  TransportHttpError,
  TransportNetworkError,
} from "../../src/transport";

const OPTIONS = { apiUrl: "https://control-plane.example", apiKey: `sk_proj_${"0".repeat(64)}` };
const CHECK = { estimatedInputTokens: 1, model: "gpt-5.5", provider: "openai" as const };

describe("trusted Zod diagnostic labels", () => {
  it.each([
    ["constructed ZodError", () => new ZodError([])],
    [
      "schema parse rejection",
      () => {
        try {
          z.never().parse(null);
        } catch (error) {
          return error;
        }
        throw new Error("expected schema rejection");
      },
    ],
    [
      "schema safeParse rejection",
      () => {
        const result = z.never().safeParse(null);
        if (result.success) throw new Error("expected schema rejection");
        return result.error;
      },
    ],
  ] satisfies ReadonlyArray<
    readonly [string, () => unknown]
  >)("recognizes %s without reading mutable diagnostic or Zod branding fields", (_label, create) => {
    const error = create();
    let reads = 0;
    for (const field of ["name", "constructor"]) {
      Object.defineProperty(error, field, {
        get() {
          reads++;
          throw new Error("diagnostic getter must stay unread");
        },
      });
    }
    expect(safeExceptionType(error)).toBe("ZodError");
    expect(reads).toBe(0);
  });

  it("does not inspect caller-owned Zod branding or trust a diagnostic-name lookalike", () => {
    let reads = 0;
    const lookalike = {
      name: "ZodError",
      get _zod() {
        reads++;
        throw new Error("branding getter must stay unread");
      },
    };
    expect(safeExceptionType(lookalike)).toBe("UnknownError");
    expect(reads).toBe(0);
    expect(safeExceptionType(new Error())).toBe("Error");
  });
});

interface Rejection {
  value: unknown;
  reads: () => number;
}

const rejectionCases: ReadonlyArray<readonly [string, (marker: string) => Rejection]> = [
  ["ordinary error", () => ({ value: new Error("offline"), reads: () => 0 })],
  ["ordinary type error", () => ({ value: new TypeError("offline"), reads: () => 0 })],
  [
    "mutable error name",
    (marker) => ({ value: Object.assign(new Error(), { name: marker }), reads: () => 0 }),
  ],
  [
    "mutable transport name",
    (marker) => ({
      value: Object.assign(new TransportNetworkError("offline"), { name: marker }),
      reads: () => 0,
    }),
  ],
  [
    "prototype trap with named secondary error",
    (marker) => ({
      value: new Proxy(
        {},
        {
          getPrototypeOf() {
            throw Object.assign(new Error(), { name: marker });
          },
        },
      ),
      reads: () => 0,
    }),
  ],
  [
    "revoked proxy",
    () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return { value: revocable.proxy, reads: () => 0 };
    },
  ],
  ...["name", "constructor"].map((field): readonly [string, (marker: string) => Rejection] => [
    `throwing ${field} accessor`,
    (marker) => {
      let reads = 0;
      const value = new TransportNetworkError("offline");
      Object.defineProperty(value, field, {
        get() {
          reads++;
          throw new Error(marker);
        },
      });
      return { value, reads: () => reads };
    },
  ]),
  ...["name", "constructor"].map((field): readonly [string, (marker: string) => Rejection] => [
    `throwing ordinary ${field} accessor`,
    (marker) => {
      let reads = 0;
      const value = new Error();
      Object.defineProperty(value, field, {
        get() {
          reads++;
          throw new Error(marker);
        },
      });
      return { value, reads: () => reads };
    },
  ]),
  [
    "caller-named error subclass",
    (marker) => {
      class CustomError extends Error {}
      Object.defineProperty(CustomError, "name", { value: marker });
      return { value: new CustomError(), reads: () => 0 };
    },
  ],
];

function diagnostics(marker: string) {
  let disclosed = false;
  let rawArgument = false;
  const entries: string[] = [];
  const capture = (message: string, ...args: unknown[]) => {
    for (const value of [message, ...args]) {
      if (typeof value === "string") {
        disclosed ||= value.includes(marker);
        entries.push(value);
      } else if (value !== null && (typeof value === "object" || typeof value === "function")) {
        rawArgument = true;
      }
    }
  };
  const logger: Logger = { debug: capture, info: capture, warn: capture, error: capture };
  return { logger, entries, safe: () => !disclosed && !rawArgument };
}

describe("post-remediation 11: budget rejection diagnostics", () => {
  it.each(
    rejectionCases,
  )("preserves outage decisions and releases recovery admission for %s", async (_label, create) => {
    const marker = `${crypto.randomUUID()}\n${"x".repeat(300)}`;
    const rejection = create(marker);
    const log = diagnostics(marker);
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 0,
      successThreshold: 1,
    });
    const plane = new FakeControlPlane();
    let offline = true;
    const budget = new BudgetEnforcer({
      ...OPTIONS,
      logger: log.logger,
      leaseEnabled: false,
      controlPlaneBreaker: breaker,
      fetch: (input, init) =>
        offline ? Promise.reject(rejection.value) : plane.fetch(input, init),
    });
    breaker.recordFailure();
    let failed = false;
    let allowed = false;
    try {
      allowed = (await budget.checkBudget(CHECK)).allowed;
    } catch {
      failed = true;
    }
    expect(failed).toBe(false);
    expect(allowed).toBe(true);
    expect(log.safe()).toBe(true);
    expect(rejection.reads()).toBe(0);
    expect(log.entries.includes("TransportNetworkError")).toBe(true);
    expect(breaker.getState().state).toBe("open");
    offline = false;
    expect((await budget.checkBudget(CHECK)).allowed).toBe(true);
    expect(breaker.getState().state).toBe("closed");
    await budget.close();
  });

  it("preserves a public hard deny through a hostile fetch outage without provider dispatch", async () => {
    const marker = crypto.randomUUID();
    const log = diagnostics(marker);
    const plane = new FakeControlPlane();
    plane.denyNext(1, { period: "monthly", scope: "check" });
    let offline = false;
    let calls = 0;
    const wrapped = new Solwyn(
      {
        chat: {
          completions: {
            create: async (_request: { model: string; messages: unknown[] }) => {
              calls++;
              return { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
            },
          },
        },
      },
      {
        ...OPTIONS,
        provider: "openai",
        logger: log.logger,
        leaseEnabled: false,
        fetch: (input, init) => {
          if (offline && input.endsWith("/budgets/check")) {
            throw new Proxy(
              {},
              {
                getPrototypeOf() {
                  throw Object.assign(new Error(), { name: marker });
                },
              },
            );
          }
          return plane.fetch(input, init);
        },
      },
    );
    for (const outage of [false, true]) {
      offline = outage;
      let budgetDenied = false;
      try {
        await wrapped.chat.completions.create({ model: "gpt-5.5", messages: [] });
      } catch (error) {
        budgetDenied = error instanceof BudgetExceededError;
      }
      expect(budgetDenied).toBe(true);
    }
    await wrapped.close();
    expect(calls).toBe(0);
    expect(log.safe()).toBe(true);
  });

  it("normalizes hostile transport lookalikes without reading their status or diagnostic fields", async () => {
    let reads = 0;
    const lookalike = Object.create(TransportHttpError.prototype) as object;
    for (const field of ["status", "name", "constructor"]) {
      Object.defineProperty(lookalike, field, {
        get() {
          reads++;
          throw new Error("unexpected getter");
        },
      });
    }
    const transport = new Transport(OPTIONS.apiUrl, OPTIONS.apiKey, {
      fetch: () => Promise.reject(lookalike),
    });
    let networkFailure = false;
    try {
      await transport.postJson("/check", {}, { timeoutMs: 100 });
    } catch (error) {
      networkFailure = error instanceof TransportNetworkError;
    }
    expect(networkFailure).toBe(true);
    expect(reads).toBe(0);
    let classificationFailed = false;
    let retryable = true;
    try {
      retryable = isRetryableTransportError(lookalike);
    } catch {
      classificationFailed = true;
    }
    expect(classificationFailed).toBe(false);
    expect(retryable).toBe(false);
    expect(reads).toBe(0);
    expect(isRetryableTransportError(new TransportHttpError(429))).toBe(true);
    expect(isRetryableTransportError(new TransportHttpError(400))).toBe(false);
  });

  it("preserves fail-closed outage policy for a revoked fetch rejection", async () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const budget = new BudgetEnforcer({
      ...OPTIONS,
      failOpen: false,
      fetch: () => Promise.reject(revocable.proxy),
    });
    const result = await budget.checkBudget(CHECK);
    expect(result.allowed).toBe(false);
    expect(result.denySource).toBe("local_enforcement");
    expect(result.denyReason).toBe("no_prior_budget_limit");
    await budget.close();
  });
});

describe("post-remediation 12: contract helper rejection diagnostics", () => {
  it("bounds hostile cyclic prototype inspection and keeps the request phase", async () => {
    let reads = 0;
    const cyclic: object = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          if (++reads > 40) throw new Error("reflection limit");
          return cyclic;
        },
      },
    );
    let message = "";
    try {
      await assertCheckContract(() => Promise.reject(cyclic), OPTIONS);
    } catch (error) {
      if (error instanceof Error) message = error.message;
    }
    expect(message).toBe("[check.monthly] request failed (UnknownError)");
    expect(reads).toBeLessThanOrEqual(32);
  });

  for (const phase of ["request", "response body read"] as const) {
    it.each(
      rejectionCases,
    )(`${phase} failures expose only a stable phase and type for %s`, async (_label, create) => {
      const marker = `${crypto.randomUUID()}\n${"x".repeat(300)}`;
      const rejection = create(marker);
      const fetch: FetchLike =
        phase === "request"
          ? () => Promise.reject(rejection.value)
          : async () => ({ text: () => Promise.reject(rejection.value) }) as Response;
      let message = "";
      let createdError = false;
      try {
        await assertCheckContract(fetch, OPTIONS);
      } catch (error) {
        // Do not send the unknown error to an assertion or test formatter.
        try {
          createdError = error !== rejection.value && error instanceof Error;
          const descriptor = Object.getOwnPropertyDescriptor(error, "message");
          if (descriptor && "value" in descriptor && typeof descriptor.value === "string")
            message = descriptor.value;
        } catch {
          /* Hostile errors remain a boolean failure. */
        }
      }
      expect(createdError).toBe(true);
      expect(message.includes(marker)).toBe(false);
      expect(rejection.reads()).toBe(0);
      expect(message.startsWith(`[check.monthly] ${phase} failed (`)).toBe(true);
      expect(
        /^\[check\.monthly\] (?:request|response body read) failed \((?:Error|TypeError|TransportNetworkError|UnknownError)\)$/.test(
          message,
        ),
      ).toBe(true);
    });
  }
});
