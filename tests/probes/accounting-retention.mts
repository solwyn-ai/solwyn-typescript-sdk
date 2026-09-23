import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { createSolwynMiddleware } from "../../src/ai-sdk";
import { BudgetEnforcer } from "../../src/budget";
import { BudgetExceededError } from "../../src/errors";
import { LeaseLedger, type LeaseState } from "../../src/lease";
import { createRun, currentRun, noopLogger, run, Solwyn } from "../../src/node";
import type { ReleaseDispatcher } from "../../src/release-dispatcher";
import type { FetchLike } from "../../src/transport";
import type { LeaseGrantResponse } from "../../src/types";

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.ok(forceGc, "run with --expose-gc");
async function collect(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await setImmediate();
    forceGc?.();
  }
  await setImmediate();
}
/** The enforcer's bounded surrender dispatcher (diagnostic counters only). */
function releasesOf(budget: BudgetEnforcer): ReleaseDispatcher {
  return (budget as unknown as { releases: ReleaseDispatcher }).releases;
}
async function releasesIdle(budget: BudgetEnforcer): Promise<void> {
  await releasesOf(budget).whenIdle();
  await setImmediate();
}
const apiKey = `sk_proj_${"a".repeat(64)}`;
const projectId = `proj_${"0".repeat(24)}`;
const results: Record<string, unknown> = {};

function fixture(ineligible = false, tokens = 0) {
  const refs: WeakRef<LeaseState>[] = [];
  const counters = { grants: 0, checks: 0, surrenders: 0, surrenderedSpend: 0, dispatches: 0 };
  let ledger: LeaseLedger | undefined;
  let budget: BudgetEnforcer | undefined;
  const apply = LeaseLedger.prototype.applyGrantResponse;
  const check = BudgetEnforcer.prototype.checkBudget;
  LeaseLedger.prototype.applyGrantResponse = function (runId, response, options) {
    const result = apply.call(this, runId, response, options);
    const state = this.stateFor(runId);
    if (state) refs.push(new WeakRef(state));
    ledger = this;
    return result;
  };
  BudgetEnforcer.prototype.checkBudget = function (options) {
    budget = this;
    return check.call(this, options);
  };
  let surrenderFails = false;
  let surrenderGate: Promise<void> | undefined;
  let denyChecks = false;
  let checksOutage = false;
  let renewal: Promise<LeaseGrantResponse> | undefined;
  const grant = (generation = 1): LeaseGrantResponse => ({
    eligible: !ineligible,
    allowed: true,
    lease_id: ineligible ? null : `retention-${counters.grants}`,
    generation: ineligible ? null : generation,
    granted_tokens: ineligible ? null : 2000,
    refresh_interval_s: ineligible ? null : 300,
    lease_length_s: ineligible ? null : 600,
    headroom_share_tokens: ineligible ? null : 0,
    posture: ineligible ? null : { mode: "hard_deny", on_unreachable: "local_enforce" },
    final_grant: renewal === undefined,
    project_id: projectId,
    mode: "hard_deny",
    budget_limit: 100,
    current_usage: 0,
    remaining_budget: 100,
  });
  const fetch: FetchLike = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/budgets/lease")) {
      counters.grants++;
      return Response.json(grant());
    }
    if (pathname.endsWith("/budgets/lease/renew")) return Response.json(await renewal);
    if (pathname.endsWith("/budgets/check")) {
      counters.checks++;
      if (checksOutage) throw new TypeError("synthetic check outage");
      return Response.json({
        allowed: !denyChecks,
        remaining_budget: 100,
        reservation_id: null,
        mode: "hard_deny",
        budget_limit: 100,
        current_usage: 0,
        denied_by_period: denyChecks ? "agent_run" : null,
        project_id: projectId,
        price_hints: null,
      });
    }
    if (pathname.endsWith("/budgets/confirm")) return new Response(null, { status: 204 });
    if (pathname.endsWith("/metadata/ingest"))
      return Response.json(
        { ingested: JSON.parse(String(init?.body)).length, rejected: [] },
        { status: 202 },
      );
    if (pathname.endsWith("/budgets/lease/surrender")) {
      counters.surrenders++;
      await surrenderGate;
      if (surrenderFails) return new Response(null, { status: 503 });
      counters.surrenderedSpend += Number(JSON.parse(String(init?.body)).spent_tokens);
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected mocked accounting endpoint");
  };
  const client = new Solwyn(
    {
      chat: {
        completions: {
          create: async (params: { model: string; max_tokens?: number; stream?: boolean }) => {
            counters.dispatches++;
            if (params.stream)
              return (async function* () {
                yield { choices: [], usage: { prompt_tokens: tokens, completion_tokens: 0 } };
              })();
            return { usage: { prompt_tokens: tokens, completion_tokens: 0 } };
          },
        },
      },
    },
    {
      apiKey,
      apiUrl: "https://accounting-retention.invalid",
      fetch,
      logger: noopLogger,
      reportUntrackedSurfaces: false,
      breakerReportingEnabled: false,
      budgetCheckCacheTtl: 0,
    },
  );
  return {
    client,
    refs,
    counters,
    grant,
    fetch,
    get ledger() {
      assert.ok(ledger);
      return ledger;
    },
    get budget() {
      assert.ok(budget);
      return budget;
    },
    call: () => client.chat.completions.create({ model: "gpt-4o", max_tokens: 1 }),
    setSurrenderFailure(value: boolean) {
      surrenderFails = value;
    },
    setSurrenderGate(value: Promise<void>) {
      surrenderGate = value;
    },
    setDenyChecks(value: boolean) {
      denyChecks = value;
    },
    setChecksOutage(value: boolean) {
      checksOutage = value;
    },
    setRenewal(value: Promise<LeaseGrantResponse>) {
      renewal = value;
    },
    async close() {
      await client.close();
      LeaseLedger.prototype.applyGrantResponse = apply;
      BudgetEnforcer.prototype.checkBudget = check;
    },
  };
}

