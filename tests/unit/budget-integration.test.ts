/**
 * Client-level budget and circuit-breaker integration behaviors that only surface once
 * the enforcer and breaker are wired into the
 * `Solwyn` pipeline (the enforcer/breaker units themselves are covered by
 * `budget.test.ts` / `circuit-breaker.test.ts`):
 *
 *  - a hard-deny short-circuits dispatch (provider never called, no success event,
 *    a `budget_denied` event with the pre-flight estimate, and a `BudgetExceededError`
 *    whose fields, including `budgetPeriod`, come verbatim from the deny response);
 *  - the hard deny is PRESERVED across a subsequent budget-API outage AT THE CLIENT
 *    LEVEL (deny -> unreachable -> still denied, even with failOpen=true — invariant 9);
 *  - a served success confirms with the SAME call_id as its metadata event, on both the
 *    buffered and streaming reporter-settlement paths; an
 *    errored call reconciles via the event's call_id and sends NO confirm;
 *  - fail-open proceeds when configured and no deny is active; fail-closed denies;
 *  - the primary breaker opens after the failure threshold and then blocks the dispatch
 *    path with `ProviderUnavailableError`.
 *
 * Fully offline: `fetch` is injected and routes budget-check / confirm / ingest by URL.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer, budgetCheckResult } from "../../src/budget";
import type { SolwynOptions } from "../../src/client";
import {
  BudgetExceededError,
  ProviderUnavailableError,
  RunStoppedError,
  UntranslatableRequestError,
} from "../../src/errors";
import { type BudgetCheckResult, Solwyn } from "../../src/index";
import type { Logger } from "../../src/logging";
import { currentRun, run } from "../../src/node";
import { __resetAdapterRegistry, __setAdapterLoadersForTesting } from "../../src/providers/index";
import type {
  CreateStreamAccumulatorOptions,
  EstimateMissingUsageOptions,
  PrepareCallOptions,
  PreparedDispatch,
  ProviderAdapter,
  StreamUsageAccumulator,
} from "../../src/providers/protocol";
import * as translation from "../../src/providers/translation/index";
import { MetadataReporter } from "../../src/reporter";
import {
  acquireTerminationHandle,
  markTerminated,
  resetRunControlForTest,
  runTermination,
} from "../../src/run-control";
import { FakeControlPlane } from "../../src/testing/index";
import { createTokenDetails, type TokenDetails, zeroTokenDetails } from "../../src/token-details";
import type { FetchLike } from "../../src/transport";
import type { BudgetConfirmRequest, LeaseGrantResponse, MetadataEvent } from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

// ---------------------------------------------------------------------------
// Wire-body helpers.
// ---------------------------------------------------------------------------

/** The serialized (wire) metadata event shape (dot access, no index signature). */
type WireEvent = MetadataEvent;

interface RawPlaneTraffic {
  fetch: FetchLike;
  ingested: WireEvent[];
  confirms: BudgetConfirmRequest[];
}

function recordPlaneTraffic(plane: FakeControlPlane): RawPlaneTraffic {
  const ingested: WireEvent[] = [];
  const confirms: BudgetConfirmRequest[] = [];
  return {
    ingested,
    confirms,
    fetch: async (input, init) => {
      if (typeof init?.body === "string") {
        const pathname = new URL(input).pathname;
        if (pathname === "/api/v1/metadata/ingest") {
          ingested.push(...(JSON.parse(init.body) as WireEvent[]));
        } else if (pathname === "/api/v1/budgets/confirm") {
          confirms.push(JSON.parse(init.body) as BudgetConfirmRequest);
        }
      }
      return plane.fetch(input, init);
    },
  };
}

function clientOptions(plane: FakeControlPlane, options: SolwynOptions = {}): SolwynOptions {
  return {
    apiKey: plane.apiKey,
    apiUrl: plane.apiUrl,
    fetch: plane.fetch,
    ...options,
  };
}

/** A minimal OpenAI-shaped client whose `chat.completions.create` is a spy. */
function openAIClient(impl: (kwargs: Record<string, unknown>) => unknown) {
  const create = vi.fn((kwargs: Record<string, unknown>) => impl(kwargs));
  return { chat: { completions: { create } } };
}

function fundedLeaseDecision() {
  return budgetCheckResult({
    allowed: true,
    remainingBudget: 900,
    projectId: `proj_${"0".repeat(24)}`,
    reservationId: null,
    leaseId: "lease-client-1",
    leaseClaimToken: 77,
    mode: "alert_only",
    budgetLimit: 1_000,
    currentUsage: 100,
  });
}

function emptyLeaseGrantResponse(): LeaseGrantResponse {
  return {
    eligible: true,
    allowed: true,
    lease_id: "",
    generation: 1,
    granted_tokens: 15_000,
    refresh_interval_s: 300,
    lease_length_s: 600,
    headroom_share_tokens: 5_000,
    posture: { mode: "alert_only", on_unreachable: "fail_open" },
    final_grant: false,
    project_id: `proj_${"0".repeat(24)}`,
    mode: "alert_only",
    budget_limit: 1_000,
    current_usage: 100,
    remaining_budget: 900,
  };
}

/** Serve one real lease lifecycle while leaving confirm/ingest capture at the wire boundary. */
function withEmptyLeaseGrant(next: FetchLike): FetchLike {
  return async (input, init) => {
    const pathname = new URL(input).pathname;
    if (pathname === "/api/v1/budgets/lease") {
      return new Response(JSON.stringify(emptyLeaseGrantResponse()), { status: 200 });
    }
    if (
      pathname === "/api/v1/budgets/lease/renew" ||
      pathname === "/api/v1/budgets/lease/surrender"
    ) {
      return new Response(null, { status: 204 });
    }
    return next(input, init);
  };
}

/** Exact public result shape produced by pre-lease third-party enforcer fakes. */
function legacyBudgetDecision(): BudgetCheckResult {
  return {
    allowed: true,
    remainingBudget: 900,
    projectId: `proj_${"0".repeat(24)}`,
    reservationId: null,
    mode: "alert_only",
    warning: null,
    budgetLimit: 1_000,
    currentUsage: 100,
    priceHints: null,
    failoverTuningAllowed: null,
    deniedByPeriod: null,
  };
}

class LeaseUsageAdapter implements ProviderAdapter {
  readonly name = "openai";
  readonly dialect = "openai";

  constructor(
    private readonly extract: () => TokenDetails,
    private readonly estimate: () => TokenDetails | null,
  ) {}

  detectClient(client: unknown): boolean {
    return (
      typeof (client as { chat?: { completions?: { create?: unknown } } })?.chat?.completions
        ?.create === "function"
    );
  }
  detectModel(): boolean {
    return false;
  }
  extractUsage(): TokenDetails {
    return this.extract();
  }
  estimateMissingUsage(
    _response: unknown,
    _options: EstimateMissingUsageOptions,
  ): TokenDetails | null {
    return this.estimate();
  }
  extractServiceTier(): string | null {
    return null;
  }
  extractRegion(): string | null {
    return null;
  }
  prepareStreaming(kwargs: Record<string, unknown>): Record<string, unknown> {
    return { ...kwargs };
  }
  createStreamAccumulator(_options?: CreateStreamAccumulatorOptions): StreamUsageAccumulator {
    return {
      observe() {},
      finalize: () => zeroTokenDetails(),
      getServiceTier: () => null,
    };
  }
  prepareCall(
    client: unknown,
    kwargs: Record<string, unknown>,
    _options: PrepareCallOptions,
  ): PreparedDispatch {
    const completions = (
      client as { chat: { completions: { create: (...args: unknown[]) => unknown } } }
    ).chat.completions;
    return (...passthroughArgs) => completions.create({ ...kwargs }, ...passthroughArgs);
  }
  unwrapStreamSource(response: unknown): unknown {
    return response;
  }
  wrapStreamResult(wrapper: unknown): unknown {
    return wrapper;
  }
}

