import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitBreakerAdmission } from "../../src/circuit-breaker";
import { CostPolicy, type ProviderCandidate, type SelectionPolicy, Solwyn } from "../../src/index";
import type { FetchLike } from "../../src/transport";
import type { CircuitState } from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

function captureFetch(priceHints: Record<string, number> | null): {
  fetch: ReturnType<typeof vi.fn<FetchLike>>;
  events: Array<Record<string, unknown>>;
} {
  return captureFetchSequence([priceHints]);
}

function captureFetchSequence(priceHints: readonly (Record<string, number> | null)[]): {
  fetch: ReturnType<typeof vi.fn<FetchLike>>;
  events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  let checkIndex = 0;
  const impl: FetchLike = async (url, init) => {
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.includes("/api/v1/budgets/check")) {
      const currentPriceHints = priceHints[checkIndex] ?? null;
      checkIndex += 1;
      return new Response(
        JSON.stringify({
          allowed: true,
          remaining_budget: 950,
          reservation_id: "res-cost-route",
          mode: "alert_only",
          budget_limit: 1000,
          current_usage: 50,
          denied_by_period: null,
          project_id: `proj_${"0".repeat(24)}`,
          price_hints: currentPriceHints,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/v1/budgets/confirm")) {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/v1/metadata/ingest") && Array.isArray(raw)) {
      events.push(...(raw as Array<Record<string, unknown>>));
    }
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  return { fetch: vi.fn(impl), events };
}

function openaiClient(
  create: (...args: unknown[]) => unknown = () => ({
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }),
) {
  return {
    chat: {
      completions: {
        create: vi.fn(create),
      },
    },
  };
}

function compatibleClient(
  baseURL = "https://api.deepseek.com/v1",
  create: (...args: unknown[]) => unknown = () => ({
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }),
) {
  return {
    baseURL,
    chat: {
      completions: {
        create: vi.fn(create),
      },
    },
  };
}

interface ForcedPolicyOptions {
  consumesPriceSignals?: boolean;
  omitPrimary?: boolean;
  counterfeit?: (candidate: ProviderCandidate, index: number) => ProviderCandidate;
}

function forcedFallbackPolicy(options: ForcedPolicyOptions = {}): SelectionPolicy {
  return {
    ...(options.consumesPriceSignals === undefined
      ? {}
      : { consumesPriceSignals: options.consumesPriceSignals }),
    order(candidates) {
      const projected = candidates.map((candidate, index) =>
        options.counterfeit === undefined ? candidate : options.counterfeit(candidate, index),
      );
      const primary = projected[0];
      const fallback = projected[1];
      if (fallback === undefined) return [];
      return options.omitPrimary || primary === undefined ? [fallback] : [fallback, primary];
    },
  };
}

function breakerSnapshot(state: CircuitState) {
  return Object.freeze({
    state,
    failureCount: 0,
    successCount: 0,
    lastFailureTime: null,
    lastStateChange: 0,
    recoveryEligible: state === "open",
  });
}

async function routedSuccess(options: {
  hints: Record<string, number> | null;
  policy: SelectionPolicy;
  sameProvider?: boolean;
  breakerStates?: readonly [CircuitState, CircuitState];
}): Promise<Record<string, unknown>> {
  const primary = openaiClient();
  const fallback = options.sameProvider ? primary : compatibleClient();
  const { fetch, events } = captureFetch(options.hints);
  const solwyn = new Solwyn(primary, {
    apiKey: API_KEY,
    fetch,
    fallback: [[fallback, options.sameProvider ? "gpt-4o-mini" : "deepseek-chat"]],
    selectionPolicy: options.policy,
  });
  const stateSpy =
    options.breakerStates === undefined
      ? null
      : vi
          .spyOn(CircuitBreaker.prototype, "getState")
          .mockImplementationOnce(() => breakerSnapshot(options.breakerStates?.[0] ?? "closed"))
          .mockImplementationOnce(() => breakerSnapshot(options.breakerStates?.[1] ?? "closed"));
  try {
    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
  } finally {
    stateSpy?.mockRestore();
    await solwyn.close();
  }
  return events.find((event) => event["status"] === "success") as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cost-routed attribution matrix", () => {
  it("attributes a healthy strictly-cheaper cross-provider displacement", async () => {
    const event = await routedSuccess({
      hints: { openai: 9, deepseek: 1 },
      policy: new CostPolicy(),
    });

    expect(event).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      requested_provider: "openai",
      requested_model: "gpt-4o",
      is_provider_fallback: true,
      is_model_fallback: false,
      attempt_index: 1,
      failover_reason: "cost_routed",
    });
  });

  it.each([
    { label: "equal hints", hints: { openai: 4, deepseek: 4 } },
    { label: "a pricier first provider", hints: { openai: 1, deepseek: 9 } },
  ])("does not attribute $label as cost routing", async ({ hints }) => {
    const event = await routedSuccess({
      hints,
      policy: forcedFallbackPolicy({
        counterfeit(candidate, index) {
          return { ...candidate, priceHint: index === 0 ? 9 : 1 };
        },
      }),
    });

    expect(event["failover_reason"]).toBe("circuit_open");
  });

  it("attributes a hinted fallback when the primary is unhinted", async () => {
    const event = await routedSuccess({
      hints: { deepseek: 1 },
      policy: new CostPolicy(),
    });

    expect(event["failover_reason"]).toBe("cost_routed");
  });

  it("rejects a policy copy that invents a hint for an unhinted first provider", async () => {
    const event = await routedSuccess({
      hints: { openai: 9 },
      policy: forcedFallbackPolicy({
        counterfeit(candidate, index) {
          return { ...candidate, priceHint: index === 0 ? 9 : 1 };
        },
      }),
    });

    expect(event["failover_reason"]).toBe("circuit_open");
  });

  it.each([
    "open",
    "half_open",
  ] as const)("does not call a cheaper fallback cost-routed when the primary snapshot is %s", async (primaryState) => {
    const event = await routedSuccess({
      hints: { openai: 9, deepseek: 1 },
      policy: forcedFallbackPolicy({
        counterfeit(candidate) {
          return { ...candidate, breakerState: "closed" };
        },
      }),
      breakerStates: [primaryState, "closed"],
    });

    expect(event["failover_reason"]).toBe("circuit_open");
  });

  it.each([
    "open",
    "half_open",
  ] as const)("does not call a non-CLOSED first candidate cost-routed when its snapshot is %s", async (fallbackState) => {
    const event = await routedSuccess({
      hints: { openai: 9, deepseek: 1 },
      policy: forcedFallbackPolicy({
        counterfeit(candidate) {
          return { ...candidate, breakerState: "closed" };
        },
      }),
      breakerStates: ["closed", fallbackState],
    });

    expect(event["failover_reason"]).toBe("circuit_open");
  });

  it("keeps a same-provider model swap classified as model fallback", async () => {
    const event = await routedSuccess({
      hints: { openai: 1 },
      policy: forcedFallbackPolicy(),
      sameProvider: true,
    });

    expect(event).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      is_provider_fallback: false,
      is_model_fallback: true,
      attempt_index: 1,
      failover_reason: "model_fallback",
    });
  });

  it("requires the primary runtime to remain in the policy output", async () => {
    const event = await routedSuccess({
      hints: { openai: 9, deepseek: 1 },
      policy: forcedFallbackPolicy({ omitPrimary: true }),
    });

    expect(event["failover_reason"]).toBe("circuit_open");
  });

  it("requires the active policy to consume price signals", async () => {
    let observedPriceHints: Array<number | null | undefined> = [];
    const event = await routedSuccess({
      hints: { openai: 9, deepseek: 1 },
      policy: {
        consumesPriceSignals: false,
        order(candidates) {
          observedPriceHints = candidates.map((candidate) => candidate.priceHint);
          const primary = candidates[0];
          const fallback = candidates[1];
          return primary === undefined || fallback === undefined ? [] : [fallback, primary];
        },
      },
    });

    expect(observedPriceHints).toEqual([null, null]);
    expect(event["failover_reason"]).toBe("circuit_open");
  });

  it("keeps undeclared custom policies price-consuming by default", async () => {
    const event = await routedSuccess({
      hints: { openai: 9, deepseek: 1 },
      policy: forcedFallbackPolicy(),
    });

    expect(event["failover_reason"]).toBe("cost_routed");
  });

  it("rebases a stateful policy's retained candidate onto the current request snapshot", async () => {
    const primary = openaiClient();
    const fallback = compatibleClient();
    const { fetch, events } = captureFetchSequence([{ openai: 9, deepseek: 1 }, null]);
    let retainedFallback: ProviderCandidate | null = null;
    let currentRequestHints: Array<number | null | undefined> = [];
    let calls = 0;
    const policy: SelectionPolicy = {
      order(candidates) {
        calls += 1;
        const currentPrimary = candidates[0];
        const currentFallback = candidates[1];
        if (currentPrimary === undefined || currentFallback === undefined) return [];
        if (calls === 1) {
          retainedFallback = currentFallback;
          return [currentPrimary, currentFallback];
        }
        currentRequestHints = candidates.map((candidate) => candidate.priceHint);
        const mutableCandidates = candidates as ProviderCandidate[];
        mutableCandidates[1] = retainedFallback ?? currentFallback;
        return [mutableCandidates[1] as ProviderCandidate, currentPrimary];
      },
    };
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch,
      fallback: [[fallback, "deepseek-chat"]],
      selectionPolicy: policy,
    });

    await solwyn.chat.completions.create({ model: "gpt-first", messages: [] });
    await solwyn.chat.completions.create({ model: "gpt-second", messages: [] });
    await solwyn.close();

    const second = events.find((event) => event["requested_model"] === "gpt-second");
    expect(currentRequestHints).toEqual([null, null]);
    expect(second).toMatchObject({
      provider: "deepseek",
      attempt_index: 1,
      failover_reason: "circuit_open",
    });
  });
});