{
  const f = fixture(true);
  const handle = createRun("retained-denial");
  try {
    f.setDenyChecks(true);
    await assert.rejects(
      handle.activate(() => f.call()),
      BudgetExceededError,
    );
    await collect();
    f.setChecksOutage(true);
    await assert.rejects(
      handle.activate(() => f.call()),
      BudgetExceededError,
    );
    assert.equal(f.counters.grants, 1);
    assert.equal(
      f.counters.dispatches,
      0,
      "a retained run denial governs reactivation during outage",
    );
    handle.finish();
    await collect();
    assert.equal(f.ledger.stateFor(handle.runId), null);
    results["retained_denial"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture();
  const middleware = createSolwynMiddleware({
    apiKey,
    apiUrl: "https://accounting-retention.invalid",
    fetch: f.fetch,
    logger: noopLogger,
  });
  type Args = {
    model: { provider: string; modelId: string };
    params: { prompt: never[]; maxOutputTokens: number };
    doGenerate: () => Promise<{
      content: never[];
      usage: { inputTokens: number; outputTokens: number };
    }>;
  };
  const generate = middleware.middleware.wrapGenerate as unknown as (
    args: Args,
  ) => Promise<unknown>;
  const streamCall = middleware.middleware.wrapStream as unknown as (
    args: Omit<Args, "doGenerate"> & {
      doStream: () => Promise<{ stream: ReadableStream<unknown> }>;
    },
  ) => Promise<{ stream: ReadableStream<unknown> }>;
  try {
    for (let index = 0; index < 1000; index++)
      await run("ai-completed", () =>
        generate({
          model: { provider: "openai", modelId: "gpt-4o" },
          params: { prompt: [], maxOutputTokens: 1 },
          doGenerate: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 } }),
        }),
      );
    await collect();
    assert.equal(f.refs.filter((ref) => ref.deref() !== undefined).length, 0);
    assert.equal(f.counters.surrenders, 1000);
    results["ai_histories"] = { observed: f.refs.length, alive: 0 };
    const completedStreams: ReadableStream<unknown>[] = [];
    for (let index = 0; index < 100; index++) {
      const { stream } = await run("ai-completed-stream", () =>
        streamCall({
          model: { provider: "openai", modelId: "gpt-4o" },
          params: { prompt: [], maxOutputTokens: 1 },
          doStream: async () => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "finish", usage: { inputTokens: 0, outputTokens: 0 } });
                controller.close();
              },
            }),
          }),
        }),
      );
      completedStreams.push(stream);
      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        /* consume through terminal */
      }
      reader.releaseLock();
    }
    await collect();
    assert.equal(
      f.refs.filter((ref) => ref.deref() !== undefined).length,
      0,
      "retained terminal AI streams must release run owners",
    );
    assert.equal(completedStreams.length, 100);
    results["retained_terminal_ai_streams"] = true;
  } finally {
    await middleware.close();
    await f.close();
  }
}

for (const ineligible of [false, true]) {
  const f = fixture(ineligible);
  try {
    for (let count = 0; count < 10000; count++) await run("completed", () => f.call());
    f.ledger.sweep(performance.now() / 1000 + 901);
    await collect();
    const alive = f.refs.filter((ref) => ref.deref() !== undefined).length;
    assert.equal(alive, 0, "unreachable completed scopes must not retain lease states");
    results[ineligible ? "completed_ineligible" : "completed_granted"] = {
      observed: f.refs.length,
      alive,
      surrenders: f.counters.surrenders,
    };
  } finally {
    await f.close();
  }
}