// ---------------------------------------------------------------------------
// Deny short-circuits dispatch.
// ---------------------------------------------------------------------------

describe("client budget wiring — hard-deny short-circuits dispatch", () => {
  it("throws BudgetExceededError, never calls the provider, and emits a budget_denied event", async () => {
    const plane = new FakeControlPlane({
      budgetLimit: 100,
      currentUsage: 150,
      remainingBudget: 0,
    });
    const traffic = recordPlaneTraffic(plane);
    plane.denyNext();
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const originalCheckBudget = BudgetEnforcer.prototype.checkBudget;
    let rawOutputBound: number | undefined;
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockImplementation(function (this: BudgetEnforcer, request) {
        rawOutputBound = request.estimatedOutputBound;
        return originalCheckBudget.call(this, request);
      });
    const solwyn = new Solwyn(
      client,
      clientOptions(plane, { fetch: traffic.fetch, tags: { environment: "test" } }),
    );

    let caught: unknown;
    try {
      await solwyn.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello world" }],
        max_tokens: 200_000_001,
      });
    } catch (error) {
      caught = error;
    }
    await solwyn.close();
    checkBudget.mockRestore();

    // The wrapped client's create was NEVER invoked — the deny blocked dispatch entirely.
    expect(client.chat.completions.create).not.toHaveBeenCalled();

    // BudgetExceededError fields come verbatim from the deny response,
    // and budgetPeriod is resolved from denied_by_period rather than hardcoded as "unknown".
    expect(caught).toBeInstanceOf(BudgetExceededError);
    const err = caught as BudgetExceededError;
    expect(err.budgetLimit).toBe(100);
    expect(err.currentUsage).toBe(150);
    expect(err.mode).toBe("hard_deny");
    expect(err.budgetPeriod).toBe("monthly");

    // Exactly one event, and it is budget_denied (never a success), with the pre-flight
    // estimate as input_tokens, output 0, latency 0. No confirm (nothing was served).
    expect(traffic.ingested).toHaveLength(1);
    const event = traffic.ingested[0] as WireEvent;
    expect(event.status).toBe("budget_denied");
    expect(event.output_tokens).toBe(0);
    expect(event.latency_ms).toBe(0);
    expect(event.input_tokens).toBeGreaterThan(0); // "hello world" → non-zero estimate
    expect(event).toMatchObject({
      deny_source: "server",
      deny_reason: "monthly",
      denied_by_period: "monthly",
      estimated_output_bound: 100_000_000,
    });
    expect(rawOutputBound).toBe(200_000_001);
    expect(traffic.confirms).toHaveLength(0);
  });

  it("logs a failed budget_denied report by class name only, without a raw error or stack", async () => {
    const secret = "budget-denied-ingest-secret";
    const warn = vi.fn<(message: string, ...args: unknown[]) => void>();
    const logger = {
      debug: vi.fn<(message: string, ...args: unknown[]) => void>(),
      info: vi.fn<(message: string, ...args: unknown[]) => void>(),
      warn,
      error: vi.fn<(message: string, ...args: unknown[]) => void>(),
    } satisfies Logger;
    const plane = new FakeControlPlane();
    plane.denyNext();
    const attemptedEvents: WireEvent[] = [];
    const fetchMock: FetchLike = async (input, init) => {
      if (new URL(input).pathname === "/api/v1/metadata/ingest") {
        if (typeof init?.body === "string") {
          attemptedEvents.push(...(JSON.parse(init.body) as WireEvent[]));
        }
        throw new TypeError(secret);
      }
      return plane.fetch(input, init);
    };
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const solwyn = new Solwyn(client, clientOptions(plane, { fetch: fetchMock, logger }));

    await expect(
      solwyn.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "preserve this estimate" }],
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();

    expect(attemptedEvents).toHaveLength(1);
    const event = attemptedEvents[0] as WireEvent;
    expect(event.status).toBe("budget_denied");
    expect(event.input_tokens).toBeGreaterThan(0);
    expect(event.output_tokens).toBe(0);
    expect(event).not.toHaveProperty("token_details");
    expect(warn.mock.calls).toEqual([
      ["Failed to send metadata batch (1 events): TransportNetworkError"],
      ["reporter.spend_events_dropped: new=%d totals=%s", 1, '{"event.retry_exhausted":1}'],
    ]);
    expect(warn.mock.calls.flat().some((argument) => argument instanceof Error)).toBe(false);
    expect(warn.mock.calls.flat().join("\n")).not.toContain(secret);
    expect(warn.mock.calls.flat().join("\n")).not.toContain("at ");
  });

  it("run-scoped hard deny forwards the run id, blocks dispatch, and preserves deny-event attribution", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const solwyn = new Solwyn(
      client,
      clientOptions(plane, { fetch: traffic.fetch, tags: { environment: "test" } }),
    );

    let activeRunId = "";
    await run("core-denied-run", { tags: { scope: "run" } }, async () => {
      activeRunId = currentRun()?.agentRunId ?? "";
      plane.denyRun(activeRunId);
      await expect(
        solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: "deny this run" }],
          solwyn_tags: { customer: "acme" },
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
    });
    await solwyn.close();

    expect(activeRunId).toMatch(/^run_/);
    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(plane.checks).toHaveLength(1);
    expect(plane.checks[0]?.agent_run_id).toBe(activeRunId);
    expect(plane.checks[0]?.tags).toEqual({ customer: "acme", scope: "run", environment: "test" });
    const denied = traffic.ingested.filter((event) => event.status === "budget_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.tags).toEqual({ customer: "acme", scope: "run", environment: "test" });
    expect(denied[0]?.agent_run_id).toBe(activeRunId);
    expect(denied[0]?.agent_run_name).toBe("core-denied-run");
  });
});

