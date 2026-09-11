import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { CircuitBreaker } from "../../src/circuit-breaker";
import { RunStoppedError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { currentRun, run } from "../../src/node";
import {
  acquireTerminationHandle,
  markTerminated,
  postcheckTermination,
  resetRunControlForTest,
  runTermination,
  setRunControlClockForTest,
  type TerminationHandle,
} from "../../src/run-control";
import type { FetchLike } from "../../src/transport";
import type {
  BudgetCheckRequest,
  BudgetCheckResponse,
  BudgetConfirmRequest,
  MetadataEvent,
} from "../../src/types";

const API_KEY = `sk_proj_${"a".repeat(64)}`;
const API_URL = "https://api.solwyn.test";
const PROJECT_ID = `proj_${"0".repeat(24)}`;

const PRE_STOP_TOKEN_DETAILS = {
  input_tokens: 11,
  output_tokens: 7,
  cached_input_tokens: 3,
  cache_creation_5m_tokens: 2,
  cache_creation_1h_tokens: 0,
  reasoning_tokens: 4,
  audio_input_tokens: 1,
  audio_output_tokens: 1,
  image_input_tokens: 0,
  image_output_tokens: 0,
  accepted_prediction_tokens: 2,
  rejected_prediction_tokens: 1,
  tool_use_input_tokens: 0,
} as const;

let monotonicNow = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function checkResponse(overrides: Partial<BudgetCheckResponse> = {}): BudgetCheckResponse {
  return {
    allowed: true,
    remaining_budget: 900,
    reservation_id: null,
    mode: "alert_only",
    budget_limit: 1_000,
    current_usage: 100,
    denied_by_period: null,
    project_id: PROJECT_ID,
    price_hints: null,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function callId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function checkOptions(runId: string, index: number) {
  return {
    estimatedInputTokens: 5,
    estimatedOutputBound: 13,
    model: "gpt-4o",
    provider: "openai" as const,
    fallbackProviders: [],
    fallbackModels: [],
    agentRunId: runId,
    callId: callId(index),
  };
}

function enforcer(fetch: FetchLike): BudgetEnforcer {
  return new BudgetEnforcer({
    apiUrl: API_URL,
    apiKey: API_KEY,
    fetch,
    leaseEnabled: false,
    cacheTtl: 0,
    holderId: "task-11-holder",
  });
}

function openAIClient(impl: (kwargs: Record<string, unknown>) => unknown) {
  const create = vi.fn((kwargs: Record<string, unknown>) => impl(kwargs));
  return { chat: { completions: { create } } };
}

beforeEach(() => {
  monotonicNow = 0;
  resetRunControlForTest();
  vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  setRunControlClockForTest(() => monotonicNow);
});

afterEach(() => {
  resetRunControlForTest();
  vi.restoreAllMocks();
});

describe("public run-abort acceptance", () => {
  it("applies an independent directive after a served chunk and settles only pre-stop usage once", async () => {
    const breakerFailure = vi.spyOn(CircuitBreaker.prototype, "recordFailure");
    const checkBudgetCalls = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
    const publicChecks: BudgetCheckRequest[] = [];
    const confirms: BudgetConfirmRequest[] = [];
    const ingestCalls: MetadataEvent[][] = [];
    const publicFetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (path === "/api/v1/budgets/check") {
        publicChecks.push(body as BudgetCheckRequest);
        return response(checkResponse({ reservation_id: "reservation-public-stream" }));
      }
      if (path === "/api/v1/budgets/confirm") {
        confirms.push(body as BudgetConfirmRequest);
        return new Response(null, { status: 204 });
      }
      if (path === "/api/v1/metadata/ingest") {
        const events = body as MetadataEvent[];
        ingestCalls.push(events);
        return response({ ingested: events.length, rejected: [] }, 202);
      }
      throw new Error(`unexpected public control-plane path ${path}`);
    };

    const publisherChecks: BudgetCheckRequest[] = [];
    let runId = "";
    const publisher = enforcer(async (input, init) => {
      const path = new URL(input).pathname;
      if (path !== "/api/v1/budgets/check") {
        throw new Error(`unexpected publisher path ${path}`);
      }
      publisherChecks.push(JSON.parse(String(init?.body)) as BudgetCheckRequest);
      return response(
        checkResponse({
          reservation_id: "reservation-publisher-stranded",
          run_control: {
            version: "1",
            action: "terminate",
            agent_run_id: runId,
            reason: "dashboard_stop",
          },
        }),
      );
    });

    let rawPulls = 0;
    let providerCloses = 0;
    async function* rawStream(): AsyncGenerator<unknown> {
      try {
        rawPulls += 1;
        yield {
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            prompt_tokens_details: {
              cached_tokens: 3,
              cache_write_tokens: 2,
              audio_tokens: 1,
            },
            completion_tokens_details: {
              reasoning_tokens: 4,
              audio_tokens: 1,
              accepted_prediction_tokens: 2,
              rejected_prediction_tokens: 1,
            },
          },
        };
        rawPulls += 1;
        yield {
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 999,
            completion_tokens: 999,
            prompt_tokens_details: { cached_tokens: 999 },
            completion_tokens_details: { reasoning_tokens: 999 },
          },
        };
      } finally {
        providerCloses += 1;
      }
    }
    const rawIterator = rawStream();
    const rawNext = vi.spyOn(rawIterator, "next");
    const rawReturn = vi.spyOn(rawIterator, "return");
    const provider = openAIClient(() => rawIterator);
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      apiUrl: API_URL,
      fetch: publicFetch,
      leaseEnabled: false,
      breakerReportingEnabled: false,
      velocityMode: "off",
    });

    const callerVisible: unknown[] = [];
    let publisherResult: Awaited<ReturnType<BudgetEnforcer["checkBudget"]>> | undefined;
    let firstError: unknown;
    let repeatedError: unknown;
    let pullsAfterFirst = 0;
    try {
      await run("task-11-public-stream", async () => {
        runId = currentRun()?.agentRunId ?? "";
        const stream = (await solwyn.chat.completions.create({
          model: "gpt-4o",
          messages: [],
          stream: true,
        })) as AsyncIterableIterator<unknown>;

        const first = await stream.next();
        if (!first.done) callerVisible.push(first.value);
        pullsAfterFirst = rawPulls;

        monotonicNow = 20;
        publisherResult = await publisher.checkBudget(checkOptions(runId, 2));
        firstError = await stream.next().catch((error: unknown) => error);
        expect(firstError).toBeInstanceOf(RunStoppedError);
        expect(firstError).toMatchObject({
          agentRunId: runId,
          reason: "dashboard_stop",
          source: "server",
        });

        markTerminated(runId, { reason: "release-proof", source: "server" });
        for (let index = 0; index <= 256; index += 1) {
          markTerminated(`task-11-stream-eviction-${index}`, {
            reason: "evict",
            source: "server",
          });
        }
        expect(postcheckTermination(runId)).toBeUndefined();

        repeatedError = await stream.next().catch((error: unknown) => error);
      });
    } finally {
      await solwyn.close();
      await publisher.close(0);
    }

    expect(runId).toMatch(/^run_[0-9a-f-]{36}$/);
    expect(publicChecks).toHaveLength(1);
    expect(checkBudgetCalls).toHaveBeenCalledTimes(2);
    expect(publicChecks[0]).toMatchObject({
      agent_run_id: runId,
      run_directive_version: "1",
    });
    expect(publisherChecks).toHaveLength(1);
    expect(publisherChecks[0]).toMatchObject({
      agent_run_id: runId,
      run_directive_version: "1",
    });
    expect(publisherResult).toMatchObject({
      allowed: false,
      reservationId: null,
      mode: "hard_deny",
      deniedByPeriod: "run_stopped",
      denySource: "server",
      denyReason: "dashboard_stop",
    });

    expect(provider.chat.completions.create).toHaveBeenCalledOnce();
    expect(callerVisible).toEqual([
      {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          prompt_tokens_details: {
            cached_tokens: 3,
            cache_write_tokens: 2,
            audio_tokens: 1,
          },
          completion_tokens_details: {
            reasoning_tokens: 4,
            audio_tokens: 1,
            accepted_prediction_tokens: 2,
            rejected_prediction_tokens: 1,
          },
        },
      },
    ]);
    expect(pullsAfterFirst).toBe(1);
    expect(rawPulls - pullsAfterFirst).toBe(1);
    expect(rawPulls).toBe(2);
    expect(rawNext).toHaveBeenCalledTimes(2);
    expect(rawReturn).toHaveBeenCalledTimes(1);
    expect(providerCloses).toBe(1);
    expect(repeatedError).toBe(firstError);

    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({
      reservation_id: "reservation-public-stream",
      provider: "openai",
      model: "gpt-4o",
      is_provider_fallback: false,
    });
    expect(confirms[0]?.token_details).toEqual(PRE_STOP_TOKEN_DETAILS);
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0]).toHaveLength(1);
    const event = ingestCalls[0]?.[0];
    expect(event).toMatchObject({
      status: "success",
      provider: "openai",
      model: "gpt-4o",
      input_tokens: 11,
      output_tokens: 7,
      agent_run_id: runId,
      agent_run_name: "task-11-public-stream",
    });
    expect(event?.token_details).toEqual(PRE_STOP_TOKEN_DETAILS);
    expect(confirms[0]?.call_id).toBe(checkBudgetCalls.mock.calls[0]?.[0].callId);
    expect(confirms[0]?.call_id).toBe(event?.call_id);
    expect(ingestCalls.flat().filter((item) => item.status === "error")).toEqual([]);
    expect(breakerFailure).not.toHaveBeenCalled();
  });

  it.each([
    ["older", 100, 200],
    ["equal", 200, 200],
  ] as const)("keeps an entered public %s ALLOW behind an independent directive and clears only later", async (_relation, requestEpoch, directiveEpoch) => {
    monotonicNow = requestEpoch;
    const enteredPost = deferred<void>();
    const delayedAllow = deferred<Response>();
    const publicChecks: BudgetCheckRequest[] = [];
    const confirms: BudgetConfirmRequest[] = [];
    const ingestCalls: MetadataEvent[][] = [];
    const publicFetch: FetchLike = async (input, init) => {
      const path = new URL(input).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (path === "/api/v1/budgets/check") {
        publicChecks.push(body as BudgetCheckRequest);
        enteredPost.resolve();
        return delayedAllow.promise;
      }
      if (path === "/api/v1/budgets/confirm") {
        confirms.push(body as BudgetConfirmRequest);
        return new Response(null, { status: 204 });
      }
      if (path === "/api/v1/metadata/ingest") {
        const events = body as MetadataEvent[];
        ingestCalls.push(events);
        return response({ ingested: events.length, rejected: [] }, 202);
      }
      throw new Error(`unexpected public control-plane path ${path}`);
    };

    let runId = "";
    const publisherChecks: BudgetCheckRequest[] = [];
    const publisher = enforcer(async (input, init) => {
      const path = new URL(input).pathname;
      if (path !== "/api/v1/budgets/check") {
        throw new Error(`unexpected publisher path ${path}`);
      }
      publisherChecks.push(JSON.parse(String(init?.body)) as BudgetCheckRequest);
      if (publisherChecks.length === 1) {
        return response(
          checkResponse({
            reservation_id: "reservation-publisher-stranded",
            run_control: {
              version: "1",
              action: "terminate",
              agent_run_id: runId,
              reason: "first_server_reason",
            },
          }),
        );
      }
      return response(checkResponse());
    });

    const provider = openAIClient(() => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const releaseReservation = vi.spyOn(BudgetEnforcer.prototype, "releaseReservation");
    const solwyn = new Solwyn(provider, {
      apiKey: API_KEY,
      apiUrl: API_URL,
      fetch: publicFetch,
      leaseEnabled: false,
      breakerReportingEnabled: false,
      velocityMode: "off",
    });

    let oldHandle: TerminationHandle | undefined;
    let newHandle: TerminationHandle | undefined;
    let publisherResult: Awaited<ReturnType<BudgetEnforcer["checkBudget"]>> | undefined;
    let laterAllow: Awaited<ReturnType<BudgetEnforcer["checkBudget"]>> | undefined;
    let caught: unknown;
    let registryBeforeClear: ReturnType<typeof runTermination>;
    let stickyBeforeClear = false;
    let registryAfterClear: ReturnType<typeof runTermination>;
    let stickyAfterClear = true;
    let oldHandleWinnerAfterClear: ReturnType<TerminationHandle["check"]>;
    let newHandleWinnerAfterClear: ReturnType<TerminationHandle["check"]>;
    try {
      const publicCall = run(`task-11-${_relation}-allow`, async () => {
        runId = currentRun()?.agentRunId ?? "";
        return solwyn.chat.completions.create({ model: "gpt-4o", messages: [] });
      });

      await enteredPost.promise;
      monotonicNow = directiveEpoch;
      publisherResult = await publisher.checkBudget(checkOptions(runId, 10));

      delayedAllow.resolve(
        response(checkResponse({ reservation_id: "reservation-entered-allow-stranded" })),
      );
      caught = await publicCall.catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(RunStoppedError);
      expect(caught).toMatchObject({
        agentRunId: runId,
        reason: "first_server_reason",
        source: "server",
      });

      registryBeforeClear = runTermination(runId);
      stickyBeforeClear = publisher.hasStickyHardDeny;
      expect(registryBeforeClear).toMatchObject({
        reason: "first_server_reason",
        source: "server",
      });
      expect(stickyBeforeClear).toBe(true);

      monotonicNow = directiveEpoch + 1;
      oldHandle = acquireTerminationHandle(runId);
      laterAllow = await publisher.checkBudget(checkOptions(runId, 11));
      registryAfterClear = runTermination(runId);
      stickyAfterClear = publisher.hasStickyHardDeny;
      newHandle = acquireTerminationHandle(runId);
      oldHandleWinnerAfterClear = oldHandle.check();
      newHandleWinnerAfterClear = newHandle.check();
    } finally {
      oldHandle?.release();
      newHandle?.release();
      await solwyn.close();
      await publisher.close(0);
    }

    expect(runId).toMatch(/^run_[0-9a-f-]{36}$/);
    expect(publicChecks).toHaveLength(1);
    expect(publicChecks[0]).toMatchObject({
      agent_run_id: runId,
      run_directive_version: "1",
    });
    expect(publisherChecks).toHaveLength(2);
    expect(publisherChecks).toEqual([
      expect.objectContaining({ agent_run_id: runId, run_directive_version: "1" }),
      expect.objectContaining({ agent_run_id: runId, run_directive_version: "1" }),
    ]);
    expect(publisherResult).toMatchObject({
      allowed: false,
      reservationId: null,
      mode: "hard_deny",
      deniedByPeriod: "run_stopped",
      denySource: "server",
      denyReason: "first_server_reason",
    });
    expect(provider.chat.completions.create).not.toHaveBeenCalled();
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(confirms).toEqual([]);
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0]).toHaveLength(1);
    expect(ingestCalls[0]?.[0]).toMatchObject({
      status: "budget_denied",
      provider: "openai",
      model: "gpt-4o",
      input_tokens: 0,
      output_tokens: 0,
      agent_run_id: runId,
      agent_run_name: `task-11-${_relation}-allow`,
      deny_source: "server",
      deny_reason: "first_server_reason",
      denied_by_period: "run_stopped",
      estimated_output_bound: 4096,
      attempt_index: 0,
      is_model_fallback: false,
      is_provider_fallback: false,
    });

    expect(laterAllow).toMatchObject({ allowed: true, reservationId: null });
    expect(registryAfterClear).toBeUndefined();
    expect(stickyAfterClear).toBe(false);
    expect(oldHandleWinnerAfterClear).toMatchObject({
      reason: "first_server_reason",
      source: "server",
    });
    expect(newHandleWinnerAfterClear).toBeUndefined();
  });
});