{
  const f = fixture();
  const completed: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < 100; index++) {
      const promise = run("kept-completion", () => f.call());
      completed.push(promise);
      await promise;
    }
    await collect();
    assert.equal(
      f.refs.filter((ref) => ref.deref() !== undefined).length,
      0,
      "settled promises retain no run owner on Node 20/22/24",
    );
    assert.equal(completed.length, 100);
    results["retained_completed_promises"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture();
  const completed: AsyncIterable<unknown>[] = [];
  try {
    for (let index = 0; index < 100; index++) {
      const stream = (await run("kept-terminal-stream", () =>
        f.client.chat.completions.create({ model: "gpt-4o", max_tokens: 1, stream: true }),
      )) as AsyncIterable<unknown>;
      completed.push(stream);
      for await (const _ of stream) {
        /* consume through terminal */
      }
    }
    await collect();
    assert.equal(
      f.refs.filter((ref) => ref.deref() !== undefined).length,
      0,
      "retained terminal native streams must release run owners",
    );
    assert.equal(completed.length, 100);
    results["retained_terminal_native_streams"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture(true);
  let resource!: AsyncResource;
  let runId = "";
  try {
    await run("async-resource", async () => {
      runId = currentRun()?.agentRunId ?? "";
      await f.call();
      resource = new AsyncResource("solwyn-retention-control");
    });
    await collect();
    assert.equal(f.ledger.stateFor(runId)?.runIneligible, true);
    await resource.runInAsyncScope(() => f.call());
    assert.equal(f.counters.grants, 1);
    resource.emitDestroy();
    await collect();
    assert.equal(f.ledger.stateFor(runId), null);
    results["async_resource_owner"] = true;
  } finally {
    resource?.emitDestroy();
    await f.close();
  }
}

for (const ineligible of [false, true]) {
  const f = fixture(ineligible);
  const handle = createRun("reactivatable");
  try {
    await handle.activate(() => f.call());
    await collect();
    assert.ok(
      f.ledger.stateFor(handle.runId),
      "unfinished handles preserve state between activations",
    );
    await handle.activate(() => f.call());
    assert.equal(
      f.counters.grants,
      1,
      "reactivation must preserve grant or permanent ineligibility",
    );
    handle.finish();
    await collect();
    assert.equal(
      f.ledger.stateFor(handle.runId),
      null,
      "a kept finished handle releases its owner token",
    );
    results[ineligible ? "ineligible_handle" : "granted_handle"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture(false, 2);
  try {
    let runId = "";
    const stream = (await run("active-stream", async () => {
      runId = currentRun()?.agentRunId ?? "";
      return f.client.chat.completions.create({ model: "gpt-4o", max_tokens: 100, stream: true });
    })) as AsyncIterable<unknown>;
    await collect();
    assert.equal(
      f.ledger.stateFor(runId)?.reservations.size,
      1,
      "stream pins its admission after callback completion",
    );
    assert.equal(f.counters.surrenders, 0);
    for await (const _ of stream) {
      /* terminal usage only */
    }
    assert.equal(f.ledger.stateFor(runId)?.spentTokensSinceReport, 2);
    results["active_stream"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture(true);
  try {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let background!: Promise<void>;
    let runId = "";
    await run("background", async () => {
      runId = currentRun()?.agentRunId ?? "";
      await f.call();
      background = gate.then(async () => {
        await f.call();
      });
    });
    await collect();
    assert.equal(f.ledger.stateFor(runId)?.runIneligible, true);
    resume();
    await background;
    assert.equal(f.counters.grants, 1, "inherited background frames keep permanent ineligibility");
    results["background_frame"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture(false, 2);
  try {
    f.setSurrenderFailure(true);
    await run("unsettled", () => f.call());
    await collect();
    assert.equal(
      f.refs.filter((ref) => ref.deref() !== undefined).length,
      0,
      "a refused surrender is dropped with its advisory spend, not retained",
    );
    await releasesIdle(f.budget);
    assert.equal(f.counters.surrenders, 1);
    assert.equal(releasesOf(f.budget).counts().dropped.refused, 1);
    f.setSurrenderFailure(false);
    for (let index = 0; index < 3; index++) await f.call();
    await releasesIdle(f.budget);
    assert.equal(f.counters.surrenders, 1, "a refused surrender is never relaunched");
    assert.equal(f.counters.surrenderedSpend, 0, "no retry carries the dropped spend");
    const counts = releasesOf(f.budget).counts();
    assert.equal(counts.enqueued, counts.sent + counts.dropped.refused);
    results["refused_surrender_dropped_and_counted"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture(true);
  let runId = "";
  try {
    await run("managed-and-direct", async () => {
      runId = currentRun()?.agentRunId ?? "";
      await f.call();
      await f.budget.checkBudget({
        agentRunId: runId,
        model: "gpt-4o",
        provider: "openai",
        estimatedInputTokens: 0,
      });
    });
    await collect();
    assert.equal(
      f.ledger.stateFor(runId)?.runIneligible,
      true,
      "direct identity use conservatively disables ownership retirement",
    );
    results["identity_only_reuse"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture(true);
  const enforcer = new BudgetEnforcer({
    apiKey,
    apiUrl: "https://accounting-retention.invalid",
    fetch: f.fetch,
  });
  const runId = `run_${crypto.randomUUID()}`;
  const options = {
    agentRunId: runId,
    model: "gpt-4o",
    provider: "openai" as const,
    estimatedInputTokens: 0,
  };
  try {
    await enforcer.checkBudget(options);
    let owner: object | undefined = {};
    enforcer.observeRun({ agentRunId: runId, agentRunName: "mixed-order", lifetime: owner });
    await enforcer.checkBudget({ ...options, runLifetime: owner });
    owner = undefined;
    await collect();
    await enforcer.checkBudget(options);
    assert.equal(
      f.counters.grants,
      1,
      "unmanaged-first identity use must preserve permanent ineligibility after managed owner GC",
    );
    results["unmanaged_before_owned"] = true;
  } finally {
    await enforcer.close();
    await f.close();
  }
}

{
  const f = fixture(false, 2);
  let finishRenewal!: (response: LeaseGrantResponse) => void;
  f.setRenewal(
    new Promise((resolve) => {
      finishRenewal = resolve;
    }),
  );
  try {
    await run("pending-renewal", () =>
      f.client.chat.completions.create({ model: "gpt-4o", max_tokens: 1500 }),
    );
    await collect();
    assert.equal(
      f.counters.surrenders,
      0,
      "renewal owns the state after run frames become unreachable",
    );
    finishRenewal(f.grant(2));
    await collect();
    assert.equal(f.counters.surrenders, 1);
    assert.equal(
      f.counters.surrenderedSpend,
      2,
      "retirement reports the successor's net unreported spend",
    );
    assert.equal(f.refs.filter((ref) => ref.deref() !== undefined).length, 0);
    results["pending_renewal"] = true;
  } finally {
    await f.close();
  }
}

{
  const f = fixture(false, 2);
  let finishSurrender!: () => void;
  f.setSurrenderGate(
    new Promise<void>((resolve) => {
      finishSurrender = resolve;
    }),
  );
  let runId = "";
  try {
    await run("revived-during-retirement", async () => {
      runId = currentRun()?.agentRunId ?? "";
      await f.call();
    });
    await collect();
    assert.equal(f.counters.surrenders, 1);
    const options = {
      agentRunId: runId,
      model: "gpt-4o",
      provider: "openai" as const,
      estimatedInputTokens: 0,
    };
    const during = await f.budget.checkBudget(options);
    assert.equal(
      during.leaseId,
      null,
      "an in-flight surrendered grant cannot admit revived identity work",
    );
    assert.equal(f.counters.checks, 1);
    finishSurrender();
    await collect();
    assert.equal(f.ledger.stateFor(runId)?.hasLease, false);
    assert.equal(f.ledger.stateFor(runId)?.spentTokensSinceReport, 0);
    assert.equal(f.counters.surrenderedSpend, 2);
    await f.budget.checkBudget(options);
    assert.equal(f.counters.grants, 2, "revival acquires fresh authority after surrender");
    results["revival_during_retirement"] = true;
  } finally {
    finishSurrender();
    await f.close();
  }
}

{
  // An idle release dispatcher starts no timers and holds no pending work, so it cannot
  // keep an unclosed enforcer reachable.
  async function exercise(): Promise<WeakRef<BudgetEnforcer>> {
    const enforcer = new BudgetEnforcer({
      apiKey,
      apiUrl: "https://accounting-retention.invalid",
      fetch: async () => new Response(null, { status: 204 }),
    });
    const internal = enforcer as unknown as {
      surrenderLateSuccessor(response: LeaseGrantResponse, spentTokens: number): void;
    };
    internal.surrenderLateSuccessor(
      {
        eligible: true,
        allowed: true,
        lease_id: "idle-late",
        generation: 2,
        granted_tokens: 2000,
        refresh_interval_s: 300,
        lease_length_s: 600,
        headroom_share_tokens: 0,
        posture: { mode: "hard_deny", on_unreachable: "local_enforce" },
        final_grant: false,
        project_id: projectId,
        mode: "hard_deny",
        budget_limit: 100,
        current_usage: 0,
        remaining_budget: 100,
      },
      3,
    );
    await releasesIdle(enforcer);
    assert.equal(releasesOf(enforcer).counts().sent, 1);
    return new WeakRef(enforcer);
  }
  const reference = await run("idle-dispatcher", () => exercise());
  await collect();
  assert.equal(reference.deref(), undefined, "an idle release dispatcher roots nothing");
  results["idle_release_dispatcher"] = true;
}

process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