describe("client budget wiring — run-scoped preflight attribution", () => {
  it("forwards one captured run id through buffered, streaming, and media checks, then omits it outside", async () => {
    const plane = new FakeControlPlane();
    async function* responseStream(): AsyncGenerator<unknown> {
      yield {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      };
    }
    const chatCreate = vi.fn((kwargs: Record<string, unknown>) =>
      kwargs["stream"] === true
        ? responseStream()
        : { usage: { prompt_tokens: 2, completion_tokens: 1 } },
    );
    const embeddingsCreate = vi.fn((_kwargs: Record<string, unknown>) => ({
      usage: { prompt_tokens: 4 },
    }));
    const client = {
      chat: { completions: { create: chatCreate } },
      embeddings: { create: embeddingsCreate },
    };
    const solwyn = new Solwyn(client, clientOptions(plane, { leaseEnabled: false }));

    let activeRunId = "";
    const stream = await run("core-active-run", async () => {
      activeRunId = currentRun()?.agentRunId ?? "";
      await solwyn.chat.completions.create({ model: "buffered-model", messages: [] });
      const activeStream = (await solwyn.chat.completions.create({
        model: "streaming-model",
        messages: [],
        stream: true,
      })) as AsyncIterable<unknown>;
      await solwyn.embeddings.create({ model: "embedding-model", input: "measure me" });
      return activeStream;
    });

    // Drain after the callback exits: the preflight must have used the entry snapshot.
    for await (const _chunk of stream) {
      // drain to settlement
    }
    await solwyn.chat.completions.create({ model: "outside-model", messages: [] });
    await solwyn.close();

    expect(activeRunId).toMatch(/^run_/);
    expect(plane.checks).toHaveLength(4);
    for (const check of plane.checks.slice(0, 3)) {
      expect(check.agent_run_id).toBe(activeRunId);
    }
    expect(plane.checks[3]).not.toHaveProperty("agent_run_id");
    expect(plane.leaseGrants).toEqual([]);
    expect(plane.leaseRenewals).toEqual([]);
    expect(chatCreate).toHaveBeenCalledTimes(3);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Confirm and call_id reconciliation across settlement paths.
// ---------------------------------------------------------------------------

describe("client budget wiring — confirm + call_id reconciliation", () => {
  it("buffered success: queues one settlement with the same call_id as the success event", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      service_tier: "priority",
    }));
    const solwyn = new Solwyn(client, clientOptions(plane, { fetch: traffic.fetch }));

    await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(traffic.confirms).toHaveLength(0);
    expect(traffic.ingested).toHaveLength(0);
    await solwyn.close();

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(traffic.ingested).toHaveLength(1);
    expect(traffic.confirms).toHaveLength(1);
    const event = traffic.ingested[0] as WireEvent;
    const confirm = traffic.confirms[0];
    expect(event.status).toBe("success");
    expect(confirm?.reservation_id).toBe("res_fake_00000001");
    // The confirm and metadata event use the same reconciliation key.
    expect(confirm?.call_id).toBe(event.call_id);
    expect(confirm?.provider).toBe("openai");
    expect(confirm?.model).toBe("gpt-4o");
    // The service tier is extracted once and threaded into both records.
    expect(confirm?.service_tier).toBe("priority");
    expect(event.service_tier).toBe("priority");
  });

  it("streaming success: settles via a single combined reportSettlement carrying the same call_id", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    async function* stream(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "he" } }] };
      yield {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
        service_tier: "flex",
      };
    }
    const client = openAIClient(() => stream());
    const solwyn = new Solwyn(client, clientOptions(plane, { fetch: traffic.fetch }));

    const s = (await solwyn.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _chunk of s) {
      // drain to settlement
    }
    expect(traffic.confirms).toHaveLength(0);
    expect(traffic.ingested).toHaveLength(0);
    await solwyn.close();

    expect(traffic.ingested).toHaveLength(1);
    expect(traffic.confirms).toHaveLength(1);
    const event = traffic.ingested[0] as WireEvent;
    const confirm = traffic.confirms[0];
    expect(event.status).toBe("success");
    expect(event.input_tokens).toBe(5);
    expect(event.output_tokens).toBe(7);
    expect(confirm?.reservation_id).toBe("res_fake_00000001");
    expect(confirm?.call_id).toBe(event.call_id);
    expect(confirm?.service_tier).toBe("flex");
    expect(event.service_tier).toBe("flex");
  });

  it("cache hit skips confirm entirely; the lone success event reconciles (behavior 24)", async () => {
    // First call → fresh allow (with reservation → confirm). Second call within TTL →
    // cache hit → reservationId null → NO confirm.
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const client = openAIClient(() => ({ usage: { prompt_tokens: 2, completion_tokens: 2 } }));
    const solwyn = new Solwyn(client, clientOptions(plane, { fetch: traffic.fetch }));

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    // Two served successes, one HTTP check (the second was cache-served), one confirm.
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(plane.checks).toHaveLength(1);
    expect(traffic.ingested.filter((event) => event.status === "success")).toHaveLength(2);
    expect(traffic.confirms).toHaveLength(1);
  });

  it("treats an empty reservation id as event-only", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const fetch: FetchLike = async (input, init) => {
      const response = await traffic.fetch(input, init);
      if (new URL(input).pathname !== "/api/v1/budgets/check") {
        return response;
      }
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, reservation_id: "" }), { status: 200 });
    };
    const client = openAIClient(() => ({ usage: { prompt_tokens: 2, completion_tokens: 2 } }));
    const solwyn = new Solwyn(client, clientOptions(plane, { fetch }));

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();

    expect(traffic.confirms).toHaveLength(0);
    expect(traffic.ingested.filter((event) => event.status === "success")).toHaveLength(1);
  });

  it("errored call: the error event carries a call_id for reconciliation and sends NO confirm", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const boom = new Error("boom");
    const client = openAIClient(() => {
      throw boom;
    });
    const solwyn = new Solwyn(client, clientOptions(plane, { fetch: traffic.fetch }));

    await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
      boom,
    );
    await solwyn.close();

    expect(traffic.ingested).toHaveLength(1);
    const event = traffic.ingested[0] as WireEvent;
    expect(event.status).toBe("error");
    expect(typeof event.call_id).toBe("string");
    expect(event.call_id.length).toBeGreaterThan(0);
    // Confirm settles only on a served success — an errored call sends none.
    expect(traffic.confirms).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fail-open and fail-closed handling at the client level.
// ---------------------------------------------------------------------------

