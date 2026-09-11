import { afterEach, describe, expect, it, vi } from "vitest";
import { zeroTokenDetails } from "../../src/token-details";
import type { BudgetConfirmRequest, LeaseGrantResponse, MetadataEvent } from "../../src/types";
import { BudgetConfirmRequestSchema, MetadataEventSchema } from "../../src/validation";

const API_URL = "https://api.solwyn.test";
const API_KEY = `sk_proj_${"a".repeat(64)}`;
const HOOK = Symbol.for("@solwyn/sdk/node-reporter-registration");
const LEASE_HOOK = Symbol.for("@solwyn/sdk/node-lease-registration");
const REGISTRY = Symbol.for("@solwyn/sdk/node-reporter-registry");
const LEASE_URL = `${API_URL}/api/v1/budgets/lease`;
const SURRENDER_URL = `${API_URL}/api/v1/budgets/lease/surrender`;

function event(index: number) {
  return MetadataEventSchema.parse({
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 1,
    output_tokens: 1,
    latency_ms: 1,
    status: "success",
    is_model_fallback: false,
    call_id: `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`,
    sdk_instance_id: "sdk-node-exit",
    timestamp: "2026-08-31T00:00:00Z",
  });
}

function deniedEvent(index: number, receiptWeight: number) {
  return MetadataEventSchema.parse({
    ...event(index),
    status: "budget_denied",
    deny_source: "server",
    deny_reason: "monthly",
    denied_by_period: "monthly",
    receipt_aggregate_count: receiptWeight,
  });
}

function confirm(index: number) {
  return BudgetConfirmRequestSchema.parse({
    reservation_id: `res-${index}`,
    model: "gpt-4o",
    provider: "openai",
    call_id: `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`,
    token_details: zeroTokenDetails(),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function leaseGrant(): LeaseGrantResponse {
  return {
    eligible: true,
    allowed: true,
    lease_id: "node-exit-lease",
    generation: 1,
    granted_tokens: 2_000,
    refresh_interval_s: 300,
    lease_length_s: 600,
    headroom_share_tokens: 500,
    posture: { mode: "alert_only", on_unreachable: "fail_open" },
    final_grant: false,
    project_id: `proj_${"0".repeat(24)}`,
    mode: "alert_only",
    budget_limit: 100,
    current_usage: 20,
    remaining_budget: 80,
  };
}

async function flushUntil(predicate: () => boolean, turns = 50): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, HOOK);
  Reflect.deleteProperty(globalThis, LEASE_HOOK);
  Reflect.deleteProperty(globalThis, REGISTRY);
});