describe("cost-routed event precedence", () => {
  it("retains cost-routed attribution through streaming settlement", async () => {
    const primary = openaiClient();
    async function* fallbackStream(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "ok" } }] };
      yield { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } };
    }
    const fallback = compatibleClient("https://api.deepseek.com/v1", () => fallbackStream());
    const { fetch, events } = captureFetch({ openai: 9, deepseek: 1 });
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch,
      fallback: [[fallback, "deepseek-chat"]],
      selectionPolicy: new CostPolicy(),
    });

    const stream = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      // Drain the real wrapper so settlement runs.
    }
    await solwyn.close();

    expect(primary.chat.completions.create).not.toHaveBeenCalled();
    expect(fallback.chat.completions.create).toHaveBeenCalledOnce();
    expect(events.find((event) => event["status"] === "success")).toMatchObject({
      provider: "deepseek",
      failover_reason: "cost_routed",
      attempt_index: 1,
    });
  });

  it("gives a later primary provider error precedence over initial cost displacement", async () => {
    const primary = openaiClient(() => {
      throw Object.assign(new Error("primary limited"), { status: 429 });
    });
    const cheaper = compatibleClient("https://api.deepseek.com/v1", () => {
      throw Object.assign(new Error("cheaper limited"), { status: 429 });
    });
    const third = compatibleClient("https://api.together.xyz/v1");
    const { fetch, events } = captureFetch({ deepseek: 1, openai: 5, together: 9 });
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch,
      fallback: [
        [cheaper, "deepseek-chat"],
        [third, "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
      ],
      selectionPolicy: new CostPolicy(),
    });

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(events.find((event) => event["status"] === "success")).toMatchObject({
      provider: "together",
      failover_reason: "primary_error",
      attempt_index: 2,
    });
  });

  it("masks initial cost displacement after the primary breaker refuses admission", async () => {
    const primary = openaiClient();
    const cheaper = compatibleClient("https://api.deepseek.com/v1", () => {
      throw Object.assign(new Error("cheaper limited"), { status: 429 });
    });
    const third = compatibleClient("https://api.together.xyz/v1");
    const { fetch, events } = captureFetch({ deepseek: 1, openai: 5, together: 9 });
    const solwyn = new Solwyn(primary, {
      apiKey: API_KEY,
      fetch,
      fallback: [
        [cheaper, "deepseek-chat"],
        [third, "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
      ],
      selectionPolicy: new CostPolicy(),
    });
    const originalAdmit = CircuitBreaker.prototype.admit;
    let admissions = 0;
    const admit = vi.spyOn(CircuitBreaker.prototype, "admit").mockImplementation(function (
      this: CircuitBreaker,
    ) {
      admissions += 1;
      // 1 = control-plane check, 2 = cheaper candidate, 3 = primary candidate.
      if (admissions === 3) return new CircuitBreakerAdmission(false);
      return originalAdmit.call(this);
    });

    try {
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    } finally {
      admit.mockRestore();
      await solwyn.close();
    }

    expect(primary.chat.completions.create).not.toHaveBeenCalled();
    expect(events.find((event) => event["status"] === "success")).toMatchObject({
      provider: "together",
      failover_reason: "circuit_open",
      attempt_index: 2,
    });
  });
});