describe("client budget wiring — outage behavior with no active deny", () => {
  it("fails OPEN (proceeds) on a budget-API outage when failOpen=true and no prior deny", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const outage = plane.outage({ path: "/api/v1/budgets/check" });
    const client = openAIClient(() => ({ usage: { prompt_tokens: 2, completion_tokens: 3 } }));
    const solwyn = new Solwyn(
      client,
      clientOptions(plane, { failOpen: true, fetch: traffic.fetch }),
    );

    await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    await solwyn.close();
    outage.end();

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(traffic.ingested).toHaveLength(1);
    expect((traffic.ingested[0] as WireEvent).status).toBe("success");
    // A fail-open allow has no reservation → no confirm.
    expect(traffic.confirms).toHaveLength(0);
  });

  it("fails CLOSED (denies before dispatch) on an outage when failOpen=false with no prior cloud contact", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const outage = plane.outage({ path: "/api/v1/budgets/check" });
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const solwyn = new Solwyn(
      client,
      clientOptions(plane, { failOpen: false, fetch: traffic.fetch }),
    );

    await expect(
      solwyn.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await solwyn.close();
    outage.end();

    expect(client.chat.completions.create).not.toHaveBeenCalled();
    expect(traffic.ingested).toHaveLength(1);
    expect((traffic.ingested[0] as WireEvent).status).toBe("budget_denied");
    expect(traffic.ingested[0]).toMatchObject({
      deny_source: "local_enforcement",
      deny_reason: "no_prior_budget_limit",
    });
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker opens after the failure threshold and blocks dispatch.
// ---------------------------------------------------------------------------

describe("client circuit-breaker wiring — opens after the threshold and blocks dispatch", () => {
  it("blocks the dispatch path with ProviderUnavailableError once the primary breaker opens (default threshold 3)", async () => {
    // Budget always allows, so the breaker — not the budget — is what gates.
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    // Only a health-signal disposition counts toward opening the breaker. A bare
    // `Error` (no status) classifies FAIL_FAST — request-shaped, never a breaker signal —
    // so a 5xx-shaped error is used here to accrue the failures (POST_SEND_AMBIGUOUS counts
    // the breaker; under the default "safe" idempotency it re-raises the original error
    // without crossing providers on this single-runtime chain).
    const boom = Object.assign(new Error("upstream 500"), { status: 503 });
    const client = openAIClient(() => {
      throw boom;
    });
    const solwyn = new Solwyn(client, clientOptions(plane, { fetch: traffic.fetch }));

    // Three consecutive dispatch failures each record one breaker failure; the third
    // reaches the default threshold (3) and OPENS the primary's breaker.
    for (let i = 0; i < 3; i++) {
      await expect(solwyn.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toBe(
        boom,
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);

    // The fourth call is refused at admission (OPEN, not recovery-eligible): a
    // ProviderUnavailableError, and the wrapped client is NOT invoked again.
    await expect(
      solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(3);
    await solwyn.close();

    // Three error events from the served-then-failed dispatches; the blocked call emits
    // none (admission refusal has no metadata event).
    expect(traffic.ingested.filter((event) => event.status === "error")).toHaveLength(3);
    expect(traffic.ingested.some((event) => event.status === "budget_denied")).toBe(false);
    // No confirm — no call was ever served successfully.
    expect(traffic.confirms).toHaveLength(0);
  });
});

describe("client lease funding ownership", () => {
  // Mutation caught: removing core-text trust-boundary normalization forwards an
  // `undefined` legacy claim token to the first release consumer.
  it("normalizes a legacy budget decision before failed-call release", async () => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(legacyBudgetDecision());
    const release = vi
      .spyOn(BudgetEnforcer.prototype, "releaseReservation")
      .mockImplementation(() => {});
    const sentinel = new Error("provider failed");
    const solwyn = new Solwyn(
      openAIClient(() => {
        throw sentinel;
      }),
      clientOptions(new FakeControlPlane()),
    );

    try {
      await expect(solwyn.chat.completions.create({ model: "gpt-5.5", messages: [] })).rejects.toBe(
        sentinel,
      );

      expect(release).not.toHaveBeenCalled();
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
    }
  });

  it("settles a spec-valid empty lease id after a buffered success", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const client = openAIClient(() => ({
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    }));
    const solwyn = new Solwyn(
      client,
      clientOptions(plane, { fetch: withEmptyLeaseGrant(traffic.fetch) }),
    );

    await run("core-empty-lease-buffered", () =>
      solwyn.chat.completions.create({ model: "gpt-5.5", messages: [] }),
    );
    await solwyn.close();

    expect(traffic.confirms).toHaveLength(1);
    expect(traffic.confirms[0]).toMatchObject({
      lease_id: "",
      token_details: { input_tokens: 4, output_tokens: 3 },
    });
    const success = traffic.ingested.find((event) => event.status === "success");
    expect(traffic.confirms[0]?.call_id).toBe(success?.call_id);
  });

  it("settles a spec-valid empty lease id after a streaming success", async () => {
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    async function* chunks(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "one" } }] };
      yield {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      };
    }
    const solwyn = new Solwyn(
      openAIClient(() => chunks()),
      clientOptions(plane, { fetch: withEmptyLeaseGrant(traffic.fetch) }),
    );

    const stream = await run(
      "core-empty-lease-stream",
      () =>
        solwyn.chat.completions.create({
          model: "gpt-5.5",
          messages: [],
          stream: true,
        }) as Promise<AsyncIterable<unknown>>,
    );
    for await (const _chunk of stream) {
      // Drain to terminal usage settlement.
    }
    await solwyn.close();

    expect(traffic.confirms).toHaveLength(1);
    expect(traffic.confirms[0]).toMatchObject({
      lease_id: "",
      token_details: { input_tokens: 5, output_tokens: 2 },
    });
    const success = traffic.ingested.find((event) => event.status === "success");
    expect(traffic.confirms[0]?.call_id).toBe(success?.call_id);
  });

  it("passes one minted call id and effective cap through failed-hop fallback lease settlement", async () => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(fundedLeaseDecision());
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const primaryError = Object.assign(new Error("primary failed"), { status: 500 });
    const primary = openAIClient(() => {
      throw primaryError;
    });
    const fallback = openAIClient(() => ({
      usage: { prompt_tokens: 13, completion_tokens: 8 },
    }));
    const solwyn = new Solwyn(
      primary,
      clientOptions(plane, {
        fetch: traffic.fetch,
        failoverIdempotency: "always",
        fallback: [[fallback, "gpt-5.5", {}, "openai"]],
      }),
    );

    try {
      await solwyn.chat.completions.create({
        model: "gpt-5.5",
        messages: [],
        max_tokens: 640,
      });
      await solwyn.close();

      expect(primary.chat.completions.create).toHaveBeenCalledOnce();
      expect(fallback.chat.completions.create).toHaveBeenCalledOnce();
      expect(checkBudget).toHaveBeenCalledOnce();
      const preflight = checkBudget.mock.calls[0]?.[0];
      expect(preflight?.callId).toMatch(/^[0-9a-f-]{36}$/);
      expect(preflight?.estimatedOutputBound).toBe(640);
      expect(traffic.confirms).toHaveLength(1);
      expect(traffic.confirms[0]).toMatchObject({
        lease_id: "lease-client-1",
        call_id: preflight?.callId,
      });
      expect(traffic.confirms[0]).not.toHaveProperty("reservation_id");
      const success = traffic.ingested.find((event) => event.status === "success");
      expect(success?.call_id).toBe(preflight?.callId);
      expect(release).not.toHaveBeenCalled();
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
    }
  });

  it.each([
    "exhaustion",
    "consumer break",
  ] as const)("settles one lease confirm on stream %s", async (exit) => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(fundedLeaseDecision());
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    async function* chunks(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "one" } }] };
      yield {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      };
    }
    const solwyn = new Solwyn(
      openAIClient(() => chunks()),
      clientOptions(plane, { fetch: traffic.fetch }),
    );

    try {
      const stream = (await solwyn.chat.completions.create({
        model: "gpt-5.5",
        messages: [],
        stream: true,
        max_completion_tokens: 321,
      })) as AsyncIterable<unknown>;
      for await (const _chunk of stream) {
        if (exit === "consumer break") break;
      }
      await solwyn.close();

      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(checkBudget.mock.calls[0]?.[0].estimatedOutputBound).toBe(321);
      expect(traffic.confirms).toHaveLength(1);
      expect(traffic.confirms[0]).toMatchObject({
        lease_id: "lease-client-1",
        call_id: callId,
      });
      expect(traffic.confirms[0]).not.toHaveProperty("reservation_id");
      expect(release).not.toHaveBeenCalled();
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
    }
  });

  it("releases once on a mid-stream provider failure and never confirms", async () => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(fundedLeaseDecision());
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const sentinel = new Error("stream failed");
    async function* chunks(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "partial" } }] };
      throw sentinel;
    }
    const solwyn = new Solwyn(
      openAIClient(() => chunks()),
      clientOptions(plane, { fetch: traffic.fetch }),
    );

    try {
      const stream = (await solwyn.chat.completions.create({
        model: "gpt-5.5",
        messages: [],
        stream: true,
      })) as AsyncIterable<unknown>;
      await expect(
        (async () => {
          for await (const _chunk of stream) {
            // drain
          }
        })(),
      ).rejects.toBe(sentinel);

      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(release.mock.calls).toEqual([[callId, 77]]);
      await solwyn.close();
      expect(traffic.confirms).toHaveLength(0);
      expect(traffic.ingested.filter((event) => event.status === "error")).toHaveLength(1);
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
    }
  });

  it("retains paid usage and the chunk-translation error when iterator cleanup also fails", async () => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(fundedLeaseDecision());
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const sentinel = new Error("chunk translation failed");
    const cleanupFailure = new Error("foreign iterator cleanup failed");
    const iteratorReturn = vi.fn(async (): Promise<IteratorResult<unknown>> => {
      throw cleanupFailure;
    });
    let emitted = false;
    const source = {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return {
              done: false,
              value: {
                type: "message_start",
                message: { usage: { input_tokens: 1, output_tokens: 0 } },
              },
            };
          },
          return: iteratorReturn,
        };
      },
    };
    const translate = vi.spyOn(translation, "translateStreamChunk").mockImplementation(() => {
      throw sentinel;
    });
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const primary = openAIClient(() => {
      throw Object.assign(new Error("advance to foreign stream"), { status: 429 });
    });
    const anthropic = { messages: { create: vi.fn(() => source) } };
    const solwyn = new Solwyn(
      primary,
      clientOptions(plane, {
        fetch: traffic.fetch,
        fallback: [[anthropic, "claude-opus-4", {}, "anthropic"]],
      }),
    );

    try {
      const stream = (await solwyn.chat.completions.create({
        model: "gpt-5.5",
        messages: [],
        max_tokens: 100,
        stream: true,
      })) as AsyncIterable<unknown>;
      await expect(
        (async () => {
          for await (const _chunk of stream) {
            // drain
          }
        })(),
      ).rejects.toBe(sentinel);

      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(translate).toHaveBeenCalledOnce();
      expect(iteratorReturn).toHaveBeenCalledOnce();
      // The observed paid input is retained while the missing terminal output
      // marks this settlement estimated instead of refunding the claim on translation failure.
      expect(release).not.toHaveBeenCalled();
      await solwyn.close();
      expect(traffic.confirms).toHaveLength(1);
      expect(traffic.confirms[0]).toMatchObject({
        call_id: callId,
        provider: "anthropic",
        lease_id: "lease-client-1",
        token_details: { input_tokens: 1, output_tokens: 0, is_estimated: true },
      });
      expect(traffic.ingested.some((event) => event.status === "success")).toBe(false);
      const paidEvents = traffic.ingested.filter((event) => event.provider === "anthropic");
      expect(paidEvents).toHaveLength(1);
      expect(paidEvents[0]).toMatchObject({
        status: "error",
        input_tokens: 1,
        output_tokens: 0,
        token_details: { input_tokens: 1, output_tokens: 0, is_estimated: true },
        failover_error_class: "Error",
      });
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
      translate.mockRestore();
    }
  });

  it("releases once and preserves a terminal provider failure", async () => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(fundedLeaseDecision());
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const sentinel = Object.assign(new Error("terminal request failure"), { status: 400 });
    const client = openAIClient(() => {
      throw sentinel;
    });
    const solwyn = new Solwyn(client, clientOptions(plane, { fetch: traffic.fetch }));

    try {
      await expect(solwyn.chat.completions.create({ model: "gpt-5.5", messages: [] })).rejects.toBe(
        sentinel,
      );
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(release.mock.calls).toEqual([[callId, 77]]);
      await solwyn.close();
      expect(traffic.confirms).toHaveLength(0);
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
    }
  });

  it("releases once when candidate selection returns no usable provider", async () => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(fundedLeaseDecision());
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const plane = new FakeControlPlane();
    const client = openAIClient(() => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const solwyn = new Solwyn(
      client,
      clientOptions(plane, { selectionPolicy: { order: () => [] } }),
    );

    try {
      await expect(
        solwyn.chat.completions.create({ model: "gpt-5.5", messages: [] }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(release.mock.calls).toEqual([[callId, 77]]);
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
    }
  });

  it("releases once when cross-dialect preparation fails before dispatch", async () => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(fundedLeaseDecision());
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const plane = new FakeControlPlane();
    const primary = openAIClient(() => {
      throw Object.assign(new Error("advance"), { status: 500 });
    });
    const anthropic = { messages: { create: vi.fn() } };
    const solwyn = new Solwyn(
      primary,
      clientOptions(plane, {
        failoverIdempotency: "always",
        fallback: [[anthropic, "claude-opus-4", {}, "anthropic"]],
      }),
    );

    try {
      await expect(
        solwyn.chat.completions.create({ model: "gpt-5.5", messages: [] }),
      ).rejects.toBeInstanceOf(UntranslatableRequestError);
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      expect(release.mock.calls).toEqual([[callId, 77]]);
      expect(anthropic.messages.create).not.toHaveBeenCalled();
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
    }
  });

  it("normalizes before settlement while retaining paid usage and the normalization failure", async () => {
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValue(fundedLeaseDecision());
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const sentinel = new Error("normalize failed");
    const normalize = vi.spyOn(translation, "normalizeResponse").mockImplementation(() => {
      throw sentinel;
    });
    const plane = new FakeControlPlane();
    const traffic = recordPlaneTraffic(plane);
    const defaults = { temperature: 0.2, solwyn_tags: { global: "default" } };
    const entryDefaults = { max_tokens: 64, solwyn_tags: { entry: "target" } };
    const caller = {
      model: "gpt-5.5",
      messages: [],
      max_tokens: 200,
      solwyn_tags: { caller: "call" },
    };
    const primary = openAIClient(() => {
      throw Object.assign(new Error("advance"), { status: 500 });
    });
    const anthropic = {
      messages: {
        create: vi.fn((_kwargs: Record<string, unknown>) => ({
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-opus-4",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 3 },
        })),
      },
    };
    const solwyn = new Solwyn(
      primary,
      clientOptions(plane, {
        fetch: traffic.fetch,
        failoverIdempotency: "always",
        defaultParams: defaults,
        fallback: [[anthropic, "claude-opus-4", entryDefaults, "anthropic"]],
      }),
    );

    try {
      await expect(solwyn.chat.completions.create(caller)).rejects.toBe(sentinel);
      const callId = checkBudget.mock.calls[0]?.[0].callId;
      // Normalization stays loud, but paid authority is
      // consumed by measured settlement rather than released as an unpaid provider failure.
      expect(release).not.toHaveBeenCalled();
      const translated = anthropic.messages.create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(translated).not.toHaveProperty("solwyn_tags");
      expect(defaults).toEqual({ temperature: 0.2, solwyn_tags: { global: "default" } });
      expect(entryDefaults).toEqual({ max_tokens: 64, solwyn_tags: { entry: "target" } });
      expect(caller).toMatchObject({ solwyn_tags: { caller: "call" } });
      await solwyn.close();
      expect(traffic.confirms).toHaveLength(1);
      expect(traffic.confirms[0]).toMatchObject({
        call_id: callId,
        provider: "anthropic",
        lease_id: "lease-client-1",
        token_details: { input_tokens: 4, output_tokens: 3 },
      });
      const paidEvents = traffic.ingested.filter((event) => event.provider === "anthropic");
      expect(paidEvents).toHaveLength(1);
      expect(paidEvents[0]).toMatchObject({
        status: "error",
        input_tokens: 4,
        output_tokens: 3,
        failover_error_class: "Error",
      });
    } finally {
      await solwyn.close().catch(() => undefined);
      checkBudget.mockRestore();
      release.mockRestore();
      normalize.mockRestore();
    }
  });
});