describe("node beforeExit reporter drain", () => {
  // Mutation caught: omitting the reporter's terminal fold take during the
  // beforeExit close loses replay before confirms/settlements/events and lets
  // lease cleanup observe an incomplete reporter drain.
  it("attempts final replay with ordinary queues before lease cleanup", async () => {
    vi.resetModules();
    let beforeExit: (() => Promise<void>) | undefined;
    vi.spyOn(process, "once").mockImplementation(((eventName: string, listener: () => void) => {
      if (eventName === "beforeExit") beforeExit = listener as () => Promise<void>;
      return process;
    }) as typeof process.once);
    await import("../../src/node");
    const { MetadataReporter } = await import("../../src/reporter");
    const order: string[] = [];
    const ingestBodies: MetadataEvent[][] = [];
    const reporter = new MetadataReporter(API_URL, API_KEY, {
      flushInterval: 1_000_000,
      maxQueueSize: 1,
      fetch: async (url, init) => {
        if (url.endsWith("/budgets/confirm")) {
          const body = JSON.parse(String(init?.body)) as BudgetConfirmRequest;
          order.push(`confirm:${body.reservation_id}`);
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body)) as MetadataEvent[];
        ingestBodies.push(body);
        order.push("ingest");
        return new Response(
          JSON.stringify({ ingested: body.length - 1, rejected: [{ index: 1 }] }),
          { status: 202 },
        );
      },
    });
    reporter.report(deniedEvent(40, 7));
    reporter.report(event(41));
    reporter.reportConfirm(confirm(42));
    reporter.reportSettlement(confirm(43), event(43));
    const registerLease = Reflect.get(globalThis, LEASE_HOOK) as (holder: unknown) => void;
    registerLease({
      isClosed: false,
      close: async () => {
        order.push("lease");
      },
    });

    await beforeExit?.();

    expect(order).toEqual(["confirm:res-42", "confirm:res-43", "ingest", "lease"]);
    expect(ingestBodies).toHaveLength(1);
    expect(ingestBodies[0]?.map((item) => item.status)).toEqual([
      "success",
      "budget_denied",
      "success",
    ]);
    expect(ingestBodies[0]?.[1]).toMatchObject({
      deny_source: "aggregate_replay",
      receipt_aggregate_count: 7,
    });
    expect(reporter.droppedCounts).toEqual({ "event.ingest_rejected": 7 });
  });

  it("weakly registers live reporters and concurrently drains only through injected fetch", async () => {
    vi.resetModules();
    let beforeExit: (() => Promise<void>) | undefined;
    vi.spyOn(process, "once").mockImplementation(((eventName: string, listener: () => void) => {
      if (eventName === "beforeExit") beforeExit = listener as () => Promise<void>;
      return process;
    }) as typeof process.once);
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("global fetch must not be used"));
    await import("../../src/node");
    const { MetadataReporter } = await import("../../src/reporter");
    const firstGate = deferred<Response>();
    const secondGate = deferred<Response>();
    const firstFetch = vi.fn(() => firstGate.promise);
    const secondFetch = vi.fn(() => secondGate.promise);
    const first = new MetadataReporter(API_URL, API_KEY, { fetch: firstFetch });
    const second = new MetadataReporter(API_URL, API_KEY, { fetch: secondFetch });
    const alreadyClosed = new MetadataReporter(API_URL, API_KEY, {
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
      shutdownDeadline: 0,
    });
    first.report(event(1));
    second.reportConfirm(confirm(2));
    await alreadyClosed.close();

    const draining = beforeExit?.();
    for (let turn = 0; turn < 20 && firstFetch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }

    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    firstGate.resolve(new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 }));
    secondGate.resolve(new Response(null, { status: 204 }));
    await draining;
    expect(first.isShutdown).toBe(true);
    expect(second.isShutdown).toBe(true);
  });

  it("re-arms beforeExit when a reporter registers during an active drain", async () => {
    vi.resetModules();
    const beforeExitListeners: Array<() => Promise<void>> = [];
    vi.spyOn(process, "once").mockImplementation(((eventName: string, listener: () => void) => {
      if (eventName === "beforeExit") {
        beforeExitListeners.push(listener as () => Promise<void>);
      }
      return process;
    }) as typeof process.once);
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("global fetch must not be used"));
    await import("../../src/node");
    const { MetadataReporter } = await import("../../src/reporter");

    const firstGate = deferred<Response>();
    const firstFetch = vi.fn(() => firstGate.promise);
    const first = new MetadataReporter(API_URL, API_KEY, { fetch: firstFetch });
    first.report(event(10));

    const firstDrain = beforeExitListeners[0]?.();
    for (let turn = 0; turn < 20 && firstFetch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(firstFetch).toHaveBeenCalledTimes(1);

    const secondGate = deferred<Response>();
    const secondFetch = vi.fn(() => secondGate.promise);
    const second = new MetadataReporter(API_URL, API_KEY, { fetch: secondFetch });
    second.reportConfirm(confirm(11));

    expect(beforeExitListeners).toHaveLength(2);
    expect(secondFetch).not.toHaveBeenCalled();

    firstGate.resolve(new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 }));
    await firstDrain;
    expect(first.isShutdown).toBe(true);
    expect(second.isShutdown).toBe(false);

    const secondDrain = beforeExitListeners[1]?.();
    for (let turn = 0; turn < 20 && secondFetch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    secondGate.resolve(new Response(null, { status: 204 }));
    await secondDrain;
    expect(second.isShutdown).toBe(true);
  });

  it("installs one listener and drains reporters before lease holders through injected fetch", async () => {
    vi.resetModules();
    const beforeExitListeners: Array<() => Promise<void>> = [];
    vi.spyOn(process, "once").mockImplementation(((eventName: string, listener: () => void) => {
      if (eventName === "beforeExit") {
        beforeExitListeners.push(listener as () => Promise<void>);
      }
      return process;
    }) as typeof process.once);
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("global fetch must not be used"));
    await import("../../src/node");
    const { MetadataReporter } = await import("../../src/reporter");
    const { BudgetEnforcer } = await import("../../src/budget");
    const order: string[] = [];
    const reporterGate = deferred<Response>();
    const reporterFetch = vi.fn(() => {
      order.push("reporter");
      return reporterGate.promise;
    });
    const surrenderFetch = vi.fn(async (url: string) => {
      if (url === LEASE_URL) return new Response(JSON.stringify(leaseGrant()), { status: 200 });
      if (url === SURRENDER_URL) {
        order.push("lease");
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected test URL");
    });
    const reporter = new MetadataReporter(API_URL, API_KEY, { fetch: reporterFetch });
    reporter.report(event(20));
    const budget = new BudgetEnforcer({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: surrenderFetch,
      leaseEnabled: true,
      holderId: "node-holder",
    });
    await budget.checkBudget({
      agentRunId: "run-node-exit",
      callId: "00000000-0000-0000-0000-000000000020",
      estimatedInputTokens: 100,
      estimatedOutputBound: 500,
      model: "gpt-5.5",
      provider: "openai",
    });
    const close = vi.spyOn(budget, "close");

    expect(beforeExitListeners).toHaveLength(1);
    const draining = beforeExitListeners[0]?.();
    await flushUntil(() => reporterFetch.mock.calls.length === 1);
    expect(order).toEqual(["reporter"]);
    expect(surrenderFetch).toHaveBeenCalledTimes(1);

    reporterGate.resolve(
      new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 }),
    );
    await flushUntil(() => order.includes("lease"));
    await draining;

    expect(order).toEqual(["reporter", "lease"]);
    expect(close).toHaveBeenCalledWith(2_000);
    expect(budget.isClosed).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("bounds the entire lease phase by one real 2,000ms race when a holder ignores its timeout", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    let beforeExit: (() => Promise<void>) | undefined;
    vi.spyOn(process, "once").mockImplementation(((eventName: string, listener: () => void) => {
      if (eventName === "beforeExit") beforeExit = listener as () => Promise<void>;
      return process;
    }) as typeof process.once);
    await import("../../src/node");
    const register = Reflect.get(globalThis, LEASE_HOOK) as (holder: unknown) => void;
    const close = vi.fn(() => new Promise<void>(() => {}));
    register({ isClosed: false, close });
    register({ isClosed: true, close: vi.fn() });

    let settled = false;
    const draining = beforeExit?.().then(() => {
      settled = true;
    });
    await flushUntil(() => close.mock.calls.length === 1);
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(2_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await draining;
    expect(settled).toBe(true);
  });

  it("re-arms when a lease holder registers during the reporter snapshot drain", async () => {
    vi.resetModules();
    const beforeExitListeners: Array<() => Promise<void>> = [];
    vi.spyOn(process, "once").mockImplementation(((eventName: string, listener: () => void) => {
      if (eventName === "beforeExit") {
        beforeExitListeners.push(listener as () => Promise<void>);
      }
      return process;
    }) as typeof process.once);
    await import("../../src/node");
    const { MetadataReporter } = await import("../../src/reporter");
    const reporterGate = deferred<Response>();
    const reporterFetch = vi.fn(() => reporterGate.promise);
    const reporter = new MetadataReporter(API_URL, API_KEY, { fetch: reporterFetch });
    reporter.report(event(30));

    const firstDrain = beforeExitListeners[0]?.();
    await flushUntil(() => reporterFetch.mock.calls.length === 1);
    const register = Reflect.get(globalThis, LEASE_HOOK) as (holder: unknown) => void;
    const holderClose = vi.fn(async () => {});
    register({ isClosed: false, close: holderClose });
    expect(beforeExitListeners).toHaveLength(2);

    reporterGate.resolve(
      new Response(JSON.stringify({ ingested: 1, rejected: [] }), { status: 202 }),
    );
    await firstDrain;
    expect(holderClose).not.toHaveBeenCalled();

    await beforeExitListeners[1]?.();
    expect(holderClose).toHaveBeenCalledOnce();
    expect(holderClose).toHaveBeenCalledWith(2_000);
  });
});