describe("client lease activation identity", () => {
  it("uses one SDK instance id for the lease holder and metadata", async () => {
    const grants: Array<Record<string, unknown>> = [];
    const events: WireEvent[] = [];
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (path === "/api/v1/budgets/lease") {
        grants.push(body as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            eligible: true,
            allowed: true,
            lease_id: "lease-core-holder",
            generation: 1,
            // Enough for the configured 512 default, but not the built-in 4096 default:
            // proves the camel-case option reached the real lease ledger.
            granted_tokens: 1_024,
            refresh_interval_s: 300,
            lease_length_s: 600,
            headroom_share_tokens: 0,
            posture: { mode: "alert_only", on_unreachable: "fail_open" },
            final_grant: false,
            project_id: `proj_${"0".repeat(24)}`,
            mode: "alert_only",
            budget_limit: 1_000,
            current_usage: 100,
            remaining_budget: 900,
          }),
          { status: 200 },
        );
      }
      if (path === "/api/v1/metadata/ingest") {
        events.push(...(body as WireEvent[]));
        return new Response(
          JSON.stringify({ ingested: (body as unknown[]).length, rejected: [] }),
          {
            status: 202,
          },
        );
      }
      if (path === "/api/v1/budgets/confirm" || path === "/api/v1/budgets/lease/surrender") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected control-plane path ${path}`);
    };
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
    const solwyn = new Solwyn(provider, {
      apiKey: `sk_proj_${"a".repeat(64)}`,
      fetch,
      leaseEnabled: true,
      leaseOutputBoundDefault: 512,
    });

    await run("core-holder", async () => {
      await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
    });
    await solwyn.close();

    expect(grants).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(grants[0]?.["holder_id"]).toBe(events[0]?.sdk_instance_id);
  });
});

describe("client fail-soft lease accounting", () => {
  afterEach(() => {
    __resetAdapterRegistry();
  });

  it.each([
    {
      name: "synthetic unmeasured usage",
      extract: () => {
        throw new TypeError("extract failed");
      },
      estimate: () => null,
      expectedSpent: 501,
      expectedDetails: { input_tokens: 1, output_tokens: 0, is_estimated: true },
    },
    {
      name: "unmeasured adapter estimate",
      extract: () => {
        throw new TypeError("extract failed");
      },
      estimate: () =>
        createTokenDetails({ input_tokens: 1, output_tokens: 14, is_estimated: true }),
      // An adapter estimate remains unknown paid usage; its original 501-token
      // authority cannot be refunded merely because the estimate reports 15 tokens.
      expectedSpent: 501,
      expectedDetails: { input_tokens: 1, output_tokens: 14, is_estimated: true },
    },
    {
      name: "measured provider usage",
      extract: () => createTokenDetails({ input_tokens: 1, output_tokens: 14 }),
      estimate: () => null,
      expectedSpent: 15,
      expectedDetails: { input_tokens: 1, output_tokens: 14 },
    },
  ])("settles $name at the correct real-lease amount", async (scenario) => {
    const confirms: BudgetConfirmRequest[] = [];
    const surrenders: Array<Record<string, unknown>> = [];
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (path === "/api/v1/budgets/lease") {
        return new Response(
          JSON.stringify({
            eligible: true,
            allowed: true,
            lease_id: "lease-fail-soft-real",
            generation: 1,
            granted_tokens: 2_000,
            refresh_interval_s: 300,
            lease_length_s: 600,
            headroom_share_tokens: 0,
            posture: { mode: "alert_only", on_unreachable: "fail_open" },
            final_grant: false,
            project_id: `proj_${"0".repeat(24)}`,
            mode: "alert_only",
            budget_limit: 1_000,
            current_usage: 100,
            remaining_budget: 900,
          }),
          { status: 200 },
        );
      }
      if (path === "/api/v1/budgets/confirm") {
        confirms.push(body as BudgetConfirmRequest);
        return new Response(null, { status: 204 });
      }
      if (path === "/api/v1/metadata/ingest") {
        return new Response(
          JSON.stringify({ ingested: (body as unknown[]).length, rejected: [] }),
          { status: 202 },
        );
      }
      if (path === "/api/v1/budgets/lease/surrender") {
        surrenders.push(body as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected control-plane path ${path}`);
    };
    __setAdapterLoadersForTesting({
      openai: async () => new LeaseUsageAdapter(scenario.extract, scenario.estimate),
    });
    const response = { id: scenario.name };
    const provider = openAIClient(() => response);
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await run(`fail-soft-${scenario.expectedSpent}`, async () => {
      await expect(
        solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: "abcd" }],
          max_tokens: 500,
        }),
      ).resolves.toBe(response);
    });
    await solwyn.close();

    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.token_details).toMatchObject(scenario.expectedDetails);
    if (scenario.name === "measured provider usage") {
      expect(confirms[0]?.token_details).not.toHaveProperty("is_estimated");
    }
    expect(surrenders).toEqual([
      {
        lease_id: "lease-fail-soft-real",
        holder_id: expect.any(String),
        generation: 1,
        spent_tokens: scenario.expectedSpent,
      },
    ]);
  });
});

describe("Responses unmeasured lease floor", () => {
  it.each([
    {
      name: "native buffered missing usage",
      provider: "openai" as const,
      mode: "buffered" as const,
      expectedDetails: { input_tokens: 2, output_tokens: 0, is_estimated: true },
    },
    {
      name: "Azure streamed compat estimate",
      provider: "azure_openai" as const,
      mode: "streamed" as const,
      expectedDetails: { input_tokens: 2, output_tokens: 2, is_estimated: true },
    },
    {
      name: "native abandoned stream",
      provider: "openai" as const,
      mode: "abandoned" as const,
      expectedDetails: { input_tokens: 2, output_tokens: 0, is_estimated: true },
    },
  ])("holds the reserved output bound for $name", async (scenario) => {
    const confirms: BudgetConfirmRequest[] = [];
    const events: MetadataEvent[] = [];
    const surrenders: Array<Record<string, unknown>> = [];
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (path === "/api/v1/budgets/lease") {
        return new Response(
          JSON.stringify({
            eligible: true,
            allowed: true,
            lease_id: "lease-responses-floor",
            generation: 1,
            granted_tokens: 2_000,
            refresh_interval_s: 300,
            lease_length_s: 600,
            headroom_share_tokens: 0,
            posture: { mode: "alert_only", on_unreachable: "fail_open" },
            final_grant: false,
            project_id: `proj_${"0".repeat(24)}`,
            mode: "alert_only",
            budget_limit: 1_000,
            current_usage: 100,
            remaining_budget: 900,
          }),
          { status: 200 },
        );
      }
      if (path === "/api/v1/budgets/confirm") {
        confirms.push(body as BudgetConfirmRequest);
        return new Response(null, { status: 204 });
      }
      if (path === "/api/v1/metadata/ingest") {
        events.push(...(body as MetadataEvent[]));
        return new Response(
          JSON.stringify({ ingested: (body as unknown[]).length, rejected: [] }),
          { status: 202 },
        );
      }
      if (path === "/api/v1/budgets/lease/surrender") {
        surrenders.push(body as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };
    async function* rawStream(): AsyncGenerator<unknown> {
      if (scenario.mode === "streamed") {
        yield { choices: [{ delta: { content: "12345678" } }] };
        return;
      }
      yield { type: "response.output_text.delta", delta: "first" };
      yield {
        type: "response.completed",
        response: { usage: { input_tokens: 80, output_tokens: 20 } },
      };
    }
    const create = vi.fn((_kwargs: Record<string, unknown>) =>
      scenario.mode === "buffered" ? {} : rawStream(),
    );
    const sdkClient =
      scenario.provider === "azure_openai"
        ? {
            baseURL: "https://example.openai.azure.com/openai/v1",
            chat: { completions: { create: vi.fn() } },
            responses: { create },
          }
        : { responses: { create } };
    const solwyn = new Solwyn(sdkClient, {
      apiKey: API_KEY,
      fetch,
      ...(scenario.provider === "openai" ? { provider: "openai" as const } : {}),
      leaseEnabled: true,
      leaseOutputBoundDefault: 500,
      velocityMode: "off",
    });

    await run(`responses-floor-${scenario.mode}`, async () => {
      const result = await solwyn.responses.create({
        model: "gpt-4o",
        input: "12345678",
        max_output_tokens: 20,
        ...(scenario.mode === "buffered" ? {} : { stream: true }),
      });
      if (scenario.mode === "streamed") {
        for await (const _event of result as AsyncIterable<unknown>) {
          // Drain the usage-less compat stream.
        }
      } else if (scenario.mode === "abandoned") {
        const stream = result as AsyncIterableIterator<unknown>;
        await stream.next();
        await stream.return?.();
      }
    });
    await solwyn.close();

    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.token_details).toMatchObject(scenario.expectedDetails);
    expect(events).toHaveLength(1);
    expect(events[0]?.token_details).toMatchObject(scenario.expectedDetails);
    expect(confirms[0]?.call_id).toBe(events[0]?.call_id);
    expect(surrenders).toEqual([
      {
        lease_id: "lease-responses-floor",
        holder_id: expect.any(String),
        generation: 1,
        spent_tokens: 22,
      },
    ]);
  });
});

describe("client run-control post-budget gate", () => {
  afterEach(() => {
    resetRunControlForTest();
    vi.restoreAllMocks();
  });

  it("releases the live funding claim and denies when a local stop lands during budget I/O", async () => {
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    let runId = "";
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockImplementation(async (request) => {
        runId = request.agentRunId ?? "";
        markTerminated(runId, { reason: "monotonic_growth", source: "local_velocity" });
        return fundedLeaseDecision();
      });
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const reports: MetadataEvent[] = [];
    vi.spyOn(MetadataReporter.prototype, "report").mockImplementation((event) => {
      reports.push(event);
    });
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      fetch: async () => new Response(null, { status: 204 }),
      leaseEnabled: false,
      velocityMode: "off",
    });

    let caught: unknown;
    try {
      await run("post-budget-stop", async () => {
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [] })
          .catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    expect(caught).toBeInstanceOf(RunStoppedError);
    expect(caught).toMatchObject({
      agentRunId: runId,
      reason: "monotonic_growth",
      source: "local_velocity",
    });
    expect(checkBudget).toHaveBeenCalledTimes(1);
    expect(provider.chat.completions.create).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.any(String), 77);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "budget_denied",
      deny_source: "run_terminated",
      deny_reason: "monotonic_growth",
      denied_by_period: "run_stopped",
    });
  });

  it("gives a retained server stop one live allow check that clears it before dispatch", async () => {
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    let checks = 0;
    const fetch: FetchLike = async (input) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/budgets/check") {
        checks += 1;
        return new Response(
          JSON.stringify({
            allowed: true,
            remaining_budget: 100,
            reservation_id: null,
            mode: "alert_only",
            budget_limit: 100,
            current_usage: 0,
            denied_by_period: null,
            project_id: `proj_${"0".repeat(24)}`,
            price_hints: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
    };
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      fetch,
      leaseEnabled: false,
      velocityMode: "off",
    });

    let runId = "";
    try {
      await run("server-live-check", async () => {
        runId = currentRun()?.agentRunId ?? "";
        markTerminated(runId, { reason: "prior_server_stop", source: "server" });
        await expect(
          solwyn.chat.completions.create({ model: "gpt-4o", messages: [] }),
        ).resolves.toMatchObject({ usage: { prompt_tokens: 2, completion_tokens: 1 } });
      });
    } finally {
      await solwyn.close();
    }

    expect(checks).toBe(1);
    expect(provider.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(runTermination(runId)).toBeUndefined();
  });

  it.each([
    "server",
    "sticky_replay",
  ] as const)("preserves an exact server stop as an ordinary %s denial without releasing unfunded work", async (denySource) => {
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: false,
        remainingBudget: 0,
        deniedByPeriod: "run_stopped",
        denySource,
        denyReason: "server_policy",
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const reports: MetadataEvent[] = [];
    vi.spyOn(MetadataReporter.prototype, "report").mockImplementation((event) => {
      reports.push(event);
    });
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      fetch: async () => new Response(null, { status: 204 }),
      leaseEnabled: false,
      velocityMode: "off",
    });

    let runId = "";
    let caught: unknown;
    try {
      await run(`ordinary-${denySource}`, async () => {
        runId = currentRun()?.agentRunId ?? "";
        markTerminated(runId, { reason: "server_policy", source: "server" });
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [] })
          .catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    expect(caught).toMatchObject({
      agentRunId: runId,
      reason: "server_policy",
      source: "server",
    });
    expect(provider.chat.completions.create).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "budget_denied",
      agent_run_id: runId,
      deny_source: denySource,
      deny_reason: "server_policy",
      denied_by_period: "run_stopped",
    });
  });

  it.each([
    {
      name: "matching server run_stopped denial",
      decision: budgetCheckResult({
        allowed: false,
        remainingBudget: 0,
        deniedByPeriod: "run_stopped",
        denySource: "server",
        denyReason: "server_pending_collision",
      }),
      expectedReceiptSource: "server",
      expectedReleaseToken: null,
    },
    {
      name: "matching sticky replay run_stopped denial",
      decision: budgetCheckResult({
        allowed: false,
        remainingBudget: 0,
        deniedByPeriod: "run_stopped",
        denySource: "sticky_replay",
        denyReason: "server_pending_collision",
      }),
      expectedReceiptSource: "sticky_replay",
      expectedReleaseToken: null,
    },
    {
      name: "funded non-stopped denial",
      decision: budgetCheckResult({
        allowed: false,
        remainingBudget: 0,
        deniedByPeriod: "monthly",
        denySource: "server",
        denyReason: "monthly",
        leaseId: "lease-pending-collision",
        leaseClaimToken: 81,
      }),
      expectedReceiptSource: "run_terminated",
      expectedReleaseToken: 81,
    },
  ])("keeps the server winner when pending local velocity meets $name", async (scenario) => {
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    const checkBudget = vi
      .spyOn(BudgetEnforcer.prototype, "checkBudget")
      .mockResolvedValueOnce(budgetCheckResult({ allowed: true, remainingBudget: 100 }))
      .mockResolvedValueOnce(scenario.decision);
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const reports: MetadataEvent[] = [];
    vi.spyOn(MetadataReporter.prototype, "report").mockImplementation((event) => {
      reports.push(event);
    });
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      fetch: async () => new Response(null, { status: 204 }),
      leaseEnabled: false,
      velocityMode: "deny",
      velocityRepeatCount: 2,
      velocityRepeatWindowS: 60,
    });

    let runId = "";
    let caught: unknown;
    try {
      await run(`pending-collision-${scenario.expectedReceiptSource}`, async () => {
        runId = currentRun()?.agentRunId ?? "";
        await solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
        markTerminated(runId, {
          reason: "server_pending_collision",
          source: "server",
        });
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [] })
          .catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    expect(checkBudget).toHaveBeenCalledTimes(2);
    expect(caught).toBeInstanceOf(RunStoppedError);
    expect(caught).toMatchObject({
      agentRunId: runId,
      reason: "server_pending_collision",
      source: "server",
    });
    expect(provider.chat.completions.create).toHaveBeenCalledTimes(1);
    const secondCallId = checkBudget.mock.calls[1]?.[0].callId;
    if (scenario.expectedReleaseToken === null) {
      expect(release).not.toHaveBeenCalled();
    } else {
      expect(release.mock.calls).toEqual([[secondCallId, scenario.expectedReleaseToken]]);
    }
    const denials = reports.filter((event) => event.status === "budget_denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      agent_run_id: runId,
      deny_source: scenario.expectedReceiptSource,
      deny_reason: "server_pending_collision",
      denied_by_period: "run_stopped",
      velocity_flags: ["repeat_size"],
    });
  });

  it("uses a registry-evicted active handle to retain the ordinary server-denial branch", async () => {
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(
      budgetCheckResult({
        allowed: false,
        remainingBudget: 0,
        deniedByPeriod: "run_stopped",
      }),
    );
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      fetch: async () => new Response(null, { status: 204 }),
      leaseEnabled: false,
      velocityMode: "off",
    });

    let handle: ReturnType<typeof acquireTerminationHandle> | undefined;
    let runId = "";
    let caught: unknown;
    try {
      await run("evicted-server-handle", async () => {
        runId = currentRun()?.agentRunId ?? "";
        handle = acquireTerminationHandle(runId);
        markTerminated(runId, { reason: "server_handle_only", source: "server" });
        for (let index = 0; index < 257; index += 1) {
          markTerminated(`evict-server-${index}`, { reason: "evict", source: "server" });
        }
        expect(runTermination(runId)).toBeUndefined();
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [] })
          .catch((error: unknown) => error);
      });
    } finally {
      handle?.release();
      await solwyn.close();
    }

    expect(caught).toMatchObject({
      agentRunId: runId,
      reason: "server_handle_only",
      source: "server",
    });
    expect(provider.chat.completions.create).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a funded allow",
      decision: fundedLeaseDecision(),
    },
    {
      name: "a funded monthly denial",
      decision: budgetCheckResult({
        allowed: false,
        remainingBudget: 0,
        deniedByPeriod: "monthly",
        denySource: "server",
        denyReason: "monthly",
        leaseId: "lease-client-1",
        leaseClaimToken: 77,
      }),
    },
  ])("makes a retained server winner override $name and releases once", async ({ decision }) => {
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    vi.spyOn(BudgetEnforcer.prototype, "checkBudget").mockResolvedValue(decision);
    const release = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const reports: MetadataEvent[] = [];
    vi.spyOn(MetadataReporter.prototype, "report").mockImplementation((event) => {
      reports.push(event);
    });
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      fetch: async () => new Response(null, { status: 204 }),
      leaseEnabled: false,
      velocityMode: "off",
    });

    let runId = "";
    let caught: unknown;
    try {
      await run("retained-server-winner", async () => {
        runId = currentRun()?.agentRunId ?? "";
        markTerminated(runId, { reason: "newer_server_winner", source: "server" });
        caught = await solwyn.chat.completions
          .create({ model: "gpt-4o", messages: [] })
          .catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
    }

    expect(caught).toMatchObject({
      agentRunId: runId,
      reason: "newer_server_winner",
      source: "server",
    });
    expect(provider.chat.completions.create).not.toHaveBeenCalled();
    expect(release.mock.calls).toEqual([[expect.any(String), 77]]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "budget_denied",
      agent_run_id: runId,
      deny_source: "run_terminated",
      deny_reason: "newer_server_winner",
      denied_by_period: "run_stopped",
    });
  });

  it("preserves a matching v1 directive across resident and registry-evicted outage replay", async () => {
    let checks = 0;
    let directiveRunId = "";
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      if (path === "/api/v1/budgets/check") {
        checks += 1;
        if (checks === 1) {
          const body = JSON.parse(String(init?.body)) as { agent_run_id: string };
          directiveRunId = body.agent_run_id;
          return new Response(
            JSON.stringify({
              allowed: true,
              remaining_budget: 100,
              reservation_id: null,
              mode: "alert_only",
              budget_limit: 100,
              current_usage: 0,
              denied_by_period: null,
              project_id: `proj_${"0".repeat(24)}`,
              price_hints: null,
              run_control: {
                version: "1",
                action: "terminate",
                agent_run_id: directiveRunId,
                reason: "server_directive",
              },
            }),
            { status: 200 },
          );
        }
        throw new TypeError("offline");
      }
      return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
    };
    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    const reports: MetadataEvent[] = [];
    vi.spyOn(MetadataReporter.prototype, "report").mockImplementation((event) => {
      reports.push(event);
    });
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      fetch,
      failOpen: true,
      leaseEnabled: false,
      budgetCheckCacheTtl: 0,
      velocityMode: "off",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    const failures: unknown[] = [];
    try {
      await run("directive-run", async () => {
        failures.push(
          await solwyn.chat.completions
            .create({ model: "gpt-4o", messages: [] })
            .catch((error: unknown) => error),
        );
        failures.push(
          await solwyn.chat.completions
            .create({ model: "gpt-4o", messages: [] })
            .catch((error: unknown) => error),
        );
        for (let index = 0; index < 257; index += 1) {
          markTerminated(`evict-directive-${index}`, { reason: "evict", source: "server" });
        }
        expect(runTermination(directiveRunId)).toBeUndefined();
        failures.push(
          await solwyn.chat.completions
            .create({ model: "gpt-4o", messages: [] })
            .catch((error: unknown) => error),
        );
      });
    } finally {
      await solwyn.close();
    }

    expect(checks).toBe(3);
    expect(provider.chat.completions.create).not.toHaveBeenCalled();
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure).toMatchObject({
        agentRunId: directiveRunId,
        reason: "server_directive",
        source: "server",
      });
    }
    expect(reports).toHaveLength(3);
    expect(reports.map((event) => [event.deny_source, event.deny_reason])).toEqual([
      ["server", "server_directive"],
      ["sticky_replay", "server_directive"],
      ["sticky_replay", "server_directive"],
    ]);
  });
});
